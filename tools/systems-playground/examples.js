/**
 * examples.js — built-in example models for the playground.
 * The first two are lethain/systems models rewritten with this language's
 * up-front stock declarations; the flow semantics (and output) are identical
 * to the original Python tool.
 */

export const EXAMPLES = [
  {
    id: 'hiring-funnel',
    name: 'Hiring funnel (after lethain/systems)',
    rounds: 10,
    source: `# Stocks are declared up front:
#   Name(initial, max)? "description"? visible: true|false?
# [Brackets] mark infinite boundary stocks (never shown).

[Candidates]  "Boundary: the infinite pool of applicants"
PhoneScreens  "Candidates in the phone-screen stage"
Onsites       "Candidates invited on-site"
Offers        "Offers extended"
Hires         "Offers accepted"
Employees     "Current staff"
Departures    "People on their way out" visible: false
[Departed]    "Boundary: people who left"
Recruiters(3) "The recruiting team — drives top-of-funnel volume"

# Flows: source > destination @ rate
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
    id: 'recruiters',
    name: 'Growing recruiting team (after lethain/systems)',
    rounds: 25,
    source: `# The recruiting team itself grows over time (to a max of 15),
# so the whole funnel accelerates.

[PossibleRecruiters] "Boundary: recruiters we could hire"
Recruiters(10, 15)   "Recruiting team, capped at 15"
[Candidates]         "Boundary: applicant pool"
PhoneScreens
Onsites
Offers
Hires
Employees
Departures           visible: false
[Departed]

[PossibleRecruiters] > Recruiters @ 1

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
    source: `# Language extensions: auxiliaries (name = expr), IF…THEN…ELSE,
# test inputs like PULSE, and seeded randomness.

[Market] "Boundary: addressable market"
Trials   "Users in a free trial"
Active   "Paying users"
[Gone]   "Boundary: churned users"

[Market] > Trials @ Signups
Trials   > Active @ 0.6
Active   > [Gone] @ Leak(ChurnRate)

# Organic signups fluctuate; a marketing campaign fires every 12 rounds.
Signups = ROUND(MAX(0, NORMAL(40, 8))) + PULSE(200, 6, 12)

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

Engineers(20) "Total engineering team" visible: false
[Backlog]     "Boundary: feature ideas"
Shipped       "Features delivered"
[RiskPool]    "Boundary: where defects come from"
LatentDefects "Bugs shipped but not yet noticed"
Incidents     "Active incidents"
[Resolved]    "Boundary: closed incidents"

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

[Source]
Stepped "Receives STEP input"
Pulsed  "Receives PULSE input"
Ramped  "Receives RAMP input"

[Source] > Stepped @ STEP(5, 10)        # 0 until round 10, then 5/round
[Source] > Pulsed  @ PULSE(20, 5, 10)   # 20 at rounds 5, 15, 25, …
[Source] > Ramped  @ RAMP(0.5, 10)      # grows 0.5/round after round 10
`,
  },
];
