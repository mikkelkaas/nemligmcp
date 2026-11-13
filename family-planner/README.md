# Namlig family basket planner

## Where this lives

This folder is part of the Namlig MCP repository (`nemligmcp/family-planner/`). Clone that
repository and run the planner from this folder. On this host, for example, it also answers
to the older path `/opt/docker/scripts/nemlig`, which is a symlink. A new host uses its own
clone path and changes nothing. Credentials come from the `.env` the MCP server reads;
`paths.mjs` finds it, and `NEMLIG_HOME` moves the whole folder somewhere else without an
edit. Read "Environment variables" and "First run on another host" before your first plan.

Nothing here needs installing: no `npm install`, the planner runs on plain Node. The planner
needs two things that are not code: your own `.env` with your Nemlig login, and your own
household profile in `profiles/`. Git ignores both, so a clone arrives with neither, and
`node doctor.mjs` says exactly that. If anything fails, run `node doctor.mjs` first: one line
per check, and the command that answers it.

## Environment variables

The table lists every name the code reads, with the place that reads it. No script here
prints a value from a `.env`. `auth.mjs` reads `NEMLIG_USER` and `NEMLIG_PASS` from the
`.env` file; the other names come from the process environment.

| Name | Read by | Default | Purpose |
|---|---|---|---|
| `NEMLIG_HOME` | planner, `paths.mjs:18` | the folder `paths.mjs` lives in | moves the planner home (`data/`, `profiles/`) |
| `NEMLIG_ENV` | planner, `paths.mjs:35` | unset, then the search order below | points at one `.env` file |
| `NEMLIG_MCP_URL` | planner, `lib.mjs:48,77` | unset, then the two candidates in `lib.mjs:13` | base URL of the MCP endpoint, for example `http://127.0.0.1:3900/mcp` |
| `NEMLIG_USER` | planner `auth.mjs:116`; server `src/config.ts:38` | unset | login name; unset means anonymous mode upstream |
| `NEMLIG_PASS` | planner `auth.mjs:117`; server `src/config.ts:39` | unset | the password; never printed |
| `MCP_SECRET` | planner `lib.mjs:49`; server `src/http.ts:26` | unset | the endpoint path secret; at least 32 characters |
| `NEMLIG_CONCURRENCY` | planner, `lib.mjs:445` | 4, clamped 1-8 | calls in flight to the shop |
| `NEMLIG_MAX_MINUTES` | planner, `plan.mjs:634` | 15 | wall clock a run may take; `--max-minutes` wins |
| `NEMLIG_MAX_CALLS` | planner, `plan.mjs:555` | 400 | calls one run may make |
| `NEMLIG_FAMILY_PROFILE` | planner, `family.mjs:23` | unset | which `profiles/family-*.json` to load |
| `NEMLIG_CONTAINER` | planner, `lib.mjs:19` | `nemligmcp` | container name the endpoint probe asks Docker about |
| `NEMLIG_NET` | planner, `lib.mjs:20` | `docker_infra_net` | Docker network that name lives on |

On this host, for example, the probe finds the container by name. A new host that does not
run Docker gets one `warn:` line, and the HTTP candidates decide. The server's own transport
switches are `MCP_TRANSPORT`, `MCP_HTTP_PORT` or `PORT`, `MCP_HTTP_HOST` and
`MCP_ALLOW_UNAUTHENTICATED`, all in `src/http.ts:22-32`, and the upstream README documents
them.

## First run on another host

1. Install Node 20 or newer. Upstream `package.json` states engines `>=20` and its
   `Dockerfile` runs `node:22-alpine`. `--test-name-pattern`, used in `test/golden.test.mjs:14`,
   needs at least Node 18.11, so an older Node loses one documented command.
2. Copy the credential template: `cp .env.example .env` in the repository root. Fill it from
   the table above: no code reads a name that is not in that table, so check each one there.
   `MCP_SECRET` needs at least 32 characters: `openssl rand -hex 32` gives one. The
   server refuses a shorter one (`src/http.ts:27`), and so does the planner (`lib.mjs:50`).
