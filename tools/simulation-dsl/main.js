/**
 * main.js — editor, live simulation, chart, table, and exports.
 *
 *   keystroke → CodeMirror update
 *     ├─ analyze(text)  → diagnostics / completion / hover  (main thread)
 *     └─ debounce 350 ms → compile(analysis, Model) → model.simulate()
 *           → uPlot chart + table
 *
 * The scottfr/simulation engine runs synchronously on the main thread (module
 * workers don't see the page's import map), bounded by the model's own
 * length / step. A step-count guard refuses obviously runaway runs.
 */

import { basicSetup } from 'codemirror';
import { EditorView, hoverTooltip } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import uPlot from 'uplot';
import { Model, toModelJSON } from 'simulation';

import {
  analyze, hasErrors, NAME_RE, PROP_DOCS, DECL_KEYWORDS,
  ALGORITHMS, TIME_UNITS, STOCK_TYPES, INTERPOLATIONS, TRIGGERS, PLACEMENTS, NETWORKS, PLOT_KINDS,
} from './lang.js';
import { compile } from './compiler.js';
import { EXAMPLES } from './examples.js';

const $ = (id) => document.getElementById(id);

const SIM_DEBOUNCE_MS = 350;
const MAX_STEPS = 2_000_000;
const TABLE_ROW_LIMIT = 500;

// Words highlighted as keywords (declarations + property names + enum values).
const PROP_NAMES = new Set();
for (const props of Object.values(PROP_DOCS)) for (const k of Object.keys(props)) PROP_NAMES.add(k.toLowerCase());
const ENUM_WORDS = new Set(
  [...ALGORITHMS, ...TIME_UNITS, ...STOCK_TYPES, ...INTERPOLATIONS, ...TRIGGERS, ...PLOT_KINDS]
    .map((w) => w.toLowerCase()).concat(['true', 'false', 'time', 'all', 'none']),
);
const DECL_WORDS = new Set([...DECL_KEYWORDS].map((w) => w.toLowerCase()));

// ---------------------------------------------------------------------------
// Syntax highlighting (the analyzer does the real parsing)
// ---------------------------------------------------------------------------

const simLanguage = StreamLanguage.define({
  name: 'simulation-dsl',
  startState: () => ({}),
  token(stream) {
    if (stream.match(/#.*/) || stream.match(/\/\/.*/)) return 'comment';
    if (stream.eatSpace()) return null;
    if (stream.match(/"(?:[^"\\]|\\.)*"?/) || stream.match(/'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/->/)) return 'operator';
    if (stream.match(/[$@]/)) return 'keyword';     // stock / variable sigils
    if (stream.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/)) return 'number';
    if (stream.match(/[\p{L}_][\p{L}\p{N}_]*/u)) {
      const word = stream.current().toLowerCase();
      if (DECL_WORDS.has(word)) return 'keyword';
      if (ENUM_WORDS.has(word)) return 'atom';
      if (PROP_NAMES.has(word)) return 'propertyName';
      return 'variableName';
    }
    if (stream.match(/[{}()[\]]/)) return 'bracket';
    if (stream.match(/[,;:=]/)) return 'punctuation';
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: '#' },
    autocomplete: completionSource,
  },
});

// ---------------------------------------------------------------------------
// Shared analysis: one analyzer feeds the linter, completion, and hover
// ---------------------------------------------------------------------------

let lastAnalysis = analyze('');
let lastResult = null; // { times, series: Map<name, number[]>, plottables }

function lintSource(view) {
  const text = view.state.doc.toString();
  lastAnalysis = analyze(text);
  const max = text.length;
  return lastAnalysis.diagnostics.map((d) => ({
    from: Math.min(d.from, max),
    to: Math.min(Math.max(d.to, d.from + 1), max),
    severity: d.severity,
    message: d.message,
  }));
}

/**
 * Find the declaration kind of the innermost unclosed `{ … }` block before
 * `pos` — a keyword (`sim`, `converter`, …) or a sigil/arrow form mapped to its
 * property-doc key (`@` → stock, `$` → variable, `->` → flow).
 */
