#!/usr/bin/env bun
/**
 * news-trader — serveur de page dashboard (Bun).
 * API: /healthz, /api/state (GET), /api/scan, /api/tick, /api/trade,
 *      /api/close, /api/watchlist, /api/reset (POST, JSON).
 * Lit les mêmes fichiers de données que le moteur (ob-plugin-news-trader-engine),
 * délègue les actions au moteur. Aucun état propre — survit aux redémarrages.
 * UI (directive dashboard server 2026-10-16) : install figée → bundle servi via
 * OPEN_BOT_PAGE_UI ; checkout local / preview → import("./index.html") bundle à la volée.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = process.env.OPEN_BOT_PLUGIN_ID || "news-trader";
const PORT = Number(process.env.OPEN_BOT_PAGE_PORT ?? 4746);
const TOKEN = process.env.OPEN_BOT_PAGE_TOKEN ?? "";
const DATA_DIR = `/home/agent/.open-bot/pages-data/${PLUGIN_ID}`;
const ENGINE_BIN = `/usr/local/bin/ob-plugin-${PLUGIN_ID}-engine`;

function engineCmd(args: string[]): string[] {
  if (existsSync(ENGINE_BIN)) return [ENGINE_BIN, ...args];
  return ["bun", join(import.meta.dir, "..", "engine", "news-trader-engine.ts"), ...args];
}
function runEngine(args: string[], timeoutMs = 90000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let done = false;
    let stdout = "", stderr = "";
    const proc = Bun.spawn(engineCmd(args), { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { if (!done) { try { proc.kill(); } catch {} } }, timeoutMs);
    Promise.all([
      new Response(proc.stdout).text().then((t) => (stdout = t)),
      new Response(proc.stderr).text().then((t) => (stderr = t)),
    ]).then(async () => {
      const code = await proc.exited;
      if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); }
    });
  });
}

function loadJson<T>(f: string, def: T): T {
  try { return JSON.parse(require("node:fs").readFileSync(join(DATA_DIR, f), "utf8")) as T; } catch { return def; }
}
function loadConfig(): Record<string, string> {
  try {
    const raw = JSON.parse(require("node:fs").readFileSync(`/home/agent/.config/open-bot/plugin-${PLUGIN_ID}.json`, "utf8"));
    return raw?.settings ?? {};
  } catch { return {}; }
}
function marketOpen(): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday) && mins >= 570 && mins < 960;
}

function statePayload() {
  const s = loadConfig();
  const cfg = {
    autoTrade: /^(true|on|1)$/i.test(s.auto_trade ?? "false"),
    threshold: Number(s.confidence_threshold ?? 60),
    maxPosPct: Number(s.max_position_pct ?? 20),
    stopLossPct: Number(s.stop_loss_pct ?? 8),
    takeProfitPct: Number(s.take_profit_pct ?? 15),
    maxPositions: Number(s.max_positions ?? 8),
    currency: s.currency === "USD" ? "USD" : "CAD",
  };
  const p = loadJson<any>("portfolio.json", null);
  const signals = loadJson<any[]>("signals.json", []);
  const news = loadJson<any[]>("news.json", []);
  const watchlist = loadJson<string[]>("watchlist.json", (s.watchlist || "").split(",").map((x: string) => x.trim().toUpperCase()).filter(Boolean));
  const positions = p ? Object.entries(p.positions ?? {}).map(([sym, x]: [string, any]) => ({
    ticker: sym, qty: x.qty, entry: x.entry, last: x.last,
    pnlPct: +(((x.last - x.entry) / x.entry) * 100).toFixed(2),
    pnl: +((x.last - x.entry) * x.qty).toFixed(2),
    value: +(x.last * x.qty).toFixed(2),
    entryTime: x.entryTime, reason: x.reason,
    stop: +(x.entry * (1 - cfg.stopLossPct / 100)).toFixed(2),
    target: +(x.entry * (1 + cfg.takeProfitPct / 100)).toFixed(2),
  })) : [];
  const marketValue = p ? p.cash + positions.reduce((a, x) => a + x.value, 0) : 0;
  return {
    serverTime: Date.now(),
    marketOpen: marketOpen(),
    exists: !!p,
    config: cfg,
    portfolio: p ? {
      cash: +p.cash.toFixed(2), startCash: p.startCash, currency: p.currency,
      marketValue: +marketValue.toFixed(2), pnl: +(marketValue - p.startCash).toFixed(2),
      pnlPct: +(((marketValue - p.startCash) / p.startCash) * 100).toFixed(2),
      lastScan: p.lastScan, lastTick: p.lastTick,
    } : null,
    positions,
    trades: (p?.trades ?? []).slice(0, 40),
    signals: signals.slice(0, 25),
    news: news.slice(0, 20),
    watchlist,
  };
}

// UI : fichiers réels server/index.html + app.ts + styles.css (directive dashboard server 2026-10-16).
// Install figée : le control plane bundle l'UI au install et la sert via OPEN_BOT_PAGE_UI.
// Checkout local / preview (bun --hot) : import de index.html, bundle rendu à la volée par Bun.serve.
const UI_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };
const routes = process.env.OPEN_BOT_PAGE_UI
  ? {
      "/": () =>
        new Response(Bun.file(process.env.OPEN_BOT_PAGE_UI as string), { headers: UI_HEADERS }),
    }
  : { "/": await import("./index.html").then((m) => m.default) };

function authed(req: Request): boolean {
  if (!TOKEN) return true;
  if (req.headers.get("x-open-bot-page-token") === TOKEN) return true;
  if (req.headers.get("x-open-bot-page-token") === "dev-preview") {
    // Preview : token « dev-preview » accepté en loopback uniquement (directive 2026-10-16).
    try {
      const ip = server.requestIP(req);
      if (!ip) return false;
      const a = ip.address.replace(/^::ffff:/, "");
      return a === "127.0.0.1" || a === "::1";
    } catch { return false; }
  }
  return new URL(req.url).searchParams.get("t") === TOKEN;
}



// Alias historique /index.html : même contenu que la route "/" (bundle figé ou checkout).
const pageHtml = process.env.OPEN_BOT_PAGE_UI
  ? () => new Response(Bun.file(process.env.OPEN_BOT_PAGE_UI as string), { headers: UI_HEADERS })
  : async () => new Response(await import("./index.html").then((m) => m.default), { headers: UI_HEADERS });

const server = Bun.serve({
  port: PORT,
  routes,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/$/, "") || "/";
    if (p === "/healthz") return new Response("ok");
    if (!authed(req)) return new Response("forbidden", { status: 403 });

    if (req.method === "GET" && p === "/index.html") return pageHtml();

    if (req.method === "GET" && p === "/api/state") return Response.json(statePayload());

    if (req.method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      if (p === "/api/scan") {
        const r = await runEngine(["scan"], 120000);
        return Response.json({ ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
      }
      if (p === "/api/tick") {
        const r = await runEngine(["tick"], 60000);
        return Response.json({ ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
      }
      if (p === "/api/trade") {
        const action = body.action === "sell" ? "sell" : "buy";
        const args = ["trade", action, String(body.ticker ?? "").toUpperCase()];
        if (body.qty) args.push(String(Math.max(1, Math.floor(Number(body.qty) || 0))));
        if (body.reason) args.push("--reason", String(body.reason).slice(0, 200));
        if (!body.ticker) return Response.json({ ok: false, error: "ticker requis" }, { status: 400 });
        const r = await runEngine(args);
        return Response.json({ ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
      }
      if (p === "/api/close") {
        if (!body.ticker) return Response.json({ ok: false, error: "ticker requis" }, { status: 400 });
        const r = await runEngine(["close", String(body.ticker).toUpperCase()]);
        return Response.json({ ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
      }
      if (p === "/api/watchlist") {
        const action = body.action === "remove" ? "remove" : "add";
        if (!body.ticker) return Response.json({ ok: false, error: "ticker requis" }, { status: 400 });
        const r = await runEngine(["watchlist", action, String(body.ticker).toUpperCase()]);
        return Response.json({ ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
      }
      if (p === "/api/reset") {
        if (!body.confirm) return Response.json({ ok: false, error: "confirmation requise" }, { status: 400 });
        const r = await runEngine(["reset", "--yes"]);
        return Response.json({ ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
      }
      return Response.json({ ok: false, error: "endpoint inconnu" }, { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`news-trader page server on :${PORT}`);