3. Run the offline suite before you trust anything else: `node --test test/*.test.mjs`. It
   needs no login, no shop and no container.
4. Run the golden set the same way: `node --test test/golden.test.mjs`. It starts its own stub
   shop on loopback. Before the first run, write its baseline:
   `node tools/golden-baseline.mjs --write`.
5. `.env` may live in four places, and `paths.mjs:34-39` takes the first that exists: the file
   `NEMLIG_ENV` names, `<planner>/.env`, the repository root above it, and on this host for
   example `/opt/docker/.env`. Git ignores every `.env`: `.gitignore` lists it.
6. Run the server with the upstream `compose.yaml`. It joins an external Docker network named
   `npm_default`, which must exist already: create it with `docker network create npm_default`,
   or point `PROXY_NETWORK` at a network you have. Without it, Compose stops before any
   container starts, with a message such as `network npm_default ... could not be found`.
   If the endpoint is not on container DNS, set `NEMLIG_MCP_URL` to where it runs.
7. Build your profile from your own orders, then check and plan:

   ```bash
   node mine-history.mjs && node mine-recipes.mjs && node mine-recipes-fetch.mjs
   node mine-recipes-analyze.mjs      # init-family.mjs reads what these four write
   node init-family.mjs --name <your-name> --adults 2 --children 2
   node doctor.mjs                    # one line per check; exit 1 when something blocks
   node plan.mjs --days 8
   ```

   `node doctor.mjs --online` also probes the server (one `GET /healthz`), and
   `node doctor.mjs --json` gives the same findings as one object. "One profile to tweak"
   lists the miners in full.

## Recipe cards in the basket

`node recipes.mjs` adds the dinner recipe itself to the basket, so the card is openable in
the Namlig app while you cook. `POST /webapi/basket/AddRecipeToBasket` with
`{ RecipeId: "<guid>", NumberOfPeople: <portions a night> }`. `GetBasket` then returns the
card under `Recipes[]` with Namlig's own `RecipeLineItems`. The GUID comes from
`search_products`, never from the recipe URL - the URL only holds the Umbraco number, which
the endpoint rejects. The run is a dry run until `--write --approve I-APPROVE-THIS-BASKET`.

Order matters: add the card, then `apply.mjs` overwrites the quantities. `AddToBasket` sets
an absolute quantity, so a plan line replaces the recipe's line instead of doubling it, and
a product the family profile rejects is set to 0. See `PR-RECIPE-TOOL.md` for the patch
that upstream needs (`add_recipe_to_basket` in `src/api/basket.ts`).

# Nemlig basket planner

