import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readdir, readFile } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { exec } from "node:child_process";
import { backfillMeta } from "./inferMeta.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const joined = normalize(join(root, decoded));
  const rootResolved = normalize(root);
  if (!joined.startsWith(rootResolved + sep) && joined !== rootResolved) return null;
  return joined;
}

async function listRuns(runsDir: string): Promise<{ id: string; mtime: number; size?: number; summary?: any }[]> {
  let entries;
  try { entries = await readdir(runsDir, { withFileTypes: true }); } catch { return []; }
  const out: { id: string; mtime: number; size?: number; summary?: any }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    const dir = join(runsDir, id);
    const jsonPath = join(dir, `${id}.json`);
    let mtime = 0;
    let summary: any = undefined;
    try { mtime = (await stat(jsonPath)).mtimeMs; } catch { continue; }
    try {
      const raw = await readFile(jsonPath, "utf8");
      const data = JSON.parse(raw);
      await backfillMeta(dir, data);
      const evals = data.evals || [];
      const total = evals.length;
      const pass = evals.filter((x: any) => (x.finalScore ?? x.judgment?.score ?? 0) >= 90).length;
      const partial = evals.filter((x: any) => {
        const s = x.finalScore ?? x.judgment?.score ?? 0;
        return s >= 60 && s < 90;
      }).length;
      const fail = evals.filter((x: any) => (x.finalScore ?? x.judgment?.score ?? 0) < 60 && !x.error).length;
      const errored = evals.filter((x: any) => !!x.error).length;
      const avg = total ? evals.reduce((a: number, x: any) => a + (x.finalScore ?? x.judgment?.score ?? 0), 0) / total : 0;
      summary = {
        timestamp: data.timestamp,
        duration: data.totalDuration,
        total,
        pass,
        partial,
        fail,
        errored,
        avg: Number(avg.toFixed(1)),
        passRate: total ? Number(((pass / total) * 100).toFixed(1)) : 0,
        passPlusPartialRate: total ? Number((((pass + partial) / total) * 100).toFixed(1)) : 0,
        model: data.meta?.model,
        judgeModel: data.meta?.judgeModel,
      };
    } catch { /* skip broken */ }
    out.push({ id, mtime, summary });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function indexHtml(runs: { id: string; summary?: any }[], projectDir: string): string {
  const dataJson = JSON.stringify(runs).replace(/<\/script/gi, "<\\/script");
  const projectName = projectDir.split(/[\\/]/).filter(Boolean).pop() || "evals";

  // Compute server-side header KPIs
  const valid = runs.filter((r) => r.summary && r.summary.total > 0);
  const latest = valid[0]?.summary;
  const avgPass = valid.length
    ? (valid.reduce((s, r) => s + (r.summary.passRate || 0), 0) / valid.length).toFixed(1)
    : "—";
  const totalEvals = valid.reduce((s, r) => s + (r.summary.total || 0), 0);
  const best = valid.reduce<{ id: string; rate: number } | null>((acc, r) => {
    const rate = r.summary.passRate || 0;
    return !acc || rate > acc.rate ? { id: r.id, rate } : acc;
  }, null);
  const last7Days = valid.filter((r) => {
    const t = r.summary.timestamp ? new Date(r.summary.timestamp).getTime() : 0;
    return Date.now() - t < 7 * 86400000;
  }).length;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Copilot Eval · ${escHtml(projectName)}</title>
<link rel="icon" href="data:image/svg+xml;utf8,${encodeURIComponent(BRAND_SVG)}">
<style>
  :root {
    color-scheme: light dark;
    --bg: #fafafa; --fg: #1b1b1f; --muted: #6b6b6b; --border: #e1dfdd;
    --card: #fff; --card-hover: #f3f2f1;
    --accent: #0f6cbd; --accent-bg: #0f6cbd14;
    --pass: #107c10; --partial: #c4a000; --fail: #d13438; --error: #5c2d91;
    --shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1b1b1f; --fg: #f5f5f5; --muted: #9a9a9a; --border: #3a3a40;
      --card: #25252a; --card-hover: #2e2e34;
      --accent: #479ef5; --accent-bg: #479ef522;
      --pass: #6ccb5f; --partial: #f2c661; --fail: #f36d6d; --error: #b794f6;
      --shadow: 0 1px 3px rgba(0,0,0,.4), 0 1px 2px rgba(0,0,0,.3);
    }
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.45 'Segoe UI Variable','Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif;
    margin: 0; padding: 0; background: var(--bg); color: var(--fg);
  }
  .container { max-width: none; margin: 0; padding: 24px 32px; }

  /* === HERO === */
  .hero {
    padding: 24px 0 8px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .hero-inner { }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .brand svg { width: 28px; height: 28px; }
  .brand h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -.01em; color: var(--fg); }
  .brand .scope {
    font-size: 12px; padding: 2px 10px; border-radius: 12px;
    background: var(--accent-bg); color: var(--accent);
    font-family: ui-monospace,Consolas,monospace;
  }
  .tagline { color: var(--muted); font-size: 13px; margin: 0 0 16px; }

  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .kpi {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
  }
  .kpi-value { font-size: 22px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--fg); }
  .kpi-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-top: 4px; }
  .kpi-sub { font-size: 11px; color: var(--muted); margin-top: 2px; opacity: .85; }

  /* === SPARKLINE === */
  .trend-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px 20px; margin-bottom: 20px; box-shadow: var(--shadow);
  }
  .trend-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
  .trend-title { font-weight: 600; font-size: 13px; }
  .trend-sub { font-size: 12px; color: var(--muted); }
  .sparkline { width: 100%; height: 80px; display: block; color: var(--fg); }
  .spark-pt { cursor: pointer; }
  .spark-pt .dot { transition: r .12s; }
  .spark-pt:hover .dot, .spark-pt.hl .dot { r: 6; stroke: var(--card); stroke-width: 2; }
  tr.run-row.hl-from-spark td {
    background: var(--accent-bg) !important;
    box-shadow: inset 3px 0 0 var(--accent);
  }

  /* === TOOLBAR === */
  .toolbar {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 12px; margin-bottom: 14px; box-shadow: var(--shadow);
  }
  .search-wrap { flex: 1; min-width: 240px; position: relative; }
  .search-wrap input {
    width: 100%; padding: 8px 10px 8px 32px; font: inherit;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .search-wrap input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  .search-wrap::before {
    content: "🔍"; position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    opacity: .5; font-size: 12px;
  }
  .pill-group { display: flex; gap: 4px; }
  .pill {
    padding: 6px 12px; font-size: 12px; cursor: pointer; user-select: none;
    background: transparent; border: 1px solid var(--border); border-radius: 999px;
    color: var(--fg);
  }
  .pill:hover { background: var(--card-hover); }
  .pill.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .pill .count { opacity: .7; margin-left: 4px; font-variant-numeric: tabular-nums; }
  .pill.active .count { opacity: .9; }
  select.model-filter {
    padding: 7px 10px; font: inherit;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
  }

  /* === TABLE === */
  .table-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; box-shadow: var(--shadow); }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--border);
    cursor: pointer; user-select: none; background: var(--card);
    position: sticky; top: 0; z-index: 1;
  }
  th:hover { color: var(--fg); }
  th.num { text-align: right; }
  th.sorted::after { content: " ▾"; color: var(--accent); }
  th.sorted.asc::after { content: " ▴"; }
  td {
    padding: 12px 14px; border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums; vertical-align: middle;
  }
  td.num { text-align: right; }
  td.muted { color: var(--muted); }
  tr.run-row { transition: background .1s; }
  tr.run-row:hover td { background: var(--card-hover); }
  tr.run-row:last-child td { border-bottom: none; }
  a.run-link { color: var(--accent); text-decoration: none; font-weight: 600; }
  a.run-link:hover { text-decoration: underline; }
  .badge-rate {
    display: inline-block; padding: 3px 10px; border-radius: 12px; font-weight: 600;
    font-size: 12px; min-width: 56px; text-align: center;
  }
  .badge-rate.ok  { background: var(--pass)22;    color: var(--pass); }
  .badge-rate.warn{ background: var(--partial)22; color: var(--partial); }
  .badge-rate.bad { background: var(--fail)22;    color: var(--fail); }
  .stack-bar {
    display: flex; height: 8px; border-radius: 4px; overflow: hidden;
    background: var(--border); min-width: 100px;
  }
  .stack-bar > span { display: block; }
  .stack-bar .pass    { background: var(--pass); }
  .stack-bar .partial { background: var(--partial); }
  .stack-bar .fail    { background: var(--fail); }
  .stack-bar .error   { background: var(--error); }
  .model-chip {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    background: var(--accent-bg); color: var(--accent);
    font-size: 11px; font-family: ui-monospace,Consolas,monospace;
    max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    vertical-align: middle;
  }
  .when { font-size: 12px; color: var(--muted); }
  .when .relative { color: var(--fg); font-weight: 500; }

  .empty {
    text-align: center; padding: 60px 20px; color: var(--muted);
  }
  .empty .icon { font-size: 48px; margin-bottom: 12px; }
  .footer { margin-top: 24px; padding: 12px 4px; color: var(--muted); font-size: 12px; text-align: center; }

  @media (max-width: 760px) {
    .kpis { grid-template-columns: repeat(2, 1fr); }
    .container { padding: 16px; }
    th, td { padding: 8px 10px; font-size: 13px; }
    .col-stack, .col-pp, .col-when { display: none; }
  }
