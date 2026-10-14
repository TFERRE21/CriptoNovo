import { WalletConnectWalletAdapter } from "@solana/wallet-adapter-walletconnect";
import { VersionedTransaction } from "@solana/web3.js";

const statusEl = document.getElementById("walletConnectStatus");
const addressEl = document.getElementById("walletConnectAddress");
const connectBtn = document.getElementById("walletConnectConnect");
const disconnectBtn = document.getElementById("walletConnectDisconnect");

let adapter = null;
const EXPECTED_SOLANA_WALLET = "EBfqqSSXikpujiBQEZLaYFUCcKHwRbGT9QYVYq9Q8vhp";

function setStatus(message, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function shortAddress(value) {
  return value ? value.slice(0, 6) + "…" + value.slice(-6) : "—";
}


function installManualSwapPanel() {
  const panel = document.getElementById("walletConnectPanel");
  if (!panel || document.getElementById("jupiterManualSwap")) return;
  const box = document.createElement("div");
  box.id = "jupiterManualSwap";
  box.style.cssText = "margin-top:14px;padding:14px;border:1px solid #25334b;border-radius:10px;background:#0d1525";
  box.innerHTML = '<h3 style="margin:0 0 8px">Compra manual via Jupiter · teste controlado</h3>' +
    '<p style="margin-bottom:10px">Compra manual; não liga o robô automático. Teste inicial sugerido: 0,001 SOL. Preserve saldo para taxas e criação da conta do token. Confirme se o endereço conectado é o mesmo da carteira que contém SOL.</p>' +
    '<label for="jupiterTokenMint" style="display:block;margin:8px 0 4px">Mint do token Solana que deseja comprar</label>' +
    '<input id="jupiterTokenMint" autocomplete="off" spellcheck="false" placeholder="Cole o endereço mint do token" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #25334b;background:#111c2d;color:#eef4ff">' +
    '<label for="jupiterSolAmount" style="display:block;margin:8px 0 4px">Valor em SOL (máximo 0,01)</label>' +
    '<input id="jupiterSolAmount" type="number" min="0.001" max="0.01" step="0.001" value="0.001" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #25334b;background:#111c2d;color:#eef4ff">' +
    '<button id="jupiterBuyButton" type="button" class="primary" style="margin-top:10px" disabled>Solicitar cotação e comprar</button>' +
    '<p id="jupiterSwapStatus" role="status" aria-live="polite" style="margin-top:8px">Verificando API Jupiter…</p>';
  panel.appendChild(box);
  const btn = box.querySelector("#jupiterBuyButton");
  const status = box.querySelector("#jupiterSwapStatus");
  fetch("/api/jupiter/status", { cache: "no-store" }).then(r => r.json()).then(s => {
    if (s.configured) { status.textContent = "API configurada. Compra manual; assinatura obrigatória."; btn.disabled = false; }
    else { status.textContent = "JUPITER_API_KEY não detectada no servidor. Verifique a variável no VPS."; btn.disabled = true; }
  }).catch(() => { status.textContent = "Não foi possível verificar a configuração Jupiter."; btn.disabled = true; });
  btn.addEventListener("click", async () => {
    status.textContent = "Clique recebido. Validando carteira e dados…";
    if (!adapter || !adapter.connected || !adapter.publicKey) {
      status.textContent = "Conecte a Binance Web3 Wallet primeiro.";
      return;
    }
    const connectedAddress = adapter.publicKey.toBase58();
    if (connectedAddress !== EXPECTED_SOLANA_WALLET) {
      status.textContent = "Compra bloqueada: a carteira conectada (" + connectedAddress + ") é diferente da carteira informada pelo usuário (" + EXPECTED_SOLANA_WALLET + "). Desconecte e conecte a carteira correta. Nenhuma cotação foi solicitada.";
      return;
    }
    const mint = box.querySelector("#jupiterTokenMint").value.trim();
    const sol = Number(box.querySelector("#jupiterSolAmount").value);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) { status.textContent = "Mint inválido. Confira o endereço oficial do token."; return; }
    if (!Number.isFinite(sol) || sol < 0.001 || sol > 0.01) { status.textContent = "O valor deve ser de 0,001 a 0,01 SOL."; return; }
    const lamports = String(Math.floor(sol * 1_000_000_000));
    if (!window.confirm("Você está solicitando uma COMPRA REAL na Solana.\n\nEntrada: " + sol + " SOL, mais taxas.\nToken mint: " + mint + "\n\nA próxima tela deve mostrar a transação na sua carteira. Só aprove se conferir os dados. Continuar?")) return;
    btn.disabled = true;
    try {
      status.textContent = "Buscando cotação na Jupiter…";
      const orderResponse = await fetch("/api/jupiter/order", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputMint: "So11111111111111111111111111111111111111112", outputMint: mint, amount: lamports, taker: adapter.publicKey.toBase58() })
      });
      const orderBody = await orderResponse.json();
      if (!orderResponse.ok || !orderBody.ok) { const d = orderBody.diagnostic || {}; const detail = [d.router ? "roteador: " + d.router : "", d.errorCode != null ? "código: " + d.errorCode : "", d.apiMessage || ""].filter(Boolean).join(" · "); if (/insufficient funds/i.test(d.apiMessage || "")) throw new Error("Saldo insuficiente na carteira informada à Jupiter. Confira se o endereço conectado é o mesmo que mostra seu saldo e reserve SOL para taxas e criação da conta do token. A tentativa não foi enviada para assinatura."); throw new Error((orderBody.error || "Não foi possível obter a cotação.") + (detail ? " Detalhes: " + detail : "")); }
      const order = orderBody.order;
      const out = String(order.outAmount || "não informado");
      const impact = order.priceImpactPct == null ? "não informado" : String(order.priceImpactPct) + "%";
      if (!window.confirm("CONFIRA ANTES DE ASSINAR\n\nEntrada: " + sol + " SOL\nQuantidade de saída (unidade mínima do token): " + out + "\nImpacto estimado: " + impact + "\nMint: " + mint + "\n\nA quantidade pode estar em unidades mínimas e não equivale necessariamente a tokens inteiros. Continuar para a carteira?")) {
        status.textContent = "Compra cancelada antes da assinatura.";
        return;
      }
      if (typeof adapter.signTransaction !== "function") throw new Error("Esta carteira não disponibilizou assinatura de transação. Nenhuma compra foi enviada.");
      status.textContent = "Solicitando assinatura na Binance Web3 Wallet…";
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(order.transaction), c => c.charCodeAt(0)));
      const signed = await adapter.signTransaction(tx);
      const signedTransaction = btoa(String.fromCharCode(...signed.serialize()));
      status.textContent = "Enviando transação assinada à Jupiter…";
      const executeResponse = await fetch("/api/jupiter/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTransaction, requestId: order.requestId })
      });
      const executeBody = await executeResponse.json();
      if (!executeResponse.ok || !executeBody.ok) throw new Error(executeBody.error || "A Jupiter não confirmou a execução.");
      const result = executeBody.result || {};
      const signature = result.signature || result.txid || result.transactionSignature || "";
      status.textContent = signature
        ? "Jupiter retornou a execução. Assinatura: " + signature + " · confira a confirmação na Solana Explorer."
        : "Resposta da Jupiter recebida. Verifique o resultado e a assinatura na atividade da carteira antes de repetir.";
      if (signature) {
        const link = document.createElement("a");
        link.href = "https://solscan.io/tx/" + encodeURIComponent(signature);
        link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Abrir transação no Solscan";
        link.style.cssText = "display:block;margin-top:8px;color:#60a5fa";
        status.appendChild(document.createTextNode(" "));
        status.appendChild(link);
      }
    } catch (error) {
      status.textContent = "Compra não confirmada: " + (error?.message || String(error)) + ". Confira a atividade da carteira antes de tentar novamente.";
    } finally {
      btn.disabled = false;
    }
  });
}