Deterministic 7-8 day basket planner for namely.com (your household, recipes of the
profile's `dinners.maxRecipeMinutes` or less, cheapest option). Skill entry point:
`skill/SKILL.md`.

Credentials: `NEMLIG_USER` / `NEMLIG_PASS` in the `.env` the MCP server reads. On this host,
for example, that is `/opt/docker/.env`, read by the container `nemligmcp`; a new host puts
them in any `.env` `paths.mjs` finds. No script here prints them. `lib.mjs` needs
`MCP_SECRET` from that file, and picks the MCP endpoint from `NEMLIG_MCP_URL` or its two
candidates.

## Run it

```bash
cd <your-clone>/family-planner    # on this host, for example: /opt/docker/scripts/nemlig
node plan.mjs --days 8 --breakfast yes --lunchbox yes --snacks no --household auto
node slots.mjs --days 8                       # which timeslot, and what it costs
node apply.mjs --plan data/plans/plan-latest.json --approve I-APPROVE-THIS-BASKET --slot <id>
```

`plan.mjs` and `slots.mjs` are read-only. `apply.mjs` is the only script that writes,
and it refuses to run without `--approve I-APPROVE-THIS-BASKET`.

## Scripts

| File | Role | Writes |
|---|---|---|
| `lib.mjs` | MCP client: env, endpoint, session, tool calls, timeouts | nothing |
| `mine-history.mjs` | reads `get_order_history`, learns rebuys | `data/history-raw.json`, `data/patterns.json`, `data/staples.json`, `data/recipes.json` |
| `match.mjs` | Danish name matching (norm, tokens, score, nameMatches) | nothing |
| `units.mjs` | pack parsing and unit maths (g/kg, ml/l, stk) | nothing |
| `catalog.mjs` | search + cache + intent → one product, with `alt` fallbacks | `data/product-cache.json` |
| `pin-skus.mjs` | pins favourite SKUs found in history into the profiles | `profiles/*.json` with `--write` |
| `plan.mjs` | builds the plan, resolves every intent, diffs the live basket | `data/plans/plan-<stamp>.{json,md}` |
| `slots.mjs` | ranks bookable timeslots by price, window and weekday; drops slots whose order deadline passed | nothing |
| `apply.mjs` | writes an approved plan, re-reads and verifies the basket | `data/plans/applied-<stamp>.json` |

## A budget that decides

`budget.softCapKr` is a warning line: the plan prints over-cap and writes the basket
anyway. `budget.maxKrPerPlan` is a ceiling, and a ceiling is met. The plan then makes two
kinds of move, prints every one of them, and keeps them in the plan file under `trim`.

1. The brand, not the product. The resolver already saw the rivals of the product it
   picked, so a cheaper one that passes the same name guard, the same delivery check and
   the same brand rules is bought instead — by `--max-kr`, or by the profile. A rival that
   delivers less than nine tenths of what the family was getting is refused: two 180 g
   cups are not two 430 g tubs, and a smaller shop is not a cheaper one. A saving under
   `budget.minSwapKr` (5 kr) is brand churn, not a saving, and a word in
   `budget.swapNeverWords` keeps a product out of the swap: a diaper size, a medicine, the
   one bread a child eats.
2. One line back on the shelf — only when the swaps were not enough. A treat goes before
   the household, the household before breakfast, breakfast before the child's lunch box,
   and a dinner's own ingredient never: a basket without its potatoes is not cheaper, it
   is a second trip to the shop. Which block a line came from decides this, so a banana in
   the child's box is protected as the box and not as a snack.

When even that does not fit, the plan says so and still writes the plan whole:
`trimShortfall` is what no budget is allowed to take. `--trim off` returns to warning.

## Profiles (edit these, they are the memory)

Everything here is built from your own order history, and `.gitignore` keeps all of it out
of git except `profiles/family-EXAMPLE.json`. A clone therefore arrives with no profile:
write yours with `init-family.mjs`, as "One profile to tweak" describes.

- `profiles/family-<name>.json` — the file you edit: who eats and how much, the soft budget
  in `budget.softCapKr`, the hard ceiling in `budget.maxKrPerPlan` (see "A budget that decides"),
  `basket.neverClearBasket`, and the delivery preference (window, weekdays,
  `delivery.minWindowHours`). `profiles/family-EXAMPLE.json` shows the shape.
- `profiles/pantry.json` — rebuy staples per block: `breakfast`, `kidLunchbox`,
  `snacks`, `household`. Each item has `query`, `qtyPerCycle`, `everyNDays`, `mode`
  (`cheapest` or `history`), optional `sku`, `alt` and `per`. **You write this file
  yourself**: no script in this repository creates it (`pin-skus.mjs` only fills in the
  `sku` of lines you wrote), so a clone has none and the plan
  says so out loud instead of buying no breakfast in silence. Copy
  `profiles/pantry-EXAMPLE.json`, which documents every field and carries invented
  quantities, and set `cycleDays` to how often you shop. `per` says what a line's
  quantity counts — `cycle` (the default, and what a number measured from your own
  orders means), `person-day` (an apple per lunch box per day) or `person-cycle` (a
  cheese pack per child per cycle).
- `profiles/dinners.json` — the dinner cores your history supports. Each stays within the
  profile's `dinners.maxRecipeMinutes` and covers `dinners.maxNightsPerDinner` evenings for
  your household's portions. An ingredient has `query`, `need` and optional `alt`.

Stock-cycle gate: an item with `everyNDays` is skipped when `data/staples.json`
shows it was bought more recently than the cycle. The gate looks up the pinned `sku`
first, so it survives a rename of the product name. The skip is printed in the plan.

## The loop: it learns from the basket you approved

The plan is meant to be about 95 % right. You fix the rest in the app - take two things out,
put yoghurt in, change a quantity - and check out. That edit is the clearest signal about
your family there is, and it is already stored in your order history.

```bash
node refresh.mjs             # your orders afresh, then each plan compared with the basket that followed it
node refresh.mjs --recipes   # also re-mine the recipe coverage (slow)
node refresh.mjs --dry       # only the comparison, nothing fetched
```

`learn.mjs`, run by refresh, writes `profiles/learned.json`: products you keep taking out,
how much more or less of a thing you really buy, and what you keep adding yourself. It is a
generated file and `profiles/family-*.json` always outranks it. Turn it off with
`learning.enabled: false`, or read what it decided in the plan file under
`What the planner learned from your baskets`.

Dishes work the same way, and one command makes it stick:

```bash
node learn.mjs --rate "/opskrifter/kaalruller-saeson-98002578" good
```

A refused dish never comes back by itself. A dish cooked `cooldownTimes` or more inside
`cooldownDays` waits at the back of the queue, so the rotation brings something new without
anyone keeping a list.

## Purchase rules (`profiles/family-*.json`)

- Which pack, decided over the whole shelf (`purchasing`): the buy that covers the need
  for the lowest **total** price wins. A better price per unit is never a reason to pay
  more kroner. 12 eggs take one 15-pack at 54,95 kr because two 10-packs cost 83,90 kr;
  4 eggs take the 10-pack even when the 15-pack is the cheaper per egg.
- `overshootPctFresh` (25) caps how far a fresh product may exceed the need;
  `overshootPctStable` (400) does the same for food listed in `stableWords`, which is
  what your family considers no loss to buy extra of. `freshWords` is checked first and
  always wins, so "saltet" smør stays fresh even though "salt" is in the other list.
  `tieBreakKr` (3): a difference under that goes to the offer on sale, then to the one
  that wastes least.
- Pieces are weighed with the weight the shop prints on the pack ("4 x 125 g",
  "2 stk. / 260 g", "180 g / 10 skiver"); the table in `units.mjs` covers only what the
  shop sells loose. A candidate's unknown weight is never borrowed from another product.
- A recipe that counts PARTS is weighed, not counted: "6 fed hvidløg" is six cloves off one
  head, so the plan asks for 30-50 g and buys one 4 kr head instead of that many packets.
  The default weights for parts (`fed` 5 g, `skive` 25 g) live in the code because they are
  the language's, not one family's; correct any of them for your household under
  `purchasing.pieceWeights`, e.g. `"pieceWeights": { "fed": 8 }`.
- What to buy is decided over the WHOLE shelf, on the total for the need - so a product
  priced per piece competes with one priced per kilo (`4 kr / stk` against `66,65 kr / kg`
  is decided by what your 50 g costs, not by which price axis has more products on it). The
  plan line names the two axes when they differ. Expect a basket that moves a little when
  this first runs for you: measured on a pinned menu, the same shelf cost 1154,53 kr before
  and 1105,25 kr after, on five lines.
- `minNameScore` (default 0,7, `family.mjs:144`) is how sure the planner must be that a
  shelf name is the product
  the recipe asked for: the share of the query's words the name has to contain. Lower
  accepts closer names, higher blocks more lines into the plan's `NOT FOUND` list. The
  plan prints the best name and score it saw, so a blocked line is a decision you can
  read, not a guess. `apply.mjs` refuses a plan with such a line.
- The shop's own words count as evidence next to the name: the product's brand and the
  shelf category it stands in. That is how a brand-first name (`Polskey Vodka`, sold under
  the category "Vodka") gets compared on price at all, and why "Færdig pizzadej" finds the
  `Pizzadej` in the chill cabinet - no producer prints the word "færdig", so it is not
  asked for. It cannot loosen a real difference: a strawberry is still the flavour of a
  yoghurt, and "hakket" is still demanded, because the shelf does print that word.
- When the words genuinely do not reach the product you buy, say so in your profile under
  `exclusions.queryAliases` and map the recipe's word onto yours ("hård ost" -> the hard
  cheese you keep in the fridge). The matcher stays a reader of names; your cheese stays
  your taste.
