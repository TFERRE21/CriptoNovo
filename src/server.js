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
app.get("/api/state", (_req, res) => {
  if (!engine.state) return res.status(503).json({ ok: false, initializing: true, startupError, message: "O monitor ainda está inicializando; tente novamente em alguns segundos." });
  try { return res.json({ ...engine.snapshot(), startupError }); }
  catch (error) { console.error("Failed to create state snapshot:", error); return res.status(503).json({ ok: false, initializing: false, startupError: error.message || "Falha ao carregar estado" }); }
});
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

// Live trading readiness: VPS-only signer, disabled unless explicitly enabled.
// Never place seed phrases or private keys in source control. Configure a dedicated wallet
// secret in the VPS environment only after the executor has been validated.
function decodeBase58Secret(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Chave privada Base58 contém caractere inválido.");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros++;
  return Uint8Array.from([...Array(leadingZeros).fill(0), ...bytes]);
}
function parseSolanaSecret(value) {
  const secret = String(value || "").trim();
  if (!secret) throw new Error("SOLANA_TRADING_SECRET_KEY não configurada.");
  let bytes;
  if (secret.startsWith("[")) {
    try { bytes = JSON.parse(secret); }
    catch { throw new Error("A chave em array precisa ser JSON válido."); }
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255))
      throw new Error("O array JSON da chave precisa conter exatamente 64 bytes.");
  } else {
    bytes = Array.from(decodeBase58Secret(secret));
    if (bytes.length !== 64) throw new Error("A chave Base58 decodificada não contém 64 bytes; confira se copiou a chave privada Solana completa, não a frase de recuperação.");
  }
  return Uint8Array.from(bytes);
}
function liveTradingConfig() {
  const enabled = String(process.env.LIVE_TRADING_ENABLED || "").toLowerCase() === "true";
  const secret = String(process.env.SOLANA_TRADING_SECRET_KEY || "").trim();
  const expectedAddress = String(process.env.SOLANA_TRADING_WALLET_ADDRESS || "").trim();
  const jupiterConfigured = Boolean(String(process.env.JUPITER_API_KEY || "").trim());
  let signerAddress = null, signerValid = false, signerMatches = false, signerError = null;
  if (secret) {
    try {
      const { Keypair } = require("@solana/web3.js");
      const keypair = Keypair.fromSecretKey(parseSolanaSecret(secret));
      signerAddress = keypair.publicKey.toBase58();
      signerValid = true;
      signerMatches = Boolean(expectedAddress && signerAddress === expectedAddress);
    } catch (error) { signerError = error.message || "Chave de assinatura inválida."; }
  }
  return { enabled, signerConfigured: Boolean(secret), signerValid, signerMatches, signerAddress,
    expectedAddressConfigured: Boolean(expectedAddress), jupiterConfigured,
    ready: enabled && signerValid && signerMatches && jupiterConfigured,
    mode: "PAPER", signerError, liveTradingEnabled: false,
    note: "Diagnóstico somente leitura; o executor automático de compra/venda ainda não foi validado." };
}
app.get("/api/live/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...liveTradingConfig(), liveTradingEnabled: false });
});

