import { WalletConnectWalletAdapter } from "@solana/wallet-adapter-walletconnect";
import { VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";

// web3.js and wallet adapters expect Buffer in browser bundles.
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;

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
  btn.textContent = "Abrir compra na Jupiter";
  btn.addEventListener("click", () => {
    const mint = box.querySelector("#jupiterTokenMint").value.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      status.textContent = "Mint inválido. Confira o endereço do token antes de abrir a Jupiter.";
      return;
    }
    const url = "https://jup.ag/swap/SOL-" + encodeURIComponent(mint);
    const opened = window.open(url, "_blank");
    if (opened) {
      opened.opener = null;
      status.textContent = "Jupiter aberta em outra aba. Conecte sua carteira diretamente na Jupiter e confira token, valor e taxas antes de assinar.";
    } else {
      status.textContent = "O navegador bloqueou a nova aba. Permita pop-ups para este site e clique novamente.";
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
