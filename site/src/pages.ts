// Page renderers for the static gallery. Pure functions: data in, HTML string out.
// Every string from meta.json, the ledger or the showcase is untrusted and goes through esc() or safeUrl().
import type { LedgerEntry, Meta, Mood, Pad, RubricKey } from "../../harness/types.js";
import type { ShowcaseEntry } from "../../harness/monthly-showcase.js";

export interface Showcase {
  month: string;
  entries: ShowcaseEntry[];
}

export interface EmotionState {
  baseline?: number[];
  mood?: number[];
  sentiments?: Record<string, { liking?: number }>;
}

export interface Compo {
  id: string;
  label: string;
  size_budget_bytes: number;
}

export interface PreviewInfo {
  /** One line shown in every footer. */
  note: string;
  /** Extra line per date, shown beside the score breakdown. */
  pieceNotes: Record<string, string>;
  /** Dates the front page ignores when choosing its hero. */
  frontSkip: string[];
}

export interface SiteData {
  metas: Meta[];
  ledger: LedgerEntry[];
  emotion: EmotionState | null;
  showcases: Showcase[];
  compos: Compo[];
  /** Dates whose screenshot files were copied into dist, keyed by date. */
  shots: Record<string, { t2: boolean; t8: boolean; t20: boolean }>;
  preview?: PreviewInfo;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Returns the URL only when it parses as http or https; anything else (javascript:, data:, relative) is dropped. */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const RUBRIC: Array<[RubricKey, string, number]> = [
  ["mechanism", "Mechanism", 20],
  ["ambition", "Ambition", 25],
  ["craft", "Craft", 25],
  ["distinctness", "Distinctness", 20],
  ["polish", "Polish", 10],
];

const SHELF: Record<string, string> = { published: "Published", "b-side": "B-side", shelved: "Shelved" };
const n2 = (x: number): string => (Math.round(x * 100) / 100).toFixed(2);
const shipped = (m: Meta): boolean => (m.status === "published" || m.status === "b-side") && m.piece_rel_path !== null;
const titleOf = (m: Meta): string => m.brief?.title ?? m.date;
const scoreOf = (m: Meta): number | null => m.attempts.find((a) => a.attempt === m.best_attempt)?.verdict?.total ?? null;
/** Escaped prose with straight apostrophes inside words set curly. */
const prose = (s: unknown): string => esc(String(s ?? "").replace(/(\w)'(\w)/g, "$1\u2019$2"));
const time = (d: string): string => `<time datetime="${esc(d)}">${esc(d)}</time>`;

function compoLabel(data: SiteData, id: string): string {
  return data.compos.find((c) => c.id === id)?.label ?? id;
}

// ---------- layout ----------

type Current = "front" | "archive" | "crew" | "monthly" | null;

/** Doctype through the skip link, shared by every gallery page. */
function docHead(o: { title: string; description: string; hero: "ledge" | "stage" | "banner"; up: string; head?: string; bodyClass?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sofia+Sans+Extra+Condensed:wght@200;400&amp;family=Barlow:wght@300;400&amp;display=swap">
<link rel="stylesheet" href="${o.up}assets/gallery.css">
<style>/* Hallmark · hero: ${o.hero} */</style>
${o.head ?? ""}</head>
<body${o.bodyClass ? ` class="${o.bodyClass}"` : ""}>
<a class="skip" href="#main">Skip to content</a>
`;
}

function layout(o: { title: string; description: string; hero: "ledge" | "stage" | "banner"; depth: number; current: Current; body: string; data: SiteData; head?: string; scripts?: string[] }): string {
  const up = "../".repeat(o.depth);
  const link = (href: string, label: string, key: Current): string =>
    `<li><a href="${up}${href}"${o.current === key ? ' aria-current="page"' : ""}>${label}</a></li>`;
  return `${docHead({ ...o, up })}<header class="bar">
<div class="container">
<a class="wordmark" href="${up}index.html">Nightly Demoparty</a>
<nav aria-label="Site">
<ul class="nav">
${link("index.html", "Tonight", "front")}
${link("archive/index.html", "Archive", "archive")}
${link("crew/index.html", "The crew", "crew")}
${link("monthly/index.html", "Monthly", "monthly")}
</ul>
</nav>
</div>
</header>
<main id="main">
${o.body}
</main>
<footer class="foot">
<div class="container">
<p class="statement">One piece a night, or a plain note saying why not.</p>
<ul class="links">
${link("index.html", "Tonight", null)}
${link("archive/index.html", "Archive", null)}
${link("crew/index.html", "The crew", null)}
${link("monthly/index.html", "Monthly showcase", null)}
</ul>
${o.data.preview ? `<p class="note">${esc(o.data.preview.note)}</p>` : ""}
</div>
</footer>
${(o.scripts ?? []).map((s) => `<script src="${up}${s}" defer></script>`).join("\n")}
</body>
</html>
`;
}

// ---------- charts ----------

/** A small three-spoke glyph: pleasure up, arousal lower right, dominance lower left, each spoke as long as its value. */
export function moodGlyph(pad: Pad): string {
  const c = 28;
  const spokes = [pad.pleasure, pad.arousal, pad.dominance].map((v, i) => {
    const a = ((-90 + i * 120) * Math.PI) / 180;
    const r = 4 + 22 * ((Math.max(-1, Math.min(1, v)) + 1) / 2);
    return { x: c + r * Math.cos(a), y: c + r * Math.sin(a), ax: c + 26 * Math.cos(a), ay: c + 26 * Math.sin(a) };
  });
  const label = `Mood glyph: pleasure ${n2(pad.pleasure)}, arousal ${n2(pad.arousal)}, dominance ${n2(pad.dominance)}`;
  return `<svg class="glyph" viewBox="0 0 56 56" role="img" aria-label="${esc(label)}">
<circle class="ring" cx="${c}" cy="${c}" r="26"/>
${spokes.map((s) => `<line class="axis" x1="${c}" y1="${c}" x2="${s.ax.toFixed(1)}" y2="${s.ay.toFixed(1)}"/>`).join("")}
<polygon class="shape" points="${spokes.map((s) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" ")}"/>
</svg>`;
}

/** Pleasure, arousal and dominance as diverging bars on a -1 to 1 axis. */
export function padPlot(pad: Pad): string {
  const W = 560;
  const L = 110;
  const R = 56;
  const span = W - L - R;
  const x = (v: number): number => L + ((Math.max(-1, Math.min(1, v)) + 1) / 2) * span;
  const rows = [
    ["Pleasure", pad.pleasure],
    ["Arousal", pad.arousal],
    ["Dominance", pad.dominance],
  ] as const;
  const H = rows.length * 44 + 28;
  const ticks = [-1, -0.5, 0, 0.5, 1];
  const bars = rows
    .map(([name, v], i) => {
      const y = 8 + i * 44;
      const x0 = Math.min(x(0), x(v));
      const w = Math.abs(x(v) - x(0));
      return `<text x="0" y="${y + 17}">${name}</text>
<rect class="bar" x="${x0.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="20"/>
<text x="${W - 4}" y="${y + 17}" text-anchor="end">${n2(v)}</text>`;
    })
    .join("\n");
  const grid = ticks
    .map((t) => `<line class="${t === 0 ? "zero" : "grid"}" x1="${x(t)}" y1="4" x2="${x(t)}" y2="${H - 24}"/><text x="${x(t)}" y="${H - 4}" text-anchor="middle">${t}</text>`)
    .join("");
  const label = `Mood at build time on a scale of minus one to one: pleasure ${n2(pad.pleasure)}, arousal ${n2(pad.arousal)}, dominance ${n2(pad.dominance)}`;
  return `<svg class="chart pad-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
${grid}
${bars}
</svg>`;
}

/** Labelled values from zero to one as horizontal bars. */
export function emotionBars(list: Array<{ label: string; value: number }>, title: string): string {
  const W = 560;
  const L = 110;
  const R = 56;
  const span = W - L - R;
  const H = list.length * 44 + 28;
  const ticks = [0, 0.5, 1];
  const grid = ticks
    .map((t) => `<line class="${t === 0 ? "zero" : "grid"}" x1="${L + t * span}" y1="4" x2="${L + t * span}" y2="${H - 24}"/><text x="${L + t * span}" y="${H - 4}" text-anchor="middle">${t}</text>`)
    .join("");
  const bars = list
    .map((e, i) => {
      const y = 8 + i * 44;
      const v = Math.max(0, Math.min(1, e.value));
      return `<text x="0" y="${y + 17}">${esc(e.label)}</text>
<rect class="${i === 0 ? "bar" : "bar-2"}" x="${L}" y="${y + 4}" width="${(v * span).toFixed(1)}" height="20"/>
<text x="${W - 4}" y="${y + 17}" text-anchor="end">${n2(v)}</text>`;
    })
    .join("\n");
  const label = `${title}: ${list.map((e) => `${e.label} ${n2(e.value)}`).join(", ")}`;
  return `<svg class="chart emotion-bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
${grid}
${bars}
</svg>`;
}

/** Pleasure, arousal and dominance over nights. With no nights, the baseline as flat lines. */
export function padTimeline(points: Array<{ date: string; pad: Pad }>, baseline: Pad | null): string {
  const W = 1000;
  const H = 360;
  const L = 88;
  const R = 16;
  const T = 16;
  const B = 64;
  const y = (v: number): number => T + ((1 - Math.max(-1, Math.min(1, v))) / 2) * (H - T - B);
  const xs = (i: number, n: number): number => (n <= 1 ? L + (W - L - R) / 2 : L + (i / (n - 1)) * (W - L - R));
  const grid = [-1, -0.5, 0, 0.5, 1]
    .map((t) => `<line class="${t === 0 ? "zero" : "grid"}" x1="${L}" y1="${y(t)}" x2="${W - R}" y2="${y(t)}"/><text x="${L - 12}" y="${y(t)}" text-anchor="end" dominant-baseline="middle">${t}</text>`)
    .join("");
  const keys: Array<keyof Pad> = ["pleasure", "arousal", "dominance"];
  let series = "";
  let xlabels = "";
  let label: string;
  if (points.length) {
    series = keys
      .map((k, si) => {
        const pts = points.map((p, i) => `${xs(i, points.length).toFixed(1)},${y(p.pad[k]).toFixed(1)}`);
        const dots = points.map((p, i) => `<circle class="d${si + 1}" cx="${xs(i, points.length).toFixed(1)}" cy="${y(p.pad[k]).toFixed(1)}" r="3"/>`).join("");
        return `<polyline class="s${si + 1}" points="${pts.join(" ")}"/>${dots}`;
      })
      .join("\n");
    // At most four date labels, evenly spaced, so they never crowd at the larger mobile type.
    const n = points.length;
    const step = Math.max(1, Math.ceil((n - 1) / 3));
    xlabels = points
      .map((p, i) => {
        if (i !== n - 1 && (i % step !== 0 || n - 1 - i < step)) return "";
        // First and last labels hug the plot edges so the larger mobile type never runs past the frame.
        const anchor = points.length > 1 && i === 0 ? "start" : points.length > 1 && i === points.length - 1 ? "end" : "middle";
        return `<text x="${xs(i, points.length).toFixed(1)}" y="${H - 16}" text-anchor="${anchor}">${esc(p.date)}</text>`;
      })
      .join("");
    label = `Pleasure, arousal and dominance over ${points.length} night${points.length === 1 ? "" : "s"}, from ${points[0]!.date} to ${points[points.length - 1]!.date}`;
  } else if (baseline) {
    series = keys.map((k, si) => `<line class="s${si + 1}" x1="${L}" y1="${y(baseline[k]).toFixed(1)}" x2="${W - R}" y2="${y(baseline[k]).toFixed(1)}"/>`).join("\n");
    xlabels = `<text x="${(L + W - R) / 2}" y="${H - 16}" text-anchor="middle">baseline, before the first night</text>`;
    label = `Baseline mood before the first night: pleasure ${n2(baseline.pleasure)}, arousal ${n2(baseline.arousal)}, dominance ${n2(baseline.dominance)}`;
  } else {
    label = "No mood recorded yet";
  }
  return `<svg class="chart pad-timeline" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
${grid}
${series}
${xlabels}
</svg>
<ul class="legend" aria-hidden="true"><li><span class="swatch k1"></span>Pleasure</li><li><span class="swatch k2"></span>Arousal</li><li><span class="swatch k3"></span>Dominance</li></ul>`;
}

// ---------- shared parts ----------

function cover(data: SiteData, m: Meta, up: string, headingLevel = 3): string {
  const t = data.shots[m.date];
  const img = t?.t8
    ? `<img src="${up}pieces/${m.date}/shot-08s.png" alt="${esc(`${titleOf(m)} at eight seconds`)}" width="1280" height="720" loading="lazy">`
    : "";
  const score = scoreOf(m);
  const h = `h${headingLevel}`;
  return `<a href="${up}pieces/${m.date}/index.html">${img}<${h}>${esc(titleOf(m))}</${h}></a>
<dl>
<div><dt class="visually-hidden">Night</dt><dd>${time(m.date)}</dd></div>
<div><dt class="visually-hidden">Compo</dt><dd>${esc(compoLabel(data, m.plan.compo))}</dd></div>
${score !== null ? `<div><dt>Score</dt><dd class="num">${score}</dd></div>` : ""}
<div><dt class="visually-hidden">Shelf</dt><dd>${SHELF[m.status]}</dd></div>
</dl>`;
}

function coverSection(data: SiteData, list: Meta[], heading: string, line: string, up: string, cls = ""): string {
  if (!list.length) return "";
  return `<section class="${cls}" aria-labelledby="${cls || "more"}-h">
<div class="container">
<div class="head"><h2 id="${cls || "more"}-h">${heading}</h2><p>${line}</p></div>
<ul class="${coversClass(list.length)}">
${list.map((m) => `<li class="cover">${cover(data, m, up)}</li>`).join("\n")}
</ul>
</div>
</section>`;
}

const coversClass = (n: number): string => (n === 1 ? "covers covers--1" : n === 2 ? "covers covers--2" : "covers");

// ---------- front page ----------

export function renderFront(data: SiteData): string {
  const skip = new Set(data.preview?.frontSkip ?? []);
  const nights = [...data.metas].filter((m) => !skip.has(m.date)).sort((a, b) => b.date.localeCompare(a.date));
  const latest = nights[0];
  const published = nights.filter((m) => m.status === "published" && shipped(m));
  const bsides = nights.filter((m) => m.status === "b-side" && shipped(m));
  let hero: string;
  let heroPiece: Meta | null = null;
  if (!latest) {
    hero = plate(
      "Nothing has run yet",
      "When the first night publishes, its piece plays here.",
      [["archive/index.html", "Browse the archive"], ["crew/index.html", "Meet the crew"]],
      "",
    );
  } else if (latest.status === "shelved") {
    hero = plate(
      "No release tonight",
      latest.reason ?? "The crew shelved tonight’s piece.",
      [["archive/index.html", "Browse the archive"], ["crew/index.html", "Meet the crew"]],
      time(latest.date),
      "no-release",
    );
  } else if (latest.status === "published" && shipped(latest)) {
    heroPiece = latest;
    hero = stageHero(data, latest);
  } else if (published[0]) {
    heroPiece = published[0];
    hero = stageHero(data, published[0]);
  } else {
    hero = plate(
      "No main stage release yet",
      "Every night so far has landed on the B-sides shelf below, under the publish threshold.",
      [["archive/index.html", "Browse the archive"], ["crew/index.html", "Meet the crew"]],
      "",
      "no-main-stage",
    );
  }
  const earlier = published.filter((m) => m !== heroPiece).slice(0, 6);
  const sections = [
    coverSection(data, bsides.slice(0, 6), "B-sides shelf", "Nights that shipped a working piece but scored under the publish threshold.", "", "b-sides"),
    coverSection(data, earlier, "Earlier releases", "Published nights before this one.", "", "earlier"),
  ].filter(Boolean);
  if (!data.metas.length) sections.push(composSection(data));
  return layout({ title: heroPiece ? `${titleOf(heroPiece)}, Nightly Demoparty` : "Nightly Demoparty", description: "A generative demoscene piece made every night, with its liner note, jury score and the crew’s mood.", hero: "ledge", depth: 0, current: "front", data, head: heroPiece ? `<style>/* Hallmark · dismissed 58 · the hero headline and its sentence are the night’s own title and concept from meta.json, printed as the pipeline wrote them */</style>\n` : "", body: `${hero}\n${sections.join("\n")}` });
}

function plate(head: string, line: string, actions: Array<[string, string]>, when: string, id = "pre-launch"): string {
  return `<section class="plate-wrap" id="${id}" aria-labelledby="${id}-h">
<div class="container plate">
<div class="title">${when}<h1 id="${id}-h">${esc(head)}</h1></div>
<div class="side">
<p class="lead">${esc(line)}</p>
<div class="actions">${actions.map(([href, label], i) => `<a class="btn${i === 0 ? " btn--primary" : ""}" href="${href}">${label}</a>`).join("")}</div>
</div>
</div>
</section>`;
}

function stageHero(data: SiteData, m: Meta): string {
  const glyph = m.mood ? moodGlyph(m.mood.pad) : "";
  return `<section class="hero" aria-labelledby="hero-h">
<div class="stage">
<iframe sandbox="allow-scripts" src="pieces/${m.date}/piece.html" title="${esc(`${titleOf(m)}, running live`)}" allow="autoplay" tabindex="-1"></iframe>
</div>
<div class="container hero-text">
<div class="title">
<h1 id="hero-h">${esc(titleOf(m))}</h1>
</div>
<div class="side">
<p class="lead">${prose(m.brief?.concept)}</p>
<div class="actions"><a class="btn btn--primary" href="pieces/${m.date}/index.html">Read the liner note</a><a class="btn" href="pieces/${m.date}/stage.html">Full screen</a></div>
<p class="byline">${glyph}${time(m.date)}<span>${esc(compoLabel(data, m.plan.compo))}</span></p>
</div>
</div>
</section>`;
}

function composSection(data: SiteData): string {
  if (!data.compos.length) return "";
  return `<section aria-labelledby="compos-h">
<div class="container">
<div class="head"><h2 id="compos-h">The compos</h2><p>Each night draws one compo, and the piece must fit its byte budget.</p></div>
<dl class="sheet">
${data.compos.map((c) => `<div><dt class="num">${(c.size_budget_bytes / 1024).toFixed(0)}&nbsp;KB</dt><dd class="big">${esc(c.label)}</dd></div>`).join("\n")}
</dl>
</div>
</section>`;
}

// ---------- piece page ----------

export function sourcesOf(m: Meta): Array<{ url: string; title: string }> {
  const seen = new Map<string, string>();
  for (const f of m.dossier?.facts ?? []) {
    const u = safeUrl(f.source_url);
    if (u && !seen.has(u)) seen.set(u, f.source_title || u);
  }
  const ds = safeUrl(m.dossier?.dataset?.source_url);
  if (ds && !seen.has(ds)) seen.set(ds, m.dossier?.dataset?.description || ds);
  return [...seen].map(([url, title]) => ({ url, title }));
}

export function renderPiece(data: SiteData, m: Meta): string {
  const up = "../../";
  const best = m.attempts.find((a) => a.attempt === m.best_attempt);
  const v = best?.verdict ?? null;
  const shots = data.shots[m.date] ?? { t2: false, t8: false, t20: false };
  const stills = (
    [
      ["t2", "shot-02s.png", "At 2 seconds"],
      ["t8", "shot-08s.png", "At 8 seconds"],
      ["t20", "shot-20s.png", "At 20 seconds"],
    ] as const
  )
    .filter(([k]) => shots[k])
    .map(([, f, cap]) => `<figure><img src="${f}" alt="${esc(`${titleOf(m)}, ${cap.toLowerCase()}`)}" width="1280" height="720" loading="lazy"><figcaption>${cap}</figcaption></figure>`);
  const sources = sourcesOf(m);
  const techniques = m.brief?.techniques ?? [];
  const domain = m.dossier?.domain ?? m.plan.domain;
  const previewLine = data.preview?.pieceNotes[m.date];
  const scoreRows = v
    ? RUBRIC.map(
        ([k, name, max]) =>
          `<tr><td data-label="Criterion">${name}</td><td class="score num" data-label="Score">${esc(v.scores[k])}<span class="muted">/${max}</span></td><td class="evidence" data-label="Jury evidence">${prose(v.evidence[k])}</td></tr>`,
      ).join("\n")
    : "";
  const attemptRows = m.attempts
    .map((a) => {
      const gates = a.gates === null ? "no piece built" : a.gates.passed ? "passed" : `failed: ${a.gates.failures.map((f) => f.gate).join(", ") || "see log"}`;
      return `<tr><td class="num" data-label="Attempt">${a.attempt}</td><td data-label="Model">${esc(a.model)}${a.effort ? `, effort ${esc(a.effort)}` : ""}</td><td data-label="Hard gates">${esc(gates)}</td><td class="num" data-label="Score">${a.verdict ? a.verdict.total : "not judged"}</td><td data-label="Outcome">${esc(a.outcome.replace(/_/g, " "))}</td></tr>`;
    })
    .join("\n");
  const body = `<section class="container piece-hero" aria-labelledby="piece-h">
<figure class="frame"><iframe sandbox="allow-scripts" src="piece.html" title="${esc(`${titleOf(m)}, running live`)}" allow="autoplay" tabindex="-1"></iframe></figure>
<div class="text">
<h1 id="piece-h">${esc(titleOf(m))}</h1>
<p class="lead">${prose(m.brief?.concept)}</p>
<div class="actions"><a class="btn btn--primary" href="stage.html">Full screen</a><a class="btn" href="#note">Liner note</a></div>
<p class="byline">${time(m.date)}<span>${SHELF[m.status]}</span></p>
</div>
</section>
${stills.length ? `<section class="tight" aria-labelledby="stills-h"><div class="container"><h2 id="stills-h" class="visually-hidden">Captured stills</h2><div class="stills">${stills.join("\n")}</div></div></section>` : ""}
<section id="note" aria-labelledby="note-h">
<div class="container note">
<div class="note-text">
<h2 id="note-h">Liner note</h2>
<p>${prose(m.liner_note)}</p>
</div>
<dl class="sheet">
<div><dt>Night</dt><dd>${time(m.date)}</dd></div>
<div><dt>Compo</dt><dd>${esc(compoLabel(data, m.plan.compo))}</dd></div>
<div><dt>Domain</dt><dd>${esc(domain)}</dd></div>
<div><dt>Shelf</dt><dd>${SHELF[m.status]}</dd></div>
<div><dt>Techniques</dt><dd><ul class="tags">${techniques.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></dd></div>
${sources.length ? `<div><dt>Sources</dt><dd><ul class="sources">${sources.map((s) => `<li><span>${prose(s.title)}</span> <a href="${esc(s.url)}" rel="noopener noreferrer">${esc(new URL(s.url).hostname)}</a></li>`).join("")}</ul></dd></div>` : ""}
</dl>
</div>
</section>
${
  m.mood
    ? `<section class="well" aria-labelledby="mood-h">
<div class="container">
<div class="head"><h2 id="mood-h">Mood at build time</h2><p>The crew’s state when the brief was written, read from the emotion engine.</p></div>
<div class="charts charts--3">
<figure>${padPlot(m.mood.pad)}<figcaption>Pleasure, arousal and dominance, minus one to one</figcaption></figure>
<figure>${emotionBars(m.mood.dominant_emotions.map((e) => ({ label: e.label, value: e.intensity })), "Dominant emotions at build time")}<figcaption>Dominant emotions, zero to one</figcaption></figure>
<figure>${emotionBars(Object.entries(m.mood.derived_signals).map(([label, value]) => ({ label, value })), "Derived signals at build time")}<figcaption>Interest, boredom and frustration, zero to one</figcaption></figure>
</div>
</div>
</section>`
    : ""
}
${
  v
    ? `<section aria-labelledby="score-h">
<div class="container">
<div class="head"><h2 id="score-h">Jury score</h2><p>Attempt ${esc(m.best_attempt)} scored ${esc(v.total)} out of 100 against a publish threshold of ${esc(m.publish_threshold)}.${previewLine ? ` ${esc(previewLine)}` : ""}</p></div>
<table class="table">
<thead><tr><th scope="col">Criterion</th><th scope="col">Score</th><th scope="col">Jury evidence</th></tr></thead>
<tbody>
${scoreRows}
</tbody>
<tfoot><tr><td data-label="Criterion">Total</td><td class="score num" data-label="Score">${esc(v.total)}<span class="muted">/100</span></td><td data-label="Threshold">Threshold ${esc(m.publish_threshold)}</td></tr></tfoot>
</table>
</div>
</section>`
    : ""
}
<section aria-labelledby="attempts-h">
<div class="container">
<div class="head"><h2 id="attempts-h">Attempt history</h2><p>Every build the crew tried tonight, in order.</p></div>
<table class="table">
<thead><tr><th scope="col">Attempt</th><th scope="col">Model</th><th scope="col">Hard gates</th><th scope="col">Score</th><th scope="col">Outcome</th></tr></thead>
<tbody>
${attemptRows}
</tbody>
</table>
</div>
</section>`;
  // The liner note and the jury evidence are pipeline records, so Hallmark's copy gates read them as verbatim.
  const head = `<style>/* Hallmark · copy: verbatim · the liner note and the jury evidence are pipeline records, printed as written */</style>\n`;
  return layout({ title: `${titleOf(m)}, Nightly Demoparty`, description: m.brief?.concept ?? titleOf(m), hero: "stage", depth: 2, current: null, data, head, body });
}

/** Full-screen wrapper: the piece fills the viewport in a sandboxed frame, never top-level on the gallery origin. */
export function renderStage(m: Meta): string {
  const title = titleOf(m);
  return `${docHead({ title: `${title}, full screen, Nightly Demoparty`, description: m.brief?.concept ?? title, hero: "stage", up: "../../", bodyClass: "stage-page", head: `<style>/* Hallmark · copy: verbatim · the heading is the night’s own title from meta.json, printed as written */</style>\n` })}<header class="stage-bar">
<div class="container">
<h1>${esc(title)}</h1>
<nav aria-label="Piece">
<ul class="nav">
<li><a href="index.html">Back to liner note</a></li>
<li><a href="../../index.html">Nightly Demoparty</a></li>
</ul>
</nav>
</div>
</header>
<main id="main">
<div class="stage-full"><iframe sandbox="allow-scripts" src="piece.html" title="${esc(`${title}, running live`)}" allow="autoplay" tabindex="-1"></iframe></div>
</main>
</body>
</html>
`;
}

// ---------- archive ----------

function pageHead(id: string, head: string, lead: string): string {
  return `<section class="page-head-wrap" aria-labelledby="${id}"><div class="container page-head"><h1 id="${id}">${head}</h1><p class="lead">${lead}</p></div></section>`;
}

export function renderArchive(data: SiteData): string {
  const list = data.metas.filter(shipped).sort((a, b) => b.date.localeCompare(a.date));
  const opts = (vals: string[]): string => [...new Set(vals)].sort().map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  const items = list
    .map((m) => {
      const attrs = [
        `data-compo="${esc(m.plan.compo)}"`,
        `data-domain="${esc(m.dossier?.domain ?? m.plan.domain)}"`,
        `data-mood="${esc(m.mood?.dominant_emotions[0]?.label ?? "")}"`,
        `data-shelf="${esc(m.status)}"`,
        `data-techniques="${esc((m.brief?.techniques ?? []).join("|"))}"`,
      ].join(" ");
      return `<li class="cover" ${attrs}>${cover(data, m, "../", 2)}</li>`;
    })
    .join("\n");
  const body = list.length
    ? `<form class="filters" id="filters" hidden aria-label="Filter the archive">
<label>Compo<select name="compo"><option value="">All compos</option>${opts(list.map((m) => m.plan.compo))}</select></label>
<label>Technique<select name="techniques"><option value="">All techniques</option>${opts(list.flatMap((m) => m.brief?.techniques ?? []))}</select></label>
<label>Domain<select name="domain"><option value="">All domains</option>${opts(list.map((m) => m.dossier?.domain ?? m.plan.domain))}</select></label>
<label>Mood<select name="mood"><option value="">All moods</option>${opts(list.map((m) => m.mood?.dominant_emotions[0]?.label ?? "").filter(Boolean))}</select></label>
<label>Shelf<select name="shelf"><option value="">All</option><option value="published">Published</option><option value="b-side">B-sides</option></select></label>
<output name="count" aria-live="polite">Showing ${list.length} of ${list.length}</output>
</form>
<ul class="${coversClass(list.length)}" id="archive-list">
${items}
</ul>
<p class="empty" id="archive-none" hidden>Nothing matches those filters.</p>`
    : `<p class="empty">Nothing has shipped yet. The first night that does hangs here.</p>`;
  return layout({
    title: "Archive, Nightly Demoparty",
    description: "Every nightly piece that shipped, published and B-sides, filterable by compo, technique, domain and mood.",
    hero: "banner",
    depth: 1,
    current: "archive",
    data,
    scripts: list.length ? ["assets/archive.js"] : [],
    body: `${pageHead("archive-h", "Archive", "Every night that shipped a piece, shown at eight seconds.")}
<section class="tight" aria-label="Pieces"><div class="container">
${body}
</div></section>`,
  });
}

// ---------- the crew ----------

export interface Night {
  date: string;
  status: "published" | "b-side" | "shelved";
  reason: string | null;
}

/** One row per night: ledger rows first, meta.json fills nights the ledger lacks. */
export function nightsOf(data: SiteData): Night[] {
  const by = new Map<string, Night>();
  for (const m of data.metas) by.set(m.date, { date: m.date, status: m.status, reason: m.reason });
  for (const e of data.ledger) by.set(e.date, { date: e.date, status: e.status, reason: by.get(e.date)?.reason ?? null });
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function streaks(nights: Night[]): { published: number; bsides: number; shelved: number; publishedStreak: number; shelvedStreak: number } {
  const trailing = (s: Night["status"]): number => {
    let n = 0;
    for (let i = nights.length - 1; i >= 0 && nights[i]!.status === s; i--) n++;
    return n;
  };
  return {
    published: nights.filter((n) => n.status === "published").length,
    bsides: nights.filter((n) => n.status === "b-side").length,
    shelved: nights.filter((n) => n.status === "shelved").length,
    publishedStreak: trailing("published"),
    shelvedStreak: trailing("shelved"),
  };
}

type Taste = { topic: string; score: number };

/** Topic likes and dislikes from the engine state; before any are consolidated there, the latest night's mood. */
export function tastes(data: SiteData): { likes: Taste[]; dislikes: Taste[] } {
  const fromState = Object.entries(data.emotion?.sentiments ?? {})
    .filter(([k, v]) => k.startsWith("topic:") && typeof v?.liking === "number")
    .map(([k, v]) => ({ topic: k.slice(6), score: v.liking! }));
  let likes = fromState.filter((t) => t.score > 0.05);
  let dislikes = fromState.filter((t) => t.score < -0.05);
  if (!likes.length && !dislikes.length) {
    const latest = [...data.metas].filter((m) => m.mood).sort((a, b) => b.date.localeCompare(a.date))[0];
    likes = latest?.mood?.likes ?? [];
    dislikes = latest?.mood?.dislikes ?? [];
  }
  const top = (l: Taste[]): Taste[] => [...l].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 8);
  return { likes: top(likes), dislikes: top(dislikes) };
}

export function renderCrew(data: SiteData): string {
  const nights = nightsOf(data);
  const s = streaks(nights);
  const points = [...data.ledger]
    .filter((e) => e.mood_pad)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({ date: e.date, pad: e.mood_pad! }));
  const b = data.emotion?.baseline;
  const baseline = Array.isArray(b) && b.length === 3 ? { pleasure: b[0]!, arousal: b[1]!, dominance: b[2]! } : null;
  const t = tastes(data);
  const shelved = nights.filter((n) => n.status === "shelved").reverse();
  const tasteList = (l: Taste[], empty: string): string =>
    l.length ? `<ul class="ranks">${l.map((x) => `<li><span>${esc(x.topic)}</span><span class="num">${n2(x.score)}</span></li>`).join("")}</ul>` : `<p class="muted">${empty}</p>`;
  const tasteBody =
    t.likes.length || t.dislikes.length
      ? `<div class="charts">
<div><h3>Likes</h3>${tasteList(t.likes, "No likes consolidated yet.")}</div>
<div><h3>Dislikes</h3>${tasteList(t.dislikes, "No dislikes consolidated yet.")}</div>
</div>`
      : `<p class="empty">No likes or dislikes consolidated yet.</p>`;
  const body = `${pageHead("crew-h", "The crew", "The crew’s mood each night, its tastes, and its shelved nights.")}
<section class="tight" aria-labelledby="timeline-h">
<div class="container">
<div class="head"><h2 id="timeline-h">Mood over time</h2><p>${points.length ? "Pleasure, arousal and dominance after each night, from the ledger." : "No night has run yet, so the lines hold the crew’s baseline from the emotion engine."}</p></div>
<figure class="timeline">${padTimeline(points, baseline)}</figure>
</div>
</section>
<section class="well" aria-labelledby="counts-h">
<div class="container">
<div class="head"><h2 id="counts-h">Streaks and shelved nights</h2><p>Every night counted from the ledger, and each shelved night with the reason the crew gave.</p></div>
<div class="figures">
<div><b>${s.published}</b><span>published</span></div>
<div><b>${s.bsides}</b><span>B-sides</span></div>
<div><b>${s.shelved}</b><span>shelved</span></div>
<div><b>${s.publishedStreak}</b><span>published in a row, now</span></div>
<div><b>${s.shelvedStreak}</b><span>shelved in a row, now</span></div>
</div>
<div class="shelved-log">
<h3>Shelved nights</h3>
${shelved.length ? `<ol class="rows">${shelved.map((n) => `<li><span class="when">${time(n.date)}</span><p>${prose(n.reason ?? "No reason recorded.")}</p></li>`).join("\n")}</ol>` : `<p class="muted">No night has been shelved yet.</p>`}
</div>
</div>
</section>
<section aria-labelledby="tastes-h">
<div class="container">
<div class="head"><h2 id="tastes-h">Likes and dislikes</h2><p>Topics the crew has learned to want or avoid, scored minus one to one.</p></div>
${tasteBody}
</div>
</section>`;
  return layout({
    title: "The crew, Nightly Demoparty",
    description: "The crew’s mood over time, its likes and dislikes, its streaks, and every shelved night with its reason.",
    hero: "banner",
    depth: 1,
    current: "crew",
    data,
    body,
  });
}

// ---------- monthly ----------

export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function renderMonthlyIndex(data: SiteData): string {
  const months = [...data.showcases].filter((s) => MONTH_RE.test(s.month)).sort((a, b) => b.month.localeCompare(a.month));
  const row = (s: Showcase): string => {
    const lead = s.entries.find((e) => DATE_RE.test(e.date));
    const img = lead && data.shots[lead.date]?.t8 ? `<img src="../pieces/${lead.date}/shot-08s.png" alt="${esc(`${lead.title ?? lead.date} at eight seconds`)}" width="1280" height="720" loading="lazy">` : "";
    const line = s.entries.length
      ? `${s.entries.length} published piece${s.entries.length === 1 ? "" : "s"}, led by ${esc(lead?.title ?? lead?.date ?? "")}.`
      : "No piece was published this month.";
    return `<li class="month">${img ? `<a href="${s.month}/index.html" tabindex="-1" aria-hidden="true">${img}</a>` : ""}<div><h2><a href="${s.month}/index.html">${esc(monthName(s.month))}</a></h2><p>${line}</p></div></li>`;
  };
  const body = months.length ? `<ol>${months.map(row).join("\n")}</ol>` : `<p class="empty">No month has closed with a showcase yet.</p>`;
  return layout({
    title: "Monthly showcase, Nightly Demoparty",
    description: "The best published nightly pieces of each month, ranked by jury score.",
    hero: "banner",
    depth: 1,
    current: "monthly",
    data,
    body: `${pageHead("monthly-h", "Monthly", "The best published pieces of each month, ranked by jury score.")}
<section class="tight" aria-label="Months"><div class="container">
${body}
</div></section>`,
  });
}

export function renderMonth(data: SiteData, s: Showcase): string {
  const up = "../../";
  const entries = s.entries.filter((e) => DATE_RE.test(e.date));
  const items = entries
    .map((e) => {
      const thumb = data.shots[e.date]?.t8
        ? `<img src="${up}pieces/${e.date}/shot-08s.png" alt="${esc(`${e.title ?? e.date} at eight seconds`)}" width="1280" height="720" loading="lazy">`
        : "";
      return `<li class="cover"><a href="${up}pieces/${e.date}/index.html">${thumb}<h2>${esc(e.rank)}. ${esc(e.title ?? e.concept ?? e.date)}</h2></a>
<dl>
<div><dt>Night</dt><dd>${time(e.date)}</dd></div>
<div><dt>Compo</dt><dd>${esc(compoLabel(data, e.compo))}</dd></div>
<div><dt>Score</dt><dd class="num">${esc(e.score)}</dd></div>
</dl></li>`;
    })
    .join("\n");
  return layout({
    title: `Best of ${monthName(s.month)}, Nightly Demoparty`,
    description: `The best published nightly pieces of ${monthName(s.month)}, ranked by jury score.`,
    hero: "banner",
    depth: 2,
    current: "monthly",
    data,
    body: `${pageHead("month-h", esc(monthName(s.month)), "The month’s best published pieces, ranked by jury score.")}
<section class="tight" aria-label="Ranked pieces"><div class="container">
${items ? `<ol class="${coversClass(entries.length)}">${items}</ol>` : `<p class="empty">No piece was published this month.</p>`}
</div></section>`,
  });
}
