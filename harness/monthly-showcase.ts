// Monthly "best of" page, no LLM: the month's top-scored published nights from the ledger, written to
// site/monthly/<YYYY-MM>/index.html plus showcase.json.
// Usage: tsx harness/monthly-showcase.ts [--month YYYY-MM] [--ledger P] [--site DIR] [--top N]
// --month defaults to the previous calendar month (UTC), since the workflow runs on the 1st.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findRepoRoot } from "./config.js";
import { readLedger } from "./novelty.js";
import type { LedgerEntry, Meta } from "./types.js";

export interface ShowcaseEntry {
  rank: number;
  date: string;
  score: number;
  compo: string;
  domain: string;
  title: string | null;
  concept: string | null;
  liner_note: string | null;
  piece: string;
  thumbnail: string | null;
}

export function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/** Published, scored nights of `month`, best first (earlier date wins a tie). Shelved and B-side nights never appear. */
export function selectShowcase(ledger: LedgerEntry[], month: string, top = 5): LedgerEntry[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`month must be YYYY-MM, got '${month}'`);
  return ledger
    .filter((e) => e.date.startsWith(`${month}-`) && e.status === "published" && e.score !== null)
    .sort((a, b) => b.score! - a.score! || a.date.localeCompare(b.date))
    .slice(0, top);
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderShowcase(month: string, entries: ShowcaseEntry[]): string {
  const cards = entries
    .map(
      (e) => `<li>
<a href="${esc(e.piece)}">${e.thumbnail ? `<img src="${esc(e.thumbnail)}" alt="" width="426" height="240" loading="lazy">` : ""}
<h2>${e.rank}. ${esc(e.title ?? e.concept ?? e.date)}</h2></a>
<p class="m">${esc(e.date)} · ${esc(e.compo)} · ${esc(e.domain)} · score ${e.score}</p>
${e.liner_note ? `<p>${esc(e.liner_note)}</p>` : ""}
</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Best of ${esc(month)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f1;--fg:#1b1b1b;--mut:#666}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--mut:#999}}
body{margin:0 auto;max-width:900px;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
ol{list-style:none;padding:0;display:grid;gap:32px}
a{color:inherit;text-decoration:none}
img{width:100%;height:auto;display:block;border-radius:4px}
h2{margin:8px 0 0;font-size:1.2rem}
.m{color:var(--mut);margin:4px 0}
</style>
</head>
<body>
<h1>Best of ${esc(month)}</h1>
${entries.length ? `<ol>\n${cards}\n</ol>` : "<p>No piece was published this month.</p>"}
<p><a href="../../">Back to the gallery</a></p>
</body>
</html>
`;
}

/** Writes <site>/monthly/<month>/{index.html, showcase.json}. Returns the entries. */
export function buildMonthlyShowcase(o: { month: string; ledger: LedgerEntry[]; siteDir: string; top?: number }): ShowcaseEntry[] {
  const entries = selectShowcase(o.ledger, o.month, o.top).map((e, i): ShowcaseEntry => {
    const pieceDir = join(o.siteDir, "pieces", e.date);
    const meta = existsSync(join(pieceDir, "meta.json")) ? (JSON.parse(readFileSync(join(pieceDir, "meta.json"), "utf8")) as Meta) : null;
    return {
      rank: i + 1,
      date: e.date,
      score: e.score!,
      compo: e.compo,
      domain: e.domain,
      title: meta?.brief?.title ?? null,
      concept: e.concept,
      liner_note: meta?.liner_note ?? null,
      piece: `../../pieces/${e.date}/index.html`,
      thumbnail: existsSync(join(pieceDir, "shot-08s.png")) ? `../../pieces/${e.date}/shot-08s.png` : null,
    };
  });
  const dir = join(o.siteDir, "monthly", o.month);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), renderShowcase(o.month, entries));
  writeFileSync(join(dir, "showcase.json"), `${JSON.stringify({ month: o.month, entries }, null, 2)}\n`);
  return entries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: o } = parseArgs({
    options: { month: { type: "string" }, ledger: { type: "string" }, site: { type: "string" }, top: { type: "string" } },
  });
  const root = findRepoRoot();
  const month = o.month || previousMonth();
  const entries = buildMonthlyShowcase({
    month,
    ledger: readLedger(o.ledger ?? join(root, "ledger", "ledger.jsonl"), root),
    siteDir: resolve(o.site ?? join(root, "site")),
    top: o.top ? Number(o.top) : 5,
  });
  process.stdout.write(`${JSON.stringify({ month, count: entries.length, dates: entries.map((e) => e.date) })}\n`);
}
