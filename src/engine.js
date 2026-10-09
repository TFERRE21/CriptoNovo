const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const CHAIN_IDS = ["bsc", "ethereum", "solana"];
const SUPPORTED_CHAINS = new Set(CHAIN_IDS);
const chainBalances = amount => Object.fromEntries(CHAIN_IDS.map(chain => [chain, Number(amount)]));
const defaultSettings = () => Object.fromEntries(CHAIN_IDS.map(chain => [chain, {
  entryUsd: Number(process.env.PAPER_ORDER_USD || 10),
  takeProfitNetPct: Number(process.env.TAKE_PROFIT_NET_PCT || 4),
  stopLossEnabled: false,
  stopLossNetPct: Number(process.env.STOP_LOSS_NET_PCT || 2.5)
}]));

const defaultState = () => ({
  running: false, startedAt: null, lastPollAt: null, lastError: null, pairsAnalyzed: 0, activityLogs: [], experiment: { targetEntries: 60, entriesOpened: 0, completed: false, startedAt: null },
  paperBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100) * CHAIN_IDS.length,
  initialBalanceUsd: Number(process.env.PAPER_BALANCE_USD || 100) * CHAIN_IDS.length,
  networkBalances: chainBalances(Number(process.env.PAPER_BALANCE_USD || 100)),
  settings: defaultSettings(),
  candidates: [], positions: [], trades: [], seenPairAddresses: []
});

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return { ...defaultState(), ...parsed, settings: { ...defaultSettings(), ...(parsed.settings || {}) } };
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
  const base = pair?.baseToken || {};
  const quote = pair?.quoteToken || {};
  const baseSymbol = String(base.symbol || "").toUpperCase();
  const quoteSymbol = String(quote.symbol || "").toUpperCase();
  const wrappedNativeOrStable = new Set([
    "WBNB", "BNB", "WETH", "ETH", "USDC", "USDT", "DAI", "FDUSD", "BUSD",
    "SOL", "WSOL", "USDS", "USDE", "USDBC", "WAVAX", "AVAX", "WMATIC", "MATIC"
  ]);
  const baseIsQuoteAsset = wrappedNativeOrStable.has(baseSymbol);
  const quoteIsQuoteAsset = wrappedNativeOrStable.has(quoteSymbol);
  const basePriceUsd = Number(pair?.priceUsd || 0);
  const priceNative = Number(pair?.priceNative || 0);
  if (baseIsQuoteAsset && !quoteIsQuoteAsset && priceNative > 0 && basePriceUsd > 0) {
    return { token: quote, priceUsd: basePriceUsd / priceNative };
  }
  if (quoteIsQuoteAsset && !baseIsQuoteAsset) return { token: base, priceUsd: basePriceUsd };
  return { token: base, priceUsd: basePriceUsd };
}

