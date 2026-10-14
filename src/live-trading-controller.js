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
      openPosition: p ? { mode:"REAL", tokenSymbol:p.tokenSymbol, tokenAddress:p.tokenAddress, pairAddress:p.pairAddress || null, openedAt:p.openedAt, entryPriceUsd:p.entryPriceUsd, lastPriceUsd:p.lastPriceUsd || null, currentPct:p.lastPct ?? null, peakPct:p.peakPct, trailFloorPct:p.trailFloorPct, tokenAmountRaw:p.tokenAmountRaw, signature:p.signature || null } : null,
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
    if (!er.ok || result.error || result.status === "Failed") throw new Error(result.error || result.message || "Jupiter não confirmou a transação.");
    return { order, result };
  }
  async tick() {
    if (this.busy || !this.state?.enabled || !enabledByEnv()) return;
    this.busy = true;
    try {
      if (this.state.position) {
        const p = this.state.position;
        let priceUsd = 0;
        const candidates = this.engine.snapshot().candidates || [];
        const candidate = candidates.find(x => String(x.tokenAddress).toLowerCase() === p.tokenAddress.toLowerCase() && x.chainId === "solana");
        if (Number(candidate?.priceUsd) > 0) priceUsd = Number(candidate.priceUsd);
        // Position monitoring must not depend on the token remaining in the ranking.
        if (!(priceUsd > 0)) {
          const url = p.pairAddress
            ? "https://api.dexscreener.com/latest/dex/pairs/solana/" + encodeURIComponent(p.pairAddress)
            : "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(p.tokenAddress);
          const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const data = await response.json().catch(() => ({}));
          const pairs = (data.pairs || []).filter(x => x.chainId === "solana" && String(x.baseToken?.address || x.quoteToken?.address || "").length > 0);
          const pair = pairs.find(x => String(x.baseToken?.address || "").toLowerCase() === p.tokenAddress.toLowerCase())
            || pairs.find(x => String(x.quoteToken?.address || "").toLowerCase() === p.tokenAddress.toLowerCase())
            || pairs[0];
          if (response.ok && Number(pair?.priceUsd) > 0) {
            priceUsd = Number(pair.priceUsd);
            p.pairAddress = pair.pairAddress || p.pairAddress;
          }
        }
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
          const { result } = await this.swap(p.tokenAddress, SOL_MINT, p.tokenAmountRaw);
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
      const raw = String(order.outputAmount || order.outAmount || "");
      if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("Compra enviada, mas Jupiter não retornou quantidade de token verificável; interrompido para evitar duplicar compra.");
      this.state.position = { tokenAddress:c.tokenAddress, tokenSymbol:c.tokenSymbol || "?", pairAddress:c.pairAddress, entryPriceUsd:Number(c.priceUsd), lastPriceUsd:Number(c.priceUsd), tokenAmountRaw:raw, peakPct:0, trailFloorPct:0, openedAt:new Date().toISOString(), signature:result.signature || result.txid || null };
      this.state.lastAction = { side:"BUY", tokenSymbol:c.tokenSymbol, at:new Date().toISOString(), signature:result.signature || result.txid || null };
      this.state.lastError = null; await writeState(this.state);
    } finally { this.busy = false; }
  }
}
module.exports = { LiveTradingController };