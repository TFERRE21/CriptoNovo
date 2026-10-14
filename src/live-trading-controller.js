"use strict";

// Live Solana execution controller. Starts DISABLED and never reads secrets from the browser.
// Initial rollout is deliberately capped at 0.001 SOL per buy. It allows one open position.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Keypair, VersionedTransaction, Connection, PublicKey } = require("@solana/web3.js");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const STATE_PATH = path.join(__dirname, "..", "data", "live-positions.json");
const BUY_LAMPORTS = 1_000_000;
const RESERVE_LAMPORTS = 1_000_000;
const POLL_MS = Math.max(15000, Number(process.env.LIVE_POLL_INTERVAL_MS || 30000));
const TRAIL_STEP_PCT = 2;

function readSigner() {
  const raw = String(process.env.SOLANA_TRADING_SECRET_KEY || "").trim();
  if (!raw) throw new Error("SOLANA_TRADING_SECRET_KEY ausente.");
  let bytes;
  if (raw.startsWith("[")) bytes = JSON.parse(raw);
  else {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const ch of raw) { const i = alphabet.indexOf(ch); if (i < 0) throw new Error("Chave Base58 inválida."); n = n * 58n + BigInt(i); }
    let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
    bytes = Array.from(Buffer.from(hex, "hex"));
    for (const ch of raw) { if (ch !== "1") break; bytes.unshift(0); }
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error("A chave Solana deve decodificar para 64 bytes.");
  const signer = Keypair.fromSecretKey(Uint8Array.from(bytes));
  if (signer.publicKey.toBase58() !== String(process.env.SOLANA_TRADING_WALLET_ADDRESS || "").trim())
    throw new Error("A chave privada não corresponde ao endereço público configurado.");
  return signer;
}
async function getSolUsdPrice() {
  const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + SOL_MINT, { signal: AbortSignal.timeout(8000), headers: { accept:"application/json" } });
  if (!r.ok) throw new Error("Cotação SOL/USD indisponível para calcular custo real.");
  const d = await r.json();
  const pairs = (d.pairs || []).filter(p => p.chainId === "solana" && String(p.baseToken?.address || "") === SOL_MINT && Number(p.priceUsd) > 0);
  pairs.sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
  if (!pairs[0]) throw new Error("Cotação SOL/USD indisponível; custo real não calculado.");
  return Number(pairs[0].priceUsd);
}
async function getConfirmedBuyCost(signature, tokenAddress) {
  if (!signature) throw new Error("Assinatura ausente; custo real não confirmado.");
  const signer = readSigner();
  const connection = new Connection(String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"), "confirmed");
  let tx = null;
  for (let i=0; i<5 && !tx; i++) {
    tx = await connection.getParsedTransaction(signature, { commitment:"confirmed", maxSupportedTransactionVersion:0 }).catch(()=>null);
    if (!tx) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  if (!tx?.meta || tx.meta.err) throw new Error("Compra ainda não confirmada; executor não abrirá outra posição.");
  const owner = signer.publicKey.toBase58();
  const keys = tx.transaction.message.accountKeys || [];
  const index = keys.findIndex(k => (k.pubkey?.toBase58?.() || String(k.pubkey || k)) === owner);
  if (index < 0) throw new Error("Carteira não encontrada na transação confirmada.");
  const solSpent = Math.max(0, Number(tx.meta.preBalances[index] || 0) - Number(tx.meta.postBalances[index] || 0)) / 1e9;
  const pre = (tx.meta.preTokenBalances || []).filter(x => x.owner === owner && x.mint === tokenAddress).reduce((n,x)=>n+Number(x.uiTokenAmount?.uiAmountString || 0),0);
  const post = (tx.meta.postTokenBalances || []).filter(x => x.owner === owner && x.mint === tokenAddress).reduce((n,x)=>n+Number(x.uiTokenAmount?.uiAmountString || 0),0);
  const tokenReceived = Math.max(0, post-pre);
  if (!(solSpent > 0) || !(tokenReceived > 0)) throw new Error("Não foi possível apurar SOL gasto e tokens recebidos na compra.");
  const solUsd = await getSolUsdPrice();
  return { solSpent, solUsd, solCostUsd:solSpent*solUsd, tokenReceived, entryPriceUsd:(solSpent*solUsd)/tokenReceived, feeLamports:Number(tx.meta.fee || 0) };
}
async function getOwnedTokenAmountRaw(tokenAddress) {
  const signer = readSigner();
  const connection = new Connection(String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"), "confirmed");
  const accounts = await connection.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(tokenAddress) }, "confirmed");
  let total = 0n;
  for (const account of accounts.value || []) {
    const raw = account.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof raw === "string" && /^[0-9]+$/.test(raw)) total += BigInt(raw);
  }
  return total.toString();
}
async function getSolanaTokenPrice(tokenAddress, preferredPairAddress) {
  const urls = preferredPairAddress
    ? ["https://api.dexscreener.com/latest/dex/pairs/solana/" + encodeURIComponent(preferredPairAddress), "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(tokenAddress)]
    : ["https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(tokenAddress)];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const data = await response.json().catch(() => ({}));
      const pairs = (data.pairs || []).filter(x => x.chainId === "solana" && String(x.baseToken?.address || "").toLowerCase() === String(tokenAddress).toLowerCase() && Number(x.priceUsd) > 0);
      pairs.sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      if (pairs[0]) return { priceUsd:Number(pairs[0].priceUsd), pairAddress:pairs[0].pairAddress || preferredPairAddress || null, liquidityUsd:Number(pairs[0].liquidity?.usd || 0), source:"DexScreener" };
    } catch (_) {}
  }
  return null;
}
function enabledByEnv() { return String(process.env.LIVE_TRADING_ENABLED || "").toLowerCase() === "true"; }
function apiKey() { return String(process.env.JUPITER_API_KEY || "").trim(); }
async function readState() {
  try { return JSON.parse(await fs.readFile(STATE_PATH, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; return { enabled: false, position: null, lastAction: null, lastError: null, updatedAt: null }; }
}
async function writeState(s) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  await fs.rename(tmp, STATE_PATH);
}
class LiveTradingController {
  constructor(engine) { this.engine = engine; this.timer = null; this.busy = false; this.state = null; }
  async init() { this.state = await readState(); this.state.enabled = false; await writeState(this.state); }
  status() {
    const p = this.state?.position || null;
    const lastAction = this.state?.lastAction || null;
    return {
      enabled: Boolean(this.state?.enabled && enabledByEnv()), envEnabled: enabledByEnv(),
      openPosition: p ? { mode:"REAL", tokenSymbol:p.tokenSymbol, tokenAddress:p.tokenAddress, pairAddress:p.pairAddress || null, openedAt:p.openedAt, entryPriceUsd:p.entryPriceUsd, lastPriceUsd:p.lastPriceUsd || null, currentPct:p.lastPct ?? null, peakPct:p.peakPct, trailFloorPct:p.trailFloorPct, tokenAmountRaw:p.tokenAmountRaw, signature:p.signature || null, lastCheckedAt:p.lastCheckedAt || null, priceSource:p.priceSource || null, priceLiquidityUsd:p.priceLiquidityUsd || 0 } : null,
      lastAction, lastError: this.state?.lastError || null, pollMs: POLL_MS,
      buyCapSol: BUY_LAMPORTS / 1e9, trailingStepPct: TRAIL_STEP_PCT,
      note: "Estado e histórico REAL separados da simulação; execução em mainnet pode perder capital."
    };
  }
  async enable() {
    if (!enabledByEnv()) throw new Error("Defina LIVE_TRADING_ENABLED=true no VPS para autorizar operação real.");
    if (!apiKey()) throw new Error("JUPITER_API_KEY ausente.");
    const signer = readSigner();
    const connection = new Connection(String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"), "confirmed");
    const lamports = await connection.getBalance(signer.publicKey, "confirmed");
    if (lamports < BUY_LAMPORTS + RESERVE_LAMPORTS) throw new Error("Saldo SOL insuficiente para a ordem inicial e reserva de taxas.");
    this.state.enabled = true; this.state.lastError = null; await writeState(this.state);
    if (!this.timer) this.timer = setInterval(() => this.tick().catch(e => this.fail(e)), POLL_MS);
    await this.tick(); return this.status();
  }
  async disable() {
    this.state.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null; await writeState(this.state);
    return this.status();
  }
  async sellNow() {
    if (!this.state?.position) throw new Error("Não há posição REAL registrada para vender.");
    if (this.busy) throw new Error("Há uma operação REAL em andamento; tente novamente em alguns segundos.");
    this.busy = true;
    try {
      const p = this.state.position;
      const actualAmountRaw = await getOwnedTokenAmountRaw(p.tokenAddress);
      if (!/^[1-9][0-9]*$/.test(actualAmountRaw)) throw new Error("Saldo REAL do token não encontrado nesta carteira. Posição mantida; confira se o token está na carteira configurada.");
      const { result } = await this.swap(p.tokenAddress, SOL_MINT, actualAmountRaw);
      this.state.lastAction = { side:"SELL_MANUAL", tokenSymbol:p.tokenSymbol, at:new Date().toISOString(), signature:result.signature || result.txid || null };
      this.state.position = null; this.state.lastError = null;
      await writeState(this.state);
      return this.status();
    } finally { this.busy = false; }
  }

  async fail(error) { this.state.lastError = String(error?.message || error).slice(0, 500); await writeState(this.state).catch(() => {}); }
  async swap(inputMint, outputMint, amount) {
    const signer = readSigner();
    const url = new URL("https://api.jup.ag/swap/v2/order");
    for (const [k,v] of Object.entries({inputMint, outputMint, amount:String(amount), taker:signer.publicKey.toBase58()})) url.searchParams.set(k,v);
    const r = await fetch(url, { headers: { "x-api-key": apiKey(), accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    const order = await r.json();
    if (!r.ok || !order.transaction || !order.requestId) throw new Error(order.error || order.errorMessage || "Jupiter não gerou a ordem.");
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64")); tx.sign([signer]);
    const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
    const er = await fetch("https://api.jup.ag/swap/v2/execute", { method:"POST", headers:{"content-type":"application/json","x-api-key":apiKey(),accept:"application/json"}, body:JSON.stringify({signedTransaction,requestId:order.requestId}), signal:AbortSignal.timeout(20000) });
    const result = await er.json();
    if (!er.ok || result.error || result.status === "Failed" || (result.status && result.status !== "Success")) throw new Error(result.error || result.message || result.code || "Jupiter não confirmou a transação.");
    return { order, result };
  }
  async tick() {
    if (this.busy || !this.state?.enabled || !enabledByEnv()) return;
    this.busy = true;
    try {
      if (this.state.position) {
        const p = this.state.position;
        const quote = await getSolanaTokenPrice(p.tokenAddress, p.pairAddress);
        const priceUsd = Number(quote?.priceUsd || 0);
        if (quote?.pairAddress) p.pairAddress = quote.pairAddress;
        p.priceSource = quote?.source || null;
        p.priceLiquidityUsd = quote?.liquidityUsd || 0;
        if (!(priceUsd > 0) || !(Number(p.entryPriceUsd) > 0)) {
          this.state.lastError = "Preço REAL indisponível para " + p.tokenSymbol + "; posição mantida aberta, sem venda presumida.";
          await writeState(this.state); return;
        }
        const pct = (priceUsd / Number(p.entryPriceUsd) - 1) * 100;
        p.peakPct = Math.max(Number(p.peakPct || 0), pct);
        p.trailFloorPct = Math.max(Number(p.trailFloorPct || 0), Math.floor(Math.max(0,p.peakPct) / TRAIL_STEP_PCT) * TRAIL_STEP_PCT - TRAIL_STEP_PCT);
        p.lastPct = pct; p.lastPriceUsd = priceUsd; p.lastCheckedAt = new Date().toISOString();
        await writeState(this.state);
        if (p.peakPct >= TRAIL_STEP_PCT && pct <= p.trailFloorPct) {
          const actualAmountRaw = await getOwnedTokenAmountRaw(p.tokenAddress);
          if (!/^[1-9][0-9]*$/.test(actualAmountRaw)) throw new Error("Saldo REAL do token não encontrado; venda automática não enviada e posição mantida.");
          const { result } = await this.swap(p.tokenAddress, SOL_MINT, actualAmountRaw);
          this.state.lastAction = { side:"SELL", tokenSymbol:p.tokenSymbol, pct, peakPct:p.peakPct, trailFloorPct:p.trailFloorPct, at:new Date().toISOString(), signature:result.signature || result.txid || null };
          this.state.position = null; this.state.lastError = null; await writeState(this.state);
        }
        return;
      }
      const s = this.engine.snapshot();
      const c = (s.candidates || []).find(x => x.chainId === "solana" && x.approved === true && x.winnerPatternCompatible === true && x.tokenAddress && Number(x.priceUsd) > 0);
      if (!c) return;
      const signer = readSigner();
      const connection = new Connection(String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"), "confirmed");
      const balance = await connection.getBalance(signer.publicKey, "confirmed");
      if (balance < BUY_LAMPORTS + RESERVE_LAMPORTS) throw new Error("Saldo SOL abaixo do valor da ordem mais reserva de taxas.");
      const { order, result } = await this.swap(SOL_MINT, c.tokenAddress, BUY_LAMPORTS);
      const signature = result.signature || result.txid || null;
      const raw = String(order.outputAmount || order.outAmount || "");
      if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("Compra executada, mas quantidade cotada ausente; executor interrompido para evitar duplicidade.");
      const actual = await getConfirmedBuyCost(signature, c.tokenAddress);
      const actualRaw = await getOwnedTokenAmountRaw(c.tokenAddress);
      this.state.position = { tokenAddress:c.tokenAddress, tokenSymbol:c.tokenSymbol || "?", pairAddress:c.pairAddress, entryPriceUsd:actual.entryPriceUsd, lastPriceUsd:null, tokenAmountRaw:actualRaw, actualTokenAmount:actual.tokenReceived, actualSolSpent:actual.solSpent, actualSolUsd:actual.solUsd, entryCostUsd:actual.solCostUsd, buyFeeLamports:actual.feeLamports, accountingSource:"confirmed_onchain_transaction", peakPct:0, trailFloorPct:0, openedAt:new Date().toISOString(), signature };
      this.state.lastAction = { side:"BUY", tokenSymbol:c.tokenSymbol, at:new Date().toISOString(), signature, actualSolSpent:actual.solSpent, entryCostUsd:actual.solCostUsd, buyFeeLamports:actual.feeLamports };
      this.state.lastError = null; await writeState(this.state);
    } finally { this.busy = false; }
  }
}
module.exports = { LiveTradingController };