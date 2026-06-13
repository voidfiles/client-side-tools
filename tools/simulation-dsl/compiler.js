/**
 * compiler.js — turn an analyzed DSL program into a live model built with the
 * scottfr/simulation engine.
 *
 * The engine is injected (`compile(analysis, Model)`) rather than imported, so
 * the same compiler runs in the browser (where `Model` comes from the CDN
 * import map) and under Node tests (where it comes from the npm package).
 *
 * Two passes:
 *   1. create every primitive (stocks, variables, converters, states, actions,
 *      agents + their members, populations), recording instances by scope+name;
 *   2. wire connectors (flows, transitions), converter inputs, population
 *      bases, explicit links — and auto-generate the links the engine requires
 *      for every `[Reference]` in an equation (InsightMaker adds these in its
 *      UI; the DSL infers them from the equation text).
 *
 * Returns { model, plottables, instances } where `plottables` is the list of
 * primitives the UI charts and `instances` resolves a series name to its
 * engine primitive for results lookup.
 */

/** Drop undefined keys so the engine's strict config setters aren't fed undefined. */
function clean(obj) {
  const out = {};
  for (const k in obj) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function valuedConfig(rec) {
  const cfg = { units: rec.units, note: rec.note };
  if (rec.min !== undefined || rec.max !== undefined) {
    const c = {};
    if (rec.min !== undefined) c.min = rec.min;
    if (rec.max !== undefined) c.max = rec.max;
    cfg.constraints = c;
  }
  return cfg;
}

/**
 * @param {ReturnType<import('./lang.js').analyze>} analysis
 * @param {new (config?: object) => any} Model
 */
export function compile(analysis, Model) {
  const { config, model } = analysis;
  const m = new Model(clean({
    timeStart: config.timeStart,
    timeLength: config.timeLength,
    timeStep: config.timeStep,
    timeUnits: config.timeUnits,
    algorithm: config.algorithm,
    timePause: config.timePause,
  }));
  if (analysis.name) m.name = analysis.name;
  if (analysis.description) m.description = analysis.description;

  // instances: `${scope}|${lowerName}` -> { primitive, kind, scope }
  const instances = new Map();
  const key = (scope, name) => `${scope}|${name.toLowerCase()}`;
  const remember = (scope, name, primitive, kind) => instances.set(key(scope, name), { primitive, kind, scope, name });
  const agentInstances = new Map(); // agentName(lower) -> agent primitive

  const setParent = (primitive, scope) => {
    if (scope !== 'model') {
      const agent = agentInstances.get(scope.toLowerCase());
      if (agent) primitive.parent = agent;
    }
  };

  // --- pass 1a: agents -----------------------------------------------------
  for (const a of model.agents) {
    const agent = m.Agent(clean({ name: a.name, note: a.note }));
    agentInstances.set(a.name.toLowerCase(), agent);
    remember('model', a.name, agent, 'agent');
  }

  // --- pass 1b: valued primitives -----------------------------------------
  for (const s of model.stocks) {
    const prim = m.Stock(clean({
      name: s.name,
      initial: s.initial,
      nonNegative: s.nonNegative,
      type: s.type,
      delay: s.delay,
      ...valuedConfig(s),
    }));
    setParent(prim, s.scope);
    remember(s.scope, s.name, prim, 'stock');
  }
  for (const v of model.variables) {
    const prim = m.Variable(clean({ name: v.name, value: v.value, ...valuedConfig(v) }));
    setParent(prim, v.scope);
    remember(v.scope, v.name, prim, 'variable');
  }
  for (const c of model.converters) {
    const prim = m.Converter(clean({
      name: c.name,
      interpolation: c.interpolation,
      values: c.points && c.points.length ? c.points.map((p) => ({ x: p.x, y: p.y })) : undefined,
      note: c.note,
    }));
    // input is wired in pass 2 (it may reference a primitive defined later).
    setParent(prim, c.scope);
    remember(c.scope, c.name, prim, 'converter');
  }
  for (const st of model.states) {
    const prim = m.State(clean({ name: st.name, startActive: st.startActive, residency: st.residency, note: st.note }));
    setParent(prim, st.scope);
    remember(st.scope, st.name, prim, 'state');
  }
  for (const act of model.actions) {
    const prim = m.Action(clean({
      name: act.name,
      trigger: act.trigger,
      value: act.value,
      action: act.action,
      repeat: act.repeat,
      recalculate: act.recalculate,
      note: act.note,
    }));
    setParent(prim, act.scope);
    remember(act.scope, act.name, prim, 'action');
  }

  // resolve a name within a scope (agent-local first, then model).
  const resolve = (name, scope) => {
    if (scope && scope !== 'model') {
      const local = instances.get(key(scope, name));
      if (local) return local;
    }
    return instances.get(key('model', name)) || null;
  };

  // --- pass 1c: populations (need their agent base) ------------------------
  for (const pop of model.populations) {
    const base = pop.base ? agentInstances.get(pop.base.toLowerCase()) : null;
    const prim = m.Population(clean({
      name: pop.name,
      agentBase: base || undefined,
      populationSize: pop.size,
      geoPlacementType: pop.placement,
      networkType: pop.network,
      geoWidth: pop.geoWidth,
      geoHeight: pop.geoHeight,
      geoWrapAround: pop.geoWrap,
      geoUnits: pop.geoUnits,
    }));
    remember('model', pop.name, prim, 'population');
  }

  // --- pass 2: connectors --------------------------------------------------
  const endpointPrim = (ep, scope, wantKind) => {
    if (!ep || ep.type === 'null') return null;
    const hit = resolve(ep.name, scope);
    if (hit && (!wantKind || hit.kind === wantKind)) return hit.primitive;
    return null;
  };

  for (const f of model.flows) {
    const src = endpointPrim(f.source, f.scope, 'stock');
    const dst = endpointPrim(f.target, f.scope, 'stock');
    const prim = m.Flow(src, dst, clean({
      name: f.name,
      rate: f.rate,
      nonNegative: f.nonNegative,
      units: f.units,
      note: f.note,
    }));
    setParent(prim, f.scope);
    remember(f.scope, f.name, prim, 'flow');
  }
  for (const t of model.transitions) {
    const src = endpointPrim(t.source, t.scope, 'state');
    const dst = endpointPrim(t.target, t.scope, 'state');
    const prim = m.Transition(src, dst, clean({
      name: t.name,
      trigger: t.trigger,
      value: t.value,
      repeat: t.repeat,
      recalculate: t.recalculate,
      note: t.note,
    }));
    setParent(prim, t.scope);
    remember(t.scope, t.name, prim, 'transition');
  }

  // --- pass 3: links (explicit + auto from equation references) ------------
  const linked = new Set();
  const addLink = (fromPrim, toPrim, scope) => {
    if (!fromPrim || !toPrim || fromPrim === toPrim) return;
    const id = `${fromPrim.id}->${toPrim.id}`;
    if (linked.has(id)) return;
    linked.add(id);
    const link = m.Link(fromPrim, toPrim);
    if (scope && scope !== 'model') {
      const agent = agentInstances.get(scope.toLowerCase());
      if (agent) link.parent = agent;
    }
  };

  for (const l of model.links) {
    const from = endpointPrim(l.source, l.scope, null);
    const to = endpointPrim(l.target, l.scope, null);
    addLink(from, to, l.scope);
  }

  // Converter inputs: set the input source and link it in.
  for (const c of model.converters) {
    const inst = resolve(c.name, c.scope);
    if (!inst) continue;
    if (c.input && c.input.type === 'time') {
      inst.primitive.input = 'Time';
    } else if (c.input && c.input.type === 'ref') {
      const src = resolve(c.input.name, c.scope);
      if (src) {
        inst.primitive.input = src.primitive;
        addLink(src.primitive, inst.primitive, c.scope);
      }
    }
  }

  // Auto-links from equation references on every valued primitive / connector.
  const autoLink = (rec) => {
    const target = resolve(rec.name, rec.scope);
    if (!target) return;
    for (const ref of rec.equationRefs || []) {
      const src = resolve(ref, rec.scope);
      if (src) addLink(src.primitive, target.primitive, rec.scope);
    }
  };
  [...model.stocks, ...model.variables, ...model.states, ...model.actions,
    ...model.flows, ...model.transitions].forEach(autoLink);

  // --- build the list of plottable series ---------------------------------
  const plottables = [];
  for (const pl of analysis.plottables) {
    const inst = resolve(pl.name, 'model');
    if (inst) plottables.push({ name: pl.name, kind: pl.kind, primitive: inst.primitive });
  }

  return { model: m, plottables, instances };
}
