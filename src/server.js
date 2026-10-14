require("dotenv").config();
const express = require("express");
const path = require("node:path");
const { PaperEngine } = require("./engine");

const app = express();
const engine = new PaperEngine();
let startupError = null;
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: "PAPER", time: new Date().toISOString(), running: Boolean(engine.state?.running), startupError, lastError: engine.state?.lastError || null, lastPollAt: engine.state?.lastPollAt || null, candidates: engine.state?.candidates?.length || 0 }));
app.get("/api/state", (_req, res) => res.json({ ...engine.snapshot(), startupError }));
app.get("/api/walletconnect/config", (_req, res) => {
  // WalletConnect Project ID is a public client identifier, not a private key.
  const projectId = String(process.env.WALLETCONNECT_PROJECT_ID || "").trim();
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    configured: Boolean(projectId),
    projectId: projectId || null,
    network: "solana:mainnet",
    liveTradingEnabled: false
  });
});
app.get("/api/solana/wallet-status", async (_req, res) => {
  // Read-only wallet check: public address only; never accepts or stores private keys/seed phrases.
  const address = String(process.env.SOLANA_WALLET_ADDRESS || "").trim();
  const rpcUrl = String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
  const addressLooksValid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (!address) {
    return res.json({
      ok: true,
      configured: false,
      network: "solana-mainnet",
      message: "Configure SOLANA_WALLET_ADDRESS com o endereço público da Binance Web3 Wallet.",
      liveTradingEnabled: false
    });
  }
  if (!addressLooksValid) {
    return res.status(400).json({
      ok: false,
      configured: true,
      network: "solana-mainnet",
      message: "O endereço público Solana configurado parece inválido.",
      liveTradingEnabled: false
    });
  }
  try {
    const rpcResponse = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [address, { commitment: "confirmed" }]
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!rpcResponse.ok) throw new Error("O provedor RPC retornou HTTP " + rpcResponse.status);
    const payload = await rpcResponse.json();
    if (payload.error) throw new Error(payload.error.message || "Erro do provedor RPC");
    const lamports = Number(payload.result?.value);
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error("Resposta de saldo inválida");
    return res.json({
      ok: true,
      configured: true,
      network: "solana-mainnet",
      publicAddress: address,
      balanceSol: lamports / 1_000_000_000,
      commitment: "confirmed",
      readOnly: true,
      liveTradingEnabled: false
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      configured: true,
      network: "solana-mainnet",
      message: "Não foi possível consultar o saldo Solana.",
      detail: error.message || "Falha no RPC",
      liveTradingEnabled: false
    });
  }
});

const SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_BUY_LAMPORTS = 10000000; // 0.01 SOL; conservative initial cap
function jupiterKey() { return String(process.env.JUPITER_API_KEY || "").trim(); }
app.get("/api/jupiter/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, configured: Boolean(jupiterKey()), network: "solana-mainnet", maxBuyLamports: MAX_BUY_LAMPORTS, liveTradingEnabled: false, note: "Swaps require wallet signature; automatic trading remains disabled." });
});
app.post("/api/jupiter/order", async (req, res) => {
  try {
    if (!jupiterKey()) return res.status(503).json({ ok: false, error: "JUPITER_API_KEY não configurada no servidor." });
    const { inputMint, outputMint, amount, taker } = req.body || {};
    const rawAmount = String(amount || "");
    if (!/^[1-9][0-9]{0,18}$/.test(rawAmount)) return res.status(400).json({ ok: false, error: "Quantidade inválida." });
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(taker || ""))) return res.status(400).json({ ok: false, error: "Endereço público da carteira inválido." });
    if (inputMint !== SOL_MINT || outputMint === SOL_MINT || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(outputMint || ""))) return res.status(400).json({ ok: false, error: "Por segurança, a primeira etapa permite apenas comprar um token usando SOL." });
    if (BigInt(rawAmount) > BigInt(MAX_BUY_LAMPORTS)) return res.status(400).json({ ok: false, error: "Limite inicial: 0,01 SOL por ordem. Valor acima do limite bloqueado." });
    const url = new URL("https://api.jup.ag/swap/v2/order");
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", rawAmount);
    url.searchParams.set("taker", taker);
    const response = await fetch(url, { headers: { "x-api-key": jupiterKey(), "accept": "application/json" }, signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    if (!response.ok) return res.status(502).json({ ok: false, error: payload.error || payload.message || "Jupiter não conseguiu criar a cotação." });
    if (!payload.transaction || !payload.requestId) return res.status(502).json({ ok: false, error: "Jupiter não retornou uma transação assinável.", diagnostic: { httpStatus: response.status, responseFields: Object.keys(payload || {}), apiMessage: String(payload.error || payload.message || payload.code || "A resposta não contém transaction/requestId").slice(0, 240) } });
    return res.json({ ok: true, order: payload });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message || "Falha ao solicitar cotação à Jupiter." });
  }
});
app.post("/api/jupiter/execute", async (req, res) => {
  try {
    if (!jupiterKey()) return res.status(503).json({ ok: false, error: "JUPITER_API_KEY não configurada no servidor." });
    const { signedTransaction, requestId } = req.body || {};
    if (typeof signedTransaction !== "string" || signedTransaction.length < 100 || signedTransaction.length > 20000 || typeof requestId !== "string" || requestId.length < 8 || requestId.length > 200) {
      return res.status(400).json({ ok: false, error: "Transação assinada ou requestId inválido." });
    }
    const response = await fetch("https://api.jup.ag/swap/v2/execute", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": jupiterKey(), "accept": "application/json" },
      body: JSON.stringify({ signedTransaction, requestId }),
      signal: AbortSignal.timeout(20000)
    });
    const payload = await response.json();
    if (!response.ok) return res.status(502).json({ ok: false, error: payload.error || payload.message || "Jupiter recusou a execução." });
    return res.json({ ok: true, result: payload });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message || "Falha ao enviar transação assinada à Jupiter." });
  }
});

app.put("/api/settings", async (req, res) => {
  try { const settings = await engine.updateSettings(req.body); res.json({ ok: true, settings }); }
  catch (error) { res.status(400).json({ ok: false, error: error.message || "Configurações inválidas." }); }
});
app.post("/api/start", async (_req, res) => { await engine.start(); res.json({ ok: true, state: engine.snapshot() }); });
app.post("/api/stop", async (_req, res) => { await engine.stop(); res.json({ ok: true, state: engine.snapshot() }); });
app.post("/api/reset", async (_req, res) => { await engine.reset(); res.json({ ok: true, state: engine.snapshot() }); });
app.post("/api/candidates/:id/buy", async (req, res) => {
  try {
    const result = engine.manualStrategyEntry(req.params.id);
    res.json({ ...result, state: engine.snapshot() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Compra simulada bloqueada." });
  }
});
app.post("/api/positions/:id/sell", async (req, res) => {
  try {
    const result = engine.manualSell(req.params.id);
    res.json({ ...result, state: engine.snapshot() });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Não foi possível vender a posição." });
  }
});

const port = Number(process.env.PORT || 3000);
// Bind HTTP first so the hosting lifecycle sees a healthy process immediately.
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`CriptoNovo paper dashboard listening on :${port}`);
  engine.init().then(() => {
    startupError = null;
    console.log("SQLite persistent history initialized (with JSON compatibility mirror)");
    console.log("Continuous paper monitor initialized; live trading remains disabled.");
  }).catch(err => {
    startupError = err?.message || "Falha desconhecida ao inicializar o monitor";
    console.error("Failed to initialize monitor:", err);
  });
});
