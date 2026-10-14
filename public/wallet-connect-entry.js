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