function enclosingDecl(text, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) {
        // Identify the declaration from the header on (or before) this line.
        const lineStart = text.lastIndexOf('\n', i) + 1;
        const head = text.slice(lineStart, i).trim();
        if (head.startsWith('@')) return 'stock';
        if (head.startsWith('$')) return 'variable';
        if (head.includes('->')) return 'flow';
        const m = /^([\p{L}_][\p{L}\p{N}_]*)/u.exec(head);
        return m ? m[1].toLowerCase() : null;
      }
      depth--;
    }
  }
  return null;
}

function completionSource(context) {
  const word = context.matchBefore(/[\p{L}_][\p{L}\p{N}_]*/u);
  if (!word && !context.explicit) return null;
  const text = context.state.doc.toString();
  const decl = enclosingDecl(text, word ? word.from : context.pos);
  const options = [];

  if (decl && PROP_DOCS[decl]) {
    const props = PROP_DOCS[decl];
    for (const [name, doc] of Object.entries(props)) {
      options.push({ label: name, type: 'property', info: doc });
    }
    // Enum value completions for the relevant property keys.
    const enums = { algorithm: ALGORITHMS, units: TIME_UNITS, type: STOCK_TYPES, interpolation: INTERPOLATIONS, trigger: TRIGGERS, placement: PLACEMENTS, network: NETWORKS, plot: PLOT_KINDS };
    for (const list of Object.values(enums)) for (const v of list) options.push({ label: v, type: 'enum' });
  } else {
    for (const kw of DECL_KEYWORDS) options.push({ label: kw, type: 'keyword' });
  }

  // Always offer the model's own primitive names (for equations & endpoints).
  for (const sym of lastAnalysis.symbols.values()) {
    options.push({ label: sym.name, type: 'variable', detail: sym.kind });
  }
  const seen = new Set();
  const deduped = options.filter((o) => (seen.has(o.label) ? false : seen.add(o.label)));
  return { from: word ? word.from : context.pos, options: deduped, validFor: /^[\p{L}_][\p{L}\p{N}_]*$/u };
}

const hoverDocs = hoverTooltip((view, pos) => {
  const { from, to, text } = view.state.doc.lineAt(pos);
  let start = pos, end = pos;
  while (start > from && /[\p{L}\p{N}_]/u.test(text[start - from - 1])) start--;
  while (end < to && /[\p{L}\p{N}_]/u.test(text[end - from])) end++;
  if (start === end) return null;
  const word = text.slice(start - from, end - from);
  if (!NAME_RE.test(word)) return null;

  const decl = enclosingDecl(view.state.doc.toString(), start);
  const propDoc = decl && PROP_DOCS[decl] && PROP_DOCS[decl][word];
  // Match a symbol case-insensitively.
  let sym = null;
  for (const s of lastAnalysis.symbols.values()) if (s.name.toLowerCase() === word.toLowerCase()) { sym = s; break; }
  if (!propDoc && !sym) return null;

  return {
    pos: start, end, above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-sim-hover';
      if (propDoc) dom.innerHTML = `<strong>${word}</strong> — ${escapeHtml(propDoc)}`;
      else dom.innerHTML = `<strong>${escapeHtml(sym.name)}</strong> — ${sym.kind}${sym.scope !== 'model' ? ` in agent ${escapeHtml(sym.scope)}` : ''}`;
      return { dom };
    },
  };
});

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const editorTheme = EditorView.theme({
  '&': { fontSize: '14px', height: '100%' },
  '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
  '&.cm-focused': { outline: 'none' },
});

let scheduled = null;
const view = new EditorView({
  doc: '',
  parent: $('editor'),
  extensions: [
    basicSetup,
    simLanguage,
    lintGutter(),
    linter(lintSource, { delay: 300 }),
    hoverDocs,
    editorTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        clearTimeout(scheduled);
        scheduled = setTimeout(runSimulation, SIM_DEBOUNCE_MS);
      }
    }),
  ],
});

