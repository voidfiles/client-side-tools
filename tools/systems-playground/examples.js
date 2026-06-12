/**
 * examples.js — built-in example models for the playground.
 * The first two are verbatim lethain/systems models (MIT) and run
 * identically in the original Python tool.
 */

export const EXAMPLES = [
  {
    id: 'hiring-funnel',
    name: 'Hiring funnel (lethain/systems README)',
    rounds: 10,
    source: `# The classic hiring-funnel model from the lethain/systems README.
# Runs identically in the original Python tool.

[Candidates] > PhoneScreens @ Recruiters * 3
PhoneScreens > Onsites      @ 0.5
Onsites      > Offers       @ 0.5
Offers       > Hires        @ 0.5
Hires        > Employees    @ 1.0
Employees    > Departures   @ Leak(0.1)
Departures   > [Departed]   @ 1.0

Recruiters(3)
`,
  },
  {
    id: 'recruiters',
    name: 'Growing recruiting team (lethain/systems examples)',
    rounds: 25,
    source: `# links.txt from lethain/systems: the recruiting team itself
# grows over time, so the whole funnel accelerates.

[PossibleRecruiters] > Recruiters(10, 15) @ 1

[Candidates] > PhoneScreens @ Recruiters * 3
PhoneScreens > Onsites      @ 0.5
Onsites      > Offers       @ 0.5
Offers       > Hires        @ 0.5
Hires        > Employees    @ 1.0
Employees    > Departures   @ Leak(0.1)
Departures   > [Departed]   @ 1.0
`,
  },
  {
    id: 'saas-growth',
    name: 'SaaS growth with churn (showcases extensions)',
    rounds: 36,
    source: `# Extensions beyond the original language: auxiliaries (name = expr),
# IF…THEN…ELSE, test inputs like PULSE, and seeded randomness.

# Organic signups fluctuate; a marketing campaign fires every 12 rounds.
Signups = ROUND(MAX(0, NORMAL(40, 8))) + PULSE(200, 6, 12)

[Market] > Trials @ Signups
Trials   > Active @ 0.6
Active   > [Gone] @ Leak(ChurnRate)

# Churn worsens once the user base outgrows support capacity.
ChurnRate = IF Active > 500 THEN 0.08 ELSE 0.04
`,
  },
  {
    id: 'incident-load',
    name: 'Incident load vs. remediation (feedback loop)',
    rounds: 40,
    source: `# A reliability feedback loop: shipping creates latent defects,
# defects become incidents, incidents pull engineers off feature work.

Engineers(20)
OnFeatures = MAX(0, Engineers - Firefighters)
Firefighters = MIN(Engineers, Incidents * 2)

[Backlog]     > Shipped       @ OnFeatures / 2
[RiskPool]    > LatentDefects @ ROUND(OnFeatures * 0.3)
LatentDefects > Incidents     @ Leak(0.2)
Incidents     > [Resolved]    @ Firefighters / 2
`,
  },
  {
    id: 'step-pulse',
    name: 'Test inputs: STEP, PULSE, RAMP',
    rounds: 30,
    source: `# Handy for probing how a structure responds to standard inputs.

[Source] > Stepped @ STEP(5, 10)        # 0 until round 10, then 5/round
[Source] > Pulsed  @ PULSE(20, 5, 10)   # 20 at rounds 5, 15, 25, …
[Source] > Ramped  @ RAMP(0.5, 10)      # grows 0.5/round after round 10
`,
  },
];
