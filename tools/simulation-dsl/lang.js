/**
 * lang.js — the Simulation DSL: tokenizer, parser, and analyzer.
 *
 * The DSL is a block-structured external language whose job is to describe the
 * *structure* of a model — which primitives exist and how they connect — while
 * delegating equation *semantics* to the scottfr/simulation engine's own
 * formula language (`[Refs]`, `{units}`, `if … then … else end if`, etc.).
 * That is the deliberate what/how split: this module owns the shape of the
 * model; the engine owns the math.
 *
 * The notation is terse and sigil-led: `@` marks a stock, `$` marks a variable,
 * and a bare `Source -> Target` arrow is a flow. Block bodies are `key: value`
 * pairs separated by commas, strings are quoted, and numbers are bare (a leading
 * digit is required, so write `0.5`, not `.5`).
 *
 *   sim { start: 0, length: 50, step: 0.5, units: 'Years', algorithm: RK4 }
 *
 *   @Prey { initial: 400, nonNegative: true, units: "Prey" }
 *   @Belt { initial: 0, type: Conveyor, delay: 5 }
 *   $Rate = 0.25 { units: "1 / Years" }
 *   Births: _ -> Prey { rate: "[Prey] * [Rate]", nonNegative: true }
 *   converter Growth { input: Population, interpolation: Linear, points: (0,2) (10000,0) }
 *   link Rate -> Births
 *
 *   agent Person {
 *     state Healthy  { startActive: true }
 *     state Infected { startActive: false }
 *     transition Healthy -> Infected { trigger: Probability, value: 0.05 }
 *   }
 *   population Pop { size: 100, base: Person }
 *   action Reset { trigger: Timeout, value: 10, do: "[Healthy] <- true" }
 *
 * The module is dependency-free and runs both in the browser (editor
 * diagnostics, completion, hover) and under Node (the compiler + tests).
 */

export const NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

// Top-level / block statement keywords. Stocks (`@`), variables (`$`), and flows
// (`Source -> Target`) have their own terse syntax and are not keyword-led.
export const DECL_KEYWORDS = new Set([
  'sim', 'name', 'description',
  'converter', 'state', 'transition', 'action', 'agent', 'population', 'link',
]);

// Old keyword forms, replaced by sigils/arrows — kept only to give a helpful
// "use X instead" diagnostic when someone writes the previous syntax.
export const REMOVED_KEYWORDS = new Map([
  ['stock', 'declare a stock with `@Name { … }`'],
  ['flow', 'declare a flow with `Source -> Target { … }`'],
  ['variable', 'declare a variable with `$Name = value`'],
  ['var', 'declare a variable with `$Name = value`'],
]);

export const ALGORITHMS = ['Euler', 'RK4'];
export const TIME_UNITS = ['Seconds', 'Minutes', 'Hours', 'Days', 'Weeks', 'Months', 'Years'];
export const STOCK_TYPES = ['Store', 'Conveyor'];
export const INTERPOLATIONS = ['Linear', 'Discrete'];
export const TRIGGERS = ['Timeout', 'Probability', 'Condition'];
export const PLACEMENTS = ['Random', 'Network', 'Grid', 'Ellipse', 'Custom Function'];
export const NETWORKS = ['None', 'Custom Function'];
// Primitive kinds the UI can chart / tabulate, and the default (`sim { plot: … }`).
export const PLOT_KINDS = ['stock', 'variable', 'flow', 'converter', 'state'];
export const DEFAULT_PLOT_KINDS = ['stock'];

// Property documentation used by the editor's hover + completion. Keyed by the
// declaration keyword, then the property name.
export const PROP_DOCS = {
  sim: {
    start: 'Simulation start time (default 0).',
    length: 'Length of the simulation in time units (default 100).',
    step: 'Numerical integration time step, DT (default 1).',
    units: `Time unit label: ${TIME_UNITS.join(', ')}.`,
    algorithm: 'Integration method: Euler or RK4 (default RK4).',
    pause: 'Optional pause interval for interactive runs.',
    plot: `Which primitive kinds to chart and tabulate, e.g. plot: [stock, flow]. Default [stock]. Kinds: ${PLOT_KINDS.join(', ')} (or all / none).`,
  },
  stock: {
    initial: 'Initial value (number or equation). Also settable as `@X = <value>`.',
    nonNegative: 'Flag — clamp the stock so it never drops below zero.',
    type: 'Store (default) or Conveyor (a delay/conveyor stock).',
    delay: 'Conveyor delay (only meaningful for type Conveyor).',
    units: 'Unit string, e.g. "People".',
    min: 'Lower constraint on the value.',
    max: 'Upper constraint on the value.',
    note: 'Free-text documentation.',
  },
  variable: {
    value: 'A constant, equation, or vector. Also settable as `$X = <value>`.',
    units: 'Unit string.',
    min: 'Lower constraint.', max: 'Upper constraint.', note: 'Documentation.',
  },
  flow: {
    rate: 'Flow rate equation. Also settable as `A -> B = <rate>`.',
    nonNegative: 'Flag — the flow can only run in its declared direction.',
    units: 'Unit string, e.g. "People / Year".', note: 'Documentation.',
  },
  converter: {
    input: 'Input source: `time` or the name of another primitive.',
    interpolation: 'Linear (default) or Discrete.',
    points: 'Lookup table: space-separated (x, y) pairs, e.g. points (0,2) (10,5).',
    note: 'Documentation.',
  },
  state: {
    startActive: 'true/false or an equation deciding whether the state starts active.',
    residency: 'Minimum time an agent stays in the state before leaving.',
    note: 'Documentation.',
  },
  transition: {
    trigger: 'Timeout, Probability, or Condition.',
    value: 'The timeout duration, probability, or condition equation for the trigger.',
    repeat: 'Flag — the transition can fire more than once.',
    recalculate: 'Flag — re-evaluate the trigger every time step.',
    note: 'Documentation.',
  },
  action: {
    trigger: 'Timeout, Probability, or Condition.',
    value: 'The trigger value (timeout/probability/condition).',
    do: 'The action equation to run when triggered, e.g. "[Stock] <- 0".',
    repeat: 'Flag — the action can fire more than once.',
    recalculate: 'Flag — re-evaluate the trigger every time step.',
    note: 'Documentation.',
  },
  population: {
    size: 'Number of agents to create.',
    base: 'Name of the agent definition each member is an instance of.',
    placement: `Agent placement: ${PLACEMENTS.join(', ')}.`,
    network: `Network type: ${NETWORKS.join(', ')}.`,
    geoWidth: 'Width of the geographic placement area.',
    geoHeight: 'Height of the geographic placement area.',
    geoWrap: 'Flag — wrap agents around the placement edges (a torus).',
    note: 'Documentation.',
  },
  agent: { note: 'Documentation.' },
};

