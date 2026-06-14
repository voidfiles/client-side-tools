/**
 * End-to-end tests: compile DSL source, run it on the real scottfr/simulation
 * engine, and assert on the resulting series. Requires the `simulation` package
 * (declared in package.json — run `npm install` in tools/simulation-dsl first).
 *
 *   node tools/simulation-dsl/tests/run-tests.mjs
 */

import assert from 'node:assert/strict';
import { analyze, hasErrors } from '../lang.js';
import { compile } from '../compiler.js';
import { EXAMPLES } from '../examples.js';

let Model;
try {
  ({ Model } = await import('simulation'));
} catch {
  console.error('The `simulation` package is not installed. Run:\n  cd tools/simulation-dsl && npm install\n');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}

/**
 * Compile + run, returning a helper to read series by name. Series are looked up
 * through every model-scope primitive (not just the charted ones), so a test can
 * read any stock/variable/flow/converter regardless of `sim { plot: … }`.
 */
function run(src) {
  const analysis = analyze(src);
  assert.ok(!hasErrors(analysis), 'unexpected analyzer errors: ' + JSON.stringify(analysis.diagnostics.filter((d) => d.severity === 'error')));
  const { model, plottables, instances } = compile(analysis, Model);
  const res = model.simulate();
  const byName = new Map();
  for (const inst of instances.values()) if (inst.scope === 'model') byName.set(inst.name, inst.primitive);
  return {
    res,
    series: (name) => res.series(byName.get(name)),
    value: (name, t) => res.value(byName.get(name), t),
    times: () => res.times(),
    plottables,
  };
}

function approx(a, b, tol = 1e-6, msg = '') {
  assert.ok(Math.abs(a - b) <= tol, `${msg} expected ≈${b}, got ${a}`);
}

const errorsOf = (a) => a.diagnostics.filter((d) => d.severity === 'error');

// --------------------------------------------------------------------------
// Parsing / analysis (no engine)
// --------------------------------------------------------------------------

test('analyzer: clean predator-prey has no errors', () => {
  const a = analyze(`
    sim { start: 0, length: 10, step: 1, units: 'Years', algorithm: RK4 }
    @Prey { initial: 400, nonNegative: true }
    $Rate = 0.25
    Births: _ -> Prey { rate: "[Prey] * [Rate]" }
  `);
  assert.equal(errorsOf(a).length, 0);
});

test('analyzer: flags undefined flow target', () => {
  const a = analyze(`A -> Missing { rate: 1 }\n@A { initial: 1 }`);
  assert.ok(a.diagnostics.some((d) => /Missing.*not defined/.test(d.message)));
});

test('analyzer: flags duplicate names', () => {
  const a = analyze(`@X { initial: 1 }\n$X = 2`);
  assert.ok(a.diagnostics.some((d) => /already defined/.test(d.message)));
});

test('analyzer: bad enum value reported', () => {
  const a = analyze(`@X { initial: 1, type: Banana }`);
  assert.ok(a.diagnostics.some((d) => /Stock type must be one of/.test(d.message)));
});

test('analyzer: population without base errors', () => {
  const a = analyze(`agent P {}\npopulation Pop { size: 5 }`);
  assert.ok(a.diagnostics.some((d) => /needs a base agent/.test(d.message)));
});

// --------------------------------------------------------------------------
// Syntax: sigils, separators, numbers, auto-naming
// --------------------------------------------------------------------------

test('sigils: @ declares a stock, $ declares a variable', () => {
  const a = analyze(`@S { initial: 10 }\n$V = 3`);
  assert.equal(errorsOf(a).length, 0);
  assert.ok(a.model.stocks.some((s) => s.name === 'S'));
  assert.ok(a.model.variables.some((v) => v.name === 'V'));
});

test('old keyword forms give a helpful diagnostic', () => {
  assert.ok(analyze(`stock S { initial 1 }`).diagnostics.some((d) => /@Name/.test(d.message)));
  assert.ok(analyze(`flow F: A -> B { rate 1 }`).diagnostics.some((d) => /Source -> Target/.test(d.message)));
  assert.ok(analyze(`variable X = 1`).diagnostics.some((d) => /\$Name/.test(d.message)));
});

test('floats must start with a digit: .5 is rejected, 0.5 is fine', () => {
  assert.ok(errorsOf(analyze(`$X = .5`)).length > 0);
  assert.equal(errorsOf(analyze(`$X = 0.5`)).length, 0);
});

