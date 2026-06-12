/**
 * sim-worker.js — runs simulations off the main thread.
 *
 * Receives { id, source, rounds, seed }, replies with either
 *   { id, ok: true, columns, rows: Float64Array (transferred), rowLen, issues, ms }
 * or
 *   { id, ok: false, message }
 *
 * The main thread enforces a wall-clock deadline with Worker.terminate(),
 * so a runaway run can always be stopped.
 */

import { analyze, hasErrors } from './lang.js';
import { run } from './engine.js';

self.onmessage = (e) => {
  const { id, source, rounds, seed } = e.data;
  try {
    const analysis = analyze(source);
    if (hasErrors(analysis)) {
      const first = analysis.diagnostics.find((d) => d.severity === 'error');
      self.postMessage({ id, ok: false, message: first.message });
      return;
    }
    const t0 = performance.now();
    const result = run(analysis, { rounds, seed });
    const ms = performance.now() - t0;

    const rowLen = result.columns.length;
    const flat = new Float64Array(result.rows.length * rowLen);
    result.rows.forEach((row, r) => {
      for (let c = 0; c < rowLen; c++) flat[r * rowLen + c] = row[c];
    });
    self.postMessage(
      { id, ok: true, columns: result.columns, rows: flat, rowLen, issues: result.issues, ms },
      [flat.buffer],
    );
  } catch (err) {
    self.postMessage({ id, ok: false, message: String(err.message || err) });
  }
};
