# Simulation DSL

A text language for the whole [scottfr/simulation](https://github.com/scottfr/simulation)
modeling toolkit. You write a compact, diffable model; it compiles directly onto
the simulation engine's API and **runs on that engine** — in the browser, with no
backend. The DSL describes the *structure* of a model; the engine owns the *math*
(its formula language: `[References]`, `{units}`, `if … then … else end if`, vectors,
local variables, user functions).

This is the DSL the research report (`research/systems-modeling-playground.md`)
calls for, but pointed at the one mature, pure-JS, code-first engine in the
landscape — so it covers far more than stock-and-flow: full agent-based modeling
too.

## Why a DSL over the raw API

The engine's API is `m.Stock({…})`, `m.Flow(a, b, {…})`, `m.Link(x, y)` — fluent,
but verbose, and it makes you wire every cross-reference `Link` by hand. The DSL
keeps the notation close to how modelers think, and **infers the links** the
engine requires from the `[References]` in your equations (InsightMaker adds these
in its GUI; here they fall out of the text). The result stays terse, version-
controllable, and LLM-friendly, while the engine keeps ownership of execution
(Euler/RK4 integration, units checking, the agent scheduler).

## The language

### Simulation settings

```
sim {
  start 0          # start time (default 0)
  length 50        # run length in time units (default 100)
  step 0.5         # integration time step, DT (default 1)
  units Years      # Seconds|Minutes|Hours|Days|Weeks|Months|Years
  algorithm RK4    # RK4 (default) or Euler
}

name "My Model"            # optional
description "..."          # optional
```

### System dynamics primitives

```
stock Prey { initial 400  nonNegative  units "Prey" }
stock Belt { initial 0  type Conveyor  delay 5 }     # Store (default) | Conveyor
stock Quick = 100                                    # shorthand sets `initial`

variable Rate = 0.25 { units "1 / Years" }           # shorthand sets `value`
variable Death { value "0.005 * [Predators]" }

# flow Name: source -> target     (use `_` for an external source/sink)
flow Births: _ -> Prey  { rate "[Prey] * [Rate]"  nonNegative }
flow Deaths: Prey -> _  = "[Prey] * 0.1"             # shorthand sets `rate`

converter Growth {
  input Population        # `time`, or the name of another primitive
  interpolation Linear    # Linear (default) | Discrete
  points (0, 2) (5000, 1) (10000, 0)
}

link Rate -> Births       # explicit link (links are otherwise inferred)
```

### Agent-based modeling

```
agent Person {
  state Healthy  { startActive true }
  state Infected { startActive false }

  # transition Name: from -> to     (`_` = enter from / leave to nowhere)
  transition Catch: Healthy -> Infected { trigger Probability  value 0.05 }
  transition Heal:  Infected -> Healthy { trigger Timeout       value "{14 days}" }

  # agents can own their own stocks/variables/flows too
  stock Age { initial 0 }
}

population Pop {
  size 200
  base Person                       # the agent definition to instantiate
  placement Grid                    # optional: Random|Network|Grid|Ellipse|"Custom Function"
  network "Custom Function"         # optional
}

action Reset {
  trigger Timeout      # Timeout | Probability | Condition
  value 30
  do "[Healthy] <- true"            # equation run when triggered
}
```

To chart agent counts, add population-level variables that query states:

```
variable "Num Infected" { value "Count([Pop].FindState([Infected]))" }
```

(Name counting variables differently from the states they count — a top-level
`[Infected]` would otherwise resolve to the variable, not the state.)

### Values, names, and references

- A property value is a **number** (`400`), a **"quoted equation/units string"**
  passed verbatim to the engine, a **boolean** (`true`/`false`), or a bare keyword
  (enum values like `RK4`, `Linear`).
- Names are identifiers or `"quoted strings"` (for names with spaces or symbols
  like `β`). References inside equations are `[Name]` and resolve
  case-insensitively.
- Comments start with `#` or `//`. Properties are separated by newlines or `;`.

## Mapping to the engine

| DSL | Engine primitive |
|---|---|
| `stock` | `Model.Stock` (`initial`, `nonNegative`, `type`, `delay`, `units`, `min`/`max`) |
| `variable` | `Model.Variable` (`value`, `units`, `min`/`max`) |
| `flow A: x -> y` | `Model.Flow(x, y, …)` (`rate`, `nonNegative`) |
| `converter` | `Model.Converter` (`input`, `interpolation`, `values`) |
| `state` | `Model.State` (`startActive`, `residency`) |
| `transition A: x -> y` | `Model.Transition(x, y, …)` (`trigger`, `value`, `repeat`, `recalculate`) |
| `action` | `Model.Action` (`trigger`, `value`, `action`, …) |
| `agent` | `Model.Agent` (members get `parent` set to the agent) |
| `population` | `Model.Population` (`agentBase`, `populationSize`, geo/network) |
| `link A -> B` | `Model.Link(A, B)` (also inferred from equation `[refs]`) |

`ModelJSON` (the engine's interchange format) covers the SD subset — stocks,
variables, converters, states, flows, transitions, links — but **not** agents,
populations, or actions. The "ModelJSON" export button serializes models in that
subset via the engine's own `toModelJSON`; full ABM models always run, but can't
round-trip through ModelJSON.

## Architecture

| File | Role |
|---|---|
| `lang.js` | Tokenizer, parser, analyzer (symbols + diagnostics). Dependency-free; runs in the browser and under Node. One analyzer feeds the linter, completion, and hover. |
| `compiler.js` | `compile(analysis, Model)` — builds a live model on the injected engine `Model` class, including the auto-generated links. |
| `examples.js` | Starter models spanning the toolkit (SD, lookup converter, agent-based SIR, scheduled action). |
| `main.js` | CodeMirror 6 wiring, live run on the engine (main thread, step-count guarded), uPlot chart, table, CSV + ModelJSON export, share-by-URL. |
| `index.html` | The page; loads CodeMirror, uPlot, and the `simulation` engine as pinned ES modules via an import map. |
| `tests/run-tests.mjs` | End-to-end: compile DSL → run on the real engine → assert on series. |

No build step in the browser. The engine is loaded from
`esm.sh/simulation@8.0.0` (bundled with its vendored deps in one request);
CodeMirror/uPlot from esm.sh / jsDelivr. Because
import maps don't reach module workers, the engine runs on the main thread,
bounded by the model's own length / step (with a step-count guard).

## Running the tests

```bash
cd tools/simulation-dsl
npm install            # pulls the `simulation` engine (a devtime dependency)
npm test               # node tests/run-tests.mjs
```

`simulation` is AGPL-3.0; this tool loads it as an external dependency and does
not vendor its source.