async function initWalletConnect() {
  try {
    const response = await fetch("/api/walletconnect/config", { cache: "no-store" });
    const config = await response.json();
    if (!response.ok || !config.ok) throw new Error(config.message || "Não foi possível carregar a configuração.");
    if (!config.configured || !config.projectId) {
      connectBtn.disabled = true;
      setStatus("WalletConnect ainda não configurado no servidor. Defina WALLETCONNECT_PROJECT_ID no painel e faça novo deploy.", "warning");
      return;
    }

    adapter = new WalletConnectWalletAdapter({
      network: "mainnet-beta",
      options: {
        projectId: config.projectId,
        metadata: {
          name: "CriptoNovo",
          description: "Conexão segura com carteira Solana",
          url: window.location.origin,
          icons: [window.location.origin + "/favicon.ico"]
        }
      }
    });

    adapter.on("connect", (publicKey) => {
      const address = publicKey?.toBase58?.() || String(publicKey || "");
      addressEl.textContent = address || "Endereço não informado";
      setStatus("Carteira conectada. Somente leitura; nenhuma transação foi enviada.", "success");
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
    });

    adapter.on("disconnect", () => {
      addressEl.textContent = "—";
      setStatus("Carteira desconectada. Nenhuma transação foi enviada.", "info");
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
    });

    adapter.on("error", (error) => {
      setStatus("Falha na conexão: " + (error?.message || "erro não identificado"), "error");
    });

    if (adapter.connected && adapter.publicKey) {
      addressEl.textContent = adapter.publicKey.toBase58();
      setStatus("Carteira conectada. Somente leitura; nenhuma transação foi enviada.", "success");
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
    } else {
      setStatus("Pronto para conectar. A conexão não autoriza swaps automaticamente.", "info");
    }

    connectBtn.disabled = false;
    installManualSwapPanel();
  } catch (error) {
    connectBtn.disabled = true;
    setStatus("Não foi possível inicializar WalletConnect: " + (error?.message || error), "error");
  }
}

connectBtn?.addEventListener("click", async () => {
  if (!adapter) return;
  connectBtn.disabled = true;
  setStatus("Solicitando conexão com a carteira…", "info");
  try {
    await adapter.connect();
  } catch (error) {
    setStatus("Conexão cancelada ou falhou: " + (error?.message || error), "error");
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn?.addEventListener("click", async () => {
  if (!adapter) return;
  disconnectBtn.disabled = true;
  try {
    await adapter.disconnect();
  } catch (error) {
    setStatus("Erro ao desconectar: " + (error?.message || error), "error");
  } finally {
    disconnectBtn.disabled = false;
  }
});

initWalletConnect();