// Which property keys are boolean flags (no value). Matched case-insensitively.
const FLAG_PROPS = new Set(['nonnegative', 'repeat', 'recalculate', 'geowrap']);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const TOKEN_PATTERNS = [
  ['arrow', /^->/],
  ['sigil', /^[$@]/],
  // Numbers are bare and need a leading digit: `0.5` and `10`, never `.5`.
  ['number', /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/],
  ['name', /^[\p{L}_][\p{L}\p{N}_]*/u],
  ['punct', /^[{}()[\],;:=]/],
];

/** Tokenize a whole document into {type, text, value?, from, to, line}. */
export function tokenize(text) {
  const tokens = [];
  const diagnostics = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') { tokens.push({ type: 'newline', text: '\n', from: i, to: i + 1, line }); line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\' && i + 1 < text.length) { value += text[i + 1]; i += 2; continue; }
        if (c === quote) { i++; closed = true; break; }
        if (c === '\n') break;
        value += c;
        i++;
      }
      if (!closed) diagnostics.push({ from: start, to: i, severity: 'error', message: 'Unterminated string' });
      tokens.push({ type: 'string', text: text.slice(start, i), value, from: start, to: i, line });
      continue;
    }
    const rest = text.slice(i);
    let matched = false;
    for (const [type, re] of TOKEN_PATTERNS) {
      const m = re.exec(rest);
      if (m) {
        const tok = { type, text: m[0], from: i, to: i + m[0].length, line };
        if (type === 'number') tok.value = parseFloat(m[0]);
        tokens.push(tok);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      diagnostics.push({ from: i, to: i + 1, severity: 'error', message: `Unexpected character '${ch}'` });
      i++;
    }
  }
  tokens.push({ type: 'eof', text: '', from: text.length, to: text.length, line });
  return { tokens, diagnostics };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(message, from, to) { super(message); this.from = from; this.to = to; }
}

class Parser {
  constructor(tokens) {
    // Significant tokens skip newlines except where the parser asks for them.
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) {
    // Skip newlines for lookahead.
    let p = this.pos;
    let seen = 0;
    while (p < this.tokens.length) {
      if (this.tokens[p].type !== 'newline') {
        if (seen === offset) return this.tokens[p];
        seen++;
      }
      p++;
    }
    return this.tokens[this.tokens.length - 1];
  }
  next() {
    while (this.pos < this.tokens.length && this.tokens[this.pos].type === 'newline') this.pos++;
    return this.tokens[this.pos++] || this.tokens[this.tokens.length - 1];
  }
  /** Was there a newline (statement break) between the cursor and the next token? */
  atLineBreak() {
    let p = this.pos;
    while (p < this.tokens.length && this.tokens[p].type !== 'newline') {
      if (this.tokens[p].type === 'eof') return true;
      // a non-newline, non-eof token before any newline => same line
      return false;
    }
    return true;
  }
  /**
   * Does the statement starting here have a top-level `->` before its body?
   * That makes it a flow (`A -> B { … }`), regardless of any `@`/`$`/`Name:`
   * lead-in. Scans the current line only and stops at `{` (a body) — `->` inside
   * a quoted equation is part of the string token, so it never trips this.
   */
  lineHasArrow() {
    let p = this.pos;
    while (p < this.tokens.length && this.tokens[p].type === 'newline') p++;
    while (p < this.tokens.length) {
      const t = this.tokens[p];
      if (t.type === 'arrow') return true;
      if (t.type === 'newline' || t.type === 'eof') return false;
      if (t.type === 'punct' && t.text === '{') return false;
      p++;
    }
    return false;
  }
  eof() { return this.peek().type === 'eof'; }
  expect(text, what) {
    const t = this.peek();
    if (t.text !== text || (t.type !== 'punct' && t.type !== 'arrow')) {
      throw new ParseError(what || `Expected '${text}'`, t.from, t.to);
    }
    return this.next();
  }
}