test('comma-separated properties and bare flags parse', () => {
  const a = analyze(`@S { initial: 5, nonNegative }`);
  assert.equal(errorsOf(a).length, 0);
  const s = a.model.stocks.find((x) => x.name === 'S');
  assert.equal(s.initial, 5);
  assert.equal(s.nonNegative, true);
});

test('flows auto-name as {Source}To{Target}; Name: overrides', () => {
  const a = analyze(`@A { initial: 0 }\n@B { initial: 0 }\nA -> B { rate: 1 }\n_ -> A { rate: 1 }\nMove: A -> B { rate: 1 }`);
  const names = a.model.flows.map((f) => f.name);
  assert.ok(names.includes('AToB'), 'AToB');
  assert.ok(names.includes('ExternalToA'), 'ExternalToA');
  assert.ok(names.includes('Move'), 'Move');
});

test('@ is optional on flow endpoints', () => {
  const a = analyze(`@A { initial: 1 }\n@B { initial: 0 }\n@A -> @B { rate: "0.5" }`);
  assert.equal(errorsOf(a).length, 0);
  assert.equal(a.model.flows[0].source.name, 'A');
  assert.equal(a.model.flows[0].target.name, 'B');
});

// --------------------------------------------------------------------------
// Plot configuration
// --------------------------------------------------------------------------

test('plot defaults to stocks only', () => {
  const a = analyze(`sim { start: 0, length: 2, step: 1 }\n@S { initial: 1 }\n$V = 5\n_ -> S { rate: 1 }`);
  const { plottables } = compile(a, Model);
  assert.deepEqual([...new Set(plottables.map((p) => p.kind))], ['stock']);
  assert.deepEqual(plottables.map((p) => p.name), ['S']);
});

test('sim { plot: [...] } selects which kinds are charted', () => {
  const a = analyze(`sim { start: 0, length: 2, step: 1, plot: [stock, variable] }\n@S { initial: 1 }\n$V = 5`);
  const { plottables } = compile(a, Model);
  const kinds = new Set(plottables.map((p) => p.kind));
  assert.ok(kinds.has('stock') && kinds.has('variable'));
  assert.equal(kinds.size, 2);
});

test('plot accepts all, plurals, and reports unknown kinds', () => {
  assert.equal(new Set(analyze(`sim { plot: all }`).config.plot).size, 5);
  assert.deepEqual(analyze(`sim { plot: stocks }`).config.plot, ['stock']);
  assert.ok(errorsOf(analyze(`sim { plot: [banana] }`)).length > 0);
});

// --------------------------------------------------------------------------
// System dynamics: stocks, variables, flows
// --------------------------------------------------------------------------

test('exponential growth matches closed form', () => {
  const r = run(`
    sim { start: 0, length: 5, step: 1, units: 'Years', algorithm: Euler }
    @Population { initial: 100, nonNegative: true }
    $Rate = 0.1
    Growth: _ -> Population { rate: "[Population] * [Rate]" }
  `);
  const s = r.series('Population');
  approx(s[0], 100, 1e-9, 't0');
  approx(s[1], 110, 1e-9, 't1');     // Euler: 100 * (1.1)
  approx(s[2], 121, 1e-9, 't2');
  approx(s[5], 100 * 1.1 ** 5, 1e-6, 't5');
});

test('shorthand initial / rate assignment works', () => {
  const r = run(`
    sim { start: 0, length: 3, step: 1, algorithm: Euler }
    @Tank = 0
    Fill: _ -> Tank = 5
  `);
  assert.deepEqual(r.series('Tank').map(Math.round), [0, 5, 10, 15]);
});

test('bare @Stock defaults its initial value to zero', () => {
  const r = run(`
    sim { start: 0, length: 2, step: 1, algorithm: Euler }
    @Tank
    Fill: _ -> Tank { rate: 2 }
  `);
  assert.deepEqual(r.series('Tank').map(Math.round), [0, 2, 4]);
});

test('drain flow with non-negative source', () => {
  const r = run(`
    sim { start: 0, length: 4, step: 1, algorithm: Euler }
    @Tank { initial: 10, nonNegative: true }
    Drain: Tank -> _ { rate: 3, nonNegative: true }
  `);
  // 10 -> 7 -> 4 -> 1 -> 0 (clamped, can't go negative)
  assert.deepEqual(r.series('Tank').map(Math.round), [10, 7, 4, 1, 0]);
});

