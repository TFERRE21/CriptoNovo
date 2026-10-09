const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const CHAIN_IDS = ["bsc", "ethereum", "solana", "base", "arbitrum", "optimism", "polygon", "avalanche"];
const SUPPORTED_CHAINS = new Set(CHAIN_IDS);
const chainBalances = amount => Object.fromEntries(CHAIN_IDS.map(chain => [chain, Number(amount)]));

const defaultState = () => ({
  running: false, startedAt: null, lastPollAt: null, lastError: null, pairsAnalyzed: 0, activityLogs: [], experiment: { targetEntries: 80, entriesOpened: 0, completed: false, startedAt: null },
  paperBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100) * CHAIN_IDS.length,
  initialBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100) * CHAIN_IDS.length,
  networkBalances: chainBalances(Number(process.env.PAPER_BALANCE_USD || 100)),
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
  const minLiquidity = numEnv("MIN_LIQUIDITY_USD", 10000);
  const minVolume24h = numEnv("MIN_VOLUME_24H_USD", 25000);
  const minTxns1h = numEnv("MIN_TXNS_1H", 10);
  const volume24h = Number(pair?.volume?.h24 || 0);
  const txns1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const buys1h = Number(pair?.txns?.h1?.buys || 0);
  const sells1h = Number(pair?.txns?.h1?.sells || 0);
  const maxAge = numEnv("MAX_PAIR_AGE_HOURS", 24);
  const reasons = [];
  if (!pair?.pairAddress || !pair?.baseToken?.address || !pair?.quoteToken?.address) reasons.push("Dados incompletos");
  if (!SUPPORTED_CHAINS.has(String(pair?.chainId || "").toLowerCase())) reasons.push("Rede não habilitada");
  if (liquidity < minLiquidity) reasons.push(`Liquidez abaixo do mínimo (US${minLiquidity})`);
  if (volume24h < minVolume24h) reasons.push(`Volume 24h abaixo de US${minVolume24h}`);
  if (txns1h < minTxns1h) reasons.push(`Poucas transações na última hora (${txns1h}/${minTxns1h})`);
  if (txns1h >= minTxns1h && buys1h < sells1h) reasons.push("Pressão vendedora na última hora");
  if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > maxAge) reasons.push("Idade do par ausente ou fora do limite");
  const selected = tokenSide(pair);
  if (!selected.token?.address || !(selected.priceUsd > 0)) reasons.push("Preço ou token negociável indisponível");
  if (String(pair?.dexId || "").length === 0) reasons.push("DEX não identificada");
  return { approved: reasons.length === 0, reasons, liquidityUsd: liquidity, volume24hUsd: volume24h, txns1h, buys1h, sells1h,
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
    // Schedule continuous polling immediately; don't delay HTTP startup on a slow API.
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000)));
    }
    this.poll().catch(error => {
      this.state.lastError = error?.message || "Falha na consulta inicial";
      saveState(this.state).catch(() => {});
    });
    return this.state;
  }
  addLog(message, type = "info", details = {}) {
    if (!this.state) return;
    this.state.activityLogs = Array.isArray(this.state.activityLogs) ? this.state.activityLogs : [];
    this.state.activityLogs.unshift({ at: new Date().toISOString(), type, message, ...details });
    this.state.activityLogs = this.state.activityLogs.slice(0, 150);
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      // Search endpoint is approximate. Query several terms each cycle instead of repeatedly seeing only the same WBNB results.
      const queries = ["WBNB", "BNB", "PancakeSwap", "BSC", "WETH", "ETH", "Uniswap", "Ethereum", "SOL", "Raydium", "Solana", "Base", "Aerodrome", "Arbitrum", "Optimism", "Polygon", "Avalanche"];
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
        if (!SUPPORTED_CHAINS.has(String(pair.chainId || "").toLowerCase()) || !pair.pairAddress) continue;
        byAddress.set(String(pair.pairAddress).toLowerCase(), pair);
      }
      const pairs = [...byAddress.values()]
        .sort((a, b) => Number(b.pairCreatedAt || 0) - Number(a.pairCreatedAt || 0))
        .slice(0, 300);
      const seen = new Set(this.state.seenPairAddresses);
      const now = Date.now();
      this.state.pairsAnalyzed = Number(this.state.pairsAnalyzed || 0) + pairs.length;
      this.addLog(`Consulta concluída: ${pairs.length} pares BNB Chain analisados; ${byAddress.size} pares únicos nesta rodada.`, 'scan');
      const candidatesById = new Map(this.state.candidates.map(item => [String(item.id).toLowerCase(), item]));
      for (const pair of pairs) {
        const address = String(pair.pairAddress || "").toLowerCase();
        const chainId = String(pair.chainId || "bsc").toLowerCase();
        const pairKey = `${chainId}:${address}`;
        if (!address) continue;
        const result = evaluatePair(pair, now);
        const candidate = {
          id: pairKey, chainId, pairAddress: pair.pairAddress,
          tokenAddress: result.token?.address || "",
          tokenName: result.token?.name || "Desconhecido",
          tokenSymbol: result.token?.symbol || "?",
          url: pair.url || "", priceUsd: result.priceUsd,
          liquidityUsd: result.liquidityUsd, ageMinutes: result.ageMinutes, dexId: pair.dexId || "",
          volume24hUsd: Number(pair.volume?.h24 || 0), txns1h: result.txns1h, buys1h: result.buys1h, sells1h: result.sells1h, approved: result.approved,
          reasons: result.reasons, status: result.approved ? "APROVADO PARA SIMULAÇÃO" : "BLOQUEADO",
          detectedAt: candidatesById.get(address)?.detectedAt || new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString()
        };
        const isNew = !seen.has(pairKey);
        if (isNew) {
          this.state.candidates.unshift(candidate);
          seen.add(pairKey);
          if (result.approved) this.addLog(`Novo par aprovado (${candidate.chainId}): ${candidate.tokenSymbol} — liquidez ${candidate.liquidityUsd.toFixed(2)} USD.`, 'approved', { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId, pairAddress: candidate.pairAddress });
          else if (this.state.candidates.length < 20) this.addLog(`Par bloqueado (${candidate.chainId}): ${candidate.tokenSymbol} — ${result.reasons.join('; ')}.`, 'blocked', { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId });
          if (this.state.running && result.approved) this.openPaperPosition(candidate);
        } else {
          const existing = candidatesById.get(pairKey);
          if (existing) Object.assign(existing, candidate);
        }
      }
      this.state.seenPairAddresses = [...seen].slice(-5000);
      this.state.candidates = this.state.candidates.slice(0, 500);
      // Fill the ten-entry experiment from already discovered approved pairs too.
      if (this.state.running) {
        const alreadyUsed = new Set([
          ...this.state.positions.map(p => `${String(p.chainId || "bsc").toLowerCase()}:${String(p.pairAddress || "").toLowerCase()}`),
          ...this.state.trades.map(t => `${String(t.chainId || "bsc").toLowerCase()}:${String(t.pairAddress || "").toLowerCase()}`)
        ]);
        for (const candidate of this.state.candidates) {
          if (Number(this.state.experiment?.entriesOpened || 0) >= 80) break;
          const id = `${String(candidate.chainId || "bsc").toLowerCase()}:${String(candidate.pairAddress || "").toLowerCase()}`;
          if (!candidate.approved || !id || alreadyUsed.has(id) || !(Number(candidate.priceUsd) > 0)) continue;
          this.openPaperPosition(candidate);
          alreadyUsed.add(id);
        }
      }
      await this.markToMarket();
      this.state.lastPollAt = new Date().toISOString();
      this.state.lastError = null;
    } catch (error) {
      this.state.lastError = error.message || "Erro desconhecido";
      this.addLog(`Erro na consulta: ${this.state.lastError}`, "error");
    } finally {
      this.polling = false;
      await saveState(this.state);
    }
  }
  openPaperPosition(candidate) {
    this.state.experiment = { targetEntries: 80, entriesOpened: 0, completed: false, startedAt: null, ...(this.state.experiment || {}) };
    const maxOpen = 10;
    const totalEntries = Number(this.state.experiment.entriesOpened || 0);
    const chainId = String(candidate.chainId || "bsc").toLowerCase();
    const chainEntries = [...this.state.positions, ...this.state.trades].filter(p => String(p.chainId || "bsc").toLowerCase() === chainId && Number(p.experimentEntryNumber) > 0).length;
    if (chainEntries >= 10 || totalEntries >= 80 || this.state.experiment.completed) return;
    const notional = numEnv("PAPER_ORDER_USD", 10);
    const open = this.state.positions.filter(p => p.status === "OPEN");
    this.state.networkBalances = this.state.networkBalances || chainBalances(Number(process.env.PAPER_BALANCE_USD || 100));
    if (open.length >= maxOpen || Number(this.state.networkBalances[chainId] ?? 100) < notional) return;
    if (open.some(p => String(p.chainId || "bsc").toLowerCase() === chainId && String(p.pairAddress || "").toLowerCase() === String(candidate.pairAddress || "").toLowerCase())) return;
    if (this.state.trades.some(t => String(t.chainId || "bsc").toLowerCase() === chainId && String(t.pairAddress || "").toLowerCase() === String(candidate.pairAddress || "").toLowerCase())) return;
    if (!(candidate.priceUsd > 0)) return;
    const position = {
      id: candidate.id, chainId: candidate.chainId || "bsc", pairAddress: candidate.pairAddress, tokenAddress: candidate.tokenAddress,
      tokenName: candidate.tokenName, tokenSymbol: candidate.tokenSymbol, url: candidate.url,
      notionalUsd: notional, entryPriceUsd: candidate.priceUsd, lastPriceUsd: candidate.priceUsd,
      estimatedNetPct: -numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5),
      status: "OPEN", openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      takeProfitPriceUsd: candidate.priceUsd * (1 + (numEnv("TAKE_PROFIT_NET_PCT", 5) + numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5)) / 100),
      experimentEntryNumber: chainEntries + 1,
      entryFeatures: { liquidityUsd: Number(candidate.liquidityUsd || 0), ageMinutes: candidate.ageMinutes, volume24hUsd: Number(candidate.volume24hUsd || 0), tokenSymbol: candidate.tokenSymbol, pairAddress: candidate.pairAddress, dexId: candidate.dexId || null, priceUsd: Number(candidate.priceUsd || 0) }
    };
    this.state.networkBalances[chainId] = Number(this.state.networkBalances[chainId] ?? 100) - notional;
    this.state.paperBalanceUsd = Object.values(this.state.networkBalances).reduce((sum, value) => sum + Number(value || 0), 0);
    this.state.experiment.entriesOpened = totalEntries + 1;
    this.state.experiment.startedAt = this.state.experiment.startedAt || new Date().toISOString();
    this.state.positions.unshift(position);
    this.addLog(`ENTRADA SIMULADA: ${candidate.tokenSymbol} a ${candidate.priceUsd}; ordem virtual ${notional}.`, 'entry', { tokenSymbol: candidate.tokenSymbol, chainId, pct: position.estimatedNetPct });
  }
  async markToMarket() {
    for (const position of this.state.positions.filter(p => p.status === "OPEN")) {
      try {
        const chainId = String(position.chainId || "bsc").toLowerCase();
        const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(position.pairAddress)}`;
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
    const chainId = String(position.chainId || "bsc").toLowerCase();
    this.state.networkBalances = this.state.networkBalances || chainBalances(Number(process.env.PAPER_BALANCE_USD || 100));
    this.state.networkBalances[chainId] = Number(this.state.networkBalances[chainId] ?? 100) + position.notionalUsd + pnlUsd;
    this.state.paperBalanceUsd = Object.values(this.state.networkBalances).reduce((sum, value) => sum + Number(value || 0), 0);
    this.state.trades.unshift({ ...position });
    const experimentTrades = this.state.trades.filter(t => Number(t.experimentEntryNumber) > 0);
    if (experimentTrades.length >= 80 && this.state.experiment.entriesOpened >= 80) {
      this.state.experiment.completed = true;
      const winners = experimentTrades.filter(t => Number(t.pnlUsd) > 0);
      const losers = experimentTrades.filter(t => Number(t.pnlUsd) <= 0);
      const avg = arr => arr.length ? arr.reduce((sum, t) => sum + Number(t.entryFeatures?.liquidityUsd || 0), 0) / arr.length : 0;
      this.addLog(`EXPERIMENTO FINALIZADO: ${experimentTrades.length} entradas; ${winners.length} positivas e ${losers.length} negativas. Liquidez média vencedoras: ${avg(winners).toFixed(0)}; perdedoras: ${avg(losers).toFixed(0)}.`, 'experiment');
    }
    this.addLog(`SAÍDA SIMULADA: ${position.tokenSymbol} — ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(4)} (${position.estimatedNetPct.toFixed(2)}% líquido estimado). Motivo: ${reason}.`, pnlUsd >= 0 ? 'profit' : 'loss', { tokenSymbol: position.tokenSymbol, chainId, pnlUsd, pct: position.estimatedNetPct });
    this.state.trades = this.state.trades.slice(0, 500);
  }
  async start() {
    if (this.state.running) { this.addLog('Comando iniciar recebido: monitor já estava ativo.', 'info'); await saveState(this.state); return; }
    this.addLog('Monitor de simulação iniciado manualmente.', 'info');
    this.state.running = true; this.state.startedAt = new Date().toISOString();
    await this.poll();
    this.timer = setInterval(() => this.poll(), Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000)));
    await saveState(this.state);
  }
  async stop() {
    this.addLog('Monitor de simulação parado pelo usuário.', 'warning');
    this.state.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await saveState(this.state);
  }
  async reset() {
    await this.stop();
    const initial = Number(process.env.PAPER_BALANCE_USD || 100);
    this.state = { ...defaultState(), paperBalanceUsd: initial * CHAIN_IDS.length, initialBalanceUsd: initial * CHAIN_IDS.length, networkBalances: chainBalances(initial), running: true, startedAt: new Date().toISOString() };
    this.addLog("NOVO EXPERIMENTO: estado anterior zerado; saldo virtual US$100 por rede; objetivo de 10 entradas de US$10 por rede (80 no total); filtros de qualidade reforçados.", "experiment");
    await saveState(this.state);
    this.timer = setInterval(() => this.poll(), Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000)));
    this.poll().catch(error => { this.state.lastError = error.message || "Falha na consulta inicial"; saveState(this.state).catch(() => {}); });
  }
  snapshot() {
    const positions = this.state.positions.filter(p => p.status === "OPEN");
    const realizedPnlUsd = this.state.trades.reduce((sum, t) => sum + Number(t.pnlUsd || 0), 0);
    return { ...this.state, positions, openPositionsCount: positions.length,
      closedTradesCount: this.state.trades.length, experiment: { targetEntries: 80, entriesOpened: 0, completed: false, ...(this.state.experiment || {}) }, realizedPnlUsd: Number(realizedPnlUsd.toFixed(4)),
      targetNetPct: numEnv("TAKE_PROFIT_NET_PCT", 5), mode: "PAPER" };
  }
}
module.exports = { PaperEngine, evaluatePair, tokenSide };