function isPunct(tok, text) { return tok && tok.type === 'punct' && tok.text === text; }

/** Parse a single value into a typed value node (number, string, bool, ident, list). */
function parseValueNode(p) {
  const t = p.peek();
  if (isPunct(t, '[')) return parseList(p);
  if (t.type === 'number') { p.next(); return { type: 'number', value: t.value, tok: t }; }
  if (t.type === 'string') { p.next(); return { type: 'string', value: t.value, tok: t }; }
  if (t.type === 'name') {
    const lower = t.text.toLowerCase();
    if (lower === 'true' || lower === 'false') { p.next(); return { type: 'boolean', value: lower === 'true', tok: t }; }
    p.next();
    return { type: 'ident', value: t.text, tok: t };
  }
  throw new ParseError('Expected a value (number, "string", true/false, a name, or a [list])', t.from, t.to);
}

/** A `[a, b, c]` list of values (used by `sim { plot: [...] }`). */
function parseList(p) {
  const open = p.expect('[', "Expected '[' to start a list");
  const items = [];
  for (;;) {
    const t = p.peek();
    if (t.type === 'eof') throw new ParseError("Unterminated list — missing ']'", open.from, open.to);
    if (isPunct(t, ']')) { const close = p.next(); return { type: 'list', items, tok: open, from: open.from, to: close.to }; }
    if (isPunct(t, ',')) { p.next(); continue; }
    items.push(parseValueNode(p));
    if (isPunct(p.peek(), ',')) p.next();
  }
}

/** Endpoint for flow/transition/link: a name (optionally `@`-prefixed), or `_` for null. */
function parseEndpoint(p) {
  let t = p.peek();
  if (t.type === 'sigil' && t.text === '@') { p.next(); t = p.peek(); }
  if (t.type === 'name') {
    if (t.text === '_') { p.next(); return { type: 'null', tok: t }; }
    p.next();
    return { type: 'ref', name: t.text, tok: t };
  }
  if (t.type === 'string') { p.next(); return { type: 'ref', name: t.value, tok: t }; }
  throw new ParseError('Expected a primitive name (or `_` for an external source/sink)', t.from, t.to);
}

/** A declaration name: an identifier or a quoted string (for names with spaces). */
function parseDeclName(p) {
  const t = p.peek();
  if (t.type === 'name' && t.text !== '_') { p.next(); return { name: t.text, tok: t }; }
  if (t.type === 'string') { p.next(); return { name: t.value, tok: t }; }
  return null;
}

/**
 * Parse a `{ ... }` body of `key: value` / flag properties into a map.
 * Returns { props: Map<key, {key, keyTok, value|points|flag}>, from, to }.
 * Properties are separated by commas (newlines and `;` also work). `points`
 * keys collect (x, y) pairs.
 */
function parseBody(p) {
  const open = p.expect('{', "Expected '{' to start the body");
  const props = [];
  for (;;) {
    const t = p.peek();
    if (t.type === 'eof') throw new ParseError("Unterminated body — missing '}'", open.from, open.to);
    if (isPunct(t, '}')) { const close = p.next(); return { props, from: open.from, to: close.to }; }
    if (isPunct(t, ',') || isPunct(t, ';')) { p.next(); continue; }
    if (t.type !== 'name') throw new ParseError(`Expected a property name, got '${t.text}'`, t.from, t.to);
    const keyTok = p.next();
    const key = keyTok.text;
    const lower = key.toLowerCase();
    const prop = { key, keyTok };
    // Label/value separator: ':' (canonical) or '=' are both accepted.
    if (isPunct(p.peek(), ':') || isPunct(p.peek(), '=')) p.next();

    if (lower === 'points' || lower === 'data') {
      prop.points = parsePoints(p);
    } else if (FLAG_PROPS.has(lower)) {
      // Flag — may optionally be followed by true/false.
      const nx = p.peek();
      if (nx.type === 'name' && (nx.text.toLowerCase() === 'true' || nx.text.toLowerCase() === 'false')) {
        prop.flag = nx.text.toLowerCase() === 'true'; p.next();
      } else {
        prop.flag = true;
      }
    } else {
      prop.value = parseValueNode(p);
    }
    props.push(prop);
    // Consume a trailing property separator.
    if (isPunct(p.peek(), ',') || isPunct(p.peek(), ';')) p.next();
  }
}

function parsePoints(p) {
  const points = [];
  for (;;) {
    // Points may optionally be comma-separated: (0,0), (1,5).
    if (points.length && isPunct(p.peek(), ',')) p.next();
    if (!isPunct(p.peek(), '(')) break;
    const open = p.next();
    const x = parseValueNode(p);
    p.expect(',', "Expected ',' between x and y in a point");
    const y = parseValueNode(p);
    const close = p.expect(')', "Expected ')' to close the point");
    if (x.type !== 'number' || y.type !== 'number') {
      throw new ParseError('Lookup points must be numbers', open.from, close.to);
    }
    points.push({ x: x.value, y: y.value, from: open.from, to: close.to });
  }
  if (!points.length) {
    const t = p.peek();
    throw new ParseError('Expected at least one (x, y) point', t.from, t.to);
  }
  return points;
}

