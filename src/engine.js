const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

const defaultState = () => ({
  running: false, startedAt: null, lastPollAt: null, lastError: null, pairsAnalyzed: 0,
  paperBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100),
  initialBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100),
  candidates: [], positions: [], trades: [], seenPairAddresses: []
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
function tokenSide(pair) {
  const baseIsWbnb = String(pair?.baseToken?.address || "").toLowerCase() === WBNB;
  const quoteIsWbnb = String(pair?.quoteToken?.address || "").toLowerCase() === WBNB;
  if (baseIsWbnb) return { token: pair.quoteToken, priceUsd: Number(pair.priceUsd || 0) > 0 && Number(pair.priceNative || 0) > 0 ? Number(pair.priceUsd) / Number(pair.priceNative) : 0 };
  if (quoteIsWbnb) return { token: pair.baseToken, priceUsd: Number(pair.priceUsd || 0) };
  return { token: pair.baseToken, priceUsd: Number(pair.priceUsd || 0) };
}
function evaluatePair(pair, now = Date.now()) {
  const liquidity = Number(pair?.liquidity?.usd || 0);
  const createdAt = Number(pair?.pairCreatedAt || 0);
  const ageHours = createdAt > 0 ? (now - createdAt) / 3600000 : Infinity;
  const minLiquidity = numEnv("MIN_LIQUIDITY_USD", 5000);
  const maxAge = numEnv("MAX_PAIR_AGE_HOURS", 24);
  const reasons = [];
  if (!pair?.pairAddress || !pair?.baseToken?.address || !pair?.quoteToken?.address) reasons.push("Dados incompletos");
  if (String(pair?.chainId || "").toLowerCase() !== "bsc") reasons.push("Rede diferente de BNB Chain");
  if (liquidity < minLiquidity) reasons.push(`Liquidez abaixo do mínimo (US$${minLiquidity})`);
  if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > maxAge) reasons.push("Idade do par ausente ou fora do limite");
  const selected = tokenSide(pair);
  if (!selected.token?.address || !(selected.priceUsd > 0)) reasons.push("Preço ou token negociável indisponível");
  if (String(pair?.dexId || "").length === 0) reasons.push("DEX não identificada");
  return { approved: reasons.length === 0, reasons, liquidityUsd: liquidity,
    ageMinutes: Number.isFinite(ageHours) ? Math.round(ageHours * 60) : null,
    token: selected.token, priceUsd: selected.priceUsd };
}

