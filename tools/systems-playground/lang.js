/**
 * lang.js — language core for the systems playground DSL.
 *
 * A superset of the lethain/systems notation
 * (https://github.com/lethain/systems/blob/master/docs/spec.md):
 *
 *   Stock(10)                          stock with initial value
 *   Stock(10, 50)                      stock with initial value and maximum
 *   [Boundary]                         infinite stock (hidden from output)
 *   a > b @ 2                          Rate flow (fixed units per round)
 *   a > b @ 0.5                        Conversion flow (bare decimal literal)
 *   a > b @ Leak(0.1)                  Leak flow (fraction of source, source keeps rest)
 *   name = expression                  auxiliary variable (extension)
 *   # comment
 *
 * Expressions (extension over the original's `+ - * /`):
 *   parentheses, ^, unary minus, comparisons (< <= > >= == != <>),
 *   AND OR NOT, IF cond THEN a ELSE b, and the builtin functions in
 *   BUILTINS below (an XMILE-flavored standard library).
 *
 * One deliberate divergence from lethain/systems: the original evaluates
 * formulas strictly left to right; this language uses standard operator
 * precedence. Formulas using a single operator (all of the published
 * examples) behave identically.
 *
 * This module is dependency-free and runs on the main thread (editor
 * diagnostics/completion/hover), in the simulation worker, and under Node
 * (tests).
 */

export const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

const KEYWORDS = new Set(['if', 'then', 'else', 'and', 'or', 'not', 'inf']);
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
  ['number', /^(?:\d+\.\d+|\d+\.?|\.\d+)/],
  ['name', /^[A-Za-z][A-Za-z0-9_]*/],
  ['op', /^(?:<=|>=|==|!=|<>|[-+*/^<>=@(),[\]])/],
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

/**
 * Parse one logical line into a statement (or null for blank/comment lines).
 * Statement kinds:
 *   { kind: 'stock', stock }                                — bare declaration
 *   { kind: 'flow', source, dest, flowType, rate }          — rate may be null ("a > b" declares only)
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
  if (ts.atEnd()) return { kind: 'stock', stock: source, line: lineNum };

  ts.expect('>', "Expected '>' (flow), '(' (stock parameters), or '=' (auxiliary) here");
  const dest = parseStockEndpoint(ts);
  if (ts.atEnd()) {
    // Compatible with lethain/systems: "a > b" declares both stocks but no flow.
    return { kind: 'flow', source, dest, flowType: null, rate: null, line: lineNum };
  }
  const at = ts.expect('@', "Expected '@' followed by the flow's rate");

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

function exprKey(expr) {
  // Canonical string for compare-on-redefinition (ConflictingValues semantics).
  switch (expr.type) {
    case 'num': return String(expr.value);
    case 'ref': return expr.name;
    case 'call': return `${expr.name.toUpperCase()}(${expr.args.map(exprKey).join(',')})`;
    case 'un': return `(${expr.op} ${exprKey(expr.e)})`;
    case 'bin': return `(${exprKey(expr.l)}${expr.op}${exprKey(expr.r)})`;
    case 'if': return `IF(${exprKey(expr.cond)},${exprKey(expr.then)},${exprKey(expr.else)})`;
    default: return '?';
  }
}

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
 *   stocks: Map<name, {name, infinite, initial, maximum, declFrom, declTo, hasFlows}>,
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

  // Pass 1: declare stocks and auxes.
  const declareStock = (ep) => {
    let s = stocks.get(ep.name);
    if (!s) {
      s = {
        name: ep.name, infinite: ep.infinite, initial: ep.initial, maximum: ep.maximum,
        declFrom: ep.nameFrom, declTo: ep.nameTo, hasFlows: false, referenced: false,
      };
      stocks.set(ep.name, s);
      return s;
    }
    // Redeclaration: replicate lethain/systems ConflictingValues rules —
    // a later explicit value is only allowed if the stock didn't have one yet.
    if (ep.infinite !== s.infinite) {
      err(ep.nameFrom, ep.nameTo, `'${ep.name}' is declared both as a normal and as an infinite stock`);
      return s;
    }
    if (ep.initial) {
      if (s.initial && exprKey(s.initial) !== exprKey(ep.initial)) {
        err(ep.initial.from, ep.initial.to, `Stock '${ep.name}' already has an initial value — it can only be set once`);
      } else if (s.initial) {
        err(ep.initial.from, ep.initial.to, `Stock '${ep.name}' is initialized twice (lethain/systems rejects this too)`);
      } else {
        s.initial = ep.initial;
      }
    }
    if (ep.maximum) {
      if (s.maximum) {
        err(ep.maximum.from, ep.maximum.to, `Stock '${ep.name}' already has a maximum — it can only be set once`);
      } else {
        s.maximum = ep.maximum;
      }
    }
    return s;
  };

  for (const stmt of statements) {
    if (stmt.kind === 'stock') {
      declareStock(stmt.stock);
    } else if (stmt.kind === 'flow') {
      const src = declareStock(stmt.source);
      const dst = declareStock(stmt.dest);
      if (stmt.rate !== null) {
        src.hasFlows = dst.hasFlows = true;
        flows.push(stmt);
        if ((stmt.flowType === 'conversion' || stmt.flowType === 'leak') && src.infinite) {
          err(stmt.source.nameFrom, stmt.source.nameTo,
            `A ${stmt.flowType} flow can't drain the infinite stock '${src.name}'`);
        }
      } else {
        warn(stmt.source.nameFrom, stmt.dest.nameTo,
          "Flow without '@ rate' only declares its stocks — no units will move");
      }
    } else if (stmt.kind === 'aux') {
      if (auxes.has(stmt.name)) {
        err(stmt.nameFrom, stmt.nameTo, `Auxiliary '${stmt.name}' is defined twice`);
      } else if (stocks.has(stmt.name)) {
        err(stmt.nameFrom, stmt.nameTo, `'${stmt.name}' is already a stock — pick a different auxiliary name`);
      } else {
        auxes.set(stmt.name, { name: stmt.name, expr: stmt.expr, declFrom: stmt.nameFrom, declTo: stmt.nameTo });
      }
    }
  }
  for (const stmt of statements) {
    if (stmt.kind === 'stock' && auxes.has(stmt.stock.name)) {
      err(stmt.stock.nameFrom, stmt.stock.nameTo, `'${stmt.stock.name}' is already an auxiliary — pick a different stock name`);
    }
  }

  // Pass 2: resolve references and validate calls.
  let usesRandom = false;
  const knownName = (n) => stocks.has(n) || auxes.has(n);
  const checkExpr = (expr, { where, allowAux }) => {
    if (!expr) return;
    walkExpr(expr, (e) => {
      if (e.type === 'ref') {
        if (!knownName(e.name)) {
          err(e.from, e.to, `Reference to undefined ${allowAux ? 'stock or auxiliary' : 'stock'} '${e.name}'`, [
            { kind: 'declare-stock', name: e.name },
          ]);
        } else if (!allowAux && auxes.has(e.name)) {
          err(e.from, e.to, `${where} can't reference the auxiliary '${e.name}' — only stocks`);
        } else {
          const s = stocks.get(e.name);
          if (s) s.referenced = true;
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
    checkExpr(s.initial, { where: `The initial value of '${s.name}'`, allowAux: false });
    checkExpr(s.maximum, { where: `The maximum of '${s.name}'`, allowAux: true });
  }
  for (const a of auxes.values()) checkExpr(a.expr, { where: `Auxiliary '${a.name}'`, allowAux: true });
  for (const f of flows) checkExpr(f.rate, { where: 'A flow rate', allowAux: true });

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
