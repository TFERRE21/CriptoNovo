const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const initSqlJs = require("sql.js");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const DB_FILE = path.join(DATA_DIR, "criptonovo.sqlite");
let databasePromise = null;

async function openDatabase() {
  if (!databasePromise) databasePromise = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve("sql.js")), file) });
    let db;
    try { db = new SQL.Database(await fs.readFile(DB_FILE)); }
    catch (error) { if (error.code !== "ENOENT") throw error; db = new SQL.Database(); }
    db.run("CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
    return db;
  })();
  return databasePromise;
}

async function persistDatabase(db) {
  // Cada gravação usa um temporário exclusivo para evitar colisões de rename.
  const tmp = `${DB_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, Buffer.from(db.export()));
    await fs.rename(tmp, DB_FILE);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const CHAIN_IDS = ["bsc", "ethereum", "solana"];
const SUPPORTED_CHAINS = new Set(CHAIN_IDS);
const chainBalances = amount => Object.fromEntries(CHAIN_IDS.map(chain => [chain, Number(amount)]));
const defaultSettings = () => Object.fromEntries(CHAIN_IDS.map(chain => [chain, {
  entryUsd: Number(process.env.PAPER_ORDER_USD || 10),
  takeProfitNetPct: chain === "solana" ? 10 : Number(process.env.TAKE_PROFIT_NET_PCT || 4),
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
  const db = await openDatabase();
  const stored = db.exec("SELECT state_json FROM app_state WHERE id = 1");
  if (stored.length && stored[0].values.length) {
    const parsed = JSON.parse(stored[0].values[0][0]);
    return { ...defaultState(), ...parsed, settings: { ...defaultSettings(), ...(parsed.settings || {}) } };
  }

  // Migração automática e sem apagar nada: importa o estado JSON existente na primeira inicialização do SQLite.
  let legacyState;
  try {
    legacyState = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const initial = legacyState
    ? { ...defaultState(), ...legacyState, settings: { ...defaultSettings(), ...(legacyState.settings || {}) } }
    : defaultState();
  await saveState(initial);
  return initial;
}
async function saveStateUnlocked(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const db = await openDatabase();
  const json = JSON.stringify(state);
  db.run("INSERT INTO app_state (id, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at", [json, new Date().toISOString()]);
  await persistDatabase(db);
  // Espelho legível e cópia de compatibilidade; o SQLite passa a ser a fonte persistente principal.
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
}

// Uma fila única evita gravações simultâneas no mesmo banco e no state.json.
let stateSaveQueue = Promise.resolve();
async function saveState(state) {
  const pending = stateSaveQueue.then(
    () => saveStateUnlocked(state),
    () => saveStateUnlocked(state)
  );
  stateSaveQueue = pending.catch(() => {});
  return pending;
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
  const minLiquidity = numEnv("MIN_LIQUIDITY_USD", 15000);
  const minVolume24h = numEnv("MIN_VOLUME_24H_USD", 20000);
  const minTxns1h = numEnv("MIN_TXNS_1H", 10);
  const minBuyRatio = numEnv("MIN_BUY_SELL_RATIO", 1.1);
  const isFreshPair = Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= numEnv("FRESH_PAIR_MAX_AGE_HOURS", 6);
  const reasons = [];
  if (liquidity < 15000) reasons.push("Liquidez abaixo do mínimo global de US$15.000");

  if (!pair?.pairAddress || !pair?.baseToken?.address || !pair?.quoteToken?.address) reasons.push("Dados incompletos");
  if (!SUPPORTED_CHAINS.has(chain)) reasons.push("Rede não habilitada");

  let entryScore = 0;
  let strategy = "ETH_TREND";
  if (chain === "ethereum") {
    // Keep Ethereum's existing strategy unchanged: it was the best performer in the user's sample.
    const minFreshLiquidity = numEnv("MIN_FRESH_LIQUIDITY_USD", 15000);
    const minFreshVolume5m = numEnv("MIN_FRESH_VOLUME_5M_USD", 1000);
    const minFreshTxns5m = numEnv("MIN_FRESH_TXNS_5M", 4);
    const maxAge = numEnv("MAX_PAIR_AGE_HOURS", 2160);
    const minAge = numEnv("MIN_PAIR_AGE_MINUTES", 60);
    if (liquidity < (isFreshPair ? minFreshLiquidity : minLiquidity)) reasons.push(`Liquidez abaixo do mínimo (${isFreshPair ? minFreshLiquidity : minLiquidity} USD)`);
    if (isFreshPair) {
      if (volume5m < minFreshVolume5m) reasons.push(`Volume recente abaixo do mínimo (${minFreshVolume5m} USD/5 min)`);
      if (buys5m + sells5m < minFreshTxns5m) reasons.push(`Poucas transações em 5 min (${buys5m + sells5m}/${minFreshTxns5m})`);
      if (buys5m <= sells5m) reasons.push("Moeda nova sem pressão compradora confirmada em 5 min");
      if (priceChange5m <= 0) reasons.push("Moeda nova sem momentum positivo em 5 min");
      if (priceChange5m > numEnv("MAX_FRESH_PRICE_CHANGE_5M_PCT", 8)) reasons.push("Moeda nova já subiu demais em 5 min");
    } else {
      if (volume24h < minVolume24h) reasons.push(`Volume 24h abaixo do mínimo (${minVolume24h} USD)`);
      if (txns1h < minTxns1h) reasons.push(`Poucas transações na última hora (${txns1h}/${minTxns1h})`);
      if (txns1h >= minTxns1h && buys1h < sells1h) reasons.push("Pressão vendedora na última hora");
      if (txns1h > 0 && buys1h / Math.max(sells1h, 1) < minBuyRatio) reasons.push(`Compras sem força suficiente (relação ${(buys1h / Math.max(sells1h, 1)).toFixed(2)}x)`);
      if (priceChange15m < numEnv("MIN_PRICE_CHANGE_15M_PCT", 0)) reasons.push("Tendência de 15 minutos fraca");
      if (priceChange1h < numEnv("MIN_PRICE_CHANGE_1H_PCT", 0)) reasons.push("Tendência de 1 hora insuficiente");
      // Não bloquear apenas pela alta acumulada de 1h: movimentos fortes podem continuar,
      // mas a entrada ainda exige liquidez/volume, compras recentes e momentum de 5m/15m controlado.
      // O limite de 1h deixa de ser bloqueador isolado para evitar perder projetos que aceleraram cedo.
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
      priceChange1h >= 1
    ].filter(Boolean).length;
  } else if (chain === "bsc") {
    // BNB Chain: early launch momentum, but avoid the first chaotic seconds and extreme candles.
    strategy = "BSC_EARLY_MOMENTUM";
    const minAgeMinutes = numEnv("BSC_MIN_AGE_MINUTES", 60);
    const maxAgeHours = numEnv("BSC_MAX_AGE_HOURS", 2160);
    const minLiq = numEnv("BSC_MIN_LIQUIDITY_USD", 15000);
    const minVol5m = numEnv("BSC_MIN_VOLUME_5M_USD", 1000);
    const minTx5m = numEnv("BSC_MIN_TXNS_5M", 6);
    const minRatio = numEnv("BSC_MIN_BUY_SELL_RATIO_5M", 1.2);
    const maxChange5m = numEnv("BSC_MAX_PRICE_CHANGE_5M_PCT", 8);
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
    const minAgeMinutes = numEnv("SOL_MIN_AGE_MINUTES", 60);
    const maxAgeHours = numEnv("SOL_MAX_AGE_HOURS", 2160);
    const minLiq = numEnv("SOL_MIN_LIQUIDITY_USD", 15000);
    const minVol5m = numEnv("SOL_MIN_VOLUME_5M_USD", 1000);
    const minTx5m = numEnv("SOL_MIN_TXNS_5M", 6);
    const minRatio = numEnv("SOL_MIN_BUY_SELL_RATIO_5M", 1.2);
    const maxChange5m = numEnv("SOL_MAX_PRICE_CHANGE_5M_PCT", 10);
    if (!Number.isFinite(ageHours) || ageHours * 60 < minAgeMinutes || ageHours > maxAgeHours) reasons.push("Solana: par fora da janela inicial de lançamento");
    if (liquidity < minLiq) reasons.push(`Solana: liquidez abaixo de US$${minLiq}`);
    if (volume5m < minVol5m) reasons.push(`Solana: volume de 5 min abaixo de US$${minVol5m}`);
    if (buys5m + sells5m < minTx5m) reasons.push(`Solana: menos de ${minTx5m} transações em 5 min`);
    if (buys5m / Math.max(sells5m, 1) < minRatio) reasons.push(`Solana: pressão compradora abaixo de ${minRatio}x`);
    if (priceChange5m <= 0) reasons.push("Solana: momentum de 5 min não positivo");
    if (priceChange5m > maxChange5m) reasons.push("Solana: alta de 5 min excessiva; possível compra no topo");
    if (priceChange15m <= 0) reasons.push("Solana: tendência de 15 min sem confirmação positiva");
    if (priceChange15m > numEnv("SOL_MAX_PRICE_CHANGE_15M_PCT", 12)) reasons.push("Solana: alta de 15 min excessiva; risco de entrada atrasada");
    if (priceChange1h < numEnv("SOL_MIN_PRICE_CHANGE_1H_PCT", -5)) reasons.push("Solana: tendência de 1 hora muito fraca");
    // Para projetos muito novos com liquidez/volume fortes, permitir continuação de tendência
    // até +80% em 1h; ainda exigir confirmação de fluxo e momentum curto para não comprar um candle isolado.
    const solMaxMove1h = isFreshPair
      ? numEnv("SOL_FRESH_MAX_PRICE_CHANGE_1H_PCT", 80)
      : numEnv("SOL_MAX_PRICE_CHANGE_1H_PCT", 25);
    if (priceChange1h > solMaxMove1h) reasons.push(`Solana: alta de 1 hora excessiva para o estágio (${solMaxMove1h}% máximo)`);
    if (volume5m <= 0) reasons.push("Solana: sem volume recente verificável");
    // Ajuste provisório inspirado nos dois resultados positivos: combinar fluxo comprador
    // de curto prazo com confirmação de tendência, evitando sinais isolados de 5 minutos.
    entryScore = [
      liquidity >= minLiq * 2, volume5m >= minVol5m * 2,
      buys5m > sells5m * minRatio,
      priceChange5m > 0 && priceChange5m <= maxChange5m / 2,
      buys5m + sells5m >= minTx5m * 2,
      priceChange15m > 0 && priceChange15m <= numEnv("SOL_MAX_PRICE_CHANGE_15M_PCT", 12),
      priceChange1h >= 0 && priceChange1h <= solMaxMove1h
    ].filter(Boolean).length;
  }

  // Normalize each chain's score to 0–100 so the entry threshold is comparable.
  const entryScoreMax = chain === "bsc" ? 5 : 7;
  const entryScorePct = Math.round((entryScore / entryScoreMax) * 100);

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
  // Filtro compartilhado por estágio: lançamento recente usa volume/liquidez recentes,
  // enquanto projetos com mais tempo precisam comprovar volume acumulado de 24h.
  const winnerPatternMinLiquidity = numEnv("WINNER_PATTERN_MIN_LIQUIDITY_USD", 15000);
  const winnerPatternMinVolume24h = numEnv("WINNER_PATTERN_MIN_VOLUME_24H_USD", 25000);
  const winnerPatternMinTxns5m = numEnv("WINNER_PATTERN_MIN_TXNS_5M", 4);
  const winnerPatternMaxChange5m = numEnv("WINNER_PATTERN_MAX_PRICE_CHANGE_5M_PCT", 20);
  const freshPatternLiquidity = chain === "ethereum" ? numEnv("MIN_FRESH_LIQUIDITY_USD", 15000)
    : chain === "bsc" ? numEnv("BSC_MIN_LIQUIDITY_USD", 15000)
    : numEnv("SOL_MIN_LIQUIDITY_USD", 15000);
  const freshPatternVolume5m = numEnv("MIN_FRESH_VOLUME_5M_USD", 1000);
  const freshPatternMaxMove = chain === "ethereum" ? numEnv("MAX_FRESH_PRICE_CHANGE_5M_PCT", 8)
    : chain === "bsc" ? numEnv("BSC_MAX_PRICE_CHANGE_5M_PCT", 8)
    : numEnv("SOL_MAX_PRICE_CHANGE_5M_PCT", 10);
  if (isFreshPair) {
    if (liquidity < freshPatternLiquidity) reasons.push(`Padrão lançamento: liquidez abaixo de US${freshPatternLiquidity}`);
    if (volume5m < freshPatternVolume5m) reasons.push(`Padrão lançamento: volume de 5 min abaixo de US${freshPatternVolume5m}`);
    if (buys5m + sells5m < winnerPatternMinTxns5m) reasons.push(`Padrão lançamento: menos de ${winnerPatternMinTxns5m} transações em 5 min`);
    if (buys5m <= sells5m) reasons.push("Padrão lançamento: compras não superam vendas em 5 min");
    if (priceChange5m <= 0 || priceChange5m > freshPatternMaxMove) reasons.push(`Padrão lançamento: variação de 5 min fora do intervalo positivo até ${freshPatternMaxMove}%`);
  } else {
    if (liquidity < winnerPatternMinLiquidity) reasons.push(`Padrão estabelecido: liquidez abaixo de US${winnerPatternMinLiquidity}`);
    if (volume24h < winnerPatternMinVolume24h) reasons.push(`Padrão estabelecido: volume 24h abaixo de US${winnerPatternMinVolume24h}`);
    if (buys5m + sells5m < winnerPatternMinTxns5m) reasons.push(`Padrão estabelecido: menos de ${winnerPatternMinTxns5m} transações em 5 min`);
    if (buys5m <= sells5m) reasons.push("Padrão estabelecido: compras não superam vendas em 5 min");
    if (priceChange5m <= 0 || priceChange5m > winnerPatternMaxChange5m) reasons.push(`Padrão estabelecido: variação de 5 min fora de 0–${winnerPatternMaxChange5m}%`);
  }
  if (entryScore < 2) reasons.push(`Qualidade de entrada insuficiente (score ${entryScore}; mínimo 2)`);

  const selected = tokenSide(pair);
  const selectedSymbol = String(selected.token?.symbol || "").trim().toUpperCase();
  const selectedName = String(selected.token?.name || "").trim().toUpperCase();
  const excludedAssets = new Set(["USDT", "USDC", "USDBC", "USDS", "USDE", "TUSD", "DAI", "FDUSD", "BUSD", "USDP", "PYUSD", "WBNB", "WETH", "WSOL", "WBTC"]);
  if (excludedAssets.has(selectedSymbol) || excludedAssets.has(selectedName)) reasons.push("Ativo-base estável ou wrapped excluído da estratégia");
  if (!selected.token?.address || !(selected.priceUsd > 0)) reasons.push("Preço ou token negociável indisponível");
  if (String(pair?.dexId || "").length === 0) reasons.push("DEX não identificada");
  const officialSites = Array.isArray(pair?.info?.websites) ? pair.info.websites : [];
  const hasOfficialWebsite = officialSites.some(site => /^https?:\/\//i.test(String(site?.url || "")));
  // Site oficial é informativo, não é requisito de entrada.
  return { approved: reasons.length === 0, reasons, entryScore, entryScorePct, strategy, isFreshPair, liquidityUsd: liquidity, volume24hUsd: volume24h, txns1h, buys1h, sells1h,
    buys5m, sells5m, volume5mUsd: volume5m, priceChange5m, priceChange15m, priceChange1h,
    buySellRatio: buys1h / Math.max(sells1h, 1), buySellRatio5m,
    ageMinutes: Number.isFinite(ageHours) ? Math.round(ageHours * 60) : null,
    token: selected.token, priceUsd: selected.priceUsd };
}

class PaperEngine {
  constructor() { this.state = null; this.timer = null; this.polling = false; }
  async init() {
    this.state = await loadState();
    // Meta líquida da estratégia Solana fixada em 10%, inclusive para posições já abertas.
    this.state.settings = { ...defaultSettings(), ...(this.state.settings || {}) };
    // Simulação global: US$10 por projeto e stop-loss desativado em todas as redes.
    for (const chain of CHAIN_IDS) {
      this.state.settings[chain] = { ...defaultSettings()[chain], ...(this.state.settings[chain] || {}), entryUsd: 10 };
    }
    this.state.settings.solana.takeProfitNetPct = 10;
    for (const position of this.state.positions.filter(p => p.status === "OPEN")) {
      if (String(position.chainId || "").toLowerCase() === "solana") position.takeProfitNetPctAtEntry = 10;
    }
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
      // Não pesquisar tickers/moedas populares por palavras-chave; descobrir somente projetos novos via feeds recentes e pools recém-criados.
      const results = [];
      // Fallback de descoberta: a busca direta do DexScreener complementa os feeds recentes
      // quando perfis/boosts/anúncios retornam poucos tokens. Os filtros de rede e estratégia
      // continuam sendo aplicados abaixo; esta busca nunca abre posição por si só.
      // Uma busca por ciclo evita rajadas simultâneas que podem acionar rate limit (HTTP 429).
      // Os feeds de lançamento e as pools novas abaixo complementam essa busca.
      try {
        const response = await fetch("https://api.dexscreener.com/latest/dex/search?q=new", {
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const pairs = Array.isArray(data.pairs) ? data.pairs : [];
        results.push(...pairs);
        this.addLog(`Busca DexScreener "new": ${pairs.length} pares recebidos.`, "scan");
      } catch (error) {
        this.addLog(`Busca DexScreener indisponível: ${error.message || "erro"}.`, "warning");
      }
      // Fonte adicional de descoberta on-chain: GeckoTerminal, independente dos feeds DexScreener.
      const fetchGeckoPools = async network => {
        try {
          const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/new_pools`, {
            headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(10000)
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          return (Array.isArray(data.data) ? data.data : []).map(pool => {
            const a = pool.attributes || {};
            const rel = pool.relationships || {};
            const baseRef = rel.base_token?.data?.id || "";
            const quoteRef = rel.quote_token?.data?.id || "";
            const baseAddress = String(a.base_token_address || baseRef.split("_").slice(1).join("_"));
            const quoteAddress = String(a.quote_token_address || quoteRef.split("_").slice(1).join("_"));
            const baseName = String(a.name || "Projeto novo").split(" / ")[0];
            const baseSymbol = String(a.name || "?").split(" / ")[0];
            const created = Date.parse(a.pool_created_at || "");
            const tx = a.transactions || {};
            const h24tx = tx.h24 || {};
            const m5tx = tx.m5 || {};
            const h1tx = tx.h1 || {};
            const infoWebsites = Array.isArray(a.websites) ? a.websites.map(url => ({url})) : [];
            return {
              chainId: network === "bsc" ? "bsc" : network === "eth" ? "ethereum" : "solana",
              pairAddress: a.address || String(pool.id || "").split("_").slice(1).join("_"),
              baseToken: { address: baseAddress, name: baseName, symbol: baseSymbol },
              quoteToken: { address: quoteAddress, name: "Quote", symbol: "USDC" },
              priceUsd: a.base_token_price_usd || "0",
              liquidity: { usd: Number(a.reserve_in_usd || 0) },
              volume: { h24: Number(a.volume_usd?.h24 || 0), m5: Number(a.volume_usd?.m5 || 0) },
              txns: { h24: h24tx, h1: h1tx, m5: m5tx },
              priceChange: a.price_change_percentage || {},
              pairCreatedAt: Number.isFinite(created) ? created : 0,
              dexId: a.dex_id || "geckoterminal",
              url: `https://www.geckoterminal.com/${network}/pools/${a.address || ""}`,
              info: { websites: infoWebsites, socials: [] },
              discoverySource: "GeckoTerminal"
            };
          });
        } catch (error) {
          this.addLog(`GeckoTerminal ${network} indisponível: ${error.message || "erro"}.`, "warning");
          return [];
        }
      };
      const geckoPools = (await Promise.all(["eth", "solana", "bsc"].map(fetchGeckoPools))).flat();
      this.addLog(`Descoberta independente GeckoTerminal: ${geckoPools.length} pools recentes recebidos.`, "scan");
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
      // Feeds oficiais de descoberta consultados uma vez por ciclo (padrão: 30 s).
      const [profiles, boosts, topBoosts, ads] = await Promise.all([
        fetchFeed("token-profiles/latest/v1"),
        fetchFeed("token-boosts/latest/v1"),
        fetchFeed("token-boosts/top/v1"),
        fetchFeed("ads/latest/v1")
      ]);
      const seeds = new Map();
      for (const [source, items] of [["perfil recente", profiles], ["boost recente", boosts], ["top boosts", topBoosts], ["anúncio recente", ads]]) {
        for (const item of items) {
          const chain = String(item.chainId || "").toLowerCase();
          const tokenAddress = String(item.tokenAddress || "").trim();
          if (!SUPPORTED_CHAINS.has(chain) || !tokenAddress) continue;
          const key = `${chain}:${tokenAddress.toLowerCase()}`;
          const previous = seeds.get(key) || { chain, tokenAddress, sources: [] };
          if (!previous.sources.includes(source)) previous.sources.push(source);
          seeds.set(key, previous);
        }
      }
      const seedList = [...seeds.values()].slice(0, 100);
      this.addLog(`Feeds DexScreener: perfis ${profiles.length}, boosts recentes ${boosts.length}, top boosts ${topBoosts.length}, anúncios ${ads.length}; ${seedList.length} tokens únicos.`, "scan");
      const freshPairLists = await Promise.all(seedList.map(async token => {
        try {
          const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(token.chain)}/${encodeURIComponent(token.tokenAddress)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
          if (!response.ok) return [];
          const data = await response.json();
          return Array.isArray(data) ? data : [];
        } catch { return []; }
      }));
      this.addLog(`Pares atualizados via token-pairs/v1 para ${seedList.length} tokens descobertos nos feeds recentes.`, "scan");
      // GeckoTerminal amplia a descoberta; DexScreener vem depois para preservar metadados oficiais do par quando disponíveis.
      for (const pair of [...geckoPools, ...results.flat(), ...freshPairLists.flat()]) {
        if (!SUPPORTED_CHAINS.has(String(pair.chainId || "").toLowerCase()) || !pair.pairAddress) continue;
        byAddress.set(`${String(pair.chainId).toLowerCase()}:${String(pair.pairAddress).toLowerCase()}`, pair);
      }
      // Analisa no máximo 50 projetos únicos por ciclo, priorizando pares mais recentes.
      const pairs = [...byAddress.values()]
        .filter(pair => SUPPORTED_CHAINS.has(String(pair.chainId || "").toLowerCase()))
        // Prioriza os pares com site oficial verificável para a lista, sem alterar os filtros de compra.
        .sort((a, b) => {
          const siteA = Array.isArray(a.info?.websites) && a.info.websites.some(site => /^https?:\/\//i.test(String(site?.url || ""))) ? 1 : 0;
          const siteB = Array.isArray(b.info?.websites) && b.info.websites.some(site => /^https?:\/\//i.test(String(site?.url || ""))) ? 1 : 0;
          return siteB - siteA || Number(b.pairCreatedAt || 0) - Number(a.pairCreatedAt || 0);
        })
        .filter(pair => Number(pair.liquidity?.usd || 0) >= 15000)
        .slice(0, 100);
      const seen = new Set(this.state.seenPairAddresses);
      const now = Date.now();
      this.state.pairsAnalyzed = Number(this.state.pairsAnalyzed || 0) + pairs.length;
      const chainCounts = pairs.reduce((acc, pair) => { const chain = String(pair.chainId || "unknown").toLowerCase(); acc[chain] = (acc[chain] || 0) + 1; return acc; }, {});
      const eligibleCounts = pairs.reduce((acc, pair) => { const chain = String(pair.chainId || "unknown").toLowerCase(); const verdict = evaluatePair(pair, now).approved ? "aprovados" : "bloqueados"; acc[chain] ||= { aprovados: 0, bloqueados: 0 }; acc[chain][verdict]++; return acc; }, {});
      this.addLog(`Monitor de projetos novos: ${pairs.length} projetos únicos encontrados nas fontes de descoberta recente.`, "scan");
      this.addLog(`Validação dos projetos novos concluída: ${Object.values(eligibleCounts).reduce((sum, counts) => sum + counts.aprovados + counts.bloqueados, 0)} projetos avaliados.`, "scan");
      const candidatesById = new Map(this.state.candidates.map(item => [String(item.id).toLowerCase(), item]));
      for (const pair of pairs) {
        const address = String(pair.pairAddress || "").toLowerCase();
        const chainId = String(pair.chainId || "bsc").toLowerCase();
        const pairKey = `${chainId}:${address}`;
        if (!address) continue;
        const result = evaluatePair(pair, now);
        // Critério único para o selo COMPATÍVEL no painel e para permitir entrada.
        // Um projeto fora deste padrão nunca pode abrir posição, mesmo que outro filtro aprove o par.
        const officialSitesForEntry = Array.isArray(pair.info?.websites) ? pair.info.websites : [];
        const hasOfficialWebsiteForEntry = officialSitesForEntry.some(site => /^https?:\/\//i.test(String(site?.url || "")));
        // Critérios por estágio; site oficial é apenas informativo e score mínimo é 2.
        const freshLiquidityFloor = chainId === "ethereum" ? numEnv("MIN_FRESH_LIQUIDITY_USD", 15000)
          : chainId === "bsc" ? numEnv("BSC_MIN_LIQUIDITY_USD", 15000)
          : numEnv("SOL_MIN_LIQUIDITY_USD", 15000);
        const freshVolume5mFloor = numEnv("MIN_FRESH_VOLUME_5M_USD", 1000);
        const freshMaxMove5m = chainId === "ethereum" ? numEnv("MAX_FRESH_PRICE_CHANGE_5M_PCT", 8)
          : chainId === "bsc" ? numEnv("BSC_MAX_PRICE_CHANGE_5M_PCT", 8)
          : numEnv("SOL_MAX_PRICE_CHANGE_5M_PCT", 10);
        const freshProject = result.isFreshPair === true && Number(result.ageMinutes) >= 0 && Number(result.ageMinutes) <= 90 * 24 * 60;
        const winnerPatternCompatible =
          (freshProject
            ? result.liquidityUsd >= freshLiquidityFloor &&
              Number(result.volume5mUsd || 0) >= freshVolume5mFloor &&
              result.buys5m + result.sells5m >= numEnv("WINNER_PATTERN_MIN_TXNS_5M", 4) &&
              result.buys5m > result.sells5m &&
              result.priceChange5m > 0 &&
              result.priceChange5m <= freshMaxMove5m
            : result.liquidityUsd >= numEnv("WINNER_PATTERN_MIN_LIQUIDITY_USD", 15000) &&
              Number(pair.volume?.h24 || 0) >= numEnv("WINNER_PATTERN_MIN_VOLUME_24H_USD", 25000) &&
              result.buys5m + result.sells5m >= numEnv("WINNER_PATTERN_MIN_TXNS_5M", 4) &&
              result.buys5m > result.sells5m &&
              result.priceChange5m > 0 &&
              result.priceChange5m <= numEnv("WINNER_PATTERN_MAX_PRICE_CHANGE_5M_PCT", 20));
        const entryAllowed =
          result.approved === true &&
          Array.isArray(result.reasons) && result.reasons.length === 0 &&
          winnerPatternCompatible === true &&
          Number(result.entryScore || 0) >= 2 &&
          Number(result.ageMinutes) >= 0 &&
          Number(result.ageMinutes) <= 90 * 24 * 60 &&
          (freshProject
            ? Number(result.liquidityUsd || 0) >= freshLiquidityFloor &&
              Number(result.volume5mUsd || 0) >= freshVolume5mFloor
            : Number(result.liquidityUsd || 0) >= numEnv("WINNER_PATTERN_MIN_LIQUIDITY_USD", 15000) &&
              Number(result.volume24hUsd || 0) >= numEnv("WINNER_PATTERN_MIN_VOLUME_24H_USD", 25000)) &&
          Number(result.buys5m || 0) + Number(result.sells5m || 0) >= 4 &&
          Number(result.buys5m || 0) > Number(result.sells5m || 0) &&
          Number(result.priceChange5m || 0) > 0 &&
          Number(result.priceChange5m || 0) <= freshMaxMove5m;
        const totalVariationPct = Number(result.priceChange1h || 0);
        const isExtremePump = totalVariationPct >= 1000;
        const isMicroLiquidity = Number(result.liquidityUsd || 0) < 1500 || Number(result.volume24hUsd || 0) < 5000;
        const strategySegment = isExtremePump && isMicroLiquidity
          ? "PUMP_EXTREMO_BAIXA_LIQUIDEZ"
          : entryAllowed
            ? "MOMENTUM_COM_LIQUIDEZ"
            : result.isFreshPair
              ? "LANCAMENTO_EM_OBSERVACAO"
              : "MOMENTUM_NAO_CONFIRMADO";
        const entryBlockReasons = [...result.reasons];
        if (!winnerPatternCompatible && !entryBlockReasons.some(reason => /padrão vencedor/i.test(reason))) {
          entryBlockReasons.push("Critérios combinados de liquidez, volume, compras e momentum não atendidos");
        }
        if (Number(result.entryScore || 0) < 2 && !entryBlockReasons.some(reason => /score|qualidade de entrada/i.test(reason))) {
          entryBlockReasons.push(`Score ${result.entryScore}/7; mínimo 2/7`);
        }
        const candidate = {
          id: pairKey, chainId, pairAddress: pair.pairAddress,
          tokenAddress: result.token?.address || "",
          tokenName: result.token?.name || "Desconhecido",
          tokenSymbol: result.token?.symbol || "?",
          url: pair.url || "", priceUsd: result.priceUsd,
          simulationEntryUsd: Number(candidatesById.get(pairKey)?.simulationEntryUsd || 10),
          simulationEntryPriceUsd: Number(candidatesById.get(pairKey)?.simulationEntryPriceUsd || result.priceUsd),
          simulationStartedAt: candidatesById.get(pairKey)?.simulationStartedAt || new Date(now).toISOString(),
          officialWebsite: Array.isArray(pair.info?.websites) ? (pair.info.websites.find(site => /^https?:\/\//i.test(String(site?.url || "")))?.url || "") : "",
          discoverySource: pair.discoverySource || "DexScreener",
          liquidityUsd: result.liquidityUsd, ageMinutes: result.ageMinutes, dexId: pair.dexId || "",
          volume24hUsd: Number(pair.volume?.h24 || 0), txns1h: result.txns1h, buys1h: result.buys1h, sells1h: result.sells1h, isFreshPair: result.isFreshPair, strategy: result.strategy,
          buys5m: result.buys5m, sells5m: result.sells5m, volume5mUsd: result.volume5mUsd,
          priceChange5m: result.priceChange5m, priceChange15m: result.priceChange15m, priceChange1h: result.priceChange1h,
          buySellRatio: result.buySellRatio, buySellRatio5m: result.buySellRatio5m, entryScore: result.entryScore, entryScorePct: result.entryScorePct,
          strategySegment,
          winnerPatternCompatible, approved: entryAllowed,
          reasons: entryAllowed ? [] : entryBlockReasons,
          status: entryAllowed ? (result.isFreshPair ? "MOEDA NOVA — SINAL CONFIRMADO" : "APROVADO — MOMENTUM CONFIRMADO") : "BLOQUEADO",
          detectedAt: candidatesById.get(pairKey)?.detectedAt || new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString()
        };
        const isNew = !seen.has(pairKey);
        if (isNew) {
          this.state.candidates.unshift(candidate);
          seen.add(pairKey);
          if (entryAllowed) this.addLog(`SINAL COMPATÍVEL (${candidate.chainId}): ${candidate.tokenSymbol} — aprovado pelo motor e pelo padrão vencedor; score ${candidate.entryScore}/7; m5 ${candidate.priceChange5m}%; m15 ${candidate.priceChange15m}%; h1 ${candidate.priceChange1h}%; compras/vendas m5 ${Number(candidate.buySellRatio5m || 0).toFixed(2)}x; liquidez US${candidate.liquidityUsd.toFixed(0)}.`, 'approved', { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId, pairAddress: candidate.pairAddress, entryScore: candidate.entryScore });
          else if (this.state.candidates.length < 20) this.addLog(`ENTRADA BLOQUEADA (${candidate.chainId}): ${candidate.tokenSymbol} — ${candidate.reasons.join('; ')}.`, 'blocked', { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId, pairAddress: candidate.pairAddress });
        } else {
          const existing = candidatesById.get(pairKey);
          if (existing) Object.assign(existing, candidate);
        }
        // Evaluate entry signals on every poll, not only the first time a pair is discovered.
        // A única chamada que pode abrir posição exige aprovação total e o padrão vencedor.
        if (this.state.running && entryAllowed === true && candidate.approved === true && candidate.winnerPatternCompatible === true && candidate.strategySegment === "MOMENTUM_COM_LIQUIDEZ" && Array.isArray(candidate.reasons) && candidate.reasons.length === 0) {
          this.addLog(`SINAL DE ENTRADA: ${candidate.tokenSymbol} passou nos filtros; tentando abrir posição simulada de US$10.`, "approved", { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId, pairAddress: candidate.pairAddress, entryScore: candidate.entryScore });
          try { this.openPaperPosition(candidate); }
          catch (error) { this.addLog(`FALHA AO ABRIR ${candidate.tokenSymbol}: ${error.message || error}`, "error", { tokenSymbol: candidate.tokenSymbol, chainId: candidate.chainId, pairAddress: candidate.pairAddress }); }
        }
      }
      this.state.seenPairAddresses = [...seen].slice(-5000);
      this.state.candidates = this.state.candidates.filter(candidate => Number(candidate.liquidityUsd || 0) >= 15000).slice(0, 500);
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
    // Trava final de segurança: nenhuma chamada pode abrir posição sem aprovação explícita do motor e do padrão vencedor.
    const candidateWebsite = String(candidate?.officialWebsite || "");
    const candidateLiquidity = Number(candidate?.liquidityUsd || 0);
    const candidateVolume24h = Number(candidate?.volume24hUsd || 0);
    const candidateBuys5m = Number(candidate?.buys5m || 0);
    const candidateSells5m = Number(candidate?.sells5m || 0);
    const candidateM5 = Number(candidate?.priceChange5m || 0);
    const strictWinnerGate =
      candidate?.approved === true &&
      candidate?.winnerPatternCompatible === true &&
      candidate?.strategySegment === "MOMENTUM_COM_LIQUIDEZ" &&
      Number(candidate?.entryScore || 0) >= 2 &&
      Array.isArray(candidate?.reasons) && candidate.reasons.length === 0 &&
      Number(candidate?.ageMinutes) >= 0 &&
      Number(candidate?.ageMinutes) <= 90 * 24 * 60 &&
      (candidate?.isFreshPair === true
        ? candidateLiquidity >= (String(candidate.chainId).toLowerCase() === "ethereum" ? numEnv("MIN_FRESH_LIQUIDITY_USD", 15000) : String(candidate.chainId).toLowerCase() === "bsc" ? numEnv("BSC_MIN_LIQUIDITY_USD", 15000) : numEnv("SOL_MIN_LIQUIDITY_USD", 15000)) &&
          Number(candidate.volume5mUsd || 0) >= numEnv("MIN_FRESH_VOLUME_5M_USD", 1000) &&
          candidateM5 <= (String(candidate.chainId).toLowerCase() === "ethereum" ? numEnv("MAX_FRESH_PRICE_CHANGE_5M_PCT", 8) : String(candidate.chainId).toLowerCase() === "bsc" ? numEnv("BSC_MAX_PRICE_CHANGE_5M_PCT", 8) : numEnv("SOL_MAX_PRICE_CHANGE_5M_PCT", 10))
        : candidateLiquidity >= numEnv("WINNER_PATTERN_MIN_LIQUIDITY_USD", 15000) &&
          candidateVolume24h >= numEnv("WINNER_PATTERN_MIN_VOLUME_24H_USD", 25000) &&
          candidateM5 <= numEnv("WINNER_PATTERN_MAX_PRICE_CHANGE_5M_PCT", 20)) &&
      candidateBuys5m + candidateSells5m >= numEnv("WINNER_PATTERN_MIN_TXNS_5M", 4) &&
      candidateBuys5m > candidateSells5m &&
      candidateM5 > 0;
    if (!strictWinnerGate) {
      const failed = [];
      if (candidate?.approved !== true) failed.push("motor não marcou como aprovado");
      if (candidate?.winnerPatternCompatible !== true) failed.push("padrão vencedor incompatível");
      if (candidate?.strategySegment !== "MOMENTUM_COM_LIQUIDEZ") failed.push("segmento de estratégia divergente");
      if (Number(candidate?.entryScore || 0) < 2) failed.push("score abaixo de 2");
      if (!Array.isArray(candidate?.reasons) || candidate.reasons.length) failed.push(...(Array.isArray(candidate?.reasons) ? candidate.reasons : ["motivos de bloqueio ausentes"]));
      if (!(Number(candidate?.ageMinutes) >= 0 && Number(candidate?.ageMinutes) <= 90 * 24 * 60)) failed.push("idade fora de 1 hora a 90 dias");
      if (candidateLiquidity < 15000) failed.push("liquidez abaixo de US$15.000");
      if (candidateVolume24h < 25000) failed.push("volume 24h abaixo de US$25.000");
      if (candidateBuys5m + candidateSells5m < 4) failed.push("menos de 4 transações em 5 min");
      if (candidateBuys5m <= candidateSells5m) failed.push("compras não superam vendas em 5 min");
      if (!(candidateM5 > 0)) failed.push("variação de 5 min não positiva");
      if (candidate?.isFreshPair === true && Number(candidate.volume5mUsd || 0) < 1000) failed.push("volume 5 min abaixo de US$1.000");
      this.addLog(`ENTRADA BLOQUEADA: ${candidate?.tokenSymbol || "projeto"} — ${[...new Set(failed)].join("; ") || "validação final reprovada"}.`, "blocked", {
        tokenSymbol: candidate?.tokenSymbol || "?",
        chainId: candidate?.chainId || "unknown",
        pairAddress: candidate?.pairAddress || "",
        liquidityUsd: candidateLiquidity,
        volume24hUsd: candidateVolume24h,
        volume5mUsd: Number(candidate?.volume5mUsd || 0),
        buys5m: candidateBuys5m,
        sells5m: candidateSells5m,
        priceChange5m: candidateM5,
        failedCriteria: [...new Set(failed)]
      });
      return;
    }
    this.state.experiment = { targetEntries: 60, entriesOpened: 0, completed: false, startedAt: null, ...(this.state.experiment || {}) };
    // Entradas simultâneas permitidas: cada sinal qualificado pode abrir uma posição independente.
    // Valor fixo de US$10 por entrada em todas as redes; não alterar posições já abertas.
    const totalEntries = Number(this.state.experiment.entriesOpened || 0);
    const chainId = String(candidate.chainId || "bsc").toLowerCase();
    const networkSettings = this.state.settings?.[chainId] || defaultSettings()[chainId] || defaultSettings().bsc;
    const open = this.state.positions.filter(p => p.status === "OPEN");
    this.state.networkBalances = this.state.networkBalances || chainBalances(Number(process.env.PAPER_BALANCE_USD || 100));
    // Saldo virtual ilimitado para testes: cada ordem qualificada usa US$10.
    // Mantemos o campo de saldo para compatibilidade com a interface, mas ele não bloqueia entradas simuladas.
    const availableBalance = Number.POSITIVE_INFINITY;
    const notional = 10;
    // Impede duplicar a mesma moeda/rede enquanto sua posição continua aberta.
    if (open.some(p => String(p.chainId || "bsc").toLowerCase() === chainId && String(p.pairAddress || "").toLowerCase() === String(candidate.pairAddress || "").toLowerCase())) { this.addLog(`ENTRADA IGNORADA: ${candidate.tokenSymbol} já tem uma posição aberta neste par/rede.`, "blocked", { tokenSymbol: candidate.tokenSymbol, chainId, pairAddress: candidate.pairAddress }); return; }
    if (!(candidate.priceUsd > 0)) { this.addLog(`ENTRADA NÃO EXECUTADA: ${candidate.tokenSymbol} — preço atual inválido ou ausente.`, "blocked", { tokenSymbol: candidate.tokenSymbol, chainId, priceUsd: candidate.priceUsd }); return; }
    const position = {
      id: candidate.id, chainId: candidate.chainId || "bsc", pairAddress: candidate.pairAddress, tokenAddress: candidate.tokenAddress,
      tokenName: candidate.tokenName, tokenSymbol: candidate.tokenSymbol, url: candidate.url,
      notionalUsd: notional, entryPriceUsd: candidate.priceUsd, lastPriceUsd: candidate.priceUsd,
      estimatedNetPct: -numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5),
      status: "OPEN", openedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      takeProfitPriceUsd: candidate.priceUsd * (1 + (Number(networkSettings.takeProfitNetPct ?? 4) + numEnv("ESTIMATED_ROUNDTRIP_COST_PCT", 1.5)) / 100),
      takeProfitNetPctAtEntry: Number(networkSettings.takeProfitNetPct ?? 4),
      experimentEntryNumber: totalEntries + 1,
      strategyApprovedAtEntry: true,
      officialWebsite: String(candidate.officialWebsite || ""),
      entryFeatures: {
        officialWebsite: String(candidate.officialWebsite || ""),
        liquidityUsd: Number(candidate.liquidityUsd || 0),
        ageMinutes: candidate.ageMinutes,
        volume24hUsd: Number(candidate.volume24hUsd || 0),
        tokenSymbol: candidate.tokenSymbol,
        pairAddress: candidate.pairAddress,
        dexId: candidate.dexId || null,
        priceUsd: Number(candidate.priceUsd || 0),
        entryScore: Number(candidate.entryScore || 0),
        entryScorePct: Number(candidate.entryScorePct || 0),
        isFreshPair: Boolean(candidate.isFreshPair),
        strategy: candidate.strategy || null,
        priceChange5m: Number(candidate.priceChange5m || 0),
        priceChange15m: Number(candidate.priceChange15m || 0),
        priceChange1h: Number(candidate.priceChange1h || 0),
        buySellRatio: Number(candidate.buySellRatio || 0),
        buySellRatio5m: Number(candidate.buySellRatio5m || 0),
        buys5m: Number(candidate.buys5m || 0),
        sells5m: Number(candidate.sells5m || 0),
        volume5mUsd: Number(candidate.volume5mUsd || 0)
      }
    };
    // Saldo ilimitado em modo de teste: não debitar o saldo virtual por entrada.
    this.state.experiment.entriesOpened = totalEntries + 1;
    this.state.experiment.startedAt = this.state.experiment.startedAt || new Date().toISOString();
    this.state.positions.unshift(position);
    this.addLog(`ENTRADA SIMULADA: ${candidate.tokenSymbol} a ${candidate.priceUsd}; ordem virtual US${notional.toFixed(2)}${chainId === "solana" ? " (99% do saldo livre Solana)" : (hasProfitableTrade ? " (99% do saldo disponível após lucro anterior)" : " (valor base configurado)")}.`, 'entry', { tokenSymbol: candidate.tokenSymbol, chainId, pct: position.estimatedNetPct, notionalUsd: notional, compounding: hasProfitableTrade || chainId === "solana" });
  }
  async markToMarket() {
    for (const position of this.state.positions.filter(p => p.status === "OPEN")) {
      const chainId = String(position.chainId || "bsc").toLowerCase();
      // Migração de segurança: posições simuladas antigas sem prova de compatibilidade não podem continuar como entradas válidas.
      const f = position.entryFeatures || {};
      const isFreshEntry = f.isFreshPair === true;
      const freshLiquidityFloor = chainId === "ethereum" ? numEnv("MIN_FRESH_LIQUIDITY_USD", 15000)
        : chainId === "bsc" ? numEnv("BSC_MIN_LIQUIDITY_USD", 15000)
        : numEnv("SOL_MIN_LIQUIDITY_USD", 15000);
      const freshMaxMove5m = chainId === "ethereum" ? numEnv("MAX_FRESH_PRICE_CHANGE_5M_PCT", 8)
        : chainId === "bsc" ? numEnv("BSC_MAX_PRICE_CHANGE_5M_PCT", 8)
        : numEnv("SOL_MAX_PRICE_CHANGE_5M_PCT", 10);
      const legacyEntryCompatible =
        /^https?:\/\//i.test(String(position.officialWebsite || f.officialWebsite || "")) &&
        (isFreshEntry
          ? Number(f.liquidityUsd || 0) >= freshLiquidityFloor &&
            Number(f.volume5mUsd || 0) >= numEnv("MIN_FRESH_VOLUME_5M_USD", 1000) &&
            Number(f.buys5m || 0) + Number(f.sells5m || 0) >= numEnv("WINNER_PATTERN_MIN_TXNS_5M", 4) &&
            Number(f.buys5m || 0) > Number(f.sells5m || 0) &&
            Number(f.priceChange5m || 0) > 0 &&
            Number(f.priceChange5m || 0) <= freshMaxMove5m
          : Number(f.liquidityUsd || 0) >= numEnv("WINNER_PATTERN_MIN_LIQUIDITY_USD", 15000) &&
            Number(f.volume24hUsd || 0) >= numEnv("WINNER_PATTERN_MIN_VOLUME_24H_USD", 25000) &&
            Number(f.buys5m || 0) + Number(f.sells5m || 0) >= numEnv("WINNER_PATTERN_MIN_TXNS_5M", 4) &&
            Number(f.buys5m || 0) > Number(f.sells5m || 0) &&
            Number(f.priceChange5m || 0) > 0 &&
            Number(f.priceChange5m || 0) <= numEnv("WINNER_PATTERN_MAX_PRICE_CHANGE_5M_PCT", 20));
      // A estratégia é validada no momento da entrada. Não encerrar uma posição aberta
      // só porque o momentum mudou depois da compra; a saída é controlada pelo trailing de lucro.
      // Nenhuma rede usa stop-loss nem encerramento por tempo: posição virtual fica aberta até a meta de lucro.
      const expired = false;
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
              // Trailing de lucro em degraus de 10 pontos percentuais:
              // ao atingir +10%, protege +10%; ao atingir +20%, protege +20%, etc.
              const currentNetPct = Number(position.estimatedNetPct);
              // Trailing por degraus de 10 pontos percentuais, sem stop-loss de prejuízo.
              // Ao tocar +10%, protege +10%; ao tocar +20%, mantém +10%;
              // ao tocar +30%, protege +20%, e assim sucessivamente.
              const previousPeak = Number(position.maxNetProfitPct ?? -Infinity);
              position.maxNetProfitPct = Math.max(previousPeak, currentNetPct);
              if (position.maxNetProfitPct >= 10) {
                position.protectedProfitPct = Math.max(
                  10,
                  Math.floor((position.maxNetProfitPct - 0.000001) / 10) * 10
                );
                position.trailingSellArmed = true;
              } else {
                position.protectedProfitPct = 0;
                position.trailingSellArmed = false;
              }
              position.updatedAt = new Date().toISOString();
              priceUpdated = true;
              const settings = this.state.settings?.[chainId] || defaultSettings()[chainId];
              const target = Number(settings.takeProfitNetPct ?? 4);
              position.takeProfitPriceUsd = position.entryPriceUsd * (1 + (target + costPct) / 100);
              // Alvo extraordinário: encerrar a posição simulada quando seu valor total estimado chegar a R$ 100 mil.
              const usdBrlRate = Math.max(0.01, numEnv("USD_BRL_RATE", 5.10));
              const exitTargetBrl = Math.max(1000, numEnv("PAPER_EXIT_TARGET_BRL", 100000));
              const positionValueUsd = Number(position.notionalUsd || 0) * (price / Math.max(Number(position.entryPriceUsd || 0), 1e-18));
              const positionValueBrl = positionValueUsd * usdBrlRate;
              position.currentValueUsd = Number(positionValueUsd.toFixed(6));
              position.currentValueBrl = Number(positionValueBrl.toFixed(2));
              position.exitTargetBrl = exitTargetBrl;
              if (positionValueBrl >= exitTargetBrl) {
                this.closePosition(position, price, "ALVO_VALOR_R$100_MIL");
                this.addLog(`ALVO DE SAÍDA ATINGIDO: ${position.tokenSymbol}; valor estimado R${positionValueBrl.toFixed(2)}, alvo R${exitTargetBrl.toFixed(2)}, câmbio de referência R${usdBrlRate.toFixed(2)}/US$.`, "profit", {tokenSymbol: position.tokenSymbol, chainId, positionValueBrl, exitTargetBrl, usdBrlRate});
                continue;
              }
              // Não vender automaticamente num alvo fixo: deixar o lucro correr.
              // Quando o preço recua abaixo do último degrau protegido, executar venda simulada.
              if (position.trailingSellArmed && currentNetPct <= Number(position.protectedProfitPct || 10)) {
                const protectedPct = Number(position.protectedProfitPct || 10);
                this.closePosition(position, price, "TRAILING_LUCRO_" + protectedPct + "PCT");
                this.addLog(`VENDA TRAILING SIMULADA: ${position.tokenSymbol}; pico líquido ${Number(position.maxNetProfitPct || 0).toFixed(2)}%; degrau protegido +${protectedPct}%; pico +${Number(position.maxNetProfitPct || 0).toFixed(2)}%; saída ao recuar para ${currentNetPct.toFixed(2)}%.`, "profit", {
                  tokenSymbol: position.tokenSymbol, chainId, protectedProfitPct: protectedPct,
                  maxNetProfitPct: Number(position.maxNetProfitPct || 0), exitNetProfitPct: currentNetPct
                });
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
  manualStrategyEntry(candidateId) {
    const candidate = this.state.candidates.find(c => String(c.id) === String(candidateId));
    if (!candidate) throw new Error("Projeto não encontrado no monitor.");
    const chainId = String(candidate.chainId || "bsc").toLowerCase();
    const alreadyOpen = this.state.positions.some(p => p.status === "OPEN" && String(p.chainId || "bsc").toLowerCase() === chainId && String(p.pairAddress || "").toLowerCase() === String(candidate.pairAddress || "").toLowerCase());
    if (alreadyOpen) throw new Error("Este projeto já tem uma posição aberta.");
    if (candidate.approved !== true || candidate.winnerPatternCompatible !== true || candidate.strategySegment !== "MOMENTUM_COM_LIQUIDEZ" || !Array.isArray(candidate.reasons) || candidate.reasons.length !== 0) {
      this.addLog("COMPRA MANUAL BLOQUEADA: " + candidate.tokenSymbol + " não está compatível com a estratégia aprovada.", "blocked", {tokenSymbol:candidate.tokenSymbol,chainId,pairAddress:candidate.pairAddress});
      throw new Error("Fora do padrão. A compra manual respeita a estratégia e foi bloqueada.");
    }
    const before = this.state.positions.filter(p => p.status === "OPEN").length;
    this.openPaperPosition(candidate);
    const position = this.state.positions.find(p => p.status === "OPEN" && String(p.chainId || "bsc").toLowerCase() === chainId && String(p.pairAddress || "").toLowerCase() === String(candidate.pairAddress || "").toLowerCase());
    if (!position || this.state.positions.filter(p => p.status === "OPEN").length <= before - 1) throw new Error("Entrada não executada: limite de posições, saldo ou outra trava do motor.");
    this.addLog("COMPRA MANUAL SIMULADA AUTORIZADA PELA ESTRATÉGIA: " + candidate.tokenSymbol + ".", "manual-entry", {tokenSymbol:candidate.tokenSymbol,chainId,pairAddress:candidate.pairAddress});
    return {ok:true,position};
  }
  manualSell(positionId) {
    const position = this.state.positions.find(p => String(p.id) === String(positionId) && p.status === "OPEN");
    if (!position) throw new Error("A posição não está aberta ou não foi encontrada.");
    const price = Number(position.lastPriceUsd || position.entryPriceUsd || 0);
    if (!(price > 0)) throw new Error("Preço atual indisponível; venda manual não executada.");
    this.closePosition(position, price, "VENDA_MANUAL");
    this.addLog(`VENDA MANUAL EXECUTADA: ${position.tokenSymbol} ao preço disponível na simulação.`, "manual-sell", {
      tokenSymbol: position.tokenSymbol, chainId: position.chainId, pairAddress: position.pairAddress,
      pnlUsd: Number(position.pnlUsd || 0), closeReason: "VENDA_MANUAL"
    });
    return { ok: true, trade: this.state.trades[0] };
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
    this.addLog("NOVO EXPERIMENTO REINICIADO: histórico simulado zerado; US$100 virtuais por rede; stop-loss desativado; após a primeira saída lucrativa em cada rede, próximas entradas usam 99% do saldo virtual disponível dessa rede.", "experiment");
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
      if (!Number.isFinite(entryUsd) || entryUsd < 1 || entryUsd > 1000000) throw new Error(`Entrada de ${chain} deve ficar entre US$1 e US$1.000.000.`);
      if (!Number.isFinite(takeProfitNetPct) || takeProfitNetPct < 0.1 || takeProfitNetPct > 500) throw new Error(`Meta de ganho de ${chain} deve ficar entre 0,1% e 500%.`);
      next[chain] = { entryUsd: 10, takeProfitNetPct };
    }
    this.state.settings = next;
    this.state.settingsUpdatedAt = new Date().toISOString();
    for (const position of this.state.positions.filter(p => p.status === "OPEN")) {
      const chain = String(position.chainId || "bsc").toLowerCase();
      const setting = next[chain] || defaultSettings()[chain];
      position.stopLossEnabledAtEntry = false;
      position.takeProfitNetPctAtEntry = Number(setting.takeProfitNetPct ?? 4);
    }
    const stopSummary = "Stop-loss removido; posições não são encerradas por limite de perda.";
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
      engineBuild: "winner-pattern-runtime-fix-v4-2026-10-11",
      targetNetPct: numEnv("TAKE_PROFIT_NET_PCT", 4), mode: "PAPER" };
  }
}
module.exports = { PaperEngine, evaluatePair, tokenSide };
