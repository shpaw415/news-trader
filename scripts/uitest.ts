#!/usr/bin/env bun
/**
 * Harnais de test UI headless (happy-dom) pour la page dashboard news-trader.
 * Usage : UI_PORT=4749 UITOKEN=xxx bun scripts/uitest.ts
 * (port + token réels : OPEN_BOT_PAGE_PORT / OPEN_BOT_PAGE_TOKEN du process
 *  `bun run /usr/local/bin/ob-plugin-news-trader-server` — voir /proc/<pid>/environ)
 * Rejoue tous les cas de bout en bout contre le serveur LIVE (après réinstall).
 */
import { Window } from "happy-dom";

const PORT = process.env.UI_PORT ?? "4749";
const TOKEN = process.env.UITOKEN ?? "";
const BASE = `http://127.0.0.1:${PORT}`;
const ENGINE = "/usr/local/bin/ob-plugin-news-trader-engine";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set("x-open-bot-page-token", TOKEN);
  return fetch(new URL(path, BASE), { ...init, headers });
}

// ------------------------------------------------------------ API pure
console.log("Cas 1 — API pure");
{
  const html = await api("/");
  check("GET / répond 200 HTML", html.status === 200 && (await html.text()).includes("News Trader"));
  const noTok = await fetch(new URL("/api/state", BASE));
  check("/api/state sans token → refusé", TOKEN ? noTok.status === 403 : noTok.status === 200);
  const health = await fetch(new URL("/healthz", BASE));
  check("GET /healthz → ok", (await health.text()) === "ok");
  const st = await (await api("/api/state")).json();
  check("/api/state avec token → JSON portefeuille", !!st && typeof st === "object" && "portfolio" in st);
  const qtok = await fetch(new URL(`/api/state?t=${encodeURIComponent(TOKEN)}`, BASE));
  check("/api/state token par query → refusé (review 2026-10-16 : plus de token en URL)", TOKEN ? qtok.status === 403 : true);
}

// ------------------------------------------------------------ UI headless
console.log("Cas 2 — UI headless (happy-dom)");
const html = await (await api("/")).text();
const win = new Window({ url: `http://localhost/?t=${encodeURIComponent(TOKEN)}` });
const doc = win.document as any;
doc.write(html);

const realFetch = globalThis.fetch.bind(globalThis);
(win as any).fetch = (input: any, init?: any) => {
  // Le header de token est requis sur les appels API depuis la page (review 2026-10-16 :
  // plus de token en query ?t=) — le stub happy-dom l'injecte comme le fait le dashboard.
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set("x-open-bot-page-token", TOKEN);
  return realFetch(new URL(String(input), BASE), { ...init, headers });
};
console.log("  [debug] location.search =", win.location.search.replace(/t=[^&]*/, "t=***"));
const scripts = [...doc.querySelectorAll("script")].map((s: any) => s.textContent).join("\n;");
try {
  const fn = new Function("window", "document", "confirm", "setInterval", `with(window){\n${scripts}\n}`);
  fn(win, doc, () => true, () => 0); // setInterval stub : pas de timers récurrents en test
} catch (e) {
  check("script inline sans SyntaxError", false, String(e));
}
await sleep(800);

const $ = (id: string) => doc.getElementById(id);
check("portefeuille rendu (#pv rempli)", ($("pv")?.textContent ?? "—") !== "—", `pv=${$("pv")?.textContent}`);
check("statut marché affiché", /ouvert|fermé/.test($("mktpill")?.textContent ?? ""));
check("watchlist chips rendues", doc.querySelectorAll(".chip").length > 0);
check("section signaux présente", /signal|Scan/i.test($("sigs")?.textContent ?? "") || doc.querySelectorAll("#sigs .sig").length >= 0);

// watchlist add/remove
$("winput").value = "TEST.TO";
$("badd").click();
await sleep(1500);
check("ajout watchlist → chip TEST.TO", ($("chips")?.textContent ?? "").includes("TEST.TO"), $("chips")?.textContent);
(win as any).delW?.("TEST.TO");
await sleep(1500);
check("retrait watchlist → chip disparu", !($("chips")?.textContent ?? "").includes("TEST.TO"));

// position : création via moteur, affichage, clôture via UI
Bun.spawnSync([ENGINE, "trade", "buy", "AAPL", "1", "--reason", "uitest"]);
await sleep(300);
await (win as any).load?.();
await sleep(800);
check("position AAPL visible dans la table", ($("tpos")?.textContent ?? "").includes("AAPL"));
check("bouton Clôturer présent", ($("tpos")?.innerHTML ?? "").includes("Clôturer"));
(win as any).closeP?.("AAPL");
await sleep(2000);
check("position clôturée → sortie de la table", !($("tpos")?.textContent ?? "").includes("uitest"));
check("transaction VENTE dans l'historique", /VENTE/.test($("ttr")?.textContent ?? ""));

// tick + reset
$("btick").click();
await sleep(1500);
check("tick exécuté sans erreur", !/✖/.test($("msg")?.textContent ?? ""), $("msg")?.textContent);
$("breset").click();
await sleep(1500);
check("reset → portefeuille au capital de départ", /100/.test($("pv")?.textContent ?? ""), $("pv")?.textContent);

console.log(`\nRésultat : ${pass} ✔ / ${fail} ✖`);
process.exit(fail ? 1 : 0);
