/**
 * lang.js — language core for the systems playground DSL.
 *
 * Derived from the lethain/systems notation
 * (https://github.com/lethain/systems/blob/master/docs/spec.md), with the
 * same flow semantics but a stricter structure: every stock is declared
 * up front, before any flow or formula uses it.
 *
 *   # stock declarations come first:
 *   #   Name(initial, max)? "description"? visible: true|false ?
 *   [Candidates]  "Boundary: infinite applicant pool"
 *   Screens       "Candidates in the phone-screen stage"
 *   Staff(5)      "Current team" visible: false
 *
 *   # then flows and auxiliaries:
 *   [Candidates] > Screens @ 25       Rate flow (fixed units per round)
 *   Screens > Staff @ 0.5             Conversion flow (bare decimal literal)
 *   Staff > [Gone] @ Leak(0.1)        Leak flow (fraction of source)
 *   name = expression                 auxiliary variable
 *   # comment
 *
 * `visible: false` hides a stock from the chart (it stays in the table and
 * CSV). Infinite stocks are never shown.
 *
 * Expressions: standard operator precedence, parentheses, ^, unary minus,
 * comparisons (< <= > >= == != <>), AND OR NOT, true/false,
 * IF cond THEN a ELSE b, and the builtin functions in BUILTINS below
 * (an XMILE-flavored standard library).
 *
 * The engine's flow semantics (Rate/Conversion/Leak, reversed processing
 * order, flooring) match lethain/systems exactly — see tests/ — but source
 * files differ: the original declares stocks implicitly inside flows, this
 * language requires the up-front declarations shown above.
 *
 * This module is dependency-free and runs on the main thread (editor
 * diagnostics/completion/hover), in the simulation worker, and under Node
 * (tests).
 */

export const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

const KEYWORDS = new Set(['if', 'then', 'else', 'and', 'or', 'not', 'inf', 'true', 'false']);
const FLOW_TYPES = new Set(['rate', 'conversion', 'leak']);

// ---------------------------------------------------------------------------
// Builtin function catalog (XMILE-flavored). `fn` receives evaluated args and
// the evaluation environment: { time, dt, startTime, endTime, rng }.
// ---------------------------------------------------------------------------