- `qualifierWords` are the words that may stand in front of a product name without making
  it another product - for your family. "Parboiled ris" and "Basmati ris" are rice to a
  family that buys both, so those two words sit in that list and the price rule chooses
  between them each week. It cannot loosen the other checks: a query for "Basmati ris" is
  still never answered by plain rice, and "Karry" never buys "Karry sauce".
- Needs are added before anything is bought: two dinners asking for 4 eggs are one need
  of 8, decided once. Two names landing on the same shelf item (a recipe's "Æg", the
  breakfast "Skrabeæg") are decided again on the summed weight. The plan file prints both
  sums.


- `preferSale` + `saleTolerancePct` (default true, 10): inside one group of
  comparable products, take the one Namlig marks as discounted (`DiscountItem`,
  `Discount`/`Prisfald` label) when its price per unit is at most 10 % above the
  cheapest. The plan says `valgt pga. tilbud: 43,20 vs 40,00 kr/kg (8 %)`.
- A tilbud on another brand can also replace the sku your family always buys, which a
  pinned favourite used to prevent. It must be cheaper for the same need, deliverable,
  outside `budget.swapNeverWords`, and carry every typed word your usual product carries -
  so a cheap First Price mayonnaise never replaces a light one. Each such swap is printed
  on the plan line and counted in the run summary. `basket.preferSale: false` ends it: the
  pinned favourite is then bought whenever it is in stock, sale or no sale.