/** Optional inline `= value` shorthand, then optional `{ body }`. */
function parseShorthandAndBody(p) {
  let shorthand = null;
  let body = null;
  if (isPunct(p.peek(), '=')) { p.next(); shorthand = parseValueNode(p); }
  if (isPunct(p.peek(), '{')) body = parseBody(p);
  return { shorthand, body };
}

function parseConnectorHeader(p) {
  // `[Name :] Source -> Target` — a leading `<name> :` names the connector.
  let name = null;
  let nameTok = null;
  const first = p.peek();
  const second = p.peek(1);
  if (((first.type === 'name' && first.text !== '_') || first.type === 'string') && isPunct(second, ':')) {
    const dn = parseDeclName(p);
    name = dn.name; nameTok = dn.tok;
    p.expect(':', "Expected ':' after the connector name");
  }
  const source = parseEndpoint(p);
  const arrow = p.expect('->', "Expected '->' between source and target");
  const target = parseEndpoint(p);
  return { name, nameTok, source, target, kwTok: nameTok || source.tok || arrow };
}

/** A flow: `[Name:] Source -> Target { … }`. No keyword — the `->` makes it a flow. */
function parseArrowFlow(p) {
  const header = parseConnectorHeader(p);
  const { shorthand, body } = parseShorthandAndBody(p);
  return { kind: 'flow', ...header, shorthand, body };
}

/** A keyword declaration: sim, name, description, link, transition, converter, state, action, population. */
function parseDeclaration(p, insideAgent) {
  const kwTok = p.next();
  const lower = kwTok.text.toLowerCase();

  if (lower === 'sim') {
    if (insideAgent) throw new ParseError('`sim` settings must be at the top level', kwTok.from, kwTok.to);
    const body = parseBody(p);
    return { kind: 'sim', body, kwTok };
  }
  if (lower === 'name' || lower === 'description') {
    if (insideAgent) throw new ParseError(`\`${lower}\` must be at the top level`, kwTok.from, kwTok.to);
    if (isPunct(p.peek(), ':') || isPunct(p.peek(), '=')) p.next();
    const v = parseValueNode(p);
    return { kind: lower, value: v, kwTok };
  }
  if (lower === 'link') {
    const source = parseEndpoint(p);
    p.expect('->', "Expected '->' in a link");
    const target = parseEndpoint(p);
    return { kind: 'link', source, target, kwTok };
  }
  if (lower === 'transition') {
    const header = parseConnectorHeader(p);
    const { shorthand, body } = parseShorthandAndBody(p);
    return { kind: 'transition', ...header, shorthand, body, kwTok };
  }

  // Named, valued declarations: converter, state, action, population.
  const dn = parseDeclName(p);
  if (!dn) {
    const t = p.peek();
    throw new ParseError(`Expected a name after '${kwTok.text}'`, t.from, t.to);
  }
  const { shorthand, body } = parseShorthandAndBody(p);
  return { kind: lower, name: dn.name, nameTok: dn.tok, shorthand, body, kwTok };
}

/**
 * Parse one statement: a flow (`A -> B`), a sigil declaration (`@Stock`,
 * `$Variable`), or a keyword declaration. Used at the top level and inside
 * agent bodies (which may own their own stocks, variables, and flows).
 */
function parseStatement(p, insideAgent) {
  const t = p.peek();

  // Keyword-led declarations (incl. `transition`/`link`, which also use `->`)
  // are matched before arrow-flows so their headers parse correctly.
  if (t.type === 'name') {
    const lower = t.text.toLowerCase();
    if (REMOVED_KEYWORDS.has(lower)) {
      throw new ParseError(`\`${t.text}\` is no longer a keyword — ${REMOVED_KEYWORDS.get(lower)}.`, t.from, t.to);
    }
    if (lower === 'agent') {
      if (insideAgent) throw new ParseError('Nested agents are not supported — declare agents at the top level', t.from, t.to);
      p.next();
      const dn = parseDeclName(p);
      if (!dn) throw new ParseError("Expected a name after 'agent'", p.peek().from, p.peek().to);
      const ab = parseAgentBody(p);
      return { kind: 'agent', name: dn.name, nameTok: dn.tok, agentBody: ab.decls, note: ab.note, kwTok: t };
    }
    if (DECL_KEYWORDS.has(lower)) return parseDeclaration(p, insideAgent);
  }

  // A top-level `->` makes the statement a flow (the source may be `_`, a bare
  // name, or an `@`-prefixed stock).
  if (p.lineHasArrow()) return parseArrowFlow(p);

  // Sigil declarations: `@Stock { … }` / `@Stock = v`, `$Variable = v`.
  if (t.type === 'sigil') {
    const sig = p.next();
    const dn = parseDeclName(p);
    if (!dn) throw new ParseError(`Expected a name after '${sig.text}'`, p.peek().from, p.peek().to);
    const { shorthand, body } = parseShorthandAndBody(p);
    return { kind: sig.text === '$' ? 'variable' : 'stock', name: dn.name, nameTok: dn.tok, shorthand, body, kwTok: sig };
  }

  // Fall through: try to parse a flow so the error points at the missing `->`.
  return parseArrowFlow(p);
}