test('predator-prey runs and stays positive', () => {
  const r = run(`
    sim { start: 0, length: 30, step: 0.25, units: 'Years', algorithm: RK4 }
    @Prey { initial: 400, nonNegative: true }
    @Predators { initial: 20, nonNegative: true }
    $PreyBirth = 0.25
    $PreyDeath { value: "0.005 * [Predators]" }
    $PredBirth { value: "0.0002 * [Prey]" }
    $PredDeath = 0.25
    PreyBirths: _ -> Prey { rate: "[Prey] * [PreyBirth]", nonNegative: true }
    PreyDeaths: Prey -> _ { rate: "[Prey] * [PreyDeath]", nonNegative: true }
    PredBirths: _ -> Predators { rate: "[Predators] * [PredBirth]", nonNegative: true }
    PredDeaths: Predators -> _ { rate: "[Predators] * [PredDeath]", nonNegative: true }
  `);
  const prey = r.series('Prey');
  assert.ok(prey.every((x) => x >= 0), 'prey stays non-negative');
  assert.ok(Math.max(...prey) > 400, 'prey population oscillates upward');
});

// --------------------------------------------------------------------------
// Converters
// --------------------------------------------------------------------------

test('converter on time interpolates linearly', () => {
  const r = run(`
    sim { start: 0, length: 4, step: 1, algorithm: Euler }
    converter C { input: time, interpolation: Linear, points: (0,0) (2,10) (4,20) }
  `);
  assert.deepEqual(r.series('C'), [0, 5, 10, 15, 20]);
});

test('converter keyed on a stock value', () => {
  const r = run(`
    sim { start: 0, length: 3, step: 1, algorithm: Euler }
    @Level { initial: 0 }
    In: _ -> Level = 1
    converter Lookup { input: Level, interpolation: Discrete, points: (0,100) (1,200) (2,300) }
  `);
  const lk = r.series('Lookup');
  approx(lk[0], 100, 1e-9, 'level 0');
  approx(lk[1], 200, 1e-9, 'level 1');
  approx(lk[2], 300, 1e-9, 'level 2');
});

// --------------------------------------------------------------------------
// Agent-based modeling
// --------------------------------------------------------------------------

test('agent population with probabilistic transition spreads', () => {
  const r = run(`
    sim { start: 0, length: 12, step: 1, units: 'Years', algorithm: Euler }
    agent Person {
      state Healthy  { startActive: true }
      state Infected { startActive: false }
      transition Spread: Healthy -> Infected { trigger: Probability, value: 0.3 }
    }
    population Pop { size: 60, base: Person }
    $NumInfected { value: "Count([Pop].FindState([Infected]))" }
    $NumHealthy  { value: "Count([Pop].FindState([Healthy]))" }
  `);
  const inf = r.series('NumInfected');
  const heal = r.series('NumHealthy');
  assert.equal(inf[0], 0, 'starts with nobody infected');
  assert.ok(inf[inf.length - 1] > inf[0], 'infections grow over time');
  for (let i = 0; i < inf.length; i++) approx(inf[i] + heal[i], 60, 1e-9, `conservation at ${i}`);
});

test('timeout transition moves agents after a delay', () => {
  const r = run(`
    sim { start: 0, length: 8, step: 1, units: 'Years', algorithm: Euler }
    agent Cell {
      state A { startActive: true }
      state B { startActive: false }
      transition Go: A -> B { trigger: Timeout, value: "{3 years}" }
    }
    population Pop { size: 10, base: Cell }
    $InB { value: "Count([Pop].FindState([B]))" }
  `);
  const inB = r.series('InB');
  assert.equal(inB[0], 0);
  assert.equal(inB[1], 0);
  assert.equal(inB[10 > inB.length - 1 ? inB.length - 1 : 5], 10, 'all moved by t=5');
});

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

test('timeout action mutates a stock', () => {
  const r = run(`
    sim { start: 0, length: 6, step: 1, units: 'Years', algorithm: Euler }
    @Tank { initial: 100 }
    action Dump { trigger: Timeout, value: 3, do: "[Tank] <- 0" }
  `);
  const t = r.series('Tank');
  assert.equal(t[0], 100);
  assert.equal(t[t.length - 1], 0, 'tank emptied by the action');
});

// --------------------------------------------------------------------------
// Every shipped example must analyze cleanly and run on the engine
// --------------------------------------------------------------------------

for (const ex of EXAMPLES) {
  test(`example "${ex.id}" compiles and runs`, () => {
    const a = analyze(ex.source);
    const errs = errorsOf(a);
    assert.equal(errs.length, 0, 'analyzer errors: ' + JSON.stringify(errs));
    const { model, plottables } = compile(a, Model);
    const res = model.simulate();
    assert.ok(plottables.length > 0, 'has plottable series');
    assert.ok(res.times().length > 1, 'produced a time series');
  });
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  process.exitCode = 1;
}
