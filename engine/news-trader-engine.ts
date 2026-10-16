#!/usr/bin/env bun
/**
 * ob-plugin-news-trader — moteur news-trader (simulation / paper trading)
 *
 * Sous-commandes :
 *   scan                 Scraper les nouvelles, détecter les événements, générer des signaux
 *   tick                 Rafraîchir les cours, appliquer stop-loss / take-profit
 *   trade buy|sell SYM [qty] [--reason "…"]   Exécuter un ordre papier
 *   close SYM            Clôturer une position au marché
 *   report               Rapport digest en français
 *   backtest [jours]     Rejouer les signaux passés (achat → maintenant)
 *   watchlist [add|remove SYM]   Gérer la liste de suivi
 *   reset --yes          Réinitialiser le portefeuille simulé
 *   status [--json]      État courant
 *   quote SYM [--json]   Cours instantané
 *
 * Données persistées dans /home/agent/.open-bot/pages-data/news-trader/
 * Avertissement : simulation uniquement. Ne constitue pas un conseil financier.
 */

import { mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = "news-trader";
const DATA_DIR = `/home/agent/.open-bot/pages-data/${PLUGIN_ID}`;
const CONFIG_PATH = `/home/agent/.config/open-bot/plugin-${PLUGIN_ID}.json`;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const NOTIFY = "/usr/bin/ob-plugin";

// ---------------------------------------------------------------- utilitaires

function arg(name: string, def = ""): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function money(v: number, cur: string): string {
  return new Intl.NumberFormat("fr-CA", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(v);
}
function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)} %`;
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/csv, application/json;q=0.9, */*;q=0.8" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 900));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks.slice(0, 30)) {
    const title = stripTags(b.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const link = stripTags(b.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? "");
    const pub = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? "";
    const desc = stripTags(b.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "").slice(0, 300);
    if (!title) continue;
    const ts = pub ? new Date(pub).getTime() : Date.now();
    items.push({ id: hash(link || title), title, link, description: desc, source, published: Number.isFinite(ts) ? ts : Date.now() });
  }
  return items;
}

// ------------------------------------------------------------- configuration

interface Config { startingCash: number; currency: string; autoTrade: boolean; threshold: number; maxPosPct: number; stopLossPct: number; takeProfitPct: number; maxPositions: number; watchlist: string[] }

function loadConfig(): Config {
  let s: Record<string, string> = {};
  try {
    const raw = JSON.parse(require("node:fs").readFileSync(CONFIG_PATH, "utf8"));
    s = raw?.settings ?? {};
  } catch {}
  return {
    startingCash: num(s.starting_cash, 100000),
    currency: s.currency === "USD" ? "USD" : "CAD",
    autoTrade: /^(true|on|1)$/i.test(s.auto_trade ?? "false"),
    threshold: num(s.confidence_threshold, 60),
    maxPosPct: num(s.max_position_pct, 20),
    stopLossPct: num(s.stop_loss_pct, 8),
    takeProfitPct: num(s.take_profit_pct, 15),
    maxPositions: num(s.max_positions, 8),
    watchlist: (s.watchlist || "RY.TO,SHOP.TO,ENB.TO,AAPL,MSFT,NVDA").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
  };
}

// -------------------------------------------------------------- persistance

interface NewsItem { id: string; title: string; link: string; description: string; source: string; published: number }
interface Signal { id: string; ticker: string; title: string; link: string; source: string; published: number; event: string; direction: number; score: number; priceAtSignal: number | null; createdAt: number; traded: boolean }
interface Position { qty: number; entry: number; entryTime: number; reason: string; score: number; last: number }
interface Trade { time: number; ticker: string; side: "buy" | "sell"; qty: number; price: number; pnl: number | null; reason: string }
interface Portfolio { cash: number; startCash: number; currency: string; positions: Record<string, Position>; trades: Trade[]; lastScan: number; lastTick: number }

const FILES = { portfolio: "portfolio.json", signals: "signals.json", news: "news.json", watchlist: "watchlist.json" };
function path(f: string) { return join(DATA_DIR, f); }
function readJson<T>(f: string, def: T): T {
  try { return JSON.parse(require("node:fs").readFileSync(path(f), "utf8")) as T; } catch { return def; }
}
function writeJson(f: string, v: unknown) {
  mkdirSync(DATA_DIR, { recursive: true });
  require("node:fs").writeFileSync(path(f), JSON.stringify(v, null, 1));
}

function loadPortfolio(cfg: Config): Portfolio {
  const p = readJson<Portfolio | null>(FILES.portfolio, null);
  if (p) return p;
  const fresh: Portfolio = { cash: cfg.startingCash, startCash: cfg.startingCash, currency: cfg.currency, positions: {}, trades: [], lastScan: 0, lastTick: 0 };
  writeJson(FILES.portfolio, fresh);
  return fresh;
}
function loadWatchlist(cfg: Config): string[] {
  const w = readJson<string[] | null>(FILES.watchlist, null);
  if (w && Array.isArray(w) && w.length) return w;
  writeJson(FILES.watchlist, cfg.watchlist);
  return cfg.watchlist;
}

// ------------------------------------------------------------------- marché

function marketOpen(): boolean {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = parts.weekday;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(day) && mins >= 570 && mins < 960; // 9:30–16:00 HE
}

interface Quote { symbol: string; price: number; source: string }
async function getQuote(sym: string): Promise<Quote> {
  try {
    const j = JSON.parse(await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`));
    const meta = j?.chart?.result?.[0]?.meta;
    const px = Number(meta?.regularMarketPrice);
    if (Number.isFinite(px) && px > 0) return { symbol: sym, price: px, source: "yahoo" };
    throw new Error("prix manquant");
  } catch (e) {
    if (/\.(to|v)$/i.test(sym)) throw new Error(`cours indisponible pour ${sym}`);
    const sq = await fetchText(`https://stooq.com/q/l/?s=${sym.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`);
    const line = sq.split("\n")[1]?.split(",");
    const px = Number(line?.[6]);
    if (Number.isFinite(px) && px > 0) return { symbol: sym, price: px, source: "stooq" };
    throw new Error(`cours indisponible pour ${sym}`);
  }
}