- A campaign that only pays at a minimum quantity (`Fast mixtilbud`, 5 for 39 kr) is
  reported as a bulk tip, never bought silently.
- Out of stock: profile `alt` queries run first, and such a swap is labelled
  `swapped from` in the plan. If those fail too, the cheapest in-stock near-match is
  written to the plan as a proposal with a ready `--extra "Name:qty"` line. Nothing
  unapproved enters the basket.
- Bulk campaigns (`Fast mixtilbud`) are listed under `Bulk offers` with the quantity
  they need. They are never applied automatically.
- `apply.mjs` refuses a plan older than 12 h (`--allow-stale` overrides), because
  Namlig moves prices every day.
- A need in pieces means packs: `2 stk` kokosmælk is 2 cans, even though the pack
  reads `400 ml`. A need in `g`/`kg`/`ml`/`l` compares against the pack size.

## Dinners (`profiles/dinners.json`)

The cores are the meals your history supports, one warm evening meal each. A core covers
`dinners.maxNightsPerDinner` evenings for your household's portions, and `--cores` plans from
this list instead of the rotation.

A cold bread topping is not evening food, so `pantry.json` holds those items as lunch-box
lines instead: no one cooks a fish salad for dinner.

## Guarantees and known limits

- Delivery slots whose deadline has passed are dropped before ranking (Copenhagen
  wall clock, because Namlig sends deadlines without a time zone). Slots shorter than
  the profile's `delivery.minWindowHours` are dropped too, unless nothing else is open.
- Quantities sent to Namlig are absolute and take the larger of basket vs plan, so a
  plan never removes an app addition.
- Every add is verified against a fresh `get_basket`; a mismatch is reported, not hidden.
- Matching is name-token based. A wrong pick shows in the plan table before apply — read it.
- Shop traffic goes through one gate (`lib.mjs`): at most 4 calls at once, at least 120 ms
  between two starts, exponential backoff when the shop pushes back, one lane after
  trouble, and a breaker that ends the run after 8 failed calls. Tune it with
  `NEMLIG_CONCURRENCY` (1-8), `--serial` (one call at a time, wider spacing) and
  `--max-minutes` (default 15): a slow evening ends with a named reason, not a hang.