function evaluatePair(pair, now = Date.now()) {
  const liquidity = Number(pair?.liquidity?.usd || 0);
  const createdAt = Number(pair?.pairCreatedAt || 0);
  const ageHours = createdAt > 0 ? (now - createdAt) / 3600000 : Infinity;
  const chain = String(pair?.chainId || "").toLowerCase();
  const volume24h = Number(pair?.volume?.h24 || 0);
  const txns1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const buys1h = Number(pair?.txns?.h1?.buys || 0);
  const sells1h = Number(pair?.txns?.h1?.sells || 0);
  const buys5m = Number(pair?.txns?.m5?.buys || 0);
  const sells5m = Number(pair?.txns?.m5?.sells || 0);
  const priceChange5m = Number(pair?.priceChange?.m5 || 0);
  const priceChange15m = Number(pair?.priceChange?.m15 || 0);
  const priceChange1h = Number(pair?.priceChange?.h1 || 0);
  const volume5m = Number(pair?.volume?.m5 || 0);
  const minLiquidity = numEnv("MIN_LIQUIDITY_USD", 1500);
  const minVolume24h = numEnv("MIN_VOLUME_24H_USD", 5000);
  const minTxns1h = numEnv("MIN_TXNS_1H", 5);
  const minBuyRatio = numEnv("MIN_BUY_SELL_RATIO", 0.9);
  const isFreshPair = Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= numEnv("FRESH_PAIR_MAX_AGE_HOURS", 6);
  const reasons = [];

  if (!pair?.pairAddress || !pair?.baseToken?.address || !pair?.quoteToken?.address) reasons.push("Dados incompletos");
  if (!SUPPORTED_CHAINS.has(chain)) reasons.push("Rede não habilitada");

  let entryScore = 0;
  let strategy = "ETH_TREND";
  if (chain === "ethereum") {
    // Keep Ethereum's existing strategy unchanged: it was the best performer in the user's sample.
    const minFreshLiquidity = numEnv("MIN_FRESH_LIQUIDITY_USD", 1000);
    const minFreshVolume5m = numEnv("MIN_FRESH_VOLUME_5M_USD", 200);
    const minFreshTxns5m = numEnv("MIN_FRESH_TXNS_5M", 2);
    const maxAge = numEnv("MAX_PAIR_AGE_HOURS", 720);
    const minAge = numEnv("MIN_PAIR_AGE_MINUTES", 0);
    if (liquidity < (isFreshPair ? minFreshLiquidity : minLiquidity)) reasons.push(`Liquidez abaixo do mínimo (${isFreshPair ? minFreshLiquidity : minLiquidity} USD)`);
    if (isFreshPair) {
      if (volume5m < minFreshVolume5m) reasons.push(`Volume recente abaixo do mínimo (${minFreshVolume5m} USD/5 min)`);
      if (buys5m + sells5m < minFreshTxns5m) reasons.push(`Poucas transações em 5 min (${buys5m + sells5m}/${minFreshTxns5m})`);
      if (buys5m <= sells5m) reasons.push("Moeda nova sem pressão compradora confirmada em 5 min");
      if (priceChange5m <= 0) reasons.push("Moeda nova sem momentum positivo em 5 min");
      if (priceChange5m > numEnv("MAX_FRESH_PRICE_CHANGE_5M_PCT", 12)) reasons.push("Moeda nova já subiu demais em 5 min");
    } else {
      if (volume24h < minVolume24h) reasons.push(`Volume 24h abaixo do mínimo (${minVolume24h} USD)`);
      if (txns1h < minTxns1h) reasons.push(`Poucas transações na última hora (${txns1h}/${minTxns1h})`);
      if (txns1h >= minTxns1h && buys1h < sells1h) reasons.push("Pressão vendedora na última hora");
      if (txns1h > 0 && buys1h / Math.max(sells1h, 1) < minBuyRatio) reasons.push(`Compras sem força suficiente (relação ${(buys1h / Math.max(sells1h, 1)).toFixed(2)}x)`);
      if (priceChange15m < numEnv("MIN_PRICE_CHANGE_15M_PCT", 0)) reasons.push("Tendência de 15 minutos fraca");
      if (priceChange1h < numEnv("MIN_PRICE_CHANGE_1H_PCT", 0)) reasons.push("Tendência de 1 hora insuficiente");
      if (priceChange1h > numEnv("MAX_PRICE_CHANGE_1H_PCT", 15)) reasons.push("Alta excessiva em 1 hora");
    }
    if (!Number.isFinite(ageHours) || ageHours < minAge / 60 || ageHours > maxAge) reasons.push("Idade do par ausente ou fora do limite");
    if (!isFreshPair && priceChange5m > numEnv("MAX_PRICE_CHANGE_5M_PCT", 6)) reasons.push("Alta muito acelerada em 5 minutos; risco de comprar no topo");
    if (!isFreshPair && priceChange15m > numEnv("MAX_PRICE_CHANGE_15M_PCT", 10)) reasons.push("Alta excessiva em 15 minutos");
    if (buys5m + sells5m < (isFreshPair ? minFreshTxns5m : numEnv("MIN_TXNS_5M", 3))) reasons.push("Pouca confirmação de negociação nos últimos 5 minutos");
    if (volume5m <= 0) reasons.push("Sem volume recente confirmado");
    entryScore = [
      liquidity >= (isFreshPair ? minFreshLiquidity * 2 : minLiquidity * 2),
      isFreshPair ? volume5m >= minFreshVolume5m * 2 : volume24h >= minVolume24h * 2,
      isFreshPair ? buys5m > sells5m : buys1h > sells1h,
      buys5m > sells5m,
      priceChange5m > 0 && priceChange5m <= (isFreshPair ? 8 : 3),
      priceChange15m >= 0.5 && priceChange15m <= 5,
      priceChange1h >= 1 && priceChange1h <= 10
    ].filter(Boolean).length;
  } else if (chain === "bsc") {
    // BNB Chain: early launch momentum, but avoid the first chaotic seconds and extreme candles.
    strategy = "BSC_EARLY_MOMENTUM";
    const minAgeMinutes = numEnv("BSC_MIN_AGE_MINUTES", 1);
    const maxAgeHours = numEnv("BSC_MAX_AGE_HOURS", 12);
    const minLiq = numEnv("BSC_MIN_LIQUIDITY_USD", 700);
    const minVol5m = numEnv("BSC_MIN_VOLUME_5M_USD", 150);
    const minTx5m = numEnv("BSC_MIN_TXNS_5M", 2);
    const minRatio = numEnv("BSC_MIN_BUY_SELL_RATIO_5M", 0.9);
    const maxChange5m = numEnv("BSC_MAX_PRICE_CHANGE_5M_PCT", 25);
    if (!Number.isFinite(ageHours) || ageHours * 60 < minAgeMinutes || ageHours > maxAgeHours) reasons.push("BNB: par fora da janela inicial de lançamento");
    if (liquidity < minLiq) reasons.push(`BNB: liquidez abaixo de US$${minLiq}`);
    if (volume5m < minVol5m) reasons.push(`BNB: volume de 5 min abaixo de US$${minVol5m}`);
    if (buys5m + sells5m < minTx5m) reasons.push(`BNB: menos de ${minTx5m} transações em 5 min`);
    if (buys5m / Math.max(sells5m, 1) < minRatio) reasons.push(`BNB: pressão compradora abaixo de ${minRatio}x`);
    if (priceChange5m <= 0) reasons.push("BNB: momentum de 5 min não positivo");
    if (priceChange5m > maxChange5m) reasons.push("BNB: alta de 5 min excessiva; possível compra no topo");
    if (volume5m <= 0) reasons.push("BNB: sem volume recente verificável");
    entryScore = [
      liquidity >= minLiq * 2, volume5m >= minVol5m * 2,
      buys5m > sells5m * minRatio,
      priceChange5m > 0 && priceChange5m <= maxChange5m / 2,
      buys5m + sells5m >= minTx5m * 2
    ].filter(Boolean).length;
  } else if (chain === "solana") {
    // Solana: faster meme-token flow, requiring more liquidity and stronger short-term demand.
    strategy = "SOLANA_FAST_FLOW";
    const minAgeMinutes = numEnv("SOL_MIN_AGE_MINUTES", 0);
    const maxAgeHours = numEnv("SOL_MAX_AGE_HOURS", 24);
    const minLiq = numEnv("SOL_MIN_LIQUIDITY_USD", 1000);
    const minVol5m = numEnv("SOL_MIN_VOLUME_5M_USD", 250);
    const minTx5m = numEnv("SOL_MIN_TXNS_5M", 2);
    const minRatio = numEnv("SOL_MIN_BUY_SELL_RATIO_5M", 0.9);
    const maxChange5m = numEnv("SOL_MAX_PRICE_CHANGE_5M_PCT", 20);
    if (!Number.isFinite(ageHours) || ageHours * 60 < minAgeMinutes || ageHours > maxAgeHours) reasons.push("Solana: par fora da janela inicial de lançamento");
    if (liquidity < minLiq) reasons.push(`Solana: liquidez abaixo de US$${minLiq}`);
    if (volume5m < minVol5m) reasons.push(`Solana: volume de 5 min abaixo de US$${minVol5m}`);
    if (buys5m + sells5m < minTx5m) reasons.push(`Solana: menos de ${minTx5m} transações em 5 min`);
    if (buys5m / Math.max(sells5m, 1) < minRatio) reasons.push(`Solana: pressão compradora abaixo de ${minRatio}x`);
    if (priceChange5m <= 0) reasons.push("Solana: momentum de 5 min não positivo");
    if (priceChange5m > maxChange5m) reasons.push("Solana: alta de 5 min excessiva; possível compra no topo");
    if (priceChange15m < -3) reasons.push("Solana: tendência de 15 min muito fraca");
    if (priceChange15m > numEnv("SOL_MAX_PRICE_CHANGE_15M_PCT", 12)) reasons.push("Solana: alta de 15 min excessiva; risco de entrada atrasada");
    if (priceChange1h < numEnv("SOL_MIN_PRICE_CHANGE_1H_PCT", -5)) reasons.push("Solana: tendência de 1 hora muito fraca");
    if (priceChange1h > numEnv("SOL_MAX_PRICE_CHANGE_1H_PCT", 25)) reasons.push("Solana: alta de 1 hora excessiva; risco de comprar após pump");
    if (volume5m <= 0) reasons.push("Solana: sem volume recente verificável");
    // Ajuste provisório inspirado nos dois resultados positivos: combinar fluxo comprador
    // de curto prazo com confirmação de tendência, evitando sinais isolados de 5 minutos.
    entryScore = [
      liquidity >= minLiq * 2, volume5m >= minVol5m * 2,
      buys5m > sells5m * minRatio,
      priceChange5m > 0 && priceChange5m <= maxChange5m / 2,
      buys5m + sells5m >= minTx5m * 2,
      priceChange15m > 0 && priceChange15m <= numEnv("SOL_MAX_PRICE_CHANGE_15M_PCT", 12),
      priceChange1h >= 0 && priceChange1h <= numEnv("SOL_MAX_PRICE_CHANGE_1H_PCT", 25)
    ].filter(Boolean).length;
  }

  // Shared confirmation pattern: recent buy pressure + active volume + controlled momentum.
  // Sludge/QSB historical entry metrics were not present in the screenshot; Solana's added multi-timeframe filter is provisional and must be validated on paper trades.
  const buySellRatio5m = buys5m / Math.max(sells5m, 1);
  const minCommonBuyRatio = 0.9;
  const minCommonTxns5m = 2;
  if (buys5m + sells5m < minCommonTxns5m) reasons.push(`Confirmação comum: menos de ${minCommonTxns5m} transações em 5 min`);
  if (buySellRatio5m < minCommonBuyRatio) reasons.push(`Confirmação comum: relação compras/vendas em 5 min abaixo de ${minCommonBuyRatio}x`);
  if (buys5m <= sells5m) reasons.push("Confirmação comum: vendas iguais ou superiores às compras nos últimos 5 min");
  if (priceChange5m <= 0) reasons.push("Confirmação comum: preço sem impulso positivo em 5 min");
  if (volume5m <= 0) reasons.push("Confirmação comum: sem volume recente");
  if (entryScore < 2) reasons.push(`Qualidade de entrada insuficiente (score ${entryScore}; mínimo 2)`);

  const selected = tokenSide(pair);
  if (!selected.token?.address || !(selected.priceUsd > 0)) reasons.push("Preço ou token negociável indisponível");
  if (String(pair?.dexId || "").length === 0) reasons.push("DEX não identificada");
  return { approved: reasons.length === 0, reasons, entryScore, strategy, isFreshPair, liquidityUsd: liquidity, volume24hUsd: volume24h, txns1h, buys1h, sells1h,
    buys5m, sells5m, volume5mUsd: volume5m, priceChange5m, priceChange15m, priceChange1h,
    buySellRatio: buys1h / Math.max(sells1h, 1), buySellRatio5m,
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
      const queries = ["WBNB USDT", "WBNB USDC", "BNB", "PancakeSwap", "WETH USDC", "WETH USDT", "USDC WETH", "USDT WETH", "ETH USDC", "ETH USDT", "PEPE WETH", "PEPE", "SHIB WETH", "SHIB", "LINK WETH", "LINK", "UNI WETH", "UNI", "AAVE WETH", "Uniswap", "SOL USDC", "SOL USDT", "Raydium", "Solana"];
      const results = await Promise.all(queries.map(async q => {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, {
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`DexScreener (${q}) respondeu HTTP ${response.status}`);
        const data = await response.json();
        return Array.isArray(data.pairs) ? data.pairs : [];
      }));
      const byAddress = new Map();
      // Supplement keyword search with DexScreener's latest token discovery feeds.
      const fetchFeed = async endpoint => {
        try {
          const response = await fetch(`https://api.dexscreener.com/${endpoint}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          return Array.isArray(data) ? data : [];
        } catch (error) {
          this.addLog(`Feed ${endpoint} indisponível: ${error.message || "erro"}.`, "warning");
          return [];
        }
      };
      const [profiles, boosts] = await Promise.all([
        fetchFeed("token-profiles/latest/v1"),
        fetchFeed("token-boosts/latest/v1")
      ]);
      const seeds = new Map();
      for (const item of [...profiles, ...boosts]) {
        const chain = String(item.chainId || "").toLowerCase();
        const tokenAddress = String(item.tokenAddress || "").trim();
        if (!SUPPORTED_CHAINS.has(chain) || !tokenAddress) continue;
        seeds.set(`${chain}:${tokenAddress.toLowerCase()}`, { chain, tokenAddress });
      }
      const seedList = [...seeds.values()].slice(0, 12);
      const freshPairLists = await Promise.all(seedList.map(async token => {
        try {
          const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(token.chain)}/${encodeURIComponent(token.tokenAddress)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
          if (!response.ok) return [];
          const data = await response.json();
          return Array.isArray(data) ? data : [];
        } catch { return []; }
      }));
      this.addLog(`Feed de descoberta recente: ${seedList.length} tokens consultados.`, "scan");
      for (const pair of [...results.flat(), ...freshPairLists.flat()]) {
        if (!SUPPORTED_CHAINS.has(String(pair.chainId || "").toLowerCase()) || !pair.pairAddress) continue;
        byAddress.set(`${String(pair.chainId).toLowerCase()}:${String(pair.pairAddress).toLowerCase()}`, pair);
      }
      const pairs = [...byAddress.values()]
        .sort((a, b) => Number(b.pairCreatedAt || 0) - Number(a.pairCreatedAt || 0))
        .filter(pair => SUPPORTED_CHAINS.has(String(pair.chainId || "").toLowerCase()));
      const seen = new Set(this.state.seenPairAddresses);
      const now = Date.now();
      this.state.pairsAnalyzed = Number(this.state.pairsAnalyzed || 0) + pairs.length;
      const chainCounts = pairs.reduce((acc, pair) => { const chain = String(pair.chainId || "unknown").toLowerCase(); acc[chain] = (acc[chain] || 0) + 1; return acc; }, {});
      const eligibleCounts = pairs.reduce((acc, pair) => { const chain = String(pair.chainId || "unknown").toLowerCase(); const verdict = evaluatePair(pair, now).approved ? "aprovados" : "bloqueados"; acc[chain] ||= { aprovados: 0, bloqueados: 0 }; acc[chain][verdict]++; return acc; }, {});
      this.addLog(`Consulta multirrede: ${pairs.length} pares únicos — ${Object.entries(chainCounts).map(([chain, count]) => `${chain}: ${count}`).join(", ") || "nenhum par retornado"}.`, "scan");
      this.addLog(`Filtros por rede: ${Object.entries(eligibleCounts).map(([chain, counts]) => `${chain}: ${counts.aprovados} aprovados / ${counts.bloqueados} bloqueados`).join("; ") || "sem dados"}.`, "scan");
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
          volume24hUsd: Number(pair.volume?.h24 || 0), txns1h: result.txns1h, buys1h: result.buys1h, sells1h: result.sells1h, isFreshPair: result.isFreshPair, strategy: result.strategy,
          buys5m: result.buys5m, sells5m: result.sells5m, volume5mUsd: result.volume5mUsd,
          priceChange5m: result.priceChange5m, priceChange15m: result.priceChange15m, priceChange1h: result.priceChange1h,
          buySellRatio: result.buySellRatio, buySellRatio5m: result.buySellRatio5m, entryScore: result.entryScore, approved: result.approved,
          reasons: result.reasons, status: result.approved ? (result.isFreshPair ? "MOEDA NOVA — SINAL CONFIRMADO" : "APROVADO — MOMENTUM CONFIRMADO") : "BLOQUEADO",
          detectedAt: candidatesById.get(pairKey)?.detectedAt || new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString()
        };
        const isNew = !seen.has(pairKey);
        if (isNew) {
          this.state.candidates.unshift(candidate);
          seen.add(pairKey);
          if (result.approved) this.addLog(`ENTRADA QUALIFICADA (${candidate.chainId}): ${candidate.tokenSymbol} — ${candidate.strategy || (candidate.isFreshPair ? "MOEDA RECENTE" : "PAR ESTABELECIDO")}; score ${candidate.entryScore}/7; m5 ${candidate.priceChange5m}%; m15 ${candidate.priceChange15m}%; h1 ${candidate.priceChange1h}%; compras/vendas m5 ${Number(candidate.buySellRatio5m || 0).toFixed(2)}x; liquidez US${candidate.liquidityUsd.toFixed(0)}.`, 'approved', { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId, pairAddress: candidate.pairAddress, entryScore: candidate.entryScore });
          else if (this.state.candidates.length < 20) this.addLog(`Par bloqueado (${candidate.chainId}): ${candidate.tokenSymbol} — ${result.reasons.join('; ')}.`, 'blocked', { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId });
        } else {
          const existing = candidatesById.get(pairKey);
          if (existing) Object.assign(existing, candidate);
        }
        // Evaluate entry signals on every poll, not only the first time a pair is discovered.
        if (this.state.running && result.approved) this.openPaperPosition(candidate);
      }
      this.state.seenPairAddresses = [...seen].slice(-5000);
      this.state.candidates = this.state.candidates.slice(0, 500);
      // Do not enter old candidates from historical state: only fresh, currently confirmed signals may open a position.
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
    this.state.experiment = { targetEntries: 60, entriesOpened: 0, completed: false, startedAt: null, ...(this.state.experiment || {}) };
    const maxOpen = numEnv("MAX_OPEN_POSITIONS", 6);
    const totalEntries = Number(this.state.experiment.entriesOpened || 0);
    const chainId = String(candidate.chainId || "bsc").toLowerCase();
    const chainEntries = [...this.state.positions, ...this.state.trades].filter(p => String(p.chainId || "bsc").toLowerCase() === chainId && Number(p.experimentEntryNumber) > 0).length;
    if (chainEntries >= 20 || totalEntries >= 60 || this.state.experiment.completed) return;
    const networkSettings = this.state.settings?.[chainId] || defaultSettings()[chainId];
    const notional = Number(networkSettings.entryUsd || 10);
    const open = this.state.positions.filter(p => p.status === "OPEN");
    this.state.networkBalances = this.state.networkBalances || chainBalances(Number(process.env.PAPER_BALANCE_USD || 100));
    if (open.length >= maxOpen || open.filter(p => String(p.chainId || "bsc").toLowerCase() === chainId).length >= 3 || Number(this.state.networkBalances[chainId] ?? 100) < notional) return;
    if (open.some(p => String(p.chainId || "bsc").toLowerCase() === chainId && String(p.pairAddress || "").toLowerCase() === String(candidate.pairAddress || "").toLowerCase())) return;
    if (this.state.trades.some(t => String(t.chainId || "bsc").toLowerCase() === chainId && String(t.pairAddress || "").toLowerCase() === String(candidate.pairAddress || "").toLowerCase())) return;
    if (!(candidate.priceUsd > 0)) return;
    const position = {
      id: candidate.id, chainId: candidate.chainId || "bsc", pairAddress: candidate.pairAddress, tokenAddress: candidate.tokenAddress,
      tokenName: candidate.tokenName, tokenSymbol: candidate.tokenSymbol, url: candidate.url,
      notionalUsd: notional, entryPriceUsd: candidate.priceUsd, lastPriceUsd: candidate.priceUsd,
      estimatedNetPct: -numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5),
      status: "OPEN", openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      takeProfitPriceUsd: candidate.priceUsd * (1 + (Number(networkSettings.takeProfitNetPct ?? 4) + numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5)) / 100),
      stopLossEnabledAtEntry: Boolean(networkSettings.stopLossEnabled),
      stopLossNetPctAtEntry: Number(networkSettings.stopLossNetPct ?? 2.5),
      takeProfitNetPctAtEntry: Number(networkSettings.takeProfitNetPct ?? 4),
      experimentEntryNumber: chainEntries + 1,
      entryFeatures: { liquidityUsd: Number(candidate.liquidityUsd || 0), ageMinutes: candidate.ageMinutes, volume24hUsd: Number(candidate.volume24hUsd || 0), tokenSymbol: candidate.tokenSymbol, pairAddress: candidate.pairAddress, dexId: candidate.dexId || null, priceUsd: Number(candidate.priceUsd || 0), entryScore: Number(candidate.entryScore || 0), isFreshPair: Boolean(candidate.isFreshPair), strategy: candidate.strategy || null, priceChange5m: Number(candidate.priceChange5m || 0), priceChange15m: Number(candidate.priceChange15m || 0), priceChange1h: Number(candidate.priceChange1h || 0), buySellRatio: Number(candidate.buySellRatio || 0), buySellRatio5m: Number(candidate.buySellRatio5m || 0), buys5m: Number(candidate.buys5m || 0), sells5m: Number(candidate.sells5m || 0), volume5mUsd: Number(candidate.volume5mUsd || 0) }
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
      const chainId = String(position.chainId || "bsc").toLowerCase();
      const maxHoldMs = numEnv("MAX_HOLD_MINUTES", 45) * 60000;
      const expired = Date.now() - new Date(position.openedAt).getTime() >= maxHoldMs;
      let priceUpdated = false;
      try {
        const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(position.pairAddress)}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          const pair = (await response.json()).pairs?.[0];
          if (pair) {
            const selected = tokenSide(pair);
            const price = selected.priceUsd;
            if (price > 0) {
              position.lastPriceUsd = price;
              const grossChangePct = (price / position.entryPriceUsd - 1) * 100;
              const costPct = numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5);
              position.estimatedNetPct = grossChangePct - costPct;
              position.updatedAt = new Date().toISOString();
              priceUpdated = true;
              const settings = this.state.settings?.[chainId] || defaultSettings()[chainId];
              const target = Number(settings.takeProfitNetPct ?? 4);
                      position.takeProfitPriceUsd = position.entryPriceUsd * (1 + (target + costPct) / 100);
              if (position.estimatedNetPct >= target) {
                this.closePosition(position, price, "ALVO_LIQUIDO");
                continue;
              }
            }
          }
        } else {
          this.addLog(`Preço indisponível para ${position.tokenSymbol} na rede ${chainId}: HTTP ${response.status}.`, "warning", { tokenSymbol: position.tokenSymbol, chainId });
        }
      } catch (error) {
        this.addLog(`Falha ao atualizar preço de ${position.tokenSymbol} na rede ${chainId}: ${error.message || "erro de consulta"}.`, "warning", { tokenSymbol: position.tokenSymbol, chainId });
      }
      if (expired) {
        const lastPrice = Number(position.lastPriceUsd || position.entryPriceUsd || 0);
        if (lastPrice > 0) {
          if (!priceUpdated) this.addLog(`Prazo máximo atingido para ${position.tokenSymbol}; usando o último preço disponível para registrar a saída simulada.`, "warning", { tokenSymbol: position.tokenSymbol, chainId });
          this.closePosition(position, lastPrice, priceUpdated ? "TEMPO_MAXIMO" : "TEMPO_MAXIMO_PRECO_DESATUALIZADO");
        }
      }
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
    if (experimentTrades.length >= 60 && this.state.experiment.entriesOpened >= 60) {
      this.state.experiment.completed = true;
      const winners = experimentTrades.filter(t => Number(t.pnlUsd) > 0);
      const losers = experimentTrades.filter(t => Number(t.pnlUsd) <= 0);
      const avg = arr => arr.length ? arr.reduce((sum, t) => sum + Number(t.entryFeatures?.liquidityUsd || 0), 0) / arr.length : 0;
      this.addLog(`EXPERIMENTO FINALIZADO: ${experimentTrades.length} entradas; ${winners.length} positivas e ${losers.length} negativas. Liquidez média vencedoras: ${avg(winners).toFixed(0)}; perdedoras: ${avg(losers).toFixed(0)}.`, 'experiment');
    }
    this.addLog(`SAÍDA SIMULADA: ${position.tokenSymbol} — ${pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(4)} (${position.estimatedNetPct.toFixed(2)}% líquido estimado). Motivo: ${reason}.`, pnlUsd >= 0 ? 'profit' : 'loss', { tokenSymbol: position.tokenSymbol, chainId, pnlUsd, pct: position.estimatedNetPct, closeReason: reason });
    this.state.trades = this.state.trades.slice(0, 500);
  }
  async start() {
    if (this.state.running && this.timer) { this.addLog('Comando iniciar recebido: monitor já estava ativo.', 'info'); await saveState(this.state); return; }
    this.addLog('Monitor de simulação iniciado manualmente.', 'info');
    this.state.running = true; this.state.startedAt = this.state.startedAt || new Date().toISOString();
    if (!this.timer) this.timer = setInterval(() => this.poll(), Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000)));
    await this.poll();
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
    const savedSettings = this.state.settings || defaultSettings();
    this.state = { ...defaultState(), settings: savedSettings, paperBalanceUsd: initial * CHAIN_IDS.length, initialBalanceUsd: initial * CHAIN_IDS.length, networkBalances: chainBalances(initial), running: true, startedAt: new Date().toISOString() };
    this.addLog("NOVO EXPERIMENTO: estado anterior zerado; saldo virtual US$100 por rede; objetivo de 10 entradas de US$10 por rede (30 no total); filtros de qualidade reforçados.", "experiment");
    await saveState(this.state);
    this.timer = setInterval(() => this.poll(), Math.max(15000, numEnv("POLL_INTERVAL_MS", 30000)));
    this.poll().catch(error => { this.state.lastError = error.message || "Falha na consulta inicial"; saveState(this.state).catch(() => {}); });
  }
  async updateSettings(input) {
    if (!input || typeof input !== "object") throw new Error("Configurações inválidas.");
    const next = { ...defaultSettings(), ...(this.state.settings || {}) };
    for (const chain of CHAIN_IDS) {
      const item = input[chain];
      if (!item) continue;
      const entryUsd = Number(item.entryUsd);
      const takeProfitNetPct = Number(item.takeProfitNetPct);
      const stopLossNetPct = Number(item.stopLossNetPct ?? 2.5);
      if (!Number.isFinite(entryUsd) || entryUsd < 1 || entryUsd > 1000000) throw new Error(`Entrada de ${chain} deve ficar entre US$1 e US$1.000.000.`);
      if (!Number.isFinite(takeProfitNetPct) || takeProfitNetPct < 0.1 || takeProfitNetPct > 500) throw new Error(`Meta de ganho de ${chain} deve ficar entre 0,1% e 500%.`);
      next[chain] = { entryUsd, takeProfitNetPct, stopLossEnabled: false, stopLossNetPct };
    }
    this.state.settings = next;
    this.state.settingsUpdatedAt = new Date().toISOString();
    // Apply the selected stop-loss toggle immediately to already-open paper positions.
    for (const position of this.state.positions.filter(p => p.status === "OPEN")) {
      const chain = String(position.chainId || "bsc").toLowerCase();
      const setting = next[chain] || defaultSettings()[chain];
      position.stopLossEnabledAtEntry = false;
      position.stopLossNetPctAtEntry = Number(setting.stopLossNetPct ?? 2.5);
      position.takeProfitNetPctAtEntry = Number(setting.takeProfitNetPct ?? 4);
    }
    const stopSummary = "Stop-loss desativado permanentemente; saídas por meta de lucro ou tempo máximo.";
    this.addLog(`Configurações salvas no servidor. ${stopSummary}. Aplicadas também às posições virtuais abertas.`, "settings");
    await saveState(this.state);
    return this.state.settings;
  }
  snapshot() {
    const positions = this.state.positions.filter(p => p.status === "OPEN");
    const realizedPnlUsd = this.state.trades.reduce((sum, t) => sum + Number(t.pnlUsd || 0), 0);
    return { ...this.state, positions, openPositionsCount: positions.length,
      closedTradesCount: this.state.trades.length, experiment: { targetEntries: 60, entriesOpened: 0, completed: false, ...(this.state.experiment || {}) }, realizedPnlUsd: Number(realizedPnlUsd.toFixed(4)),
      settings: { ...defaultSettings(), ...(this.state.settings || {}) },
      settingsUpdatedAt: this.state.settingsUpdatedAt || null,
      engineBuild: "config-guard-2026-10-09",
      targetNetPct: numEnv("TAKE_PROFIT_NET_PCT", 4), mode: "PAPER" };
  }
}
module.exports = { PaperEngine, evaluatePair, tokenSide };