// Read-only live-trading preflight: validates signer, Jupiter key and SOL balance without signing/sending a transaction.
// Dry-run: request a Jupiter order and locally sign it, but never submit it to the network.
app.post("/api/live/dry-run", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const expected = String(process.env.LIVE_TRADING_API_TOKEN || "");
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (expected.length < 32 || !got || got !== expected) return res.status(401).json({ ok: false, error: "Acesso não autorizado." });
    if (String(process.env.LIVE_TRADING_ENABLED || "").toLowerCase() === "true")
      return res.status(423).json({ ok: false, error: "Desative LIVE_TRADING_ENABLED antes do dry-run." });
    const cfg = liveTradingConfig();
    if (!cfg.signerValid || !cfg.signerMatches || !cfg.jupiterConfigured)
      return res.status(423).json({ ok: false, error: "Pré-requisitos da carteira/Jupiter não passaram." });
    const outputMint = String(req.body?.outputMint || "");
    const amount = String(req.body?.amount || "1000000");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(outputMint) || outputMint === SOL_MINT)
      return res.status(400).json({ ok: false, error: "Informe outputMint de um token Solana válido; SOL não pode ser o token de saída." });
    if (!/^[1-9][0-9]{0,18}$/.test(amount) || BigInt(amount) > 1000000n)
      return res.status(400).json({ ok: false, error: "Dry-run limitado a no máximo 0,001 SOL (1.000.000 lamports)." });
    const { Keypair, VersionedTransaction } = require("@solana/web3.js");
    const signer = Keypair.fromSecretKey(parseSolanaSecret(process.env.SOLANA_TRADING_SECRET_KEY));
    const url = new URL("https://api.jup.ag/swap/v2/order");
    url.searchParams.set("inputMint", SOL_MINT);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount);
    url.searchParams.set("taker", signer.publicKey.toBase58());
    const response = await fetch(url, { headers: { "x-api-key": jupiterKey(), "accept": "application/json" }, signal: AbortSignal.timeout(15000) });
    const order = await response.json();
    if (!response.ok || !order.transaction || !order.requestId)
      return res.status(502).json({ ok: false, error: order.error || order.errorMessage || order.message || "Jupiter não gerou uma ordem para o teste.", diagnostic: { httpStatus: response.status, errorCode: order.errorCode ?? null } });
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    tx.sign([signer]);
    const signed = Buffer.from(tx.serialize()).toString("base64");
    return res.json({
      ok: true, mode: "DRY_RUN", transactionSent: false, transactionSigned: true,
      walletAddress: signer.publicKey.toBase58(), inputMint: SOL_MINT, outputMint,
      amountLamports: amount, signedTransactionBytes: Buffer.from(signed, "base64").length,
      requestIdReceived: Boolean(order.requestId), router: order.router || null,
      note: "Transação assinada apenas em memória e descartada; não foi transmitida nem executada."
    });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message || "Falha no dry-run." });
  }
});

app.get("/api/live/preflight", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const cfg = liveTradingConfig();
  const checks = {
    signerValid: cfg.signerValid,
    signerMatches: cfg.signerMatches,
    jupiterConfigured: cfg.jupiterConfigured,
    apiTokenConfigured: String(process.env.LIVE_TRADING_API_TOKEN || "").length >= 32,
    liveTradingDisabled: String(process.env.LIVE_TRADING_ENABLED || "").toLowerCase() !== "true"
  };
  let balanceSol = null, rpcOk = false, rpcError = null;
  if (cfg.signerMatches) {
    try {
      const rpcUrl = String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [cfg.signerAddress, { commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(8000)
      });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error?.message || "RPC indisponível");
      const lamports = Number(payload.result?.value);
      if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error("Saldo RPC inválido");
      balanceSol = lamports / 1_000_000_000;
      rpcOk = true;
    } catch (error) { rpcError = error.message || "Falha no RPC"; }
  }
  checks.rpcOk = rpcOk;
  checks.balanceAboveInitialOrder = balanceSol !== null && balanceSol >= 0.002;
  const passed = Object.values(checks).every(Boolean);
  res.json({
    ok: true,
    mode: "PAPER",
    preflightPassed: passed,
    checks,
    walletAddress: cfg.signerMatches ? cfg.signerAddress : null,
    balanceSol,
    rpcError,
    initialOrderCapSol: 0.001,
    reserveRecommendationSol: 0.001,
    transactionSent: false,
    note: "Somente diagnóstico: nenhuma transação foi assinada ou enviada. O ciclo automático de posições ainda exige integração e teste."
  });
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
    if (!payload.transaction || !payload.requestId) return res.status(502).json({ ok: false, error: "Jupiter não conseguiu montar uma transação para esse token/valor.", diagnostic: { httpStatus: response.status, router: payload.router || null, errorCode: payload.errorCode ?? null, apiMessage: String(payload.errorMessage || payload.error || payload.message || "A resposta não contém transaction/requestId").slice(0, 240), responseFields: Object.keys(payload || {}) } });
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