- A write to the basket is never retried: a lost answer to an add must not come back as
  two of the same product. Only reads are retried, with a bounded number of attempts.
- `apply.mjs` reads the plan file as untrusted: product number shape, one line per
  product, whole packs between 1 and 99, a plausible kr price, and totals that add up to
  `planTotal` - any problem is a refusal with the list of lines. It then takes
  `data/locks/apply.lock` so two runs cannot write the same basket, and every state file
  (cache, rotation, plan, report) is written to a temp file and renamed, so a crash
  cannot leave half a file behind.
- When the shop cannot answer a query after its retries, the shelf from the previous run is
  used (up to a week old), the line is marked in the plan, and the summary prints
  `WARNING: N line(s) were decided on a shelf the shop could not answer`. Older than a week
  is a guess, so it is refused instead. The breaker opens after 8 consecutive failures and,
  after 15 s, lets one call try again; a shop that answers every call with an error stops
  the run too. A run cannot exceed `NEMLIG_MAX_CALLS` (default 400) calls.
- `--household` accepts `auto` or `off`; any other value warns. An unknown `--flag` warns
  instead of being ignored. `--extra` without a name in front of the colon is skipped aloud.
- A failure prints one line plus `--debug for the stack`; the stack itself is behind
  `--debug`.
- Measured 2026-11-12, 8 days, one family: 45 s with one call at a time, 10 s through the
  gate, 1,6 s when the 24 h price cache answers 46 of 52 intents.
- If a name has no in-stock match, the intent lands in `unresolved` and `apply.mjs`
  refuses until it is fixed or passed with `--ignore-unresolved`.
- Verified: an 8-day dry run finished with 0 unresolved lines and the basket untouched.
  Not verified on your account: a real `apply.mjs` run writes the basket.

## Refresh

```bash
node mine-history.mjs            # after 5+ new orders
node pin-skus.mjs --write        # re-pin favourite SKUs
node --test test/*.test.mjs      # the suite, incl. a stubbed search (no network)
rm -f data/product-cache.json    # if prices or ranges look stale
node doctor.mjs                  # one line per check, and the command that answers it
```

## One profile to tweak

`profiles/family-<your-name>.json` is the only file a family edits. `profiles/family-EXAMPLE.json`
shows its shape, and git ignores the real one. It holds who you shop for,
portions per dinner, the soft budget, the rotation rules, the basket policy, the delivery
preference, the fat band and kr-per-kg ceiling per protein, and the three recipe filters
(fresh herbs, pantry staples, never-bought items) with their word lists. `family.mjs` reads
it and hands the rest of the planner the shapes it already knows, so the profile always
wins. `plan.mjs`, `apply.mjs` and `slots.mjs` print the profile they used; `--family of-4`
picks another one when several exist, and `NEMLIG_FAMILY_PROFILE` picks one for every script.

The other files in `profiles/` are generated data with the evidence next to the numbers, and
you leave them alone: `amounts.json` (mined quantities), `recipe-pool.json` (the rotation),
`pantry.json` (rebuy staples and pinned SKUs), `dinners.json`, `meat.json` and
`exclusions.json` (how many orders asked for and bought each word).

A new family gets their own profile like this, in this order:

```bash
cp .env.example .env                       # your login, your MCP_SECRET: see "First run"
node mine-history.mjs && node mine-recipes.mjs && node mine-recipes-fetch.mjs
node mine-recipes-analyze.mjs            # their own orders, so their own history first
node init-family.mjs --name <your-name> --adults 2 --children 2 --days 8
node doctor.mjs                          # one line per check; exit 1 when something blocks
node plan.mjs --family <your-name> --days 8   # dry run
```

