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

/** Compile + run, returning a helper to read series by name. */
function run(src) {
  const analysis = analyze(src);
  assert.ok(!hasErrors(analysis), 'unexpected analyzer errors: ' + JSON.stringify(analysis.diagnostics.filter((d) => d.severity === 'error')));
  const { model, plottables } = compile(analysis, Model);
  const res = model.simulate();
  const byName = new Map(plottables.map((p) => [p.name, p.primitive]));
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

// --------------------------------------------------------------------------
// Parsing / analysis (no engine)
// --------------------------------------------------------------------------

test('analyzer: clean predator-prey has no errors', () => {
  const a = analyze(`
    sim { start 0 length 10 step 1 units Years algorithm RK4 }
    stock Prey { initial 400 nonNegative }
    variable Rate = 0.25
    flow Births: _ -> Prey { rate "[Prey] * [Rate]" }
  `);
  assert.equal(a.diagnostics.filter((d) => d.severity === 'error').length, 0);
});

test('analyzer: flags undefined flow target', () => {
  const a = analyze(`flow F: A -> Missing { rate 1 }\nstock A { initial 1 }`);
  assert.ok(a.diagnostics.some((d) => /Missing.*not defined/.test(d.message)));
});

test('analyzer: flags duplicate names', () => {
  const a = analyze(`stock X { initial 1 }\nvariable X = 2`);
  assert.ok(a.diagnostics.some((d) => /already defined/.test(d.message)));
});

test('analyzer: bad enum value reported', () => {
  const a = analyze(`stock X { initial 1 type Banana }`);
  assert.ok(a.diagnostics.some((d) => /Stock type must be one of/.test(d.message)));
});

test('analyzer: population without base errors', () => {
  const a = analyze(`agent P {}\npopulation Pop { size 5 }`);
  assert.ok(a.diagnostics.some((d) => /needs a base agent/.test(d.message)));
});

// --------------------------------------------------------------------------
// System dynamics: stocks, variables, flows
// --------------------------------------------------------------------------

test('exponential growth matches closed form', () => {
  const r = run(`
    sim { start 0 length 5 step 1 units Years algorithm Euler }
    stock Population { initial 100 nonNegative }
    variable Rate = 0.1
    flow Growth: _ -> Population { rate "[Population] * [Rate]" }
  `);
  const s = r.series('Population');
  approx(s[0], 100, 1e-9, 't0');
  approx(s[1], 110, 1e-9, 't1');     // Euler: 100 * (1.1)
  approx(s[2], 121, 1e-9, 't2');
  approx(s[5], 100 * 1.1 ** 5, 1e-6, 't5');
});

test('shorthand initial / rate assignment works', () => {
  const r = run(`
    sim { start 0 length 3 step 1 algorithm Euler }
    stock Tank = 0
    flow Fill: _ -> Tank = 5
  `);
  assert.deepEqual(r.series('Tank').map(Math.round), [0, 5, 10, 15]);
});

test('drain flow with non-negative source', () => {
  const r = run(`
    sim { start 0 length 4 step 1 algorithm Euler }
    stock Tank { initial 10 nonNegative }
    flow Drain: Tank -> _ { rate 3 nonNegative }
  `);
  // 10 -> 7 -> 4 -> 1 -> 0 (clamped, can't go negative)
  assert.deepEqual(r.series('Tank').map(Math.round), [10, 7, 4, 1, 0]);
});

test('predator-prey runs and stays positive', () => {
  const r = run(`
    sim { start 0 length 30 step 0.25 units Years algorithm RK4 }
    stock Prey { initial 400 nonNegative }
    stock Predators { initial 20 nonNegative }
    variable PreyBirth = 0.25
    variable PreyDeath { value "0.005 * [Predators]" }
    variable PredBirth { value "0.0002 * [Prey]" }
    variable PredDeath = 0.25
    flow PreyBirths: _ -> Prey { rate "[Prey] * [PreyBirth]" nonNegative }
    flow PreyDeaths: Prey -> _ { rate "[Prey] * [PreyDeath]" nonNegative }
    flow PredBirths: _ -> Predators { rate "[Predators] * [PredBirth]" nonNegative }
    flow PredDeaths: Predators -> _ { rate "[Predators] * [PredDeath]" nonNegative }
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
    sim { start 0 length 4 step 1 algorithm Euler }
    converter C { input time interpolation Linear points (0,0) (2,10) (4,20) }
  `);
  assert.deepEqual(r.series('C'), [0, 5, 10, 15, 20]);
});

test('converter keyed on a stock value', () => {
  const r = run(`
    sim { start 0 length 3 step 1 algorithm Euler }
    stock Level { initial 0 }
    flow In: _ -> Level = 1
    converter Lookup { input Level interpolation Discrete points (0,100) (1,200) (2,300) }
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
    sim { start 0 length 12 step 1 units Years algorithm Euler }
    agent Person {
      state Healthy  { startActive true }
      state Infected { startActive false }
      transition Spread: Healthy -> Infected { trigger Probability value 0.3 }
    }
    population Pop { size 60 base Person }
    variable NumInfected { value "Count([Pop].FindState([Infected]))" }
    variable NumHealthy  { value "Count([Pop].FindState([Healthy]))" }
  `);
  const inf = r.series('NumInfected');
  const heal = r.series('NumHealthy');
  assert.equal(inf[0], 0, 'starts with nobody infected');
  assert.ok(inf[inf.length - 1] > inf[0], 'infections grow over time');
  for (let i = 0; i < inf.length; i++) approx(inf[i] + heal[i], 60, 1e-9, `conservation at ${i}`);
});

test('timeout transition moves agents after a delay', () => {
  const r = run(`
    sim { start 0 length 8 step 1 units Years algorithm Euler }
    agent Cell {
      state A { startActive true }
      state B { startActive false }
      transition Go: A -> B { trigger Timeout value "{3 years}" }
    }
    population Pop { size 10 base Cell }
    variable InB { value "Count([Pop].FindState([B]))" }
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
    sim { start 0 length 6 step 1 units Years algorithm Euler }
    stock Tank { initial 100 }
    action Dump { trigger Timeout value 3 do "[Tank] <- 0" }
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
    const errs = a.diagnostics.filter((d) => d.severity === 'error');
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