/**
 * Agents own declarations (stocks, variables, flows, states, transitions),
 * not key/value properties, plus an optional `note`.
 */
function parseAgentBody(p) {
  const open = p.expect('{', "Expected '{' to start the agent body");
  const decls = [];
  let note = null;
  for (;;) {
    const t = p.peek();
    if (t.type === 'eof') throw new ParseError("Unterminated agent — missing '}'", open.from, open.to);
    if (isPunct(t, '}')) { const close = p.next(); return { decls, note, from: open.from, to: close.to }; }
    if (isPunct(t, ';') || isPunct(t, ',')) { p.next(); continue; }
    if (t.type === 'name' && t.text.toLowerCase() === 'note') {
      p.next();
      if (isPunct(p.peek(), ':') || isPunct(p.peek(), '=')) p.next();
      note = parseValueNode(p);
      continue;
    }
    decls.push(parseStatement(p, true));
  }
}

export function parseProgram(text) {
  const { tokens, diagnostics } = tokenize(text);
  const p = new Parser(tokens);
  const decls = [];
  while (!p.eof()) {
    try {
      decls.push(parseStatement(p, false));
    } catch (e) {
      if (e instanceof ParseError) {
        diagnostics.push({ from: e.from, to: Math.max(e.to, e.from + 1), severity: 'error', message: e.message });
        // Recover: skip to the next line.
        recover(p);
      } else {
        throw e;
      }
    }
  }
  return { decls, diagnostics };
}

function recover(p) {
  // Advance to the start of the next line (or eof) to resume parsing.
  while (p.pos < p.tokens.length) {
    const t = p.tokens[p.pos];
    if (t.type === 'eof') return;
    if (t.type === 'newline') { p.pos++; return; }
    p.pos++;
  }
}

// ---------------------------------------------------------------------------
// Analyzer — turn the parse tree into typed declarations + diagnostics
// ---------------------------------------------------------------------------

function refsInEquation(str) {
  const refs = [];
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(str)) !== null) refs.push(m[1].trim());
  return refs;
}

/**
 * Analyze a document. Returns:
 * {
 *   config, name, description,
 *   model: { stocks, variables, converters, flows, states, transitions,
 *            actions, agents, populations, links },  // typed maps/arrays
 *   symbols: Map<lowerName, {name, kind, scope}>,    // for completion/hover
 *   diagnostics: [...],
 *   plottables: [{ name, kind }],
 * }
 */