`init-family.mjs` reads only what those four miners write, so it fails until they have run.
Its flags are `--name` (needed), `--adults`, `--children`, `--days`, `--timezone`,
`--max-minutes` and `--force`; `--force` rewrites a profile that already exists.

`init-family.mjs` fills the profile from the numbers it can measure - portions, the soft cap
from the median order and the gap between orders, the fat percentage and the 75th-percentile
price per kg of every protein they actually buy, the recipe words they have never bought, and
only those product aliases their own staples support - and it writes a `_note` where a miner
cannot know a taste. The herb rule is a taste: it leaves every fresh herb out and says which
words the family's own history contradicts.

## Recipe rotation

One dinner is cooked once and eaten twice, so the servings a plan buys come from the
profile: `dinners.members` with their appetites, times the evenings in
`dinners.maxNightsPerDinner`. `profiles/recipe-pool.json` holds the pool: `rotation.poolSize`
dinners, split between the dishes your history already knows and new ones from Namlig's
recipes of `dinners.maxRecipeMinutes` or less. `plan.mjs` takes them in rotation, least
recently cooked first, alternating a new dish with a known one, at most
`rotation.maxPerProtein` dinners per protein and at least `rotation.minFishDishes` fish dish
in the plan.

Rebuild the generated data with these, in this order, about once a month:

```bash
node mine-history.mjs            # order history to data/staples.json, history-raw.json, recipes.json, patterns.json
node mine-recipes.mjs            # every order's raw lines, recipe lines included
node mine-recipes-fetch.mjs      # the recipe page of every recipe you have ordered
node mine-recipes-analyze.mjs    # recipe ingredients vs what you actually bought
node mine-recipe-pool.mjs        # Namlig's quick main dishes, with ingredients
node pick-recipe-pool.mjs        # score them and write profiles/recipe-pool.json
node mine-amounts.mjs            # amounts per basket and per dinner, from your own orders
node init-family.mjs --name <your-name> --adults 2 --children 2 --days 8 --force
                                 # refresh the measured knobs, keep the taste
```

Each step reads what the step before it wrote: `pick-recipe-pool.mjs` needs the candidates
`mine-recipe-pool.mjs` collected, and `mine-amounts.mjs` needs the pool.

The clash rule lives in `similarity.mjs`: two dishes are the same dinner when the FORMAT
(spaghetti, pasta salad, noodles, pizza, wrap, rice, potato, stew, tray bake) and the PROTEIN
are the same. Spaghetti bolognese and spaghetti med koedboller may not share a week; chili con
carne and tortillas may, because the format differs. `pick-recipe-pool.mjs` drops a clashing
candidate while it builds the pool, and `chooseDinners` in `dinners.mjs` refuses a clash inside
one period. The protein comes from the dish name three times over the tags and once over the
ingredients, so a single "Rejer" line cannot turn "Nudler med kylling" into a fish dish.

- `profiles/meat.json` answers a recipe's protein with the fat band and the cheap cut per
  kg your profile records, and refuses anything above a kr-per-kg ceiling.
- `profiles/exclusions.json` leaves out fresh herbs when your profile says you do not cook
  with them, pantry staples such as salt and oil, and products absent from your own order
  history. What is left out is named in the plan.
  Dried spices belong to the same list (paprika, spidskommen, gurkemeje, kanel, oregano):
  the cupboard has them, and when it does not, `--extra "Oregano:1 pk"` buys them once.
  `queryAsides` adds words that open a second choice inside a recipe line ("Spinat
  alternativt grønkål"): the query is cut there, so the search is for spinach and the
  fallback is not bought. Ordinary Danish connectives are already known without a profile.
- `profiles/amounts.json` holds the mined amounts; every dinner line in the plan file
  prints the arithmetic behind its quantity.
- `data/rotation.json` is written by `apply.mjs` after a successful write, so a dry run
  never consumes the rotation. `--cores` goes back to the pinned cores in
  `profiles/dinners.json`; `--covers 2`, `--max-per-protein 2` and `--dinners <name>`
  steer the rotation.