class PaperEngine {
  constructor() { this.state = null; this.timer = null; this.polling = false; }
  async init() {
    this.state = await loadState();
    // Keep the monitor running across dashboard navigation and refreshes.
    this.state.running = true;
    this.state.startedAt = this.state.startedAt || new Date().toISOString();
    await saveState(this.state);
    // Start polling on the server independently of the browser.
    await this.poll();
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000)));
      this.timer.unref?.();
    }
    return this.state;
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      // Search endpoint is approximate. Query several terms each cycle instead of repeatedly seeing only the same WBNB results.
      const queries = ["WBNB", "BNB", "PancakeSwap", "BSC"];
      const results = await Promise.all(queries.map(async q => {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`DexScreener (${q}) respondeu HTTP ${response.status}`);
        const data = await response.json();
        return Array.isArray(data.pairs) ? data.pairs : [];
      }));
      const byAddress = new Map();
      for (const pair of results.flat()) {
        if (String(pair.chainId || "").toLowerCase() !== "bsc" || !pair.pairAddress) continue;
        byAddress.set(String(pair.pairAddress).toLowerCase(), pair);
      }
      const pairs = [...byAddress.values()]
        .sort((a, b) => Number(b.pairCreatedAt || 0) - Number(a.pairCreatedAt || 0))
        .slice(0, 300);
      const seen = new Set(this.state.seenPairAddresses);
      const now = Date.now();
      this.state.pairsAnalyzed = Number(this.state.pairsAnalyzed || 0) + pairs.length;
      const candidatesById = new Map(this.state.candidates.map(item => [String(item.id).toLowerCase(), item]));
      for (const pair of pairs) {
        const address = String(pair.pairAddress || "").toLowerCase();
        if (!address) continue;
        const result = evaluatePair(pair, now);
        const candidate = {
          id: address, pairAddress: pair.pairAddress,
          tokenAddress: result.token?.address || "",
          tokenName: result.token?.name || "Desconhecido",
          tokenSymbol: result.token?.symbol || "?",
          url: pair.url || "", priceUsd: result.priceUsd,
          liquidityUsd: result.liquidityUsd, ageMinutes: result.ageMinutes,
          volume24hUsd: Number(pair.volume?.h24 || 0), approved: result.approved,
          reasons: result.reasons, status: result.approved ? "APROVADO PARA SIMULAÇÃO" : "BLOQUEADO",
          detectedAt: candidatesById.get(address)?.detectedAt || new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString()
        };
        const isNew = !seen.has(address);
        if (isNew) {
          this.state.candidates.unshift(candidate);
          seen.add(address);
          if (this.state.running && result.approved) this.openPaperPosition(candidate);
        } else {
          const existing = candidatesById.get(address);
          if (existing) Object.assign(existing, candidate);
        }
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
  openPaperPosition(candidate) {
    const maxOpen = Math.max(1, Math.floor(numEnv("MAX_OPEN_POSITIONS", 3)));
    const notional = numEnv("PAPER_ORDER_USD", 10);
    const open = this.state.positions.filter(p => p.status === "OPEN");
    if (open.length >= maxOpen || this.state.paperBalanceUsd < notional) return;
    if (open.some(p => p.pairAddress.toLowerCase() === candidate.pairAddress.toLowerCase())) return;
    if (!(candidate.priceUsd > 0)) return;
    const position = {
      id: candidate.id, pairAddress: candidate.pairAddress, tokenAddress: candidate.tokenAddress,
      tokenName: candidate.tokenName, tokenSymbol: candidate.tokenSymbol, url: candidate.url,
      notionalUsd: notional, entryPriceUsd: candidate.priceUsd, lastPriceUsd: candidate.priceUsd,
      estimatedNetPct: -numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5),
      status: "OPEN", openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      takeProfitPriceUsd: candidate.priceUsd * (1 + (numEnv("TAKE_PROFIT_NET_PCT", 5) + numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5)) / 100)
    };
    this.state.paperBalanceUsd -= notional;
    this.state.positions.unshift(position);
  }
  async markToMarket() {
    for (const position of this.state.positions.filter(p => p.status === "OPEN")) {
      try {
        const url = `https://api.dexscreener.com/latest/dex/pairs/bsc/${encodeURIComponent(position.pairAddress)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;
        const pair = (await response.json()).pairs?.[0];
        if (!pair) continue;
        const selected = tokenSide(pair);
        const price = selected.priceUsd;
        if (!(price > 0)) continue;
        position.lastPriceUsd = price;
        const grossChangePct = (price / position.entryPriceUsd - 1) * 100;
        const costPct = numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5);
        position.estimatedNetPct = grossChangePct - costPct;
        position.updatedAt = new Date().toISOString();
        const target = numEnv("TAKE_PROFIT_NET_PCT", 5);
        const expired = Date.now() - new Date(position.openedAt).getTime() >= numEnv("MAX_HOLD_MINUTES", 60) * 60000;
        if (position.estimatedNetPct >= target || expired) this.closePosition(position, price, position.estimatedNetPct >= target ? "ALVO_LIQUIDO" : "TEMPO_MAXIMO");
      } catch { /* keep position open if price provider temporarily fails */ }
    }
  }
  closePosition(position, price, reason) {
    const grossPnlUsd = position.notionalUsd * (price / position.entryPriceUsd - 1);
    const costUsd = position.notionalUsd * numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5) / 100;
    const pnlUsd = grossPnlUsd - costUsd;
    position.status = "CLOSED";
    position.exitPriceUsd = price; position.closedAt = new Date().toISOString(); position.closeReason = reason;
    position.grossPnlUsd = Number(grossPnlUsd.toFixed(6));
    position.estimatedCostsUsd = Number(costUsd.toFixed(6));
    position.pnlUsd = Number(pnlUsd.toFixed(6));
    this.state.paperBalanceUsd += position.notionalUsd + pnlUsd;
    this.state.trades.unshift({ ...position });
    this.state.trades = this.state.trades.slice(0, 500);
  }
  async start() {
    if (this.state.running) return;
    this.state.running = true; this.state.startedAt = new Date().toISOString();
    await this.poll();
    this.timer = setInterval(() => this.poll(), Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000)));
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
    const positions = this.state.positions.filter(p => p.status === "OPEN");
    const realizedPnlUsd = this.state.trades.reduce((sum, t) => sum + Number(t.pnlUsd || 0), 0);
    return { ...this.state, positions, openPositionsCount: positions.length,
      closedTradesCount: this.state.trades.length, realizedPnlUsd: Number(realizedPnlUsd.toFixed(4)),
      targetNetPct: numEnv("TAKE_PROFIT_NET_PCT", 5), mode: "PAPER" };
  }
}
module.exports = { PaperEngine, evaluatePair, tokenSide };
