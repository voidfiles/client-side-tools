/**
 * examples.js — starter models spanning the simulation toolkit. Each is valid
 * Simulation DSL and runs on the scottfr/simulation engine unchanged.
 */

export const EXAMPLES = [
  {
    id: 'hiring-funnel',
    name: 'Hiring funnel (stocks & flows)',
    source: `# Candidates move down a hiring funnel and on into the workforce.
# Stocks are @, flows are just Source -> Target, and by default only
# stocks are charted.
sim { start: 0, length: 10, step: 1, units: 'Days', algorithm: RK4 }

@PhoneScreens
@Offers
@Hires
@Employees { initial: 5 }
@Departures

_ -> PhoneScreens        { rate: "25" }
PhoneScreens -> Offers   { rate: "0.5" }
Offers -> Hires          { rate: "0.5" }
Hires -> Employees       { rate: "0.5" }
Employees -> Departures  { rate: "0.1" }
Departures -> _          { rate: "1" }`,
  },

  {
    id: 'predator-prey',
    name: 'Predator–Prey (Lotka–Volterra)',
    source: `# Classic Lotka-Volterra oscillation: foxes eat rabbits.
sim { start: 0, length: 40, step: 0.25, units: 'Years', algorithm: RK4 }

@Prey      { initial: 400, nonNegative: true }
@Predators { initial: 20,  nonNegative: true }

$PreyBirthRate = 0.25
$PreyDeathRate { value: "0.005 * [Predators]" }
$PredBirthRate { value: "0.0002 * [Prey]" }
$PredDeathRate = 0.25

# Name a flow with a leading "Name:"; otherwise it is auto-named SourceToTarget.
PreyBirths: _ -> Prey      { rate: "[Prey] * [PreyBirthRate]",      nonNegative: true }
PreyDeaths: Prey -> _      { rate: "[Prey] * [PreyDeathRate]",      nonNegative: true }
PredBirths: _ -> Predators { rate: "[Predators] * [PredBirthRate]", nonNegative: true }
PredDeaths: Predators -> _ { rate: "[Predators] * [PredDeathRate]", nonNegative: true }`,
  },

  {
    id: 'sir-sd',
    name: 'SIR epidemic (system dynamics)',
    source: `# Compartmental SIR model as stocks and flows.
sim { start: 0, length: 20, step: 0.2, units: 'Weeks', algorithm: RK4 }

@S { initial: 100 }   # susceptible
@I { initial: 3 }     # infected
@R { initial: 0 }     # recovered

$Beta  = 0.01     # infection coefficient
$Gamma = 0.3      # recovery rate

Infection: S -> I { rate: "[Beta] * [S] * [I]" }
Recovery:  I -> R { rate: "[Gamma] * [I]" }`,
  },

  {
    id: 'logistic-converter',
    name: 'Logistic growth (lookup converter)',
    source: `# Growth rate falls as the population rises — encoded as a lookup table.
# plot both the stock and the converter so the falling rate is visible.
sim { start: 0, length: 30, step: 0.5, units: 'Years', algorithm: RK4, plot: [stock, converter] }

@Population { initial: 1, nonNegative: true }

converter GrowthRate {
  input: Population,
  interpolation: Linear,
  points: (0, 2) (1500, 1.07) (3990, 0.429) (6780, 0.125) (10000, 0)
}

Growth: _ -> Population { rate: "[Population] * [GrowthRate]", nonNegative: true }`,
  },

  {
    id: 'abm-sir',
    name: 'Agent-based SIR (individuals)',
    source: `# The same epidemic, but every individual is an agent that moves
# between states. The S/I/R curves emerge from individual transitions.
# There are no top-level stocks here, so chart the counting variables.
sim { start: 0, length: 25, step: 1, units: 'Days', algorithm: Euler, plot: [variable] }

agent Person {
  state Susceptible { startActive: "RandBoolean(0.97)" }   # ~3% start infected
  state Infected    { startActive: "! [Susceptible]" }
  state Recovered   { startActive: false }

  # infection chance rises with the share of the population infected
  transition Catch:   Susceptible -> Infected { trigger: Probability, value: "0.5 * [Infected Share]" }
  transition Recover: Infected -> Recovered   { trigger: Timeout,     value: "{5 days}" }
}

population People { size: 200, base: Person }

# population-level counts — note these are named differently from the states
$"Infected Share"  { value: "Count([People].FindState([Infected])) / 200" }
$"Num Susceptible" { value: "Count([People].FindState([Susceptible]))" }
$"Num Infected"    { value: "Count([People].FindState([Infected]))" }
$"Num Recovered"   { value: "Count([People].FindState([Recovered]))" }`,
  },

  {
    id: 'bank-action',
    name: 'Savings with a scheduled deposit (action)',
    source: `# Compound interest, plus a one-off bonus deposit fired by an Action.
sim { start: 2026, length: 10, step: 1, units: 'Years', algorithm: Euler }

@Balance { initial: 1000, nonNegative: true }
$Rate = 0.05

Interest: _ -> Balance { rate: "[Balance] * [Rate]" }

action Bonus {
  trigger: Timeout,
  value: 5,            # at year 2031
  do: "[Balance] <- [Balance] + 500"
}`,
  },
];