// ------------------------------------------------------------ classification

const RULES: { event: string; re: RegExp; dir: number; weight: number }[] = [
  { event: "fda-approbation", re: /\bFDA\b[^.]{0,40}approv|approv[^.]{0,30}\bFDA\b|health canada approv/i, dir: 1, weight: 85 },
  { event: "guidance-relevée", re: /(raise[sd]?|boost[sd]?|lift[sd]?)\s+(its?\s+)?(full[- ]?year|annual|fy\d{2}|q[1-4]\s+)?(guidance|outlook|forecast)/i, dir: 1, weight: 75 },
  { event: "guidance-revue-baisse", re: /(cut[s]?|lower[sd]?|trim[sd]?|slash(es|ed)?)\s+(its?\s+)?(full[- ]?year|annual|fy\d{2}|q[1-4]\s+)?(guidance|outlook|forecast)|warns?\s+on/i, dir: -1, weight: 80 },
  { event: "résultats-battus", re: /beat[sd]?\s+(the\s+)?(earnings|estimates|expectations|forecasts)|tops?\s+estimates|results?\s+(above|top)/i, dir: 1, weight: 70 },
  { event: "résultats-manqués", re: /miss(es|ed)?\s+(the\s+)?(earnings|estimates|expectations|forecasts)|results?\s+below/i, dir: -1, weight: 70 },
  { event: "fusion-acquisition", re: /\bacqui(s|si)(re|red|res|sition|sitions)\b|\bmerger\b|\btakeover\b|\bbuyout\b|\bbeing acquired\b/i, dir: 1, weight: 75 },
  { event: "relevé-analyste", re: /upgrade[sd]?|initiat(e|es|ed)\s+coverage\s+with\s+(buy|outperform|overweight)|price\s+target\s+(raise[sd]?|hike[sd]?|up)/i, dir: 1, weight: 60 },
  { event: "abaissement-analyste", re: /downgrade[sd]?|price\s+target\s+(cut[s]?|lower[sd]?|trim[sd]?)/i, dir: -1, weight: 60 },
  { event: "poursuite-enquête", re: /\blawsuit\b|\bsue[sd]?\b|\bSEC\s+charges?\b|\binvestigat\w|\bclass\s+action\b|\brecalls?\b/i, dir: -1, weight: 55 },
  { event: "licenciements", re: /lay(s)?\s+off|layoffs|job\s+cuts|restructur/i, dir: -1, weight: 40 },
  { event: "lancement-produit", re: /launch(es|ed)?|unveil(s|ed)?|announce[sd]?\s+new/i, dir: 1, weight: 40 },
  { event: "dividende-hausse", re: /(raise[sd]?|hike[sd]?|increase[sd]?)\s+(its?\s+)?(dividend|buyback)/i, dir: 1, weight: 45 },
  { event: "dividende-coupure", re: /(cut[s]?|suspend(s|ed)?)\s+(its?\s+)?(dividend|buyback)/i, dir: -1, weight: 70 },
];
const POS_WORDS = /\b(surge[sd]?|soar[sd]?|jump(s|ed)?|record\s+high|beat[sd]?|strong|profit\s+up|gains?)\b/i;
const NEG_WORDS = /\b(plunge[sd]?|slump[sd]?|crash(es|ed)?|sink[sd]?|tumble[sd]?|weak|loss(es)?|miss[esd]*)\b/i;

