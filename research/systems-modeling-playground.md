# A Language-First Systems Modeling Playground — Research Report

**Date:** 2026-06-12
**Question:** How to build a browser-only (static GitHub Pages), *language-first* system dynamics playground in the spirit of [lethain/systems](https://github.com/lethain/systems) — with an embedded IDE that gives immediate, language-server-like feedback, a bigger standard library than `systems`, and charts + per-round tables as output.

**Method:** Five parallel research agents (the `systems` DSL; the open-source SD tool landscape; embeddable browser languages; in-browser editor/IDE tooling; charting + engine design) produced ~95 sourced claims. The 31 load-bearing claims were then each put to three independent adversarial verifiers (primary-source re-fetch; counter-evidence/staleness hunt; numbers/dates/licenses audit). No claim was killed (2/3 refute threshold); corrections from dissenting votes are incorporated below, and remaining soft spots are flagged in the [confidence appendix](#appendix-verification-notes--confidence).

---

## TL;DR — Recommended architecture

**Build the language. Don't embed Python as the core — but design the engine so a Python (or JS) escape hatch can be added later.**

The "bigger standard library" you're missing in `systems` is not *general-purpose computing* — it's a **known, finite list of ~40 system-dynamics builtins** that the [XMILE OASIS standard](https://docs.oasis-open.org/xmile/xmile/v1.0/xmile-v1.0.html) already catalogs (math, random distributions, `DELAY`/`SMTH`, `PULSE`/`STEP`/`RAMP`, lookup tables, `IF…THEN…ELSE`). Implementing those in TypeScript inside your own evaluator is days of work, and in exchange you keep the three things a general-purpose embedded language gives up: **domain-aware diagnostics** ("stock `Recruiters` referenced but never declared"), **determinism/sandboxing for free**, and a **~200 KB total page weight** instead of megabytes.

The concrete stack:

| Layer | Choice | Why |
|---|---|---|
| Language | Custom DSL, superset of `lethain/systems` syntax | Keeps the notation you love; adds auxiliaries, functions, builtins. No textual SD standard exists to conflict with (XMILE is XML-only) |
| Parser | [Lezer](https://lezer.codemirror.net/) grammar | Incremental, error-tolerant GLR; native CodeMirror integration; one grammar powers highlighting, lint, completion |
| Editor | [CodeMirror 6](https://codemirror.net/) | ~135 KB gz with a language package (official figure); async `linter()`, `autocompletion()`, `hoverTooltip()` give "language-server-like" feedback without LSP; works on mobile (Monaco doesn't) |
| Feedback | Shared analyzer module (parse → symbols → diagnostics), in-process; simulation in a Web Worker, debounced ~300 ms | The TypeScript playground pattern; `Worker.terminate()` is the runaway-model backstop |
| Engine | Hand-written TS: `systems`-compatible discrete-rounds mode **plus** XMILE-style continuous mode (Euler default, optional RK4, configurable `dt`) | Matches every serious open engine surveyed (PySD, Simlin, InsightMaker all default to Euler) |
| Charts | [uPlot](https://github.com/leeoniya/uPlot) (~22 KB gz, canvas) | Re-renders thousands of points per keystroke trivially; Observable Plot (~161 KB gz with d3) if you want prettier exploratory charts |
| Table | Plain HTML `<table>` + CSV export | Zero dependencies; grid libraries are 100 KB–1.9 MB for features you don't need |
| Hosting | One static `tools/systems-playground/` page; ES-module CDN imports or a small committed bundle | Fits this repo's no-build, GitHub Pages convention |

**The fallback, if you decide you'd rather not own a language:** embed **MicroPython** (WASM, ~197 KB gz, starts in <100 ms per vendor) with a BPTK-style stocks/flows Python API — not Pyodide (6.4 MB, 4–5 s startup) unless you genuinely need NumPy/pandas in the page. Details in [§3](#3-language-strategy-the-core-decision).

---

## 1. The starting point: what `lethain/systems` is and isn't

Will Larson's [`systems`](https://github.com/lethain/systems) is a Python package — "a set of tools for describing, running and visualizing systems diagrams" — built around a text DSL ([README](https://raw.githubusercontent.com/lethain/systems/master/README.md), [spec](https://raw.githubusercontent.com/lethain/systems/master/docs/spec.md)).

### The language

```
# stocks: Name(initial), Name(initial, max), [Infinite]
Start(10)
Engineers(Managers * 4, Managers * 8)

# flows: source > destination @ magnitude
Start > Middle @ 2
[Candidates] > PhoneScreens @ Recruiters * 3
PhoneScreens > Onsites @ 0.5
Employees > Departures @ Leak(0.1)
```

Verified semantics (all from [spec.md](https://raw.githubusercontent.com/lethain/systems/master/docs/spec.md), [parse.py](https://raw.githubusercontent.com/lethain/systems/master/systems/parse.py), [lexer.py](https://raw.githubusercontent.com/lethain/systems/master/systems/lexer.py)):

- **Stocks** with optional initial value and maximum; `[Brackets]` declare infinite stocks.
- **Exactly three flow types** — `Rate` (fixed units/round), `Conversion` (multiplier on source outflow), `Leak` (fraction of source) — anything else raises `UnknownFlowType`.
- **Discrete rounds**, not continuous time: `model.run(rounds=N)` iterates round by round; output is a per-round table.
- **Formulas are minimal by design**: the lexer's operator set is exactly `/ + - *` (`OPERATIONS = '[\/\+\-\*]'`), plus numbers, stock references, `inf`, and `#` comments. **There are no functions at all** — the author's own [TODO.md](https://raw.githubusercontent.com/lethain/systems/master/TODO.md) lists "support a whitelist of functions being called in formulas, e.g. max, min, etc" as unbuilt, along with better error messages and fair multi-outflow weighting.
- **Tooling**: four CLIs (`systems-run`, `systems-viz` → Graphviz, `systems-fmt` — a gofmt-style formatter, `systems-lex`), MIT license, pandas/Jupyter integration.

### Status and the author's own framing

- PyPI is frozen at 0.1.0 (Feb 2019); GitHub got a burst of activity in **May 2025** — notably "Add syntax spec to main README to improve usage with LLM" — and Larson shipped [`systems-mcp`](https://github.com/lethain/systems-mcp) (an MCP server exposing `run_systems_model` / `load_systems_documentation`) so LLMs can write and run models ([commits](https://github.com/lethain/systems/commits/master/), [systems-mcp README](https://raw.githubusercontent.com/lethain/systems-mcp/main/README.md)).
- In his [2025 retrospective](https://lethain.com/systems-mcp/) he calls it "far from a perfect" system but says he's gotten significant value from it for ~7 years **because models live in version control** — and in [his strategy writing](https://lethain.com/strategy-systems-modeling/) he recommends it over spreadsheets for iteration speed and low bug surface. *(lethain.com blocks fetchers; quotes verified by exact-phrase search — see appendix.)*
- **No graphical editor, no hosted playground, no JS/WASM port exists** — by the author (all 79 of his repos were enumerated) or any notable third party. Visualization is Graphviz-only.

### What this means for you

The DSL's *shape* is the asset: one declaration per line, `>` for flow direction, `@` for magnitude, `[X]` for boundary stocks — terse, diffable, LLM-friendly. The gaps are exactly your wishlist: no functions/builtins, no named auxiliary variables, no time/test-input functions, no lookups, no continuous-time option, weak error messages, no editor support, no charts. A superset language can keep his files runnable while fixing all of that ([§6](#6-engine-design)).

---

## 2. The landscape: what exists, and the gap you'd fill

The System Dynamics Society's [open-source tools page](https://systemdynamics.org/tools/useful-open-source-tools/) lists only four projects (PySD, Minsky, R, LunaSim) — it's a small world. The survey, all claims verified against repos/registries:

| Tool | Paradigm | Engine / integration | Browser? | License | Status (Jun 2026) |
|---|---|---|---|---|---|
| [lethain/systems](https://github.com/lethain/systems) | **Language-first** (own DSL) | Discrete rounds, Python | No | MIT | Dormant-ish; May 2025 LLM-oriented updates |
| [LunaSim](https://github.com/PHS-SMCS/LunaSim) | Diagram-first (GoJS) | Custom JS, `euler()` + `rk4()` | **Yes — fully client-side** | **None in repo**; GoJS is commercial | Active-ish; ISDC 2024 paper |
| [PySD](https://github.com/SDXorg/pysd) | File translator (Vensim `.mdl`, XMILE → Python) | **Euler only** (`_euler_step`) | No (no Pyodide story found) | MIT | v3.14.3, Mar 2025 |
| [BPTK-Py](https://github.com/transentis/bptk_py) | **Language-first** (Python "SD DSL") + XMILE transpiler | Euler; pandas results; optional Rust backend (v2.3.0) | No (Jupyter) | MIT | v2.3.0, Apr 2026 |
| [Simlin](https://github.com/bpowers/simlin) | Diagram-first UI; engine is a library | **Rust → WASM**; Euler/RK2/RK4, default Euler, default dt=1; protobuf native format; XMILE import/export, Vensim import | **Yes** | Apache-2.0 | Active |
| [sd.js](https://github.com/bpowers/sd.js) | XMILE engine in TypeScript | — | Yes | — | **Archived Sep 2021**, superseded by Simlin |
| [scottfr/simulation](https://github.com/scottfr/simulation) (InsightMaker's engine) | **Code-first JS API** (`m.Stock()`, `m.Flow()`) | Pure JS; **Euler + RK4** | **Yes** (npm) | **AGPL-3.0** | v8.0.0, Dec 2025 |
| [SDEverywhere](https://github.com/climateinteractive/SDEverywhere) | Compiler (Vensim `.mdl` → C/JS/WASM; XMILE "not yet") | Generated code | **Yes** (powers En-ROADS, C-ROADS) | MIT | Active |

Load-bearing observations:

**LunaSim is the closest analog — and a useful cautionary tale.** It's exactly the form factor you want (static client-side app, custom JS engine with selectable Euler/RK4 and dt, ApexCharts charts, Tabulator *results* tables) but diagram-first: models are GoJS `GraphLinksModel` JSON, equations are typed into a hand-rolled HTML table and **evaluated as raw JavaScript via `eval`** ([engine.js](https://github.com/PHS-SMCS/LunaSim/blob/main/sim/engine.js)). Built by Poolesville High School students, presented at the [2024 SD Conference](https://proceedings.systemdynamics.org/2024/papers/P1049.pdf). Two traps to avoid: its diagram dependency **GoJS is free only for non-commercial/non-production use**, and the repo has **no license file** despite self-describing as open-source — so neither its code nor its diagram stack is safely reusable.

**Simlin is the reference architecture for "serious engine in the browser."** Rust compiled to WASM, `SimMethod { Euler, RungeKutta2, RungeKutta4 }` with Euler default and XMILE-style dt=1 default ([datamodel.rs](https://github.com/bpowers/simlin/blob/main/src/simlin-engine/src/datamodel.rs)), protobuf model format, XMILE/Vensim importers, Apache-2.0. If you ever want a production-grade engine without writing one, embedding Simlin's engine (or importing/exporting its formats) is the path. *(Correction applied during verification: the engine default dt is 1, "just like XMILE" — dt=0.25 appears only in Simlin's model-creation tooling.)*

**The only mature pure-JS, code-first engine is AGPL.** [scottfr/simulation](https://github.com/scottfr/simulation) (extracted from InsightMaker) would otherwise be a drop-in: stocks/flows/converters declared in code, Euler + RK4, active releases. AGPL-3.0 is workable for a personal GitHub Pages tool (source is public anyway) but worth a deliberate decision if you embed it.

**BPTK-Py validates "language-first" as a paradigm** — it markets an "SD DSL" for writing models directly in code rather than drawing them — but it lives in Jupyter, not the browser.

**XMILE is your free specification work.** XMILE v1.0 has been the OASIS standard since [Dec 14, 2015](https://www.oasis-open.org/standard/xmile1-0/) (still the latest; only errata since). It standardizes `sim_specs` (start/stop/dt, **integration method defaulting to Euler**, optional rk2/rk4), stock/flow/auxiliary semantics, graphical (lookup) functions, and — most usefully for you — **the builtin function catalog** ([spec §3.5](https://docs.oasis-open.org/xmile/xmile/v1.0/xmile-v1.0.html)): math (`ABS, INT, MIN, MAX, SQRT, EXP, LN, LOG10`, trig, `PI`), random draws (`NORMAL, POISSON, RANDOM, EXPRND, LOGNORMAL`), delays/smooths (`DELAY1, DELAY3, DELAYN, SMTH1, SMTH3, SMTHN, TREND, FORCST`), test inputs (`PULSE, STEP, RAMP`), time (`DT, STARTTIME, ENDTIME`), and `IF…THEN…ELSE`. **Crucially, no vendor-neutral *textual* SD language exists** — XMILE is XML, Vensim `.mdl` is single-vendor, and the emerging [SD-JSON](https://github.com/UB-IAD/sd-ai) is JSON-for-LLMs. A clean, human-writable textual SD language with an XMILE-compatible semantic core fills a genuine gap.

---

## 3. Language strategy: the core decision

Three options, evaluated for: payload, startup, sandboxing/infinite-loop defense, stdlib, determinism (reproducible runs), and quality of editor feedback.

### Option A — Own the DSL (recommended)

A `systems`-superset grammar is *small*: ~10 statement forms, expressions with function calls. Costs that look scary but verified small:

- **Parser:** Lezer grammars for languages this size are a weekend project; the official [language-package example](https://codemirror.net/examples/lang-package/) plus the [`codemirror/lang-example`](https://github.com/codemirror/lang-example) template (archived Apr 2026 but public and current) walk through the whole `.grammar` → `@lezer/generator` → `LRLanguage` → `LanguageSupport` pipeline.
- **Stdlib:** the XMILE builtin list above is ~40 functions, almost all 1–10 lines each (the delay/smooth family needs small internal state arrays). Add a seeded PRNG (e.g. mulberry32) so `NORMAL(0,1)` is reproducible run-to-run — something Python's `random` won't give you by default and XMILE doesn't standardize.
- **What you get only here:** diagnostics in *domain* terms (undefined stock, flow into an infinite stock, unreachable stock, division-by-zero at round N with the round number), completion of stock names and builtins, hover docs per builtin, deterministic + trivially sandboxed evaluation (it's your interpreter — no `eval`), and models that stay terse and diffable (Larson's stated reason the tool stayed valuable for 7 years).

### Option B — Embed Python

Two genuinely different sub-options (sizes measured from npm tarballs during verification, gzip −9):

| Runtime | Network cost | Cold start | Stdlib | Notes |
|---|---|---|---|---|
| [Pyodide](https://pyodide.org) 314.0.0 (CPython 3.14.2) | **~6.4 MB** first load ([own roadmap](https://pyodide.org/en/stable/project/roadmap.html)) | **4–5 s** (roadmap; stock browser usage), 3–5× slower than native | Full CPython; **NumPy, pandas, SciPy, Matplotlib** prebuilt; `micropip` for pure wheels | [JupyterLite](https://github.com/jupyterlite/jupyterlite) and [marimo WASM](https://docs.marimo.io/guides/wasm/) prove the worker-on-static-hosting pattern. PySD is pure Python — theoretically loadable — but **no PySD-in-Pyodide demo exists anywhere** |
| [MicroPython WASM](https://registry.npmjs.org/@micropython/micropython-webassembly-pyscript/latest) 1.28.x | `micropython.wasm` = 446 KB raw / **~197 KB gz** (measured); PyScript cites [~170 KB](https://docs.pyscript.net/2026.1.1/user-guide/what/) | "<100 ms" and "loads almost instantly" ([Anaconda](https://www.anaconda.com/blog/pyscript-updates-bytecode-alliance-pyodide-and-micropython), vendor claim) | Micro-subset: `math`, `random`, `json`, `array`…; **[ulab](https://github.com/v923z/micropython-ulab)** variant (~634 KB wasm) adds numpy-like ndarrays, `fft`, `linalg` | The realistic Python option for a playground with instant feedback |

The embedded-Python architecture would mimic BPTK's SD DSL: ship a `systems.py`-style module (`m = Model(); s = m.stock("Engineers", 5)`…), run the user's script per edit in a worker, harvest a results object. **What you give up:** editor feedback degrades to Python tracebacks mapped back to lines (no domain diagnostics without writing a Python-AST analyzer anyway); determinism requires discipline; and your "language" is now an API, losing the notation you said you love.

### Option C — Other embeddable runtimes

Measured/verified during this research:

- **[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)** (~503 KB raw / **231 KB gz** wasm, v0.32.0, active, now on quickjs-ng): the **best sandbox controls of anything surveyed** — `shouldInterruptAfterDeadline()`, `runtime.setMemoryLimit()`, `setMaxStackSize()`. The right choice *if* you want user formulas to be JavaScript (i.e., a safer LunaSim).
- **[wasmoon](https://github.com/ceifa/wasmoon)** (Lua 5.4, ~130–150 KB gz, ~25× faster than Fengari per its own benchmark): small and fast, but tiny stdlib, no built-in interrupt story confirmed, and no release in ~2 years (Fengari-web is 2018-stale).
- **Starlark** is *semantically* the dream for this use case — the [spec](https://github.com/bazelbuild/starlark/blob/master/spec.md) mandates deterministic, hermetic, **guaranteed-finite** execution ("does not allow recursion or unbounded loops"; "safe to execute untrusted code") — but **no official browser distribution exists**; the community WASM build is 4.9 MB raw / 1.27 MB gz. Steal its semantics, not its binaries.
- **SES / Hardened JS** ([Endo](https://github.com/endojs/endo)): isolation without WASM, but **no infinite-loop or memory-exhaustion protection** — rules it out as the primary defense. *(Medium confidence on exact doc wording; substance confirmed by two of three verifiers.)*
- **Raw JS in a Worker** (LunaSim's approach minus `eval`-in-page): `Worker.terminate()` is the only loop defense; workable, but you inherit JS's nondeterminism and noisy errors.

### Decision

**Option A**, with the engine's evaluator built behind an interface so a per-model `external function` block (QuickJS- or MicroPython-backed) can be added later if you ever hit the DSL's expressiveness ceiling. The decision rule: if during MVP you find yourself wanting loops/data structures *in models* rather than more builtins, switch to B (MicroPython) before sinking more into the grammar — everything else in the stack (editor, worker, charts, table) survives that pivot unchanged.

---

## 4. The embedded IDE: CodeMirror 6 as a "language server lite"

**CodeMirror 6 over Monaco is not close** for this project:

| | CodeMirror 6 | Monaco |
|---|---|---|
| Bundle | **~135 KB gz** basic setup + language pkg; 75 KB minimal ([official example](https://codemirror.net/examples/bundle/)) | "at least 4 MB" naive bundles ([monaco-webpack-plugin #40](https://github.com/microsoft/monaco-editor-webpack-plugin/issues/40)); multi-worker build complexity |
| Mobile | Native selection/editing support | FAQ: mobile browsers "**No**" ([README](https://github.com/microsoft/monaco-editor/blob/main/README.md)) |
| Custom language | **Lezer**: incremental, error-tolerant GLR parse tree, "hugely inspired by tree-sitter" ([lezer-parser/lr](https://github.com/lezer-parser/lr)) | Monarch: declarative *tokenizer only* — you'd still write a real parser for diagnostics |
| Static-site fit | Plain ES modules; CDN-importable | Worker URLs break on `file://`, bundler recipes required |

The "immediate feedback like a language server" requirement maps onto three CodeMirror extension points, all verified against source:

1. **Diagnostics:** [`linter(source, {delay})`](https://github.com/codemirror/lint/blob/main/src/lint.ts) — the source can be **async** (`Promise<Diagnostic[]>`), so it can call your analyzer (or a worker). Default debounce is 750 ms (`delay: 750`); set ~250–300 ms for snappier feel. `Diagnostic` carries `{from, to, severity: "hint"|"info"|"warning"|"error", message, actions?}` — `actions` gives you **quick fixes** ("create stock 'Recruiters'"), plus `lintGutter()` for margin markers.
2. **Completion:** [`autocompletion`](https://codemirror.net/examples/autocompletion/) sources registered per-language via `languageData` (`myLanguage.data.of({autocomplete: ...})`), may be async — complete stock names from the live symbol table, builtins with signatures, and `>`/`@` templates via snippets.
3. **Hover:** [`hoverTooltip`](https://github.com/codemirror/view/blob/main/src/tooltip.ts) (300 ms default) — show a stock's current trajectory sparkline or a builtin's doc on hover. Tooltips can contain arbitrary DOM, so *hover-a-stock → mini uPlot of that series* is a cheap, killer feature.

**Architecture: one analyzer, three consumers.** Write a single module — `parse(text) → {tree, symbols, diagnostics}` — on top of the Lezer tree, and feed it to the linter, the completion source, and the hover source. For a one-editor playground this *is* your language server; the LSP protocol adds serialization and process boundaries you don't need. You're not painted into a corner: the **official [`@codemirror/lsp-client`](https://github.com/codemirror/lsp-client)** (stable 6.x, MIT, releases through June 2026) has a pluggable transport explicitly supporting servers that are "written in JavaScript or can be compiled to WASM, run … directly in the client" — so the same analyzer can later be wrapped in real LSP (e.g., for a VS Code extension). [Langium](https://langium.org/docs/learn/minilogo/langium_and_monaco/) (TypeFox's TS language-engineering framework, language server in a browser worker) is the heavier alternative if you ever want full LSP from day one; it drags in Monaco-scale weight.

Practical note for this repo's no-build convention: CodeMirror 6 is plain ES modules and works via `https://esm.sh/codemirror` / jsDelivr `+esm` imports in a single HTML file. The Lezer grammar needs a one-time `@lezer/generator` compile — either a tiny `node` script committed alongside the tool (like `generate-tools.js`) or check in the generated parser.

---

## 5. Output layer: charts and the table of generations

All sizes measured from npm tarballs (min / gzip −9) during verification:

| Library | Size (gz) | Render | Verdict |
|---|---|---|---|
| **[uPlot](https://github.com/leeoniya/uPlot)** 1.6.32 | **22 KB** | canvas | **Recommended.** Author-run benchmark (Mar 2023): 166,650 points cold-start in 25 ms; 34 ms vs Chart.js 38 ms vs ECharts 55 ms on the same workload. Spartan API, perfect for "re-render the whole run on every keystroke." `setData()` makes re-runs nearly free |
| [Observable Plot](https://github.com/observablehq/plot) 0.6.17 | 69 KB + **92 KB d3** (external) | SVG | The pretty option: grammar-of-graphics, facets, automatic legends. `Plot.plot()` returns a fresh detached element each call — fine at playground scale |
| [Chart.js](https://github.com/chartjs/Chart.js) 4.5.1 | 70 KB | canvas | Middle ground; built-in LTTB/min-max decimation (line charts, `parsing: false`) |
| [ECharts](https://registry.npmjs.org/echarts) 6.1.0 | 359 KB full / 169 KB "simple" | canvas/SVG | Overkill here, even tree-shaken |
| [Plotly.js](https://github.com/plotly/plotly.js/blob/master/dist/README.md) 3.6.0 | **1.4 MB** full / 365 KB "basic" | SVG/WebGL | Overkill |
| [Vega + Vega-Lite + embed](https://github.com/vega/vega-lite) | 277 KB combined | canvas/SVG | Overkill |

**Recommendation:** uPlot for the always-live time-series panel (one line per stock, toggleable); optionally Observable Plot behind an "explore" tab later. Start with uPlot only.

**Table of generations:** generate a plain HTML `<table>` — round number column + one column per stock, sticky header, `position: sticky` first column, and a "download CSV" button (a Blob URL, ~10 lines). This matches `systems-run`'s table output exactly and costs zero bytes. [Tabulator](https://registry.npmjs.org/tabulator-tables) (~100 KB gz) only if you later want client-side sorting/filtering; AG Grid (measured 471 KB gz, though third-party figures range ~300–900 KB depending on version/build — couldn't be fully reconciled) is firmly overkill.

---

## 6. Engine design

### Semantics: two modes, one evaluator

1. **Discrete-rounds mode (default, `systems`-compatible).** Integer rounds, per-round table, `Rate`/`Conversion`/`Leak` flow behaviors preserved so Larson's published example models run unmodified. This compatibility is cheap (his semantics are simple and spec'd) and gives you a ready-made corpus + test suite ([his examples](https://github.com/lethain/systems/tree/master/examples), `lethain/eng-strategy-models`).
2. **Continuous mode (XMILE-style).** `sim time 0..100 dt 0.25 method euler` as a model header. **Euler default** — this is what the entire field does: the XMILE spec defaults to Euler; PySD is Euler-only; Simlin defaults to Euler (dt=1); InsightMaker's engine ships exactly Euler and RK4; Stella defaults to Euler with dt=0.25. Offer **RK4 as the only alternative**: isee's published comparison found RK4 at dt=0.25 hit a largest relative error of 0.0077 % where Euler needed dt=1/1024 to match ([Integration Methods and DT](https://blog.iseesystems.com/modeling-tips/integration-methods-and-dt/)) — but note Stella's own guidance to stay on Euler when models use discrete/integer-valued builtins (RK sub-steps and discontinuous functions like `PULSE` don't mix).

### Standard library (the actual deliverable of "bigger than systems")

Phase-ordered, all from the XMILE catalog: `MIN MAX ABS INT SQRT EXP LN LOG10 SIN COS PI` → `IF…THEN…ELSE`, comparison/boolean operators → `PULSE STEP RAMP` and `TIME DT STARTTIME ENDTIME` → `SMTH1 SMTH3 DELAY1 DELAY3` (small ring-buffer state per call site) → seeded `RANDOM NORMAL POISSON LOGNORMAL` → graphical/lookup functions (`lookup points (0,0) (10,4) (20,6)` declared in the DSL, linear interpolation). Determinism rule: all randomness flows from one model-level seed; same source + same seed ⇒ identical table, which keeps runs diffable — the property Larson actually valued.

### Live-feedback loop

The verified pattern from production playgrounds (TypeScript playground debounces editor-driven recompute at **300 ms**, heavy features at 1 s; the Svelte REPL compiles in dedicated workers):

```
keystroke → CM6 update
  ├─ main thread: Lezer incremental re-parse → analyzer → diagnostics/completions  (sub-ms at this scale)
  └─ debounce ~300 ms → postMessage(source, seed, runSpec) to simulation Worker
        worker: parse+compile → run → Float64Array per stock
        → postMessage back with transferables (zero-copy per MDN)
  → uPlot.setData(...) + rebuild table
```

- **Runaway defense in depth:** the language has no unbounded loops (formulas are expressions; rounds are finite) — so the only runaway risk is huge `rounds × stocks`. Guard with (a) an iteration budget inside the worker loop, and (b) `Worker.terminate()` + respawn from the main thread on a ~1 s deadline — MDN confirms terminate stops the worker "at once." Keep a warm spare worker to hide respawn latency. (If you later add a QuickJS/MicroPython escape hatch, `shouldInterruptAfterDeadline` / VM-level limits take over role (a).)
- **Results transport:** one `Float64Array` per stock (or one big interleaved buffer) as transferables; at playground scale (10² stocks × 10³ rounds × 8 B ≈ 1.6 MB) even copying would be fine, but transfer is free to do right.
- Simulation state is rebuilt from scratch each run — don't bother with incremental simulation; full re-runs of models this size are sub-millisecond in JS.

### Model persistence

Plain text files in git (the whole point), plus **share-by-URL**: compress source into `location.hash` (`CompressionStream` is in all modern browsers, or lz-string) — standard playground move, no backend. Later: XMILE export (your semantics are a subset by construction) and/or [SD-JSON](https://github.com/UB-IAD/sd-ai) export for LLM interchange.

---

## 7. MVP path

1. **Weekend 1 — language core.** Lezer grammar for the `systems` superset; CM6 editor with highlighting + parse-error diagnostics; analyzer with symbol table → "undefined stock" / "duplicate init" lints + stock-name completion. *(Deliverable: typing with red squiggles that make sense.)*
2. **Weekend 2 — engine + table.** Discrete-rounds engine with the three flow types + arithmetic formulas (port `systems`' spec; run his `examples/` as the test suite). Worker + 300 ms debounce. HTML table of generations + CSV export. *(Deliverable: lethain-compatible playground.)*
3. **Weekend 3 — charts + share.** uPlot panel, series toggles, hover-tooltip sparklines, URL-hash sharing, example-model dropdown.
4. **Then, incrementally:** stdlib in the phase order above (each builtin lands with completion entry + hover doc, i.e. the "bigger standard library" *with* IDE support) → named auxiliaries/converters → continuous mode (dt/Euler/RK4) → lookups → `fmt` (pretty-printer off the Lezer tree, honoring `systems-fmt`'s spirit) → seeded-RNG distributions → XMILE/SD-JSON export → (only if needed) embedded-runtime escape hatch.

Fit with this repo: `tools/systems-playground/index.html` + an entry in `tools.json`; CM6/uPlot via ESM CDN imports keeps the no-build convention (pin versions), with the Lezer-generated parser committed as a module.

---

## Appendix: verification notes & confidence

**Process:** 31 load-bearing claims × 3 adversarial verifiers (primary-source re-fetch / counter-evidence hunt / numbers audit). 27 unanimous, 4 majority-supported with corrections, 0 killed.

**Corrections applied to this report:**
- LunaSim: Tabulator renders *results* tables (the equation editor is hand-rolled HTML/jQuery; equations evaluated via `eval`); Poolesville/ISDC-2024 attribution sourced to the [conference paper](https://proceedings.systemdynamics.org/2024/papers/P1049.pdf), not the README.
- Simlin: engine default dt = 1 ("just like XMILE"), not 0.25 (0.25 is its model-*creation* tooling default).
- Monaco bundle: "at least 4 MB" (the cited issue's figure); larger figures circulate but weren't in the cited source.
- XMILE spells the conditional `IF…THEN…ELSE`; `IF_THEN_ELSE` is Vensim's spelling.

**Flagged (medium confidence):**
- SES's lack of loop/memory protection: substance confirmed by 2/3 verifiers; the third couldn't find the exact wording in the current README. The architectural conclusion (don't rely on SES for runaway defense) is safe.
- AG Grid Community size: measured 471 KB gz here, but credible third-party figures range ~300–900 KB by version/build.
- Vendor-claimed numbers, labeled as such: uPlot's benchmarks (author-run, Mar 2023, vs Chart.js 4.2.1/ECharts 5.4.1), MicroPython's "<100 ms" startup (Anaconda), Pyodide's "4–5 s" (its own roadmap; applies to stock in-browser use — snapshot-based server runtimes start in ~tens of ms).
- lethain.com, systemdynamics.org, and the OASIS spec HTML block automated fetchers (HTTP 403); quotes from those were verified via exact-phrase search hits, raw-GitHub mirrors of the same docs, or multiple independent snippets.
- "No JS/WASM port of lethain/systems exists" is an absence claim: backed by enumerating all 79 of the author's repos plus targeted searches, but absence can't be proven conclusively.

**Primary sources (most load-bearing):**
[lethain/systems README](https://raw.githubusercontent.com/lethain/systems/master/README.md) · [spec.md](https://raw.githubusercontent.com/lethain/systems/master/docs/spec.md) · [TODO.md](https://raw.githubusercontent.com/lethain/systems/master/TODO.md) · [systems-mcp](https://github.com/lethain/systems-mcp) · [XMILE v1.0](https://docs.oasis-open.org/xmile/xmile/v1.0/xmile-v1.0.html) · [Simlin](https://github.com/bpowers/simlin) · [scottfr/simulation](https://github.com/scottfr/simulation) · [LunaSim](https://github.com/PHS-SMCS/LunaSim) · [ISDC 2024 paper P1049](https://proceedings.systemdynamics.org/2024/papers/P1049.pdf) · [PySD](https://github.com/SDXorg/pysd) · [BPTK-Py](https://github.com/transentis/bptk_py) · [SDEverywhere](https://github.com/climateinteractive/SDEverywhere) · [Pyodide roadmap](https://pyodide.org/en/stable/project/roadmap.html) · [PyScript docs](https://docs.pyscript.net/2026.1.1/user-guide/what/) · [Anaconda MicroPython post](https://www.anaconda.com/blog/pyscript-updates-bytecode-alliance-pyodide-and-micropython) · [micropython-ulab](https://github.com/v923z/micropython-ulab) · [Starlark spec](https://github.com/bazelbuild/starlark/blob/master/spec.md) · [wasmoon](https://github.com/ceifa/wasmoon) · [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) · [CodeMirror bundle example](https://codemirror.net/examples/bundle/) · [lang-package example](https://codemirror.net/examples/lang-package/) · [@codemirror/lint source](https://github.com/codemirror/lint/blob/main/src/lint.ts) · [@codemirror/lsp-client](https://github.com/codemirror/lsp-client) · [Lezer](https://github.com/lezer-parser/lr) · [Monaco README/FAQ](https://github.com/microsoft/monaco-editor/blob/main/README.md) · [Langium + Monaco tutorial](https://langium.org/docs/learn/minilogo/langium_and_monaco/) · [uPlot](https://github.com/leeoniya/uPlot) · [Plotly dist README](https://github.com/plotly/plotly.js/blob/master/dist/README.md) · [Chart.js decimation](https://www.chartjs.org/docs/latest/configuration/decimation.html) · [isee Integration Methods and DT](https://blog.iseesystems.com/modeling-tips/integration-methods-and-dt/) · [MDN Worker.terminate](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate) · [MDN transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects) · [TypeScript playground source](https://github.com/microsoft/TypeScript-Website/blob/v2/packages/playground/src/index.ts)