function setDoc(text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

// ---------------------------------------------------------------------------
// Run the model on the real engine
// ---------------------------------------------------------------------------

function runSimulation() {
  const source = view.state.doc.toString();
  const analysis = analyze(source);
  lastAnalysis = analysis;

  if (hasErrors(analysis)) {
    const first = analysis.diagnostics.find((d) => d.severity === 'error');
    setStatus('error', `Can't run yet: ${first.message}`);
    return;
  }

  const { config } = analysis;
  const steps = Math.abs(config.timeLength / config.timeStep);
  if (!Number.isFinite(steps) || steps > MAX_STEPS) {
    setStatus('error', `That's ${Math.round(steps).toLocaleString()} steps (length ${config.timeLength} ÷ step ${config.timeStep}). Increase the step or shorten the run.`);
    return;
  }

  let built;
  try {
    built = compile(analysis, Model);
  } catch (e) {
    setStatus('error', `Build error: ${e.message}`);
    return;
  }

  const t0 = performance.now();
  let res;
  try {
    res = built.model.simulate();
  } catch (e) {
    setStatus('error', `Simulation error: ${e.message}`);
    return;
  }
  const ms = performance.now() - t0;

  const times = res.times();
  const series = new Map();
  const plottables = [];
  for (const p of built.plottables) {
    try {
      const data = res.series(p.primitive);
      if (Array.isArray(data)) { series.set(p.name, data); plottables.push(p); }
    } catch { /* some primitives have no time series; skip */ }
  }
  lastResult = { times, series, plottables };
  lastModel = built.model;

  renderChart();
  renderTable();
  const counts = countByKind(plottables);
  setStatus('ok', `${times.length} steps · ${counts} · ${ms < 1 ? '<1' : Math.round(ms)} ms`);
}

let lastModel = null;

function countByKind(plottables) {
  const order = ['stock', 'flow', 'variable', 'converter', 'state'];
  const counts = {};
  for (const p of plottables) counts[p.kind] = (counts[p.kind] || 0) + 1;
  return order.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}${counts[k] > 1 ? 's' : ''}`).join(' · ') || 'no series';
}

function setStatus(kind, message) {
  const el = $('status');
  el.className = `status ${kind}`;
  el.textContent = message;
}

// ---------------------------------------------------------------------------
// Chart (uPlot)
// ---------------------------------------------------------------------------

const PALETTE = ['#667eea', '#e8590c', '#2b8a3e', '#c2255c', '#0c8599', '#9c36b5', '#e67700', '#1971c2', '#5f3dc4', '#f03e3e', '#0ca678', '#868e96'];
const DASH = { stock: undefined, variable: [4, 4], flow: [8, 4], converter: [2, 4], state: [1, 3] };

let chart = null;
let chartKey = '';

function chartData() {
  return [lastResult.times, ...lastResult.plottables.map((p) => lastResult.series.get(p.name))];
}

function renderChart() {
  const container = $('chart');
  const key = lastResult.plottables.map((p) => `${p.kind}:${p.name}`).join(',') + `|${lastResult.times.length}`;
  if (!chart || chartKey !== key) {
    if (chart) { chart.destroy(); chart = null; }
    container.textContent = '';
    chartKey = key;
    if (!lastResult.plottables.length) {
      container.innerHTML = '<p class="empty">No chartable series — add a stock, variable, flow, or converter.</p>';
      return;
    }
    const opts = {
      width: Math.max(280, container.clientWidth),
      height: 280,
      scales: { x: { time: false } },
      axes: [{ label: 'time' }, { size: 60 }],
      series: [
        { label: 'time' },
        ...lastResult.plottables.map((p, i) => ({
          label: `${p.name}${p.kind !== 'stock' ? ` (${p.kind})` : ''}`,
          stroke: PALETTE[i % PALETTE.length],
          width: 2,
          dash: DASH[p.kind],
        })),
      ],
      cursor: { focus: { prox: 16 } },
    };
    chart = new uPlot(opts, chartData(), container);
  } else {
    chart.setData(chartData());
  }
}

new ResizeObserver(() => {
  if (chart) chart.setSize({ width: Math.max(280, $('chart').clientWidth), height: 280 });
}).observe($('chart'));

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function formatNumber(v) {
  if (v === Infinity) return '∞';
  if (v === -Infinity) return '-∞';
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toFixed(4)));
}

function renderTable() {
  const container = $('table-wrap');
  container.textContent = '';
  if (!lastResult.plottables.length) return;

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of ['Time', ...lastResult.plottables.map((p) => p.name)]) {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const n = lastResult.times.length;
  const shown = Math.min(n, TABLE_ROW_LIMIT);
  for (let r = 0; r < shown; r++) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = formatNumber(lastResult.times[r]);
    tr.appendChild(td);
    for (const p of lastResult.plottables) {
      const cell = document.createElement('td');
      cell.textContent = formatNumber(lastResult.series.get(p.name)[r]);
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  if (shown < n) {
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent = `Showing the first ${TABLE_ROW_LIMIT} of ${n} steps — download the CSV for the full run.`;
    container.appendChild(note);
  }
}

// ---------------------------------------------------------------------------
// Exports: CSV, ModelJSON
// ---------------------------------------------------------------------------

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('csv').addEventListener('click', () => {
  if (!lastResult || !lastResult.plottables.length) { setStatus('warn', 'Nothing to export yet — run a model first.'); return; }
  const lines = [['time', ...lastResult.plottables.map((p) => p.name)].join(',')];
  for (let r = 0; r < lastResult.times.length; r++) {
    lines.push([lastResult.times[r], ...lastResult.plottables.map((p) => lastResult.series.get(p.name)[r])].join(','));
  }
  download('simulation-run.csv', lines.join('\n') + '\n', 'text/csv');
});

$('json').addEventListener('click', () => {
  if (!lastModel) { setStatus('warn', 'Run a model first.'); return; }
  try {
    const json = toModelJSON(lastModel);
    download('model.json', JSON.stringify(json, null, 2), 'application/json');
    setStatus('ok', 'Exported ModelJSON (the engine\'s interchange format).');
  } catch (e) {
    setStatus('warn', `ModelJSON export isn't available for this model: ${e.message} (agent/population models aren't supported by ModelJSON — the model still runs).`);
  }
});

$('run').addEventListener('click', runSimulation);

// ---------------------------------------------------------------------------
// Share by URL (compressed into the hash; no server involved)
// ---------------------------------------------------------------------------

const b64uEncode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function encodeShare() {
  const bytes = new TextEncoder().encode(view.state.doc.toString());
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + b64uEncode(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return 'r' + b64uEncode(bytes);
}

async function decodeShare(hash) {
  const kind = hash[0];
  const bytes = b64uDecode(hash.slice(1));
  if (kind === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return new TextDecoder().decode(bytes);
}

$('share').addEventListener('click', async () => {
  const hash = await encodeShare();
  const url = `${location.origin}${location.pathname}#m=${hash}`;
  history.replaceState(null, '', `#m=${hash}`);
  try {
    await navigator.clipboard.writeText(url);
    setStatus('ok', 'Share link copied to clipboard.');
  } catch {
    setStatus('warn', 'Share link is in the address bar (clipboard unavailable).');
  }
});

// ---------------------------------------------------------------------------
// Examples + boot
// ---------------------------------------------------------------------------

const select = $('examples');
for (const ex of EXAMPLES) {
  const opt = document.createElement('option');
  opt.value = ex.id;
  opt.textContent = ex.name;
  select.appendChild(opt);
}
select.addEventListener('change', () => {
  const ex = EXAMPLES.find((e) => e.id === select.value);
  if (ex) setDoc(ex.source);
});

async function boot() {
  const m = /[#&]m=([^&]+)/.exec(location.hash);
  if (m) {
    try {
      select.value = '';
      setDoc(await decodeShare(m[1]));
      return;
    } catch {
      setStatus('warn', 'Could not decode the shared model from the URL — loading an example instead.');
    }
  }
  select.value = EXAMPLES[0].id;
  setDoc(EXAMPLES[0].source);
}

boot();