export const BUILTINS = {
  ABS: { sig: 'ABS(x)', args: [1, 1], doc: 'Absolute value of x.', fn: (a) => Math.abs(a[0]) },
  INT: { sig: 'INT(x)', args: [1, 1], doc: 'Integer part of x (truncates toward zero).', fn: (a) => Math.trunc(a[0]) },
  ROUND: { sig: 'ROUND(x)', args: [1, 1], doc: 'x rounded to the nearest integer.', fn: (a) => Math.round(a[0]) },
  MIN: { sig: 'MIN(a, b, …)', args: [2, Infinity], doc: 'Smallest of the arguments.', fn: (a) => Math.min(...a) },
  MAX: { sig: 'MAX(a, b, …)', args: [2, Infinity], doc: 'Largest of the arguments.', fn: (a) => Math.max(...a) },
  MOD: { sig: 'MOD(a, b)', args: [2, 2], doc: 'Remainder of a divided by b.', fn: (a) => a[0] % a[1] },
  SQRT: { sig: 'SQRT(x)', args: [1, 1], doc: 'Square root of x.', fn: (a) => Math.sqrt(a[0]) },
  EXP: { sig: 'EXP(x)', args: [1, 1], doc: 'e raised to the power x.', fn: (a) => Math.exp(a[0]) },
  LN: { sig: 'LN(x)', args: [1, 1], doc: 'Natural logarithm of x.', fn: (a) => Math.log(a[0]) },
  LOG10: { sig: 'LOG10(x)', args: [1, 1], doc: 'Base-10 logarithm of x.', fn: (a) => Math.log10(a[0]) },
  SIN: { sig: 'SIN(x)', args: [1, 1], doc: 'Sine of x (radians).', fn: (a) => Math.sin(a[0]) },
  COS: { sig: 'COS(x)', args: [1, 1], doc: 'Cosine of x (radians).', fn: (a) => Math.cos(a[0]) },
  TAN: { sig: 'TAN(x)', args: [1, 1], doc: 'Tangent of x (radians).', fn: (a) => Math.tan(a[0]) },
  PI: { sig: 'PI()', args: [0, 0], doc: 'The constant π.', fn: () => Math.PI },
  SAFEDIV: { sig: 'SAFEDIV(a, b, onzero?)', args: [2, 3], doc: 'a / b, or onzero (default 0) when b is 0.', fn: (a) => (a[1] === 0 ? (a.length > 2 ? a[2] : 0) : a[0] / a[1]) },

  TIME: { sig: 'TIME()', args: [0, 0], doc: 'Current round number (0 at the initial state).', fn: (_a, env) => env.time },
  DT: { sig: 'DT()', args: [0, 0], doc: 'Time step per round (1 in discrete-rounds mode).', fn: (_a, env) => env.dt },
  STARTTIME: { sig: 'STARTTIME()', args: [0, 0], doc: 'First round of the run (0).', fn: (_a, env) => env.startTime },
  ENDTIME: { sig: 'ENDTIME()', args: [0, 0], doc: 'Last round of the run.', fn: (_a, env) => env.endTime },

  STEP: { sig: 'STEP(height, start)', args: [2, 2], doc: '0 before round `start`, then `height` from that round on.', fn: (a, env) => (env.time >= a[1] ? a[0] : 0) },
  PULSE: {
    sig: 'PULSE(magnitude, first, interval?)', args: [2, 3],
    doc: '`magnitude` at round `first` (and every `interval` rounds after, if given), otherwise 0.',
    fn: (a, env) => {
      const [mag, first] = a; const interval = a.length > 2 ? a[2] : 0;
      if (env.time === first) return mag;
      if (interval > 0 && env.time > first && (env.time - first) % interval === 0) return mag;
      return 0;
    },
  },
  RAMP: { sig: 'RAMP(slope, start)', args: [2, 2], doc: '0 until round `start`, then increases by `slope` per round.', fn: (a, env) => (env.time > a[1] ? a[0] * (env.time - a[1]) : 0) },

  RANDOM: { sig: 'RANDOM(min, max)', args: [2, 2], doc: 'Uniform random draw in [min, max). Deterministic for a given seed.', fn: (a, env) => a[0] + env.rng() * (a[1] - a[0]) },
  NORMAL: {
    sig: 'NORMAL(mean, stddev)', args: [2, 2],
    doc: 'Normally distributed random draw. Deterministic for a given seed.',
    fn: (a, env) => {
      let u = 0, v = 0;
      while (u === 0) u = env.rng();
      while (v === 0) v = env.rng();
      return a[0] + a[1] * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  },
  LOGNORMAL: {
    sig: 'LOGNORMAL(mean, stddev)', args: [2, 2],
    doc: 'exp(NORMAL(mean, stddev)). Deterministic for a given seed.',
    fn: (a, env) => {
      let u = 0, v = 0;
      while (u === 0) u = env.rng();
      while (v === 0) v = env.rng();
      return Math.exp(a[0] + a[1] * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    },
  },
  EXPRND: { sig: 'EXPRND(mean)', args: [1, 1], doc: 'Exponentially distributed random draw with the given mean.', fn: (a, env) => -a[0] * Math.log(1 - env.rng()) },
  POISSON: {
    sig: 'POISSON(mu)', args: [1, 1],
    doc: 'Poisson-distributed random draw with mean mu.',
    fn: (a, env) => {
      const mu = a[0];
      if (!(mu > 0)) return 0;
      if (mu > 700) return Math.round(mu); // avoid underflow; good enough at this scale
      const limit = Math.exp(-mu);
      let k = 0, p = 1;
      do { k++; p *= env.rng(); } while (p > limit);
      return k - 1;
    },
  },
};

export const RANDOM_BUILTINS = new Set(['RANDOM', 'NORMAL', 'LOGNORMAL', 'EXPRND', 'POISSON']);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const TOKEN_PATTERNS = [
  ['string', /^"[^"\n]*"/],
  ['number', /^(?:\d+\.\d+|\d+\.?|\.\d+)/],
  ['name', /^[A-Za-z][A-Za-z0-9_]*/],
  ['op', /^(?:<=|>=|==|!=|<>|[-+*/^<>=@(),:[\]])/],
];

/**
 * Tokenize one line. `base` is the document offset of the line start so all
 * token positions are absolute. Returns { tokens, error }.
 */
export function tokenizeLine(line, base) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#') break; // comment to end of line
    const rest = line.slice(i);
    let matched = false;
    for (const [type, re] of TOKEN_PATTERNS) {
      const m = re.exec(rest);
      if (m) {
        tokens.push({ type, text: m[0], from: base + i, to: base + i + m[0].length });
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (ch === '"') {
        return { tokens, error: { from: base + i, to: base + line.length, message: 'Unterminated string — descriptions need a closing "' } };
      }
      return { tokens, error: { from: base + i, to: base + i + 1, message: `Unexpected character '${ch}'` } };
    }
  }
  return { tokens, error: null };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(message, from, to) {
    super(message);
    this.from = from;
    this.to = to;
  }
}

class TokenStream {
  constructor(tokens, lineEnd) {
    this.tokens = tokens;
    this.pos = 0;
    this.lineEnd = lineEnd;
  }
  peek(offset = 0) { return this.tokens[this.pos + offset] || null; }
  next() { return this.tokens[this.pos++] || null; }
  atEnd() { return this.pos >= this.tokens.length; }
  expect(text, what) {
    const t = this.peek();
    if (!t || t.text !== text) {
      const at = t || { from: this.lineEnd, to: this.lineEnd };
      throw new ParseError(what || `Expected '${text}'`, at.from, at.to);
    }
    return this.next();
  }
  errorAtCurrent(message) {
    const t = this.peek();
    const at = t || { from: this.lineEnd, to: this.lineEnd };
    return new ParseError(message, at.from, at.to);
  }
}

function isKeyword(tok, kw) {
  return tok && tok.type === 'name' && tok.text.toLowerCase() === kw;
}

// Expression grammar (precedence climbing):
//   ifExpr   := IF expr THEN expr ELSE expr | orExpr
//   orExpr   := andExpr (OR andExpr)*
//   andExpr  := notExpr (AND notExpr)*
//   notExpr  := NOT notExpr | cmpExpr
//   cmpExpr  := addExpr ((< <= > >= == != <>) addExpr)?
//   addExpr  := mulExpr ((+|-) mulExpr)*
//   mulExpr  := unary ((*|/) unary)*
//   unary    := - unary | powExpr
//   powExpr  := atom (^ unary)?
//   atom     := number | inf | name | name(args) | (expr)

function parseExpr(ts) { return parseIf(ts); }

function parseIf(ts) {
  if (isKeyword(ts.peek(), 'if')) {
    const start = ts.next();
    const cond = parseExpr(ts);
    if (!isKeyword(ts.peek(), 'then')) throw ts.errorAtCurrent("Expected THEN after IF condition");
    ts.next();
    const thenE = parseExpr(ts);
    if (!isKeyword(ts.peek(), 'else')) throw ts.errorAtCurrent("Expected ELSE in IF expression");
    ts.next();
    const elseE = parseExpr(ts);
    return { type: 'if', cond, then: thenE, else: elseE, from: start.from, to: elseE.to };
  }
  return parseOr(ts);
}

function binaryLevel(ts, ops, nextLevel) {
  let left = nextLevel(ts);
  for (;;) {
    const t = ts.peek();
    if (t && t.type === 'op' && ops.includes(t.text)) {
      ts.next();
      const right = nextLevel(ts);
      left = { type: 'bin', op: t.text === '<>' ? '!=' : t.text, l: left, r: right, from: left.from, to: right.to };
    } else {
      return left;
    }
  }
}

function parseOr(ts) {
  let left = parseAnd(ts);
  while (isKeyword(ts.peek(), 'or')) {
    ts.next();
    const right = parseAnd(ts);
    left = { type: 'bin', op: 'or', l: left, r: right, from: left.from, to: right.to };
  }
  return left;
}

function parseAnd(ts) {
  let left = parseNot(ts);
  while (isKeyword(ts.peek(), 'and')) {
    ts.next();
    const right = parseNot(ts);
    left = { type: 'bin', op: 'and', l: left, r: right, from: left.from, to: right.to };
  }
  return left;
}

function parseNot(ts) {
  if (isKeyword(ts.peek(), 'not')) {
    const t = ts.next();
    const e = parseNot(ts);
    return { type: 'un', op: 'not', e, from: t.from, to: e.to };
  }
  return parseCmp(ts);
}

function parseCmp(ts) {
  const left = binaryLevel(ts, ['+', '-'], parseMul);
  const t = ts.peek();
  if (t && t.type === 'op' && ['<', '<=', '>', '>=', '==', '!=', '<>'].includes(t.text)) {
    ts.next();
    const right = binaryLevel(ts, ['+', '-'], parseMul);
    return { type: 'bin', op: t.text === '<>' ? '!=' : t.text, l: left, r: right, from: left.from, to: right.to };
  }
  if (t && t.text === '=') {
    throw new ParseError("Use '==' for comparison ('=' declares an auxiliary at the start of a line)", t.from, t.to);
  }
  return left;
}

function parseMul(ts) { return binaryLevel(ts, ['*', '/'], parseUnary); }

function parseUnary(ts) {
  const t = ts.peek();
  if (t && t.text === '-') {
    ts.next();
    const e = parseUnary(ts);
    return { type: 'un', op: '-', e, from: t.from, to: e.to };
  }
  return parsePow(ts);
}

function parsePow(ts) {
  const left = parseAtom(ts);
  const t = ts.peek();
  if (t && t.text === '^') {
    ts.next();
    const right = parseUnary(ts); // right associative
    return { type: 'bin', op: '^', l: left, r: right, from: left.from, to: right.to };
  }
  return left;
}

function parseAtom(ts) {
  const t = ts.peek();
  if (!t) throw ts.errorAtCurrent('Expected a value');
  if (t.type === 'number') {
    ts.next();
    return { type: 'num', value: parseFloat(t.text), raw: t.text, from: t.from, to: t.to };
  }
  if (t.text === '(') {
    ts.next();
    const e = parseExpr(ts);
    const close = ts.expect(')', "Expected ')'");
    return { ...e, from: t.from, to: close.to };
  }
  if (t.type === 'name') {
    const lower = t.text.toLowerCase();
    if (lower === 'inf') {
      ts.next();
      return { type: 'num', value: Infinity, raw: 'inf', from: t.from, to: t.to };
    }
    if (lower === 'true' || lower === 'false') {
      ts.next();
      return { type: 'num', value: lower === 'true' ? 1 : 0, raw: lower, from: t.from, to: t.to };
    }
    if (KEYWORDS.has(lower)) {
      throw new ParseError(`Unexpected keyword '${t.text}' here`, t.from, t.to);
    }
    ts.next();
    const nxt = ts.peek();
    if (nxt && nxt.text === '(') {
      ts.next();
      const args = [];
      if (ts.peek() && ts.peek().text !== ')') {
        for (;;) {
          args.push(parseExpr(ts));
          if (ts.peek() && ts.peek().text === ',') { ts.next(); continue; }
          break;
        }
      }
      const close = ts.expect(')', "Expected ')' to close the argument list");
      return { type: 'call', name: t.text, nameFrom: t.from, nameTo: t.to, args, from: t.from, to: close.to };
    }
    return { type: 'ref', name: t.text, from: t.from, to: t.to };
  }
  throw new ParseError(`Unexpected '${t.text}'`, t.from, t.to);
}

function parseFullExpr(ts) {
  const e = parseExpr(ts);
  if (!ts.atEnd()) {
    const t = ts.peek();
    throw new ParseError(`Unexpected '${t.text}' after expression`, t.from, t.to);
  }
  return e;
}

// Stock endpoint: [Name] | Name | Name(init) | Name(init, max)
function parseStockEndpoint(ts) {
  const t = ts.peek();
  if (!t) throw ts.errorAtCurrent('Expected a stock name');
  if (t.text === '[') {
    ts.next();
    const name = ts.peek();
    if (!name || name.type !== 'name') throw ts.errorAtCurrent('Expected a stock name inside [ ]');
    ts.next();
    const close = ts.expect(']', "Expected ']'");
    checkStockName(name);
    return { name: name.text, infinite: true, initial: null, maximum: null, from: t.from, to: close.to, nameFrom: name.from, nameTo: name.to };
  }
  if (t.type !== 'name') throw new ParseError(`Expected a stock name, got '${t.text}'`, t.from, t.to);
  checkStockName(t);
  ts.next();
  let initial = null, maximum = null, to = t.to;
  if (ts.peek() && ts.peek().text === '(') {
    ts.next();
    initial = parseExpr(ts);
    if (ts.peek() && ts.peek().text === ',') {
      ts.next();
      maximum = parseExpr(ts);
    }
    const close = ts.expect(')', "Expected ')' after the stock's parameters");
    to = close.to;
  }
  return { name: t.text, infinite: false, initial, maximum, from: t.from, to, nameFrom: t.from, nameTo: t.to };
}

function checkStockName(tok) {
  const lower = tok.text.toLowerCase();
  if (KEYWORDS.has(lower)) {
    throw new ParseError(`'${tok.text}' is a reserved word and can't be used as a name`, tok.from, tok.to);
  }
}

// Optional declaration attributes: "description" and `visible: true|false`.
function parseStockAttributes(ts) {
  let description = null;
  let visible = null;
  let visibleTok = null;
  const t = ts.peek();
  if (t && t.type === 'string') {
    ts.next();
    description = t.text.slice(1, -1);
  }
  const v = ts.peek();
  if (v && v.type === 'name' && v.text.toLowerCase() === 'visible') {
    ts.next();
    ts.expect(':', "Expected ':' after 'visible'");
    const b = ts.peek();
    if (!b || b.type !== 'name' || !['true', 'false'].includes(b.text.toLowerCase())) {
      throw ts.errorAtCurrent("Expected 'true' or 'false' after 'visible:'");
    }
    ts.next();
    visible = b.text.toLowerCase() === 'true';
    visibleTok = { from: v.from, to: b.to };
  }
  if (!ts.atEnd()) {
    const rest = ts.peek();
    if (rest.type === 'string') {
      throw new ParseError("The description goes before 'visible:'", rest.from, rest.to);
    }
    throw new ParseError(`Unexpected '${rest.text}' after the stock declaration`, rest.from, rest.to);
  }
  return { description, visible, visibleTok };
}

/**
 * Parse one logical line into a statement (or null for blank/comment lines).
 * Statement kinds:
 *   { kind: 'stock', stock, description, visible }          — up-front declaration
 *   { kind: 'flow', source, dest, flowType, rate }
 *   { kind: 'aux', name, expr }                             — auxiliary definition
 */
export function parseLine(line, base, lineNum) {
  const { tokens, error } = tokenizeLine(line, base);
  if (error) throw new ParseError(error.message, error.from, error.to);
  if (tokens.length === 0) return null;
  const lineEnd = base + line.length;
  const ts = new TokenStream(tokens, lineEnd);

  // Auxiliary: Name = expr  (single '=', second token)
  if (tokens.length >= 2 && tokens[0].type === 'name' && tokens[1].text === '=') {
    checkStockName(tokens[0]);
    ts.next(); ts.next();
    if (ts.atEnd()) throw new ParseError('Expected an expression after =', tokens[1].from, tokens[1].to);
    const expr = parseFullExpr(ts);
    return { kind: 'aux', name: tokens[0].text, nameFrom: tokens[0].from, nameTo: tokens[0].to, expr, line: lineNum };
  }

  const source = parseStockEndpoint(ts);
  if (ts.atEnd() || ts.peek().text !== '>') {
    const { description, visible, visibleTok } = parseStockAttributes(ts);
    return { kind: 'stock', stock: source, description, visible, visibleTok, line: lineNum };
  }

  ts.expect('>', "Expected '>' (flow) or end of declaration here");
  const dest = parseStockEndpoint(ts);
  const at = ts.expect('@', "Expected '@' followed by the flow's rate — flows always specify one");

  if (ts.atEnd()) throw new ParseError("Expected a rate expression after '@'", at.from, at.to);

  // Flow type wrapper: the whole rate is Rate(...), Conversion(...) or Leak(...)
  const first = ts.peek();
  let flowType = 'rate';
  let explicitType = false;
  let rate;
  if (first.type === 'name' && FLOW_TYPES.has(first.text.toLowerCase())
      && ts.peek(1) && ts.peek(1).text === '('
      && tokens[tokens.length - 1].text === ')') {
    const save = ts.pos;
    ts.next(); ts.next();
    const inner = parseExpr(ts);
    const closed = ts.peek() && ts.peek().text === ')' && ts.pos === tokens.length - 1;
    if (closed) {
      ts.next();
      flowType = first.text.toLowerCase();
      explicitType = true;
      rate = inner;
      rate.typeFrom = first.from;
      rate.typeTo = first.to;
    } else {
      ts.pos = save; // e.g. "Rate(2) * 3" — not a wrapper, re-parse as plain expression
      rate = parseFullExpr(ts);
    }
  } else {
    rate = parseFullExpr(ts);
  }

  if (!explicitType && rate.type === 'num' && /^\d+\.\d+$/.test(rate.raw || '')) {
    // lethain/systems: a bare decimal literal is implicitly a Conversion.
    flowType = 'conversion';
  }

  return { kind: 'flow', source, dest, flowType, rate, line: lineNum };
}

// ---------------------------------------------------------------------------
// Analyzer: parse a whole document, build symbol tables, collect diagnostics.
// ---------------------------------------------------------------------------

function walkExpr(expr, visit) {
  visit(expr);
  switch (expr.type) {
    case 'bin': walkExpr(expr.l, visit); walkExpr(expr.r, visit); break;
    case 'un': walkExpr(expr.e, visit); break;
    case 'if': walkExpr(expr.cond, visit); walkExpr(expr.then, visit); walkExpr(expr.else, visit); break;
    case 'call': expr.args.forEach((a) => walkExpr(a, visit)); break;
  }
}

function refsOf(expr) {
  const refs = [];
  if (expr) walkExpr(expr, (e) => { if (e.type === 'ref') refs.push(e); });
  return refs;
}

function topoOrder(names, depsByName) {
  // Kahn's algorithm; returns { order, cycle } where cycle is a list of names.
  const order = [];
  const state = new Map(); // 0 unvisited, 1 visiting, 2 done
  let cycle = null;
  function visit(name, path) {
    if (cycle) return;
    const s = state.get(name) || 0;
    if (s === 2) return;
    if (s === 1) { cycle = path.slice(path.indexOf(name)); return; }
    state.set(name, 1);
    for (const dep of depsByName.get(name) || []) {
      if (depsByName.has(dep)) visit(dep, [...path, dep]);
    }
    state.set(name, 2);
    order.push(name);
  }
  for (const n of names) visit(n, [n]);
  return { order, cycle };
}

/**
 * Analyze a full document. Returns:
 * {
 *   statements, diagnostics,
 *   stocks: Map<name, {name, infinite, initial, maximum, description, visible,
 *                      declFrom, declTo, declLine, hasFlows, referenced}>,
 *   auxes:  Map<name, {name, expr, declFrom, declTo}>,
 *   flows:  [{source, dest, flowType, rate, line}],
 *   stockOrder, auxOrder, initialOrder,   // evaluation orders
 *   usesRandom: bool,
 * }
 */
export function analyze(text) {
  const diagnostics = [];
  const statements = [];
  const stocks = new Map();
  const auxes = new Map();
  const flows = [];

  const err = (from, to, message, actions) => diagnostics.push({ from, to, severity: 'error', message, actions });
  const warn = (from, to, message) => diagnostics.push({ from, to, severity: 'warning', message });

  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const stmt = parseLine(line, offset, i + 1);
      if (stmt) statements.push(stmt);
    } catch (e) {
      if (e instanceof ParseError) {
        err(e.from, Math.max(e.to, e.from + 1), e.message);
      } else {
        err(offset, offset + line.length, String(e.message || e));
      }
    }
    offset += line.length + 1;
  }

  // Pass 1: collect declarations. Stocks are only created by declaration
  // lines — flows reference stocks declared on earlier lines.
  for (const stmt of statements) {
    if (stmt.kind === 'stock') {
      const ep = stmt.stock;
      if (stocks.has(ep.name)) {
        err(ep.nameFrom, ep.nameTo, `Stock '${ep.name}' is declared twice`);
        continue;
      }
      if (ep.infinite && (ep.initial || ep.maximum)) {
        err(ep.from, ep.to, `Infinite stock '${ep.name}' can't take an initial value or maximum`);
      }
      if (ep.infinite && stmt.visible === true) {
        warn(stmt.visibleTok.from, stmt.visibleTok.to, `Infinite stocks are never shown — 'visible: true' has no effect on '${ep.name}'`);
      }
      stocks.set(ep.name, {
        name: ep.name, infinite: ep.infinite, initial: ep.initial, maximum: ep.maximum,
        description: stmt.description, visible: stmt.visible,
        declFrom: ep.nameFrom, declTo: ep.nameTo, declLine: stmt.line,
        hasFlows: false, referenced: false,
      });
    } else if (stmt.kind === 'aux') {
      if (auxes.has(stmt.name)) {
        err(stmt.nameFrom, stmt.nameTo, `Auxiliary '${stmt.name}' is defined twice`);
      } else {
        auxes.set(stmt.name, { name: stmt.name, expr: stmt.expr, declFrom: stmt.nameFrom, declTo: stmt.nameTo, line: stmt.line });
      }
    }
  }
  for (const stmt of statements) {
    if (stmt.kind === 'stock' && auxes.has(stmt.stock.name)) {
      err(stmt.stock.nameFrom, stmt.stock.nameTo, `'${stmt.stock.name}' is also an auxiliary — pick a different name`);
    }
  }

  // A stock use (flow endpoint or formula reference) must come after the
  // stock's declaration line.
  const checkStockUse = (name, from, to, line) => {
    const s = stocks.get(name);
    if (!s) {
      err(from, to, `Reference to undeclared stock '${name}' — stocks are declared up front`, [
        { kind: 'declare-stock', name },
      ]);
      return null;
    }
    if (line !== undefined && s.declLine > line) {
      err(from, to, `Stock '${name}' is used before its declaration on line ${s.declLine} — declarations go up front`);
    }
    return s;
  };

  // Pass 2: resolve flows against the declarations.
  for (const stmt of statements) {
    if (stmt.kind !== 'flow') continue;
    flows.push(stmt);
    for (const ep of [stmt.source, stmt.dest]) {
      if (ep.initial || ep.maximum) {
        const declText = text.slice(ep.from, ep.to);
        err(ep.from, ep.to,
          `Stocks are declared up front — move '${declText}' to its own line before the flows`, [
            { kind: 'hoist-decl', name: ep.name, declText, epFrom: ep.from, epTo: ep.to },
          ]);
        // The hoist fix declares the stock, so don't also report it undeclared.
        if (!stocks.has(ep.name)) continue;
      }
      const s = checkStockUse(ep.name, ep.nameFrom, ep.nameTo, stmt.line);
      if (!s) continue;
      s.hasFlows = true;
      if (ep.infinite && !s.infinite) {
        err(ep.nameFrom, ep.nameTo, `'${ep.name}' isn't an infinite stock — it was declared without [ ]`);
      }
    }
    const src = stocks.get(stmt.source.name);
    if ((stmt.flowType === 'conversion' || stmt.flowType === 'leak') && src && src.infinite) {
      err(stmt.source.nameFrom, stmt.source.nameTo,
        `A ${stmt.flowType} flow can't drain the infinite stock '${src.name}'`);
    }
  }

  // Pass 3: resolve references inside formulas and validate calls.
  let usesRandom = false;
  const checkExpr = (expr, { where, allowAux, line }) => {
    if (!expr) return;
    walkExpr(expr, (e) => {
      if (e.type === 'ref') {
        if (stocks.has(e.name)) {
          const s = checkStockUse(e.name, e.from, e.to, line);
          if (s) s.referenced = true;
        } else if (auxes.has(e.name)) {
          if (!allowAux) {
            err(e.from, e.to, `${where} can't reference the auxiliary '${e.name}' — only stocks`);
          }
        } else {
          err(e.from, e.to, `Reference to undefined ${allowAux ? 'stock or auxiliary' : 'stock'} '${e.name}'`, [
            { kind: 'declare-stock', name: e.name },
          ]);
        }
      } else if (e.type === 'call') {
        const b = BUILTINS[e.name.toUpperCase()];
        if (!b) {
          err(e.nameFrom, e.nameTo, `Unknown function '${e.name}'`);
        } else {
          if (RANDOM_BUILTINS.has(e.name.toUpperCase())) usesRandom = true;
          const [min, max] = b.args;
          if (e.args.length < min || e.args.length > max) {
            const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`;
            err(e.nameFrom, e.to, `${b.sig.split('(')[0]} expects ${want} argument${min === 1 && max === 1 ? '' : 's'}, got ${e.args.length}`);
          }
        }
      }
    });
  };

  for (const s of stocks.values()) {
    checkExpr(s.initial, { where: `The initial value of '${s.name}'`, allowAux: false, line: s.declLine });
    checkExpr(s.maximum, { where: `The maximum of '${s.name}'`, allowAux: true, line: s.declLine });
  }
  for (const a of auxes.values()) checkExpr(a.expr, { where: `Auxiliary '${a.name}'`, allowAux: true, line: a.line });
  for (const f of flows) checkExpr(f.rate, { where: 'A flow rate', allowAux: true, line: f.line });

  // Pass 3: ordering. Initial values may reference other stocks (no cycles);
  // auxiliaries may reference stocks and other auxiliaries (no aux cycles).
  const initialDeps = new Map();
  for (const s of stocks.values()) {
    initialDeps.set(s.name, refsOf(s.initial).map((r) => r.name).filter((n) => stocks.has(n)));
  }
  const initialSort = topoOrder([...stocks.keys()], initialDeps);
  if (initialSort.cycle) {
    const names = initialSort.cycle.join(' → ');
    const first = stocks.get(initialSort.cycle[0]);
    err(first.declFrom, first.declTo, `Initial values form a cycle: ${names}`);
  }

  const auxDeps = new Map();
  for (const a of auxes.values()) {
    auxDeps.set(a.name, refsOf(a.expr).map((r) => r.name).filter((n) => auxes.has(n)));
  }
  const auxSort = topoOrder([...auxes.keys()], auxDeps);
  if (auxSort.cycle) {
    const names = auxSort.cycle.join(' → ');
    const first = auxes.get(auxSort.cycle[0]);
    err(first.declFrom, first.declTo, `Auxiliaries form a cycle: ${names}`);
  }

  // Gentle hints.
  for (const s of stocks.values()) {
    if (!s.hasFlows && !s.referenced && !s.infinite) {
      diagnostics.push({
        from: s.declFrom, to: s.declTo, severity: 'info',
        message: `Stock '${s.name}' has no flows and is never referenced`,
      });
    }
  }

  diagnostics.sort((a, b) => a.from - b.from);
  return {
    statements, diagnostics, stocks, auxes, flows,
    stockOrder: [...stocks.keys()],
    auxOrder: auxSort.order,
    initialOrder: initialSort.order,
    usesRandom,
  };
}

export function hasErrors(analysis) {
  return analysis.diagnostics.some((d) => d.severity === 'error');
}
