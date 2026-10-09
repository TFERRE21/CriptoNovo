const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const defaultState = () => ({
  running: false,
  startedAt: null,
  lastPollAt: null,
  lastError: null,
  paperBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100),
  initialBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100),
  candidates: [],
  positions: [],
  trades: [],
  seenPairAddresses: []
});

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return { ...defaultState(), ...parsed };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const fresh = defaultState();
    await saveState(fresh);
    return fresh;
  }
}

async function saveState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function evaluatePair(pair, now = Date.now()) {
  const liquidity = Number(pair?.liquidity?.usd || 0);
  const createdAt = Number(pair?.pairCreatedAt || 0);
  const ageHours = createdAt > 0 ? (now - createdAt) / 3600000 : Infinity;
  const minLiquidity = numEnv("MIN_LIQUIDITY_USD", 5000);
  const maxAge = numEnv("MAX_PAIR_AGE_HOURS", 24);
  const reasons = [];

  if (!pair?.pairAddress || !pair?.baseToken?.address) reasons.push("Dados incompletos");
  if (String(pair?.chainId || "").toLowerCase() !== "bnb") reasons.push("Rede diferente de BNB Chain");
  if (liquidity < minLiquidity) reasons.push(`Liquidez abaixo do mínimo (US$${minLiquidity})`);
  if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > maxAge) reasons.push("Idade do par ausente ou fora do limite");
  if (!(Number(pair?.priceUsd) > 0)) reasons.push("Preço indisponível");

  // MVP safety limitation: this is NOT an audit and does not prove the token can be sold.
  return {
    approved: reasons.length === 0,
    reasons,
    liquidityUsd: liquidity,
    ageMinutes: Number.isFinite(ageHours) ? Math.round(ageHours * 60) : null
  };
}

function targetGrossPrice(entryPrice) {
  const costPct = numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5);
  const netTargetPct = numEnv("TAKE_PROFIT_NET_PCT", 5);
  // Approximate required gross price rise to leave net target after estimated round-trip costs.
  return entryPrice * (1 + (netTargetPct + costPct) / 100);
}

class PaperEngine {
  constructor() {
    this.state = null;
    this.timer = null;
    this.polling = false;
  }

  async init() {
    this.state = await loadState();
    // Never automatically resume on boot: the operator must explicitly start it.
    this.state.running = false;
    await saveState(this.state);
    return this.state;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const url = "https://api.dexscreener.com/latest/dex/search/?q= WBNB".replace("?q= WBNB", "?q=WBNB");
      const response = await fetch(url, { headers: { "accept": "application/json" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`DexScreener respondeu HTTP ${response.status}`);
      const data = await response.json();
      const pairs = (Array.isArray(data.pairs) ? data.pairs : [])
        .filter(p => String(p.chainId).toLowerCase() === "bnb")
        .sort((a, b) => Number(b.pairCreatedAt || 0) - Number(a.pairCreatedAt || 0))
        .slice(0, 100);

      const seen = new Set(this.state.seenPairAddresses);
      const now = Date.now();
      for (const pair of pairs) {
        const address = String(pair.pairAddress || "").toLowerCase();
        if (!address || seen.has(address)) continue;
        seen.add(address);
        const result = evaluatePair(pair, now);
        this.state.candidates.unshift({
          id: address,
          pairAddress: pair.pairAddress,
          tokenAddress: pair.baseToken?.address || "",
          tokenName: pair.baseToken?.name || "Desconhecido",
          tokenSymbol: pair.baseToken?.symbol || "?",
          url: pair.url || "",
          priceUsd: Number(pair.priceUsd || 0),
          liquidityUsd: result.liquidityUsd,
          ageMinutes: result.ageMinutes,
          volume24hUsd: Number(pair.volume?.h24 || 0),
          approved: result.approved,
          reasons: result.reasons,
          status: result.approved ? "APROVADO PARA SIMULAÇÃO" : "BLOQUEADO",
          detectedAt: new Date(now).toISOString(),
          // For this MVP, a candidate is recorded but no simulated purchase is opened automatically.
          // This prevents turning a weak search endpoint into an unsafe trading signal.
        });
      }
      this.state.seenPairAddresses = [...seen].slice(-5000);
      this.state.candidates = this.state.candidates.slice(0, 500);
      await this.markToMarket();
      this.state.lastPollAt = new Date().toISOString();
      this.state.lastError = null;
    } catch (error) {
      this.state.lastError = error.message || "Erro desconhecido";
    } finally {
      this.polling = false;
      await saveState(this.state);
    }
  }

  async markToMarket() {
    const open = this.state.positions.filter(p => p.status === "OPEN");
    for (const position of open) {
      try {
        const url = `https://api.dexscreener.com/latest/dex/pairs/bsc/${encodeURIComponent(position.pairAddress)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;
        const body = await response.json();
        const pair = body.pairs?.[0];
        const price = Number(pair?.priceUsd || 0);
        if (!(price > 0)) continue;
        position.lastPriceUsd = price;
        const changePct = (price / position.entryPriceUsd - 1) * 100;
        const costPct = numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5);
        position.estimatedNetPct = changePct - costPct;
        position.updatedAt = new Date().toISOString();
        const maxHold = numEnv("MAX_HOLD_MINUTES", 60);
        const expired = Date.now() - new Date(position.openedAt).getTime() >= maxHold * 60000;
        if (position.estimatedNetPct >= numEnv("TAKE_PROFIT_NET_PCT", 5) || expired) {
          this.closePosition(position, price, position.estimatedNetPct >= numEnv("TAKE_PROFIT_NET_PCT", 5) ? "ALVO_LIQUIDO" : "TEMPO_MAXIMO");
        }
      } catch {}
    }
  }

  closePosition(position, price, reason) {
    const grossPnlUsd = position.notionalUsd * (price / position.entryPriceUsd - 1);
    const costUsd = position.notionalUsd * numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5) / 100;
    const pnlUsd = grossPnlUsd - costUsd;
    position.status = "CLOSED";
    position.exitPriceUsd = price;
    position.closedAt = new Date().toISOString();
    position.closeReason = reason;
    position.grossPnlUsd = Number(grossPnlUsd.toFixed(6));
    position.estimatedCostsUsd = Number(costUsd.toFixed(6));
    position.pnlUsd = Number(pnlUsd.toFixed(6));
    this.state.paperBalanceUsd += position.notionalUsd + pnlUsd;
    this.state.trades.unshift({ ...position });
  }

  async start() {
    if (this.state.running) return;
    this.state.running = true;
    this.state.startedAt = new Date().toISOString();
    await this.poll();
    const interval = Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000));
    this.timer = setInterval(() => this.poll(), interval);
    await saveState(this.state);
  }

  async stop() {
    this.state.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await saveState(this.state);
  }

  async reset() {
    await this.stop();
    const initial = Number(process.env.PAPER_BALANCE_USD || 100);
    this.state = { ...defaultState(), paperBalanceUsd: initial, initialBalanceUsd: initial };
    await saveState(this.state);
  }

  snapshot() {
    const openPositions = this.state.positions.filter(p => p.status === "OPEN");
    const realizedPnlUsd = this.state.trades.reduce((sum, t) => sum + Number(t.pnlUsd || 0), 0);
    return {
      ...this.state,
      positions: openPositions,
      openPositionsCount: openPositions.length,
      closedTradesCount: this.state.trades.length,
      realizedPnlUsd: Number(realizedPnlUsd.toFixed(4)),
      targetNetPct: numEnv("TAKE_PROFIT_NET_PCT", 5),
      mode: "PAPER"
    };
  }
}

module.exports = { PaperEngine };