// Gated live swap executor. Disabled unless the VPS explicitly enables it and
// a private API token + matching Solana signer are configured. Never expose secrets in source.
const LIVE_SWAP_MAX_BUY_LAMPORTS = 1000000; // 0.001 SOL per buy during initial validation
function liveApiAuthorized(req) {
  const expected = String(process.env.LIVE_TRADING_API_TOKEN || "");
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return expected.length >= 32 && got.length > 0 && got === expected;
}
app.post("/api/live/swap", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (!liveApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Acesso não autorizado. Configure um token privado no VPS." });
    const cfg = liveTradingConfig();
    if (String(process.env.LIVE_TRADING_ENABLED || "").toLowerCase() !== "true")
      return res.status(423).json({ ok: false, error: "Operações reais desativadas. LIVE_TRADING_ENABLED não está true." });
    if (!cfg.signerValid || !cfg.signerMatches || !cfg.jupiterConfigured)
      return res.status(423).json({ ok: false, error: "Assinante inválido, endereço divergente ou chave Jupiter ausente.", diagnostics: { signerValid: cfg.signerValid, signerMatches: cfg.signerMatches, jupiterConfigured: cfg.jupiterConfigured } });
    const { inputMint, outputMint, amount } = req.body || {};
    const rawAmount = String(amount || "");
    const validMint = value => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
    if (!validMint(inputMint) || !validMint(outputMint) || inputMint === outputMint || !/^[1-9][0-9]{0,18}$/.test(rawAmount))
      return res.status(400).json({ ok: false, error: "inputMint, outputMint ou amount inválido." });
    // For initial rollout only SOL buys (capped at 0.001 SOL) and token-to-SOL sells.
    const isBuy = inputMint === SOL_MINT && outputMint !== SOL_MINT;
    const isSell = inputMint !== SOL_MINT && outputMint === SOL_MINT;
    if (!isBuy && !isSell) return res.status(400).json({ ok: false, error: "Apenas compras SOL→token e vendas token→SOL são permitidas." });
    if (isBuy && BigInt(rawAmount) > BigInt(LIVE_SWAP_MAX_BUY_LAMPORTS))
      return res.status(400).json({ ok: false, error: "Limite inicial por compra: 0,001 SOL." });
    const { Keypair, VersionedTransaction } = require("@solana/web3.js");
    const signer = Keypair.fromSecretKey(parseSolanaSecret(process.env.SOLANA_TRADING_SECRET_KEY));
    if (signer.publicKey.toBase58() !== String(process.env.SOLANA_TRADING_WALLET_ADDRESS || ""))
      return res.status(423).json({ ok: false, error: "O assinante não corresponde ao endereço Solana configurado." });
    const orderUrl = new URL("https://api.jup.ag/swap/v2/order");
    orderUrl.searchParams.set("inputMint", inputMint);
    orderUrl.searchParams.set("outputMint", outputMint);
    orderUrl.searchParams.set("amount", rawAmount);
    orderUrl.searchParams.set("taker", signer.publicKey.toBase58());
    const orderResponse = await fetch(orderUrl, { headers: { "x-api-key": jupiterKey(), "accept": "application/json" }, signal: AbortSignal.timeout(15000) });
    const order = await orderResponse.json();
    if (!orderResponse.ok || !order.transaction || !order.requestId)
      return res.status(502).json({ ok: false, error: order.error || order.errorMessage || order.message || "Jupiter não gerou uma ordem executável.", diagnostic: { httpStatus: orderResponse.status, errorCode: order.errorCode ?? null } });
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    tx.sign([signer]);
    const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
    const executeResponse = await fetch("https://api.jup.ag/swap/v2/execute", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": jupiterKey(), "accept": "application/json" },
      body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
      signal: AbortSignal.timeout(20000)
    });
    const execution = await executeResponse.json();
    if (!executeResponse.ok || execution.error || execution.status === "Failed")
      return res.status(502).json({ ok: false, error: execution.error || execution.message || "Jupiter não confirmou a execução.", result: execution });
    return res.json({ ok: true, mode: "LIVE", side: isBuy ? "BUY" : "SELL", inputMint, outputMint, amount: rawAmount, result: execution, warning: "Transação enviada à Jupiter. Confirme a assinatura/resultado na rede antes de contabilizar a posição." });
  } catch (error) {
    console.error("Live swap failed:", error);
    return res.status(502).json({ ok: false, error: error.message || "Falha no executor de swap." });
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
