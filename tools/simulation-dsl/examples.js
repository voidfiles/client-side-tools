/**
 * examples.js — starter models spanning the simulation toolkit. Each is valid
 * Simulation DSL and runs on the scottfr/simulation engine unchanged.
 */

export const EXAMPLES = [
  {
    id: 'predator-prey',
    name: 'Predator–Prey (Lotka–Volterra)',
    source: `# Classic Lotka-Volterra oscillation: foxes eat rabbits.
sim { start 0  length 40  step 0.25  units Years  algorithm RK4 }

stock Prey      { initial 400  nonNegative }
stock Predators { initial 20   nonNegative }

variable PreyBirthRate = 0.25
variable PreyDeathRate  { value "0.005 * [Predators]" }
variable PredBirthRate  { value "0.0002 * [Prey]" }
variable PredDeathRate = 0.25

flow PreyBirths:  _ -> Prey       { rate "[Prey] * [PreyBirthRate]"        nonNegative }
flow PreyDeaths:  Prey -> _       { rate "[Prey] * [PreyDeathRate]"        nonNegative }
flow PredBirths:  _ -> Predators  { rate "[Predators] * [PredBirthRate]"   nonNegative }
flow PredDeaths:  Predators -> _  { rate "[Predators] * [PredDeathRate]"   nonNegative }`,
  },

  {
    id: 'sir-sd',
    name: 'SIR epidemic (system dynamics)',
    source: `# Compartmental SIR model as stocks and flows.
sim { start 0  length 20  step 0.2  units Weeks  algorithm RK4 }

stock S { initial 100 }   # susceptible
stock I { initial 3 }     # infected
stock R { initial 0 }     # recovered

variable Beta  = 0.01     # infection coefficient
variable Gamma = 0.3      # recovery rate

flow Infection: S -> I { rate "[Beta] * [S] * [I]" }
flow Recovery:  I -> R { rate "[Gamma] * [I]" }`,
  },

  {
    id: 'logistic-converter',
    name: 'Logistic growth (lookup converter)',
    source: `# Growth rate falls as the population rises — encoded as a lookup table.
sim { start 0  length 30  step 0.5  units Years  algorithm RK4 }

stock Population { initial 1  nonNegative }

converter GrowthRate {
  input Population
  interpolation Linear
  points (0, 2) (1500, 1.07) (3990, 0.429) (6780, 0.125) (10000, 0)
}

flow Growth: _ -> Population { rate "[Population] * [GrowthRate]"  nonNegative }`,
  },

  {
    id: 'abm-sir',
    name: 'Agent-based SIR (individuals)',
    source: `# The same epidemic, but every individual is an agent that moves
# between states. The S/I/R curves emerge from individual transitions.
sim { start 0  length 25  step 1  units Days  algorithm Euler }

agent Person {
  state Susceptible { startActive "RandBoolean(0.97)" }   # ~3% start infected
  state Infected    { startActive "! [Susceptible]" }
  state Recovered   { startActive false }

  # infection chance rises with the share of the population infected
  transition Catch:   Susceptible -> Infected { trigger Probability  value "0.5 * [Infected Share]" }
  transition Recover: Infected -> Recovered   { trigger Timeout       value "{5 days}" }
}

population People { size 200  base Person }

# population-level counts — note these are named differently from the states
variable "Infected Share" { value "Count([People].FindState([Infected])) / 200" }
variable "Num Susceptible" { value "Count([People].FindState([Susceptible]))" }
variable "Num Infected"    { value "Count([People].FindState([Infected]))" }
variable "Num Recovered"   { value "Count([People].FindState([Recovered]))" }`,
  },

  {
    id: 'bank-action',
    name: 'Savings with a scheduled deposit (action)',
    source: `# Compound interest, plus a one-off bonus deposit fired by an Action.
sim { start 2026  length 10  step 1  units Years  algorithm Euler }

stock Balance { initial 1000  nonNegative }
variable Rate = 0.05

flow Interest: _ -> Balance { rate "[Balance] * [Rate]" }

action Bonus {
  trigger Timeout
  value 5            # at year 2031
  do "[Balance] <- [Balance] + 500"
}`,
  },
];
