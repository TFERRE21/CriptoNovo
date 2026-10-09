require("dotenv").config();
const express = require("express");
const path = require("node:path");
const { PaperEngine } = require("./engine");

const app = express();
const engine = new PaperEngine();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", (_req, res) => res.json({ ok: true, mode: "PAPER", time: new Date().toISOString() }));
app.get("/api/state", (_req, res) => res.json(engine.snapshot()));
app.post("/api/start", async (_req, res) => { await engine.start(); res.json({ ok: true, state: engine.snapshot() }); });
app.post("/api/stop", async (_req, res) => { await engine.stop(); res.json({ ok: true, state: engine.snapshot() }); });
app.post("/api/reset", async (_req, res) => { await engine.reset(); res.json({ ok: true, state: engine.snapshot() }); });

const port = Number(process.env.PORT || 3000);
engine.init().then(() => {
  app.listen(port, "0.0.0.0", () => console.log(`CriptoNovo paper dashboard listening on :${port}`));
}).catch(err => { console.error("Failed to initialize:", err); process.exit(1); });