function classify(text: string): { event: string; dir: number; weight: number } | null {
  for (const r of RULES) {
    if (r.re.test(text)) {
      let weight = r.weight;
      if (POS_WORDS.test(text)) weight += 8;
      if (NEG_WORDS.test(text)) weight += 8;
      return { event: r.event, dir: r.dir, weight: Math.min(weight, 95) };
    }
  }
  return null;
}
function recencyFactor(published: number): number {
  const h = (Date.now() - published) / 3600000;
  if (h < 2) return 1;
  if (h < 6) return 0.8;
  if (h < 24) return 0.55;
  return 0.3;
}

// Noms d'entreprises → symboles (la watchlist pilote le reste)
const NAME_MAP: Record<string, string[]> = {
  AAPL: ["apple"], MSFT: ["microsoft"], NVDA: ["nvidia"], TSLA: ["tesla", "elon musk"],
  AMZN: ["amazon"], META: ["meta", "facebook"], GOOGL: ["google", "alphabet"], NFLX: ["netflix"],
  "SHOP.TO": ["shopify"], "RY.TO": ["royal bank", "rbc"], "ENB.TO": ["enbridge"],
};

function mapTickers(item: NewsItem, feedTicker: string | null, watchlist: string[]): string[] {
  const found = new Set<string>();
  const hay = `${item.title} ${item.description}`.toLowerCase();
  for (const sym of watchlist) {
    const names = NAME_MAP[sym] ?? [];
    let hit = names.some((n) => hay.includes(n));
    const base = sym.replace(/\.(TO|V)$/i, "");
    if (!hit && base.length >= 3 && new RegExp(`\\b${base}\\b`, "i").test(hay)) hit = true;
    // Un article d'un flux par ticker doit quand même mentionner l'entreprise
    // (Yahoo glisse des tickers voisins dans ses flux — bruit à exclure).
    if (hit) found.add(sym);
  }
  return [...found];
}

// ------------------------------------------------------------------ notify

