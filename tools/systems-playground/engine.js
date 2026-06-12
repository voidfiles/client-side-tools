/**
 * engine.js — discrete-rounds simulation engine.
 *
 * Faithful to lethain/systems semantics (verified against the original
 * Python package's output on its examples/ corpus — see tests/):
 *   - each round processes flows in REVERSED declaration order,
 *   - a flow subtracts from its source immediately but destination
 *     additions are deferred to the end of the round,
 *   - Rate moves min(rate, source, room-in-destination), never negative,
 *   - Conversion drains the source and floors the converted amount,
 *   - Leak floors the leaked amount and caps it at destination capacity,
 *   - initial values may reference other stocks (evaluated in
 *     dependency order; cycles are rejected by the analyzer).
 *
 * Extensions: auxiliaries (recomputed every round from the current state)
 * and the BUILTINS catalog from lang.js, with all randomness drawn from a
 * single seeded PRNG so a given (source, seed, rounds) is reproducible.
 *
 * Dependency-free; used by the simulation worker and by Node tests.
 */

import { BUILTINS } from './lang.js';

export const MAX_ROUNDS = 10000;
export const MAX_CELLS = 2_000_000; // rounds × columns guard

/** mulberry32 — tiny seeded PRNG, plenty for playground reproducibility. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RuntimeIssues {
  constructor() {
    this.list = [];
    this.seen = new Set();
  }
  add(round, message) {
    const key = message;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ round, message });
  }
}

function evaluate(expr, env) {
  switch (expr.type) {
    case 'num': return expr.value;
    case 'ref': {
      const v = env.lookup(expr.name);
      return v === undefined ? 0 : v;
    }
    case 'un': {
      const v = evaluate(expr.e, env);
      return expr.op === '-' ? -v : (v === 0 ? 1 : 0); // not
    }
    case 'bin': {
      const op = expr.op;
      if (op === 'and') return evaluate(expr.l, env) !== 0 && evaluate(expr.r, env) !== 0 ? 1 : 0;
      if (op === 'or') return evaluate(expr.l, env) !== 0 || evaluate(expr.r, env) !== 0 ? 1 : 0;
      const l = evaluate(expr.l, env);
      const r = evaluate(expr.r, env);
      switch (op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) env.issues.add(env.time, `Division by zero (first at round ${env.time})`);
          return l / r;
        case '^': return Math.pow(l, r);
        case '<': return l < r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '==': return l === r ? 1 : 0;
        case '!=': return l !== r ? 1 : 0;
        default: throw new Error(`Unknown operator ${op}`);
      }
    }
    case 'if': return evaluate(expr.cond, env) !== 0 ? evaluate(expr.then, env) : evaluate(expr.else, env);
    case 'call': {
      const b = BUILTINS[expr.name.toUpperCase()];
      if (!b) throw new Error(`Unknown function ${expr.name}`);
      return b.fn(expr.args.map((a) => evaluate(a, env)), env);
    }
    default: throw new Error(`Unknown expression node ${expr.type}`);
  }
}

/**
 * Run an analyzed model.
 *
 * @param analysis  result of lang.analyze() — must be error-free
 * @param opts      { rounds = 10, seed = 42 }
 * @returns {
 *   columns: [{ name, kind: 'stock'|'aux' }],   // hidden (infinite) stocks excluded
 *   rows: rounds+1 arrays of numbers,
 *   issues: [{ round, message }],
 * }
 */
export function run(analysis, opts = {}) {
  const rounds = Math.max(0, Math.min(MAX_ROUNDS, Math.floor(opts.rounds ?? 10)));
  const seed = (opts.seed ?? 42) >>> 0;

  const { stocks, auxes, flows, auxOrder, initialOrder } = analysis;
  const issues = new RuntimeIssues();
  const rng = mulberry32(seed);

  const visibleStocks = [...stocks.values()].filter((s) => !s.infinite).map((s) => s.name);
  const auxNames = auxOrder;
  const columns = [
    ...visibleStocks.map((name) => ({ name, kind: 'stock' })),
    ...auxNames.map((name) => ({ name, kind: 'aux' })),
  ];
  if ((rounds + 1) * Math.max(1, columns.length) > MAX_CELLS) {
    throw new Error(`Model too large: ${rounds} rounds × ${columns.length} columns exceeds the playground budget`);
  }

  const state = Object.create(null); // stock name → value
  const auxValues = Object.create(null); // aux name → value (frozen per round)

  const env = {
    time: 0,
    dt: 1,
    startTime: 0,
    endTime: rounds,
    rng,
    issues,
    lookup(name) {
      if (name in state) return state[name];
      return auxValues[name];
    },
  };

  // Initial state, in dependency order (initials reference stocks only).
  for (const name of initialOrder) {
    const s = stocks.get(name);
    state[name] = s.infinite ? Infinity : (s.initial ? evaluate(s.initial, env) : 0);
  }

  const computeAuxes = () => {
    for (const name of auxNames) {
      auxValues[name] = evaluate(auxes.get(name).expr, env);
    }
  };

  const reversedFlows = [...flows].reverse();

  const snapshotRow = () => {
    computeAuxes(); // keep aux columns consistent with the stocks on the same row
    const row = new Array(columns.length);
    let i = 0;
    for (const name of visibleStocks) row[i++] = state[name];
    for (const name of auxNames) row[i++] = auxValues[name];
    return row;
  };

  const rows = [snapshotRow()];

  for (let round = 0; round < rounds; round++) {
    env.time = round;
    computeAuxes(); // auxes are frozen at their start-of-round values during flows

    const deferred = [];
    for (const flow of reversedFlows) {
      const srcName = flow.source.name;
      const dstName = flow.dest.name;
      const src = state[srcName];
      const dst = state[dstName];

      const dstStock = stocks.get(dstName);
      let capacity = dstStock.maximum ? evaluate(dstStock.maximum, env) : Infinity;
      if (dst !== Infinity) capacity -= dst;

      const rate = evaluate(flow.rate, env);
      let rem = 0, add = 0;
      if (flow.flowType === 'conversion') {
        let maxSrcChange;
        if (dst === Infinity || capacity === Infinity) {
          maxSrcChange = src;
        } else {
          // Matches the original implementation, including its double
          // subtraction of the destination value.
          maxSrcChange = Math.max(0, Math.floor((capacity - dst) / rate));
        }
        const change = Math.floor(maxSrcChange * rate);
        if (change !== 0) { rem = maxSrcChange; add = change; }
      } else if (flow.flowType === 'leak') {
        let change = Math.floor(src * rate);
        if (!Number.isNaN(capacity)) change = Math.min(capacity, change);
        rem = add = change;
      } else { // rate
        if (src > 0) {
          let change = src - rate >= 0 ? rate : src;
          change = Math.min(capacity, Math.max(0, change));
          rem = add = change;
        }
      }

      state[srcName] -= rem;
      deferred.push([dstName, add]);

      if (Number.isNaN(state[srcName]) || Number.isNaN(add)) {
        issues.add(round, `'${srcName} > ${dstName}' produced NaN (first at round ${round})`);
      }
    }
    for (const [dstName, change] of deferred) state[dstName] += change;

    env.time = round + 1;
    rows.push(snapshotRow());
  }

  return { columns, rows, issues: issues.list };
}
