/**
 * main.js — editor, live simulation loop, chart, and table wiring.
 *
 * Architecture (see ../../research/systems-modeling-playground.md):
 *   keystroke → CodeMirror update
 *     ├─ main thread: re-analyze → diagnostics / completion / hover
 *     └─ debounce 300 ms → simulation worker → chart + table
 * with Worker.terminate() on a deadline as the runaway-model backstop.
 */

import { basicSetup } from 'codemirror';
import { EditorView, hoverTooltip } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import uPlot from 'uplot';

import { analyze, BUILTINS, NAME_RE } from './lang.js';
import { MAX_ROUNDS } from './engine.js';
import { EXAMPLES } from './examples.js';

const $ = (id) => document.getElementById(id);

const SIM_DEBOUNCE_MS = 300;
const SIM_DEADLINE_MS = 2000;
const TABLE_ROW_LIMIT = 500;

const KEYWORD_WORDS = new Set(['if', 'then', 'else', 'and', 'or', 'not']);
const FLOW_WORDS = new Set(['rate', 'conversion', 'leak']);

// ---------------------------------------------------------------------------
// Syntax highlighting (stream tokenizer; the analyzer does the real parsing)
// ---------------------------------------------------------------------------

const systemsLanguage = StreamLanguage.define({
  name: 'systems',
  token(stream) {
    if (stream.match(/#.*/)) return 'comment';
    if (stream.eatSpace()) return null;
    if (stream.match(/\d+\.\d+|\d+\.?|\.\d+/)) return 'number';
    if (stream.match(/[A-Za-z][A-Za-z0-9_]*/)) {
      const word = stream.current();
      const lower = word.toLowerCase();
      if (lower === 'inf') return 'atom';
      if (KEYWORD_WORDS.has(lower)) return 'keyword';
      if (FLOW_WORDS.has(lower) && stream.peek() === '(') return 'keyword';
      if (BUILTINS[word.toUpperCase()] && stream.peek() === '(') return 'variableName.function';
      return 'variableName';
    }
    if (stream.match(/<=|>=|==|!=|<>/) || stream.match(/[-+*/^<>=@]/)) return 'operator';
    if (stream.match(/[[\]()]/)) return 'bracket';
    if (stream.match(/,/)) return 'punctuation';
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
let lastResult = null; // { columns, series, rounds, issues, ms }

function reanalyze(text) {
  lastAnalysis = analyze(text);
  return lastAnalysis;
}

function lintSource(view) {
  const text = view.state.doc.toString();
  const analysis = reanalyze(text);
  const max = text.length;
  return analysis.diagnostics.map((d) => ({
    from: Math.min(d.from, max),
    to: Math.min(Math.max(d.to, d.from + 1), max),
    severity: d.severity,
    message: d.message,
    actions: (d.actions || [])
      .filter((a) => a.kind === 'declare-stock')
      .map((a) => ({
        name: `Declare stock '${a.name}'`,
        apply(v) {
          v.dispatch({ changes: { from: 0, insert: `${a.name}(0)\n` } });
        },
      })),
  }));
}

function completionSource(context) {
  const word = context.matchBefore(/[A-Za-z][A-Za-z0-9_]*/);
  if (!word && !context.explicit) return null;
  const options = [];
  for (const s of lastAnalysis.stocks.values()) {
    options.push({ label: s.name, type: 'variable', detail: s.infinite ? 'infinite stock' : 'stock' });
  }
  for (const a of lastAnalysis.auxes.values()) {
    options.push({ label: a.name, type: 'variable', detail: 'auxiliary' });
  }
  for (const [name, b] of Object.entries(BUILTINS)) {
    options.push({ label: name, type: 'function', detail: b.sig, info: b.doc, apply: b.args[0] === 0 ? `${name}()` : `${name}(` });
  }
  for (const kw of ['Rate', 'Conversion', 'Leak']) {
    options.push({ label: kw, type: 'keyword', detail: 'flow type', apply: `${kw}(` });
  }
  for (const kw of ['IF', 'THEN', 'ELSE', 'AND', 'OR', 'NOT', 'inf']) {
    options.push({ label: kw, type: 'keyword' });
  }
  return { from: word ? word.from : context.pos, options, validFor: /^[A-Za-z][A-Za-z0-9_]*$/ };
}

function sparklineCanvas(values) {
  const w = 160, h = 36, pad = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.cssText = `width:${w}px;height:${h}px;display:block;margin-top:4px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return canvas;
  const min = Math.min(...finite), max = Math.max(...finite);
  const span = max - min || 1;
  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((Number.isFinite(v) ? v : min) - min) / span * (h - 2 * pad);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  return canvas;
}

const hoverDocs = hoverTooltip((view, pos) => {
  const { from, to, text } = view.state.doc.lineAt(pos);
  let start = pos, end = pos;
  while (start > from && /[A-Za-z0-9_]/.test(text[start - from - 1])) start--;
  while (end < to && /[A-Za-z0-9_]/.test(text[end - from])) end++;
  if (start === end) return null;
  const word = text.slice(start - from, end - from);
  if (!NAME_RE.test(word)) return null;

  const builtin = BUILTINS[word.toUpperCase()];
  const stock = lastAnalysis.stocks.get(word);
  const aux = lastAnalysis.auxes.get(word);
  if (!builtin && !stock && !aux) return null;

  return {
    pos: start,
    end,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-systems-hover';
      if (builtin && !stock && !aux) {
        dom.innerHTML = `<strong>${builtin.sig}</strong><br>${builtin.doc}`;
      } else {
        const kind = stock ? (stock.infinite ? 'infinite stock' : 'stock') : 'auxiliary';
        dom.innerHTML = `<strong>${word}</strong> — ${kind}`;
        const series = lastResult && lastResult.series.get(word);
        if (series) {
          const final = series[series.length - 1];
          const span = document.createElement('div');
          span.textContent = `final value: ${formatNumber(final)}`;
          dom.appendChild(span);
          dom.appendChild(sparklineCanvas(series));
        }
      }
      return { dom };
    },
  };
});

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
    systemsLanguage,
    lintGutter(),
    linter(lintSource, { delay: 250 }),
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
// Simulation worker management
// ---------------------------------------------------------------------------

let worker = null;
let workerBroken = false;
let runId = 0;
let deadline = null;

function ensureWorker() {
  if (worker || workerBroken) return;
  try {
    worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => handleResult(e.data);
    worker.onerror = () => {
      workerBroken = true;
      try { worker.terminate(); } catch { /* already dead */ }
      worker = null;
      clearTimeout(deadline);
      runSimulation(); // retry inline
    };
  } catch {
    workerBroken = true;
  }
}

async function runSimulation() {
  const source = view.state.doc.toString();
  const rounds = clampRounds(parseInt($('rounds').value, 10));
  const seed = (parseInt($('seed').value, 10) || 0) >>> 0;
  const id = ++runId;

  ensureWorker();
  if (worker && !workerBroken) {
    worker.postMessage({ id, source, rounds, seed });
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      worker.terminate();
      worker = null;
      setStatus('error', `Simulation exceeded ${SIM_DEADLINE_MS / 1000}s and was stopped`);
    }, SIM_DEADLINE_MS);
    return;
  }

  // Fallback (e.g. file:// where module workers are unavailable): run inline.
  try {
    const [{ analyze: an, hasErrors }, { run }] = await Promise.all([
      import('./lang.js'), import('./engine.js'),
    ]);
    const analysis = an(source);
    if (hasErrors(analysis)) {
      const first = analysis.diagnostics.find((d) => d.severity === 'error');
      handleResult({ id, ok: false, message: first.message });
      return;
    }
    const t0 = performance.now();
    const result = run(analysis, { rounds, seed });
    const rowLen = result.columns.length;
    const flat = new Float64Array(result.rows.length * rowLen);
    result.rows.forEach((row, r) => { for (let c = 0; c < rowLen; c++) flat[r * rowLen + c] = row[c]; });
    handleResult({ id, ok: true, columns: result.columns, rows: flat, rowLen, issues: result.issues, ms: performance.now() - t0 });
  } catch (err) {
    handleResult({ id, ok: false, message: String(err.message || err) });
  }
}

function handleResult(msg) {
  if (msg.id !== runId) return; // stale run
  clearTimeout(deadline);
  if (!msg.ok) {
    setStatus('error', msg.message);
    return;
  }
  const { columns, rows, rowLen, issues, ms } = msg;
  const rounds = rowLen ? rows.length / rowLen - 1 : 0;
  const series = new Map();
  columns.forEach((col, c) => {
    const values = new Array(rounds + 1);
    for (let r = 0; r <= rounds; r++) values[r] = rows[r * rowLen + c];
    series.set(col.name, values);
  });
  lastResult = { columns, series, rounds, issues, ms };

  renderChart();
  renderTable();
  const stockCount = columns.filter((c) => c.kind === 'stock').length;
  let note = `${rounds} rounds · ${stockCount} stock${stockCount === 1 ? '' : 's'}`;
  if (columns.length > stockCount) note += ` · ${columns.length - stockCount} aux`;
  note += ` · ${ms < 1 ? '<1' : Math.round(ms)} ms`;
  if (issues.length) {
    setStatus('warn', `${note} — ${issues[0].message}`);
  } else {
    setStatus('ok', note);
  }
}

function clampRounds(n) {
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(n, MAX_ROUNDS);
}

function setStatus(kind, message) {
  const el = $('status');
  el.className = `status ${kind}`;
  el.textContent = message;
}

// ---------------------------------------------------------------------------
// Chart (uPlot)
// ---------------------------------------------------------------------------

const PALETTE = ['#667eea', '#e8590c', '#2b8a3e', '#c2255c', '#0c8599', '#9c36b5', '#e67700', '#1971c2', '#5f3dc4', '#868e96'];

let chart = null;
let chartColumns = '';

function chartData() {
  const xs = Array.from({ length: lastResult.rounds + 1 }, (_, i) => i);
  return [xs, ...lastResult.columns.map((c) => lastResult.series.get(c.name))];
}

function renderChart() {
  const container = $('chart');
  const key = lastResult.columns.map((c) => `${c.kind}:${c.name}`).join(',');
  if (!chart || chartColumns !== key) {
    if (chart) { chart.destroy(); chart = null; }
    container.textContent = '';
    chartColumns = key;
    if (!lastResult.columns.length) {
      container.innerHTML = '<p class="empty">Add a flow to see results — e.g. <code>[a] &gt; b @ 2</code></p>';
      return;
    }
    const opts = {
      width: Math.max(280, container.clientWidth),
      height: 260,
      scales: { x: { time: false } },
      axes: [
        { label: 'round' },
        { size: 56 },
      ],
      series: [
        { label: 'round' },
        ...lastResult.columns.map((c, i) => ({
          label: c.kind === 'aux' ? `${c.name} (aux)` : c.name,
          stroke: PALETTE[i % PALETTE.length],
          width: 2,
          dash: c.kind === 'aux' ? [5, 5] : undefined,
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
  if (chart) chart.setSize({ width: Math.max(280, $('chart').clientWidth), height: 260 });
}).observe($('chart'));

// ---------------------------------------------------------------------------
// Table of rounds
// ---------------------------------------------------------------------------

function formatNumber(v) {
  if (v === Infinity) return '∞';
  if (v === -Infinity) return '-∞';
  if (Number.isNaN(v)) return 'NaN';
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toFixed(4)));
}

function renderTable() {
  const container = $('table-wrap');
  container.textContent = '';
  if (!lastResult.columns.length) return;

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const name of ['Round', ...lastResult.columns.map((c) => c.name)]) {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const shown = Math.min(lastResult.rounds + 1, TABLE_ROW_LIMIT);
  for (let r = 0; r < shown; r++) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = String(r);
    tr.appendChild(td);
    for (const col of lastResult.columns) {
      const cell = document.createElement('td');
      cell.textContent = formatNumber(lastResult.series.get(col.name)[r]);
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  if (shown < lastResult.rounds + 1) {
    const note = document.createElement('p');
    note.className = 'empty';
    note.textContent = `Showing the first ${TABLE_ROW_LIMIT} of ${lastResult.rounds + 1} rounds — download the CSV for the full run.`;
    container.appendChild(note);
  }
}

$('csv').addEventListener('click', () => {
  if (!lastResult || !lastResult.columns.length) return;
  const lines = [['round', ...lastResult.columns.map((c) => c.name)].join(',')];
  for (let r = 0; r <= lastResult.rounds; r++) {
    lines.push([r, ...lastResult.columns.map((c) => lastResult.series.get(c.name)[r])].join(','));
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'model-run.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------------------
// Share by URL (compressed into the hash; no server involved)
// ---------------------------------------------------------------------------

const b64uEncode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function encodeShare() {
  const payload = JSON.stringify({
    c: view.state.doc.toString(),
    r: clampRounds(parseInt($('rounds').value, 10)),
    s: parseInt($('seed').value, 10) || 0,
  });
  const bytes = new TextEncoder().encode(payload);
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return 'z' + b64uEncode(compressed);
  }
  return 'r' + b64uEncode(bytes);
}

async function decodeShare(hash) {
  const kind = hash[0];
  const bytes = b64uDecode(hash.slice(1));
  let raw;
  if (kind === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    raw = bytes;
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

$('share').addEventListener('click', async () => {
  const hash = await encodeShare();
  const url = `${location.origin}${location.pathname}#m=${hash}`;
  history.replaceState(null, '', `#m=${hash}`);
  try {
    await navigator.clipboard.writeText(url);
    setStatus('ok', 'Share link copied to clipboard');
  } catch {
    setStatus('warn', 'Share link is in the address bar (clipboard unavailable)');
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
  if (!ex) return;
  $('rounds').value = String(ex.rounds);
  setDoc(ex.source);
});

for (const id of ['rounds', 'seed']) {
  $(id).addEventListener('input', () => {
    clearTimeout(scheduled);
    scheduled = setTimeout(runSimulation, SIM_DEBOUNCE_MS);
  });
}

async function boot() {
  const m = /[#&]m=([^&]+)/.exec(location.hash);
  if (m) {
    try {
      const shared = await decodeShare(m[1]);
      $('rounds').value = String(clampRounds(shared.r));
      $('seed').value = String(shared.s ?? 42);
      select.value = '';
      setDoc(shared.c);
      return;
    } catch {
      setStatus('warn', 'Could not decode the shared model from the URL — loading an example instead');
    }
  }
  select.value = EXAMPLES[0].id;
  $('rounds').value = String(EXAMPLES[0].rounds);
  setDoc(EXAMPLES[0].source);
}

boot();