function notify(title: string, body: string) {
  try {
    if (existsSync(NOTIFY)) Bun.spawnSync([NOTIFY, "notify", PLUGIN_ID, title, body], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

// ------------------------------------------------------------------- ordres

function executeBuy(p: Portfolio, cfg: Config, sym: string, price: number, reason: string, score: number): Trade | null {
  if (p.positions[sym]) return null;
  if (Object.keys(p.positions).length >= cfg.maxPositions) { console.log(`  ⊘ ${sym} : max ${cfg.maxPositions} positions atteint`); return null; }
  let budget = (p.cash * Math.min(cfg.maxPosPct, 95)) / 100;
  if (budget > p.cash) budget = p.cash;
  const qty = Math.floor(budget / price);
  if (qty < 1 || qty * price > p.cash) { console.log(`  ⊘ ${sym} : fonds insuffisants (${money(p.cash, p.currency)})`); return null; }
  const cost = qty * price;
  p.cash -= cost;
  p.positions[sym] = { qty, entry: price, entryTime: Date.now(), reason, score, last: price };
  const t: Trade = { time: Date.now(), ticker: sym, side: "buy", qty, price, pnl: null, reason };
  p.trades.unshift(t);
  return t;
}
function executeSell(p: Portfolio, sym: string, price: number, reason: string): Trade | null {
  const pos = p.positions[sym];
  if (!pos) return null;
  const pnl = (price - pos.entry) * pos.qty;
  p.cash += price * pos.qty;
  delete p.positions[sym];
  const t: Trade = { time: Date.now(), ticker: sym, side: "sell", qty: pos.qty, price, pnl, reason };
  p.trades.unshift(t);
  return t;
}
function marketValue(p: Portfolio): number {
  return p.cash + Object.values(p.positions).reduce((s, x) => s + x.last * x.qty, 0);
}

// ============================================================== commandes

async function cmdScan() {
  const cfg = loadConfig();
  const watchlist = loadWatchlist(cfg);
  const news = readJson<NewsItem[]>(FILES.news, []);
  const signals = readJson<Signal[]>(FILES.signals, []);
  const seen = new Set(news.map((n) => n.id));
  const p = loadPortfolio(cfg);
  const failures: string[] = [];
  const newItems: NewsItem[] = [];
  const newSignals: Signal[] = [];
  let notable = false;

  const feeds: { url: string; source: string; ticker: string | null }[] = [
    { url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114", source: "CNBC", ticker: null },
    { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", source: "MarketWatch", ticker: null },
    { url: "https://www.cbc.ca/webfeed/rss/rss-business", source: "CBC Affaires", ticker: null },
    ...watchlist.map((s) => ({ url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=US&lang=en-US`, source: `Yahoo·${s}`, ticker: s })),
  ];
  const results = await Promise.allSettled(feeds.map(async (f) => {
    const xml = await fetchText(f.url);
    const items = parseRss(xml, f.source);
    return { f, items, empty: items.length === 0 };
  }));
  const emptyFeeds: string[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") { failures.push(String((r as PromiseRejectedResult).reason?.message ?? r.reason)); continue; }
    if (r.value.empty) { emptyFeeds.push(r.value.f.source); continue; }
    for (const item of r.value.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      newItems.push(item);
      const tickers = mapTickers(item, r.value.f.ticker, watchlist);
      if (!tickers.length) continue;
      const cls = classify(`${item.title}. ${item.description}`);
      if (!cls) continue;
      const score = Math.round(Math.min(100, cls.weight * recencyFactor(item.published)));
      for (const sym of tickers) {
        const dupe = [...signals, ...newSignals].find((s) => s.ticker === sym && s.event === cls.event && Date.now() - s.createdAt < 12 * 3600000);
        if (dupe) { if (score > dupe.score) dupe.score = score; continue; }
        const sig: Signal = { id: hash(item.id + sym), ticker: sym, title: item.title, link: item.link, source: item.source, published: item.published, event: cls.event, direction: cls.dir, score, priceAtSignal: null, createdAt: Date.now(), traded: false };
        newSignals.push(sig);
      }
    }
  }

  // Cours à l'instant du signal + exécution auto
  const tradable = newSignals.filter((s) => s.score >= cfg.threshold).sort((a, b) => b.score - a.score);
  const quotes = new Map<string, number>();
  await Promise.allSettled([...new Set([...tradable.map((s) => s.ticker), ...Object.keys(p.positions)])].map(async (s) => {
    try { quotes.set(s, (await getQuote(s)).price); } catch {}
  }));
  for (const s of newSignals) s.priceAtSignal = quotes.get(s.ticker) ?? null;

  if (cfg.autoTrade && tradable.length) {
    for (const s of tradable) {
      const px = quotes.get(s.ticker);
      if (!px) continue;
      if (s.direction > 0) {
        const t = executeBuy(p, cfg, s.ticker, px, `Signal ${s.event} (score ${s.score}) — ${s.title.slice(0, 80)}`, s.score);
        if (t) {
          s.traded = true; notable = true;
          console.log(`  ✔ ACHAT ${t.qty} ${s.ticker} @ ${px.toFixed(2)} — signal ${s.event} (${s.score}/100)`);
          notify("News Trader — achat simulé", `${t.qty} ${s.ticker} @ ${px.toFixed(2)} — signal ${s.event} (${s.score}/100)`);
        }
      } else if (p.positions[s.ticker]) {
        const t = executeSell(p, s.ticker, px, `Signal négatif ${s.event} (score ${s.score})`);
        if (t) {
          s.traded = true; notable = true;
          console.log(`  ✔ VENTE ${s.ticker} @ ${px.toFixed(2)} — ${t.reason} (P&L ${money(t.pnl ?? 0, p.currency)})`);
          notify("News Trader — vente simulée", `${s.ticker} @ ${px.toFixed(2)} — ${t.reason} (P&L ${money(t.pnl ?? 0, p.currency)})`);
        }
      }
    }
  }

  // Sortie signaux négatifs détenus même sans auto-trade (recommandation)
  for (const s of newSignals.filter((x) => x.direction < 0 && p.positions[x.ticker] && x.score >= cfg.threshold)) {
    notable = true;
    console.log(`  ⚠ Recommandé : clôturer ${s.ticker} — signal ${s.event} (${s.score}/100). « ob-plugin-${PLUGIN_ID}-engine close ${s.ticker} »`);
  }

  p.lastScan = Date.now();
  writeJson(FILES.portfolio, p);
  writeJson(FILES.news, [...newItems, ...news].slice(0, 400));
  writeJson(FILES.signals, [...newSignals, ...signals].slice(0, 300));
  writeJson(FILES.watchlist, watchlist);

  const failLine = [...failures, ...emptyFeeds.map((s) => `${s} : flux vide`)].join("; ");
  console.log(`Scan terminé : ${newItems.length} nouvelles, ${newSignals.length} signaux (${tradable.length} ≥ seuil ${cfg.threshold}). Sources en échec : ${failLine || "aucune"}.`);
  if (notable || tradable.length) console.log(`[cron-agent] news-trader : ${tradable.length} signal(aux) fort(s) — résumé demandé.`);
}

async function cmdTick() {
  const cfg = loadConfig();
  const p = loadPortfolio(cfg);
  const syms = Object.keys(p.positions);
  let moved = false;
  for (const sym of syms) {
    try {
      const q = await getQuote(sym);
      p.positions[sym].last = q.price;
      const pos = p.positions[sym];
      const chg = ((q.price - pos.entry) / pos.entry) * 100;
      let closed: Trade | null = null;
      if (chg <= -cfg.stopLossPct) closed = executeSell(p, sym, q.price, `Stop-loss touché (${chg.toFixed(1)} %)`);
      else if (chg >= cfg.takeProfitPct) closed = executeSell(p, sym, q.price, `Take-profit touché (+${chg.toFixed(1)} %)`);
      if (closed) {
        moved = true;
        console.log(`  ✔ CLÔTURE ${sym} @ ${q.price.toFixed(2)} — ${closed.reason} (P&L ${money(closed.pnl ?? 0, p.currency)})`);
        notify("News Trader — position clôturée", `${sym} @ ${q.price.toFixed(2)} — ${closed.reason} (P&L ${money(closed.pnl ?? 0, p.currency)})`);
      } else {
        console.log(`  · ${sym} dernier ${q.price.toFixed(2)} (${pct(chg)})`);
      }
    } catch (e) {
      console.log(`  ⚠ ${sym} : ${(e as Error).message}`);
    }
  }
  p.lastTick = Date.now();
  writeJson(FILES.portfolio, p);
  if (moved) console.log("[cron-agent] news-trader : position(s) clôturée(s) par stop-loss/take-profit.");
}

async function cmdTrade(action: string, symRaw: string) {
  const cfg = loadConfig();
  const p = loadPortfolio(cfg);
  const sym = symRaw.toUpperCase();
  if (!sym) { console.error("Usage: trade buy|sell SYM [qty] [--reason \"…\"]"); process.exit(1); }
  let qty = Number(arg("--qty", "0"));
  if (!qty) {
    const pos = process.argv.slice(5).findIndex((x) => /^\d+$/.test(x));
    if (pos >= 0) qty = Number(process.argv.slice(5)[pos]);
  }
  const reason = arg("--reason", "Ordre manuel");
  let q: Quote;
  try { q = await getQuote(sym); } catch (e) { console.error(String((e as Error).message)); process.exit(1); }
  if (action === "buy") {
    if (!qty) qty = Math.floor(((p.cash * Math.min(cfg.maxPosPct, 95)) / 100) / q.price);
    const pos = p.positions[sym];
    const cost = qty * q.price;
    if (qty < 1 || cost > p.cash) {
      console.error(`Ordre refusé : fonds insuffisants (${money(p.cash, p.currency)} dispo, ${money(cost, p.currency)} requis)`);
      process.exit(1);
    }
    p.cash -= cost;
    let trade: Trade;
    if (pos) {
      pos.entry = (pos.entry * pos.qty + q.price * qty) / (pos.qty + qty);
      pos.qty += qty;
      pos.last = q.price;
    } else {
      p.positions[sym] = { qty, entry: q.price, entryTime: Date.now(), reason, score: 0, last: q.price };
    }
    trade = { time: Date.now(), ticker: sym, side: "buy", qty, price: q.price, pnl: null, reason };
    p.trades.unshift(trade);
    writeJson(FILES.portfolio, p);
    console.log(`✔ ACHAT ${qty} ${sym} @ ${q.price.toFixed(2)} (${money(qty * q.price, p.currency)}) — ${reason}`);
    notify("News Trader — achat simulé", `${qty} ${sym} @ ${q.price.toFixed(2)}`);
  } else if (action === "sell") {
    const pos = p.positions[sym];
    if (!pos) { console.error(`Aucune position sur ${sym}`); process.exit(1); }
    const n = !qty || qty >= pos.qty ? pos.qty : qty;
    const pnl = (q.price - pos.entry) * n;
    p.cash += q.price * n;
    pos.qty -= n;
    if (pos.qty <= 0) delete p.positions[sym];
    const trade: Trade = { time: Date.now(), ticker: sym, side: "sell", qty: n, price: q.price, pnl, reason };
    p.trades.unshift(trade);
    writeJson(FILES.portfolio, p);
    console.log(`✔ VENTE ${n} ${sym} @ ${q.price.toFixed(2)} — P&L ${money(pnl, p.currency)} — ${reason}`);
    notify("News Trader — vente simulée", `${n} ${sym} @ ${q.price.toFixed(2)} (P&L ${money(pnl, p.currency)})`);
  } else {
    console.error("Action inconnue : buy|sell"); process.exit(1);
  }
}

async function cmdClose(symRaw: string) {
  const cfg = loadConfig();
  const p = loadPortfolio(cfg);
  const sym = symRaw.toUpperCase();
  if (!p.positions[sym]) { console.error(`Aucune position sur ${sym}`); process.exit(1); }
  let q: Quote;
  try { q = await getQuote(sym); } catch (e) { console.error(String((e as Error).message)); process.exit(1); }
  const t = executeSell(p, sym, q.price, "Clôture manuelle");
  writeJson(FILES.portfolio, p);
  console.log(`✔ CLÔTURE ${sym} @ ${q.price.toFixed(2)} — P&L ${money(t?.pnl ?? 0, p.currency)}`);
  notify("News Trader — position clôturée", `${sym} @ ${q.price.toFixed(2)} (P&L ${money(t?.pnl ?? 0, p.currency)})`);
}

async function cmdReport() {
  const cfg = loadConfig();
  const p = loadPortfolio(cfg);
  const signals = readJson<Signal[]>(FILES.signals, []);
  const cur = p.currency;
  const mv = marketValue(p);
  const pnl = mv - p.startCash;
  const posRows = Object.entries(p.positions).map(([sym, x]) =>
    `  ${sym.padEnd(8)} ${String(x.qty).padStart(5)} q  PRU ${x.entry.toFixed(2).padStart(9)}  dernier ${x.last.toFixed(2).padStart(9)}  ${pct(((x.last - x.entry) / x.entry) * 100).padStart(8)}  stop ${money(x.entry * (1 - cfg.stopLossPct / 100), cur)} / objectif ${money(x.entry * (1 + cfg.takeProfitPct / 100), cur)}`);
  const today = p.trades.filter((t) => Date.now() - t.time < 24 * 3600000).slice(0, 10)
    .map((t) => `  ${t.side === "buy" ? "ACHAT" : "VENTE"} ${t.qty} ${t.ticker} @ ${t.price.toFixed(2)}${t.pnl !== null ? ` → P&L ${money(t.pnl, cur)}` : ""} — ${t.reason}`);
  const sigs = signals.slice(0, 8).map((s) => `  [${String(s.score).padStart(3)}] ${s.direction > 0 ? "▲" : "▼"} ${s.ticker.padEnd(8)} ${s.event} — ${s.title.slice(0, 70)}`);
  console.log(`📰 News Trader — rapport de simulation (${new Date().toLocaleString("fr-CA", { timeZone: "America/Toronto" })} HE)`);
  console.log("");
  console.log(`Portefeuille : ${money(mv, cur)} (départ ${money(p.startCash, cur)}) — P&L total ${money(pnl, cur)} (${pct((pnl / p.startCash) * 100)})`);
  console.log(`Cash : ${money(p.cash, cur)} — Positions : ${Object.keys(p.positions).length}/${cfg.maxPositions} — Marché : ${marketOpen() ? "ouvert" : "fermé"}`);
  console.log("");
  if (posRows.length) { console.log("Positions ouvertes :"); console.log(posRows.join("\n")); } else console.log("Aucune position ouverte.");
  console.log("");
  if (today.length) { console.log("Transactions (24 h) :"); console.log(today.join("\n")); } else console.log("Aucune transaction depuis 24 h.");
  console.log("");
  if (sigs.length) { console.log("Derniers signaux :"); console.log(sigs.join("\n")); }
  console.log("");
  console.log("⚠ Simulation (paper trading) — aucun argent réel. Ne constitue pas un conseil financier.");
}

async function cmdBacktest(daysArg: string) {
  const days = num(daysArg, 30);
  const signals = readJson<Signal[]>(FILES.signals, []).filter((s) => s.direction > 0 && s.priceAtSignal && Date.now() - s.createdAt <= days * 86400000);
  if (!signals.length) { console.log(`Aucun signal long avec cours sur ${days} jours — lance des scans d'abord.`); return; }
  let wins = 0, sum = 0, best = -Infinity, worst = Infinity;
  const rows: string[] = [];
  for (const s of signals) {
    let now: number;
    try { now = (await getQuote(s.ticker)).price; } catch { continue; }
    const ret = ((now - (s.priceAtSignal as number)) / (s.priceAtSignal as number)) * 100;
    if (ret > 0) wins++;
    sum += ret; best = Math.max(best, ret); worst = Math.min(worst, ret);
    rows.push(`  ${new Date(s.createdAt).toLocaleDateString("fr-CA")}  ${s.ticker.padEnd(8)} ${(s.priceAtSignal as number).toFixed(2).padStart(8)} → ${now.toFixed(2).padStart(8)}  ${pct(ret)}  (${s.event}, ${s.score})`);
  }
  const n = rows.length;
  console.log(`Backtest ${days} j — signaux longs « achat et détiens » :`);
  console.log(rows.join("\n"));
  if (n) {
    console.log("");
    console.log(`Résultat : ${n} signaux, réussite ${((wins / n) * 100).toFixed(0)} %, rendement moyen ${pct(sum / n)}, meilleur ${pct(best)}, pire ${pct(worst)}.`);
    console.log("⚠ Projection naïve (achat au signal, détiens jusqu'à maintenant) — ne prédit rien.");
  }
}

async function cmdWatchlist(op: string, symRaw: string) {
  const cfg = loadConfig();
  const w = loadWatchlist(cfg);
  const sym = symRaw.toUpperCase().trim();
  if (op === "add") {
    if (!sym || !/^[A-Z0-9.\-]+$/.test(sym)) { console.error("Symbole invalide"); process.exit(1); }
    if (!w.includes(sym)) w.unshift(sym);
    writeJson(FILES.watchlist, w);
    console.log(`✔ ${sym} ajouté — watchlist : ${w.join(", ")}`);
  } else if (op === "remove") {
    const i = w.indexOf(sym);
    if (i >= 0) w.splice(i, 1);
    writeJson(FILES.watchlist, w);
    console.log(`✔ ${sym} retiré — watchlist : ${w.join(", ") || "(vide)"}`);
  } else {
    console.log(w.join(", "));
  }
}

async function cmdReset() {
  if (!flag("--yes")) { console.error("Confirmé ? Ajoute --yes"); process.exit(1); }
  const cfg = loadConfig();
  const f = path(FILES.portfolio);
  if (existsSync(f)) { try { renameSync(f, `${f}.bak-${Date.now()}`); } catch {} }
  loadPortfolio(cfg);
  writeJson(FILES.signals, []);
  console.log(`✔ Portefeuille réinitialisé à ${money(cfg.startingCash, cfg.currency)}.`);
}

async function cmdStatus() {
  const cfg = loadConfig();
  const p = loadPortfolio(cfg);
  const signals = readJson<Signal[]>(FILES.signals, []);
  const mv = marketValue(p);
  const state = {
    cash: +p.cash.toFixed(2), marketValue: +mv.toFixed(2), pnl: +(mv - p.startCash).toFixed(2),
    pnlPct: +(((mv - p.startCash) / p.startCash) * 100).toFixed(2),
    positions: Object.keys(p.positions).length, signals24h: signals.filter((s) => Date.now() - s.createdAt < 86400000).length,
    marketOpen: marketOpen(), autoTrade: cfg.autoTrade, currency: p.currency,
    lastScan: p.lastScan, lastTick: p.lastTick,
  };
  if (flag("--json")) console.log(JSON.stringify(state));
  else console.log(`Portefeuille ${money(mv, p.currency)} — P&L ${money(state.pnl, p.currency)} (${pct(state.pnlPct)}) — ${state.positions} positions — ${state.signals24h} signaux 24 h — marché ${state.marketOpen ? "ouvert" : "fermé"}${state.autoTrade ? " — AUTO" : ""}`);
}

// ------------------------------------------------------------------ dispatch

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case "scan": return cmdScan();
    case "tick": return cmdTick();
    case "trade": return cmdTrade(a ?? "", b ?? "");
    case "close": return cmdClose(a ?? "");
    case "report": return cmdReport();
    case "backtest": return cmdBacktest(a ?? "30");
    case "watchlist": return cmdWatchlist(a ?? "", b ?? "");
    case "reset": return cmdReset();
    case "status": return cmdStatus();
    case "quote": {
      try {
        const q = await getQuote((a ?? "").toUpperCase());
        if (flag("--json")) console.log(JSON.stringify(q));
        else console.log(`${q.symbol} : ${q.price.toFixed(2)} (${q.source})`);
      } catch (e) { console.error(String((e as Error).message)); process.exit(1); }
      return;
    }
    default:
      console.log("ob-plugin-news-trader-engine — simulation bourse pilotée par les nouvelles");
      console.log("Commandes : scan | tick | trade buy|sell SYM [qty] [--reason \"…\"] | close SYM | report | backtest [jours] | watchlist [add|remove SYM] | reset --yes | status [--json] | quote SYM [--json]");
      console.log("⚠ Simulation — aucun argent réel. Ne constitue pas un conseil financier.");
  }
}
main();