</style>
</head>
<body>
<div class="container">
<header class="hero">
  <div class="hero-inner">
    <div class="brand">
      ${BRAND_SVG}
      <h1>Copilot Eval</h1>
    </div>
    <p class="tagline">Eval runs, scored and tracked over time.</p>
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-value">${latest ? latest.passRate + "%" : "—"}</div>
        <div class="kpi-label">Latest pass rate</div>
        <div class="kpi-sub">${latest ? "across " + latest.total + " evals" : "no runs yet"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-value">${avgPass}${valid.length ? "%" : ""}</div>
        <div class="kpi-label">Avg pass rate</div>
        <div class="kpi-sub">across ${valid.length} run${valid.length === 1 ? "" : "s"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-value">${best ? best.rate + "%" : "—"}</div>
        <div class="kpi-label">Best run</div>
        <div class="kpi-sub">${best ? best.id : "—"}</div>
      </div>
      <div class="kpi">
        <div class="kpi-value">${totalEvals.toLocaleString()}</div>
        <div class="kpi-label">Total evals scored</div>
        <div class="kpi-sub">${last7Days} run${last7Days === 1 ? "" : "s"} in last 7 days</div>
      </div>
    </div>
  </div>
</header>

  <div class="trend-card" id="trend-card" hidden>
    <div class="trend-head">
      <div class="trend-title">Pass rate trend</div>
      <div class="trend-sub" id="trend-sub"></div>
    </div>
    <svg class="sparkline" id="sparkline" viewBox="0 0 600 60" preserveAspectRatio="none"></svg>
  </div>

  <div class="toolbar">
    <div class="search-wrap">
      <input id="search" type="search" placeholder="Search runs by id, model, date…" autocomplete="off">
    </div>
    <select id="model-filter" class="model-filter" title="Filter by model">
      <option value="">All models</option>
    </select>
    <div class="pill-group" id="status-pills"></div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th data-sort="id" class="sorted">Run</th>
          <th data-sort="passRate" class="num">Pass %</th>
          <th data-sort="passPlusPartialRate" class="num col-pp">Pass+Partial</th>
          <th data-sort="avg" class="num">Avg</th>
          <th data-sort="total" class="num">Evals</th>
          <th class="col-stack">Distribution</th>
          <th data-sort="model">Model</th>
          <th data-sort="timestamp" class="col-when">When</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <div class="footer">
    <span>Copilot Eval · <a href="/api/runs" style="color:var(--muted)">/api/runs</a> · Press <kbd>/</kbd> to search</span>
  </div>
</div>

<script id="runs-data" type="application/json">${dataJson}</script>
<script>
const RUNS = JSON.parse(document.getElementById('runs-data').textContent);
let sortKey = 'id', sortAsc = false;
let activeStatus = 'all';
let searchText = '';
let modelFilter = '';

function classify(rate) {
  if (rate == null) return 'none';
  if (rate >= 90) return 'ok';
  if (rate >= 70) return 'warn';
  return 'bad';
}
function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// === Status counts (for pill labels) ===
function statusOf(r) {
  const s = r.summary || {};
  if (!s.total) return 'empty';
  if (s.errored > 0) return 'errors';
  if (s.passRate >= 90) return 'clean';
  if (s.passRate >= 70) return 'warning';
  return 'failing';
}
const statusCounts = RUNS.reduce((acc, r) => {
  const k = statusOf(r);
  acc[k] = (acc[k] || 0) + 1;
  acc.all = (acc.all || 0) + 1;
  return acc;
}, {});

const PILLS = [
  { key: 'all',     label: 'All' },
  { key: 'clean',   label: '✓ Clean (≥90%)' },
  { key: 'warning', label: '⚠ Warning (70–90%)' },
  { key: 'failing', label: '✗ Failing (<70%)' },
  { key: 'errors',  label: '⚡ With errors' },
];
function renderPills() {
  document.getElementById('status-pills').innerHTML = PILLS.filter(p => statusCounts[p.key]).map(p =>
    \`<button class="pill\${p.key===activeStatus?' active':''}" data-status="\${p.key}">\${p.label}<span class="count">\${statusCounts[p.key]}</span></button>\`
  ).join('');
}

// === Model filter options ===
const MODELS = [...new Set(RUNS.map(r => r.summary?.model).filter(Boolean))].sort();
MODELS.forEach(m => {
  const opt = document.createElement('option');
  opt.value = m; opt.textContent = m;
  document.getElementById('model-filter').appendChild(opt);
});

function getRows() {
  let rows = RUNS.slice();
  if (activeStatus !== 'all') rows = rows.filter(r => statusOf(r) === activeStatus);
  if (modelFilter) rows = rows.filter(r => r.summary?.model === modelFilter);
  if (searchText) {
    const q = searchText.toLowerCase();
    rows = rows.filter(r => {
      const s = r.summary || {};
      return r.id.toLowerCase().includes(q)
        || (s.model || '').toLowerCase().includes(q)
        || (s.timestamp || '').toLowerCase().includes(q);
    });
  }
  rows.sort((a, b) => {
    const va = sortKey === 'id' ? a.id : (a.summary?.[sortKey] ?? '');
    const vb = sortKey === 'id' ? b.id : (b.summary?.[sortKey] ?? '');
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });
  return rows;
}

function render() {
  const rows = getRows();
  const tbody = document.getElementById('tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty"><div class="icon">🔎</div>No runs match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = rows.map(r => {
      const s = r.summary || {};
      const cls = classify(s.passRate);
      const total = s.total || 1;
      const seg = (n, c) => n ? \`<span class="\${c}" style="width:\${(n/total*100).toFixed(1)}%"></span>\` : '';
      const stack = total ? \`<div class="stack-bar">\${seg(s.pass,'pass')}\${seg(s.partial,'partial')}\${seg(s.fail,'fail')}\${seg(s.errored,'error')}</div>\` : '';
      const when = s.timestamp
        ? \`<div class="when"><div class="relative">\${relTime(s.timestamp)}</div><div>\${new Date(s.timestamp).toLocaleString()}</div></div>\`
        : '<span class="muted">—</span>';
      return \`<tr class="run-row" data-run-id="\${escHtml(r.id)}">
        <td><a class="run-link" href="/runs/\${r.id}/\${r.id}.html">\${r.id}</a></td>
        <td class="num"><span class="badge-rate \${cls}">\${s.passRate ?? '—'}%</span></td>
        <td class="num col-pp">\${s.passPlusPartialRate ?? '—'}%</td>
        <td class="num">\${s.avg ?? '—'}</td>
        <td class="num">\${s.total ?? '—'}</td>
        <td class="col-stack">\${stack}</td>
        <td>\${s.model ? '<span class="model-chip" title="' + escHtml(s.model) + '">' + escHtml(s.model) + '</span>' : '<span class="muted">—</span>'}</td>
        <td class="col-when">\${when}</td>
      </tr>\`;
    }).join('');
  }
  // Update sort indicators
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.classList.toggle('asc', th.dataset.sort === sortKey && sortAsc);
  });
}

function renderSparkline() {
  // Use chronological order (oldest → newest) of runs that have a passRate
  const points = RUNS
    .filter(r => r.summary?.timestamp && r.summary.passRate != null)
    .slice()
    .sort((a, b) => new Date(a.summary.timestamp) - new Date(b.summary.timestamp));
  if (points.length < 2) return;
  document.getElementById('trend-card').hidden = false;
  const svg = document.getElementById('sparkline');
  // Use the actual rendered pixel width so circles stay round (no preserveAspectRatio stretching)
  const W = Math.max(300, Math.round(svg.getBoundingClientRect().width || 600));
  const H = 80, P = 8;
  svg.setAttribute('viewBox', \`0 0 \${W} \${H}\`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const xs = points.map((_, i) => P + (i * (W - 2 * P)) / (points.length - 1));
  const ys = points.map(p => H - P - ((p.summary.passRate / 100) * (H - 2 * P)));
  const path = xs.map((x, i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + ys[i].toFixed(1)).join(' ');
  const area = path + \` L\${xs[xs.length-1].toFixed(1)},\${H} L\${xs[0].toFixed(1)},\${H} Z\`;
  // Subtle gridline at 90% (pass threshold)
  const y90 = H - P - (0.9 * (H - 2 * P));
  const grid = \`<line x1="0" y1="\${y90.toFixed(1)}" x2="\${W}" y2="\${y90.toFixed(1)}" stroke="currentColor" stroke-opacity="0.12" stroke-dasharray="3 3"/>\`;
  const pts = points.map((p, i) => {
    const cls = classify(p.summary.passRate);
    const fill = cls === 'ok' ? 'var(--pass)' : cls === 'warn' ? 'var(--partial)' : 'var(--fail)';
    // Larger invisible hit-target around the visible dot for easier hovering.
    return \`<g class="spark-pt" data-run-id="\${p.id}">
      <circle class="hit" cx="\${xs[i].toFixed(1)}" cy="\${ys[i].toFixed(1)}" r="10" fill="transparent"/>
      <circle class="dot" cx="\${xs[i].toFixed(1)}" cy="\${ys[i].toFixed(1)}" r="3.5" fill="\${fill}"/>
      <title>\${p.id}: \${p.summary.passRate}%</title>
    </g>\`;
  }).join('');
  svg.innerHTML = \`
    \${grid}
    <path d="\${area}" fill="var(--accent-bg)"/>
    <path d="\${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    \${pts}\`;

  // Hover-link sparkline dots ↔ table rows
  svg.querySelectorAll('.spark-pt').forEach(g => {
    const id = g.dataset.runId;
    g.addEventListener('mouseenter', () => highlightRun(id, true));
    g.addEventListener('mouseleave', () => highlightRun(id, false));
    g.addEventListener('click', () => {
      const row = document.querySelector(\`tr.run-row[data-run-id="\${CSS.escape(id)}"]\`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  const first = points[0].summary.passRate, last = points[points.length-1].summary.passRate;
  const delta = (last - first).toFixed(1);
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '▬';
  document.getElementById('trend-sub').textContent = \`\${points.length} runs · \${arrow} \${Math.abs(delta)}% change\`;
}

function highlightRun(id, on) {
  const row = document.querySelector(\`tr.run-row[data-run-id="\${CSS.escape(id)}"]\`);
  if (row) row.classList.toggle('hl-from-spark', on);
  const pt = document.querySelector(\`.spark-pt[data-run-id="\${CSS.escape(id)}"]\`);
  if (pt) pt.classList.toggle('hl', on);
}

// Re-render sparkline on resize so it stays in sync with container width
let sparkResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(sparkResizeTimer);
  sparkResizeTimer = setTimeout(renderSparkline, 150);
});

// === Event wiring ===
document.getElementById('search').addEventListener('input', e => { searchText = e.target.value; render(); });
document.getElementById('model-filter').addEventListener('change', e => { modelFilter = e.target.value; render(); });
document.getElementById('status-pills').addEventListener('click', e => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  activeStatus = btn.dataset.status;
  renderPills(); render();
});
document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortAsc = !sortAsc;
    else { sortKey = k; sortAsc = (k === 'id' || k === 'model') ? true : false; }
    render();
  });
});
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('search').focus();
  }
});

renderPills();
renderSparkline();
render();
</script>
</body></html>`;
}

function escHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const BRAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="#0f6cbd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>`;

export interface ServeOptions {
  port: number;
  open: boolean;
  host: string;
}

export async function startServer(projectDir: string, opts: ServeOptions): Promise<void> {
  const runsDir = join(projectDir, "runs");
  const server = createServer(async (req, res) => {
    try {
      const url = req.url || "/";
      // Index: list of runs
      if (url === "/" || url === "/index.html") {
        const runs = await listRuns(runsDir);
        const html = indexHtml(runs, projectDir);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      // API endpoint: list of runs as JSON (for compare dropdown)
      if (url === "/api/runs") {
        const runs = await listRuns(runsDir);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(runs));
        return;
      }
      // Static files under /runs/<id>/...
      if (url.startsWith("/runs/")) {
        const sub = url.slice("/runs/".length);
        const filePath = safeJoin(runsDir, sub);
        if (!filePath) { res.writeHead(403); res.end("Forbidden"); return; }
        let st;
        try { st = await stat(filePath); } catch { res.writeHead(404); res.end("Not found"); return; }
        if (st.isDirectory()) {
          const entries = await readdir(filePath, { withFileTypes: true });
          const list = entries.map((e) => `<li><a href="${e.name}${e.isDirectory() ? "/" : ""}">${e.name}${e.isDirectory() ? "/" : ""}</a></li>`).join("");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><h2>${url}</h2><ul>${list}</ul>`);
          return;
        }
        const mime = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
        createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404); res.end("Not found");
    } catch (err: any) {
      res.writeHead(500); res.end(`Server error: ${err.message}`);
    }
  });
  server.listen(opts.port, opts.host, () => {
    const url = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}/`;
    console.log(`📊 Copilot Eval dashboard: ${url}`);
    console.log(`   Serving from: ${runsDir}`);
    console.log("   Press Ctrl+C to stop.");
    if (opts.open) {
      const cmd = process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
      exec(cmd, (err) => { if (err) console.error("⚠️  Could not open browser:", err.message); });
    }
  });
  await new Promise<void>(() => {});
}