export function analyze(text) {
  const { decls, diagnostics } = parseProgram(text);
  const err = (from, to, message) => diagnostics.push({ from, to: Math.max(to, from + 1), severity: 'error', message });
  const warn = (from, to, message) => diagnostics.push({ from, to: Math.max(to, from + 1), severity: 'warning', message });

  const config = { timeStart: 0, timeLength: 100, timeStep: 1, algorithm: 'RK4', timeUnits: 'Years', plot: DEFAULT_PLOT_KINDS.slice() };
  let name = null;
  let description = null;

  const model = {
    stocks: [], variables: [], converters: [], flows: [], states: [],
    transitions: [], actions: [], agents: [], populations: [], links: [],
  };
  // symbols: name (lowercased) -> {name, kind, scope: 'model' | agentName}
  const symbols = new Map();

  const declareSymbol = (nameStr, kind, scope, tok) => {
    const key = `${scope} ${nameStr.toLowerCase()}`;
    if (symbols.has(key)) {
      err(tok.from, tok.to, `'${nameStr}' is already defined${scope === 'model' ? '' : ` in agent '${scope}'`}`);
      return false;
    }
    symbols.set(key, { name: nameStr, kind, scope });
    return true;
  };

  // -- helpers to read a body's props -------------------------------------
  const propMap = (body) => {
    const map = new Map();
    if (!body) return map;
    for (const prop of body.props) {
      const k = prop.key.toLowerCase();
      if (map.has(k)) err(prop.keyTok.from, prop.keyTok.to, `Duplicate property '${prop.key}'`);
      map.set(k, prop);
    }
    return map;
  };
  const valEquation = (prop) => {
    // number -> number; string -> equation string; ident/boolean -> coerced.
    // Lists are only meaningful for `sim { plot: … }`, handled separately.
    if (!prop || !prop.value) return undefined;
    const v = prop.value;
    if (v.type === 'number' || v.type === 'string' || v.type === 'boolean' || v.type === 'ident') return v.value;
    return undefined;
  };
  // Read `sim { plot: … }` — a kind, a [list] of kinds, or all / none — into an
  // array of plottable kinds; reports unknown kinds.
  const readPlotKinds = (prop) => {
    const kinds = [];
    const addNode = (node) => {
      if (!node) return;
      if (node.type === 'list') { node.items.forEach(addNode); return; }
      const raw = String(node.value).toLowerCase();
      if (raw === 'all') { kinds.push(...PLOT_KINDS); return; }
      if (raw === 'none') return;
      const match = PLOT_KINDS.find((k) => k === raw || `${k}s` === raw);
      if (!match) err(node.tok.from, node.tok.to, `Unknown plot kind '${node.value}' — use one of: ${PLOT_KINDS.join(', ')} (or all / none)`);
      else kinds.push(match);
    };
    addNode(prop.value);
    return [...new Set(kinds)];
  };
  const requireEnum = (prop, allowed, label) => {
    if (!prop) return undefined;
    const v = prop.value;
    const raw = v ? String(v.value) : '';
    const match = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
    if (!match) {
      err(v ? v.tok.from : prop.keyTok.from, v ? v.tok.to : prop.keyTok.to,
        `${label} must be one of: ${allowed.join(', ')}`);
      return undefined;
    }
    return match;
  };
  const consumeKnown = (map, known, kw) => {
    for (const [k, prop] of map) {
      if (!known.has(k)) warn(prop.keyTok.from, prop.keyTok.to, `Unknown ${kw} property '${prop.key}'`);
    }
  };

  // -- process declarations -----------------------------------------------
  const processValued = (d, scope) => {
    const map = propMap(d.body);
    const lower = d.kind;

    if (lower === 'stock') {
      const known = new Set(['initial', 'nonnegative', 'type', 'delay', 'units', 'min', 'max', 'note']);
      consumeKnown(map, known, 'stock');
      const rec = {
        name: d.name, nameTok: d.nameTok, scope,
        initial: d.shorthand ? coerceValue(d.shorthand) : valEquation(map.get('initial')),
        nonNegative: map.has('nonnegative') ? map.get('nonnegative').flag : undefined,
        type: requireEnum(map.get('type'), STOCK_TYPES, 'Stock type'),
        delay: valEquation(map.get('delay')),
        units: valEquation(map.get('units')),
        min: numProp(map.get('min')), max: numProp(map.get('max')),
        note: valEquation(map.get('note')),
        equationRefs: [],
      };
      collectRefs(rec, [rec.initial, rec.delay]);
      if (declareSymbol(d.name, 'stock', scope, d.nameTok)) model.stocks.push(rec);
      return rec;
    }
    if (lower === 'variable') {
      const known = new Set(['value', 'units', 'min', 'max', 'note']);
      consumeKnown(map, known, 'variable');
      const rec = {
        name: d.name, nameTok: d.nameTok, scope,
        value: d.shorthand ? coerceValue(d.shorthand) : valEquation(map.get('value')),
        units: valEquation(map.get('units')),
        min: numProp(map.get('min')), max: numProp(map.get('max')),
        note: valEquation(map.get('note')),
        equationRefs: [],
      };
      collectRefs(rec, [rec.value]);
      if (declareSymbol(d.name, 'variable', scope, d.nameTok)) model.variables.push(rec);
      return rec;
    }
    if (lower === 'converter') {
      const known = new Set(['input', 'interpolation', 'points', 'data', 'note']);
      consumeKnown(map, known, 'converter');
      const inputProp = map.get('input');
      let input = { type: 'time' };
      if (inputProp && inputProp.value) {
        const v = inputProp.value;
        if (v.type === 'ident' && v.value.toLowerCase() === 'time') input = { type: 'time' };
        else input = { type: 'ref', name: String(v.value), tok: v.tok };
      }
      const ptsProp = map.get('points') || map.get('data');
      const rec = {
        name: d.name, nameTok: d.nameTok, scope,
        input,
        interpolation: requireEnum(map.get('interpolation'), INTERPOLATIONS, 'Interpolation') || 'Linear',
        points: ptsProp ? ptsProp.points : [],
        note: valEquation(map.get('note')),
        equationRefs: [],
      };
      if (input.type === 'ref') rec.equationRefs.push(input.name);
      if (!rec.points.length) err(d.nameTok.from, d.nameTok.to, `Converter '${d.name}' needs at least one (x, y) point`);
      if (declareSymbol(d.name, 'converter', scope, d.nameTok)) model.converters.push(rec);
      return rec;
    }
    if (lower === 'state') {
      const known = new Set(['startactive', 'residency', 'note']);
      consumeKnown(map, known, 'state');
      let startActive = d.shorthand ? coerceValue(d.shorthand) : undefined;
      if (startActive === undefined && map.has('startactive')) startActive = valEquation(map.get('startactive'));
      const rec = {
        name: d.name, nameTok: d.nameTok, scope,
        startActive,
        residency: valEquation(map.get('residency')),
        note: valEquation(map.get('note')),
        equationRefs: [],
      };
      collectRefs(rec, [typeof startActive === 'string' ? startActive : null, rec.residency]);
      if (declareSymbol(d.name, 'state', scope, d.nameTok)) model.states.push(rec);
      return rec;
    }
    if (lower === 'action') {
      const known = new Set(['trigger', 'value', 'do', 'action', 'repeat', 'recalculate', 'note']);
      consumeKnown(map, known, 'action');
      const rec = {
        name: d.name, nameTok: d.nameTok, scope,
        trigger: requireEnum(map.get('trigger'), TRIGGERS, 'Trigger') || 'Timeout',
        value: valEquation(map.get('value')),
        action: valEquation(map.get('do')) ?? valEquation(map.get('action')),
        repeat: map.has('repeat') ? map.get('repeat').flag : undefined,
        recalculate: map.has('recalculate') ? map.get('recalculate').flag : undefined,
        note: valEquation(map.get('note')),
        equationRefs: [],
      };
      collectRefs(rec, [typeof rec.value === 'string' ? rec.value : null, rec.action]);
      if (declareSymbol(d.name, 'action', scope, d.nameTok)) model.actions.push(rec);
      return rec;
    }
    if (lower === 'population') {
      const known = new Set(['size', 'base', 'placement', 'network', 'geowidth', 'geoheight', 'geowrap', 'geounits', 'note']);
      consumeKnown(map, known, 'population');
      const rec = {
        name: d.name, nameTok: d.nameTok, scope,
        size: numProp(map.get('size')),
        base: map.get('base') && map.get('base').value ? String(map.get('base').value.value) : undefined,
        baseTok: map.get('base') && map.get('base').value ? map.get('base').value.tok : d.nameTok,
        placement: requireEnum(map.get('placement'), PLACEMENTS, 'Placement'),
        network: requireEnum(map.get('network'), NETWORKS, 'Network'),
        geoWidth: numProp(map.get('geowidth')), geoHeight: numProp(map.get('geoheight')),
        geoWrap: map.has('geowrap') ? map.get('geowrap').flag : undefined,
        geoUnits: valEquation(map.get('geounits')),
        note: valEquation(map.get('note')),
      };
      if (!rec.base) err(d.nameTok.from, d.nameTok.to, `Population '${d.name}' needs a base agent (e.g. base AgentName)`);
      if (declareSymbol(d.name, 'population', scope, d.nameTok)) model.populations.push(rec);
      return rec;
    }
    return null;
  };

  function coerceValue(v) {
    if (!v) return undefined;
    if (v.type === 'number' || v.type === 'string' || v.type === 'boolean' || v.type === 'ident') return v.value;
    return undefined;
  }
  function numProp(prop) {
    if (!prop || !prop.value) return undefined;
    if (prop.value.type !== 'number') { err(prop.value.tok.from, prop.value.tok.to, `'${prop.key}' must be a number`); return undefined; }
    return prop.value.value;
  }
  function collectRefs(rec, equations) {
    for (const eq of equations) {
      if (typeof eq === 'string') rec.equationRefs.push(...refsInEquation(eq));
    }
  }

  const processConnector = (d, scope) => {
    const map = propMap(d.body);
    const declTok = d.nameTok || d.kwTok;
    if (d.kind === 'flow') {
      const known = new Set(['rate', 'nonnegative', 'units', 'note']);
      consumeKnown(map, known, 'flow');
      const rate = d.shorthand ? coerceValue(d.shorthand) : valEquation(map.get('rate'));
      const rec = {
        name: d.name || connectorAutoName(d), nameTok: d.nameTok, declTok,
        source: d.source, target: d.target, scope,
        rate,
        nonNegative: map.has('nonnegative') ? map.get('nonnegative').flag : undefined,
        units: valEquation(map.get('units')),
        note: valEquation(map.get('note')),
        equationRefs: typeof rate === 'string' ? refsInEquation(rate) : [],
      };
      if (d.name) declareSymbol(d.name, 'flow', scope, d.nameTok);
      model.flows.push(rec);
    } else if (d.kind === 'transition') {
      const known = new Set(['trigger', 'value', 'repeat', 'recalculate', 'note']);
      consumeKnown(map, known, 'transition');
      const value = d.shorthand ? coerceValue(d.shorthand) : valEquation(map.get('value'));
      const rec = {
        name: d.name || connectorAutoName(d), nameTok: d.nameTok, declTok,
        source: d.source, target: d.target, scope,
        trigger: requireEnum(map.get('trigger'), TRIGGERS, 'Trigger') || 'Timeout',
        value,
        repeat: map.has('repeat') ? map.get('repeat').flag : undefined,
        recalculate: map.has('recalculate') ? map.get('recalculate').flag : undefined,
        note: valEquation(map.get('note')),
        equationRefs: typeof value === 'string' ? refsInEquation(value) : [],
      };
      if (d.name) declareSymbol(d.name, 'transition', scope, d.nameTok);
      model.transitions.push(rec);
    }
  };

  // Auto-name an unnamed connector as `{Source}To{Target}`; `_` endpoints become
  // "External". Authors override it with a `Name:` prefix.
  function connectorAutoName(d) {
    const part = (ep) => (ep && ep.type === 'ref' ? ep.name : 'External');
    return `${part(d.source)}To${part(d.target)}`;
  }

  for (const d of decls) {
    if (d.kind === 'sim') {
      const map = propMap(d.body);
      consumeKnown(map, new Set(['start', 'length', 'step', 'units', 'algorithm', 'pause', 'plot']), 'sim');
      if (map.has('start')) config.timeStart = numProp(map.get('start')) ?? config.timeStart;
      if (map.has('length')) config.timeLength = numProp(map.get('length')) ?? config.timeLength;
      if (map.has('step')) config.timeStep = numProp(map.get('step')) ?? config.timeStep;
      if (map.has('pause')) config.timePause = numProp(map.get('pause'));
      if (map.has('units')) config.timeUnits = requireEnum(map.get('units'), TIME_UNITS, 'Time units') || config.timeUnits;
      if (map.has('algorithm')) config.algorithm = requireEnum(map.get('algorithm'), ALGORITHMS, 'Algorithm') || config.algorithm;
      if (map.has('plot')) config.plot = readPlotKinds(map.get('plot'));
    } else if (d.kind === 'name') {
      name = coerceValue(d.value);
    } else if (d.kind === 'description') {
      description = coerceValue(d.value);
    } else if (d.kind === 'agent') {
      const ok = declareSymbol(d.name, 'agent', 'model', d.nameTok);
      const agent = { name: d.name, nameTok: d.nameTok, note: d.note ? coerceValue(d.note) : undefined, members: [] };
      if (ok) model.agents.push(agent);
      for (const sub of d.agentBody) {
        if (sub.kind === 'flow' || sub.kind === 'transition') processConnector(sub, d.name);
        else if (sub.kind === 'link') model.links.push({ source: sub.source, target: sub.target, scope: d.name });
        else if (['stock', 'variable', 'converter', 'state', 'action'].includes(sub.kind)) {
          const rec = processValued(sub, d.name);
          if (rec) agent.members.push({ kind: sub.kind, name: rec.name });
        } else {
          err(sub.kwTok.from, sub.kwTok.to, `'${sub.kind}' can't be declared inside an agent`);
        }
      }
    } else if (d.kind === 'flow' || d.kind === 'transition') {
      processConnector(d, 'model');
    } else if (d.kind === 'link') {
      model.links.push({ source: d.source, target: d.target, scope: 'model' });
    } else {
      processValued(d, 'model');
    }
  }

  // -- cross-reference validation -----------------------------------------
  const resolve = (nameStr, scope) => {
    if (scope !== 'model') {
      const hit = symbols.get(`${scope} ${nameStr.toLowerCase()}`);
      if (hit) return hit;
    }
    return symbols.get(`model ${nameStr.toLowerCase()}`) || null;
  };

  const checkEndpoint = (ep, scope, wantKind, label) => {
    if (!ep || ep.type !== 'ref') return;
    const hit = resolve(ep.name, scope);
    if (!hit) {
      err(ep.tok.from, ep.tok.to, `${label} '${ep.name}' is not defined`);
    } else if (wantKind && hit.kind !== wantKind) {
      err(ep.tok.from, ep.tok.to, `${label} '${ep.name}' is a ${hit.kind}, expected a ${wantKind}`);
    }
  };

  for (const f of model.flows) {
    checkEndpoint(f.source, f.scope, 'stock', 'Flow source');
    checkEndpoint(f.target, f.scope, 'stock', 'Flow target');
    const pos = f.declTok || f.nameTok;
    if (f.source.type === 'null' && f.target.type === 'null') {
      warn(pos ? pos.from : 0, pos ? pos.to : 1, `Flow '${f.name}' has no source or target`);
    }
    if (f.rate === undefined) warn(pos ? pos.from : 0, pos ? pos.to : 1, `Flow '${f.name}' has no rate`);
  }
  for (const t of model.transitions) {
    checkEndpoint(t.source, t.scope, 'state', 'Transition source');
    checkEndpoint(t.target, t.scope, 'state', 'Transition target');
  }
  for (const l of model.links) {
    checkEndpoint(l.source, l.scope, null, 'Link source');
    checkEndpoint(l.target, l.scope, null, 'Link target');
  }
  for (const pop of model.populations) {
    if (pop.base) {
      const hit = resolve(pop.base, 'model');
      if (!hit) err(pop.baseTok.from, pop.baseTok.to, `Population base '${pop.base}' is not a defined agent`);
      else if (hit.kind !== 'agent') err(pop.baseTok.from, pop.baseTok.to, `Population base '${pop.base}' is a ${hit.kind}, expected an agent`);
    }
  }
  // Equation references: warn (don't error) for names we can't resolve, since
  // the engine's formula language has builtins/functions we don't model.
  const checkEquationRefs = (rec) => {
    for (const ref of rec.equationRefs || []) {
      if (!resolve(ref, rec.scope)) {
        // Unknown — could be an agent-internal state referenced via a population
        // function, a builtin, etc. Leave it to the engine; no diagnostic.
      }
    }
  };
  [...model.stocks, ...model.variables, ...model.converters, ...model.states,
    ...model.actions, ...model.flows, ...model.transitions].forEach(checkEquationRefs);

  if (config.timeStep <= 0) {
    diagnostics.push({ from: 0, to: 1, severity: 'error', message: 'sim step must be greater than 0' });
  }

  // Plottables: the top-level series the UI charts and tabulates. Which kinds
  // are included is set by `sim { plot: … }` (default: stocks only).
  const plotKinds = new Set(config.plot);
  const plottables = [];
  const pushPlottable = (records, kind) => {
    if (!plotKinds.has(kind)) return;
    for (const r of records) if (r.scope === 'model') plottables.push({ name: r.name, kind });
  };
  pushPlottable(model.stocks, 'stock');
  pushPlottable(model.variables, 'variable');
  pushPlottable(model.converters, 'converter');
  pushPlottable(model.flows, 'flow');
  pushPlottable(model.states, 'state');

  diagnostics.sort((a, b) => a.from - b.from);
  return { config, name, description, model, symbols, diagnostics, plottables };
}

export function hasErrors(analysis) {
  return analysis.diagnostics.some((d) => d.severity === 'error');
}
