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
