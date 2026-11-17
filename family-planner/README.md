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
| `pantry.mjs` | compiles the rebuy list and its cadence | `profiles/pantry.json` |
| `match.mjs` | Danish name matching (norm, tokens, score, nameMatches) | nothing |
| `units.mjs` | pack parsing and unit maths (g/kg, ml/l, stk) | nothing |
| `catalog.mjs` | search + cache + intent → one product, with `alt` fallbacks | `data/product-cache.json` |
| `pin-skus.mjs` | pins favourite SKUs found in history into the profiles | `profiles/*.json` with `--write` |
| `plan.mjs` | builds the plan, resolves every intent, diffs the live basket | `data/plans/plan-<stamp>.{json,md}` |
| `slots.mjs` | ranks bookable timeslots by price, window and weekday; drops slots whose order deadline passed | nothing |
| `apply.mjs` | writes an approved plan, re-reads and verifies the basket | `data/plans/applied-<stamp>.json` |
| `tools/scenario-check.mjs` | the evaluation battery: the guards, the arithmetic, the flag notes, the stamp states and the shop scenarios, against a scratch copy of the home; `--pure` runs only what a bare checkout can run | `data/quality/last-check.json`, plus its own scratch folders in `/tmp` |
| `doctor.mjs` | one line per health check, each with the command that answers it, including how long ago the battery last ran | nothing |

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
`trimShortfall` is what no budget is allowed to take. `--trim off` returns to warning, and
means it - the basket is planned whole, over the ceiling and all. `test/trim.test.mjs` proves
both halves on one shelf, because `--trim off` was once read as yes.

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
- How much protein your family wants is yours to say, not the recipe's:
  `meat.windowPerPersonGrams: { "min": 135, "max": 190 }` sets the band of grams per
  person for the cooked pot (120 g x 5 portions is 600 g for two nights). Inside the
  band the planner still buys the cheapest total, so one big pack can beat two small
  ones, and a pack that is a bit smaller still feeds everyone. Without the key the
  recipe gram is covered exactly. A line naming a word from `purchasing.condimentWords`
  with `purchasing.condimentShortfallPct` (e.g. 30) may come that percent under its
  grams, so one 150 g bottle of sauce is bought where two would cover - the cupboard
  tops the dish up. Both keys are family data; other families keep the plain rule.
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
- A rule of your own (`purchasing.rules`) says what the planner searches for when an
  ingredient line carries one of your words: the 4 % cooking cream, a net of onions.
  `except` keeps a rule off a line where its word means something else, so a rule about
  "fløde" must skip "piskefløde". `alt` is searched when your own text is not offered.
  Leave `query` out when the rule is only about the size of it: the recipe's word is then
  searched, which is cheaper and honest - on this shelf "Løg i net" answers the same six
  products as bare "løg" and then refuses them, so the dead text only cost a search.
  A format rule spends money on purpose: a net costs more than the two pieces one dish
  needs. The plan line names the rule that chose the product, so a rule is never quiet.
  Rules are matched in profile order, before the mined ones - a rule for "hvidløg" comes
  before one for "løg", because the second word sits inside the first.
- A rule may also name the smallest pack of it this family buys (`minPackGrams`). On an
  onion rule, 500 buys the 1 kg bag at 12 kr for a need of 200 g instead of two 5 kr pieces,
  and the line prints what it left out. A floor never blocks a buy: when the shelf has no
  pack that size, the floor is ignored and the buy goes ahead.
- A rule's refusals travel with the request to the shop (`plan.mjs:searchIntentOf`), so what
  the family said never cannot re-enter on an alt search or on the total. That one line is
  where a rule lives or dies: a field left out of it makes the rule decorative - the plan
  prints "never zittauer" while the basket fills with it.
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
  Namlig moves prices every day. It refuses a plan whose stamp it cannot read too: a
  missing stamp is not proof of a fresh basket.
- A flag value the planner could not use as given is reported before the first shop call,
  with the value it used instead. `--days 99999` says it planned 14 evenings; `--days 0`
  says one evening; `--max-kr abc` says the profile's ceiling decided.
- The plan names the plan file its menu was ranked against (`menuAgainst`), because the
  rotation moves against that file. Run one command twice and the basket can differ: the
  plan says which plan moved.
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
- `--avoid` outranks a pinned favourite. A brand or a word you refuse is not bought, even when
  the profile pins that product. Measured 2026-11-14: before the fix, the flag emptied every
  rival of that brand from the shelf and still bought the refused yoghurt as a favourite.
- `--trim off` leaves a basket over the ceiling whole. `--trim on` brings it under. Both halves
  run against one shelf in `node tools/scenario-check.mjs`.
- A value the planner cannot read prints a warning line. `--breakfast off` used to buy
  breakfast, because the code read `no` and `off` meant yes.
- The plan JSON names the menu it alternated against (`menuAgainst`), so a total that moves
  between two runs can be explained instead of guessed at.
- A failure prints one line plus `--debug for the stack`; the stack itself is behind
  `--debug`.
- Measured 2026-11-12, 8 days, one family: 45 s with one call at a time, 10 s through the
  gate, 1,6 s when the 24 h price cache answers 46 of 52 intents.
- If a name has no in-stock match, the intent lands in `unresolved` and `apply.mjs`
  refuses until it is fixed or passed with `--ignore-unresolved`.
- If the shelf held something close, the plan adds a `## Close but under your bar — one flag
  takes it` section: the name, the brand, the score it reached, the pack, the price, the sku and
  the one `--extra` flag that takes it. Nothing there is bought - a near miss is a decision to
  read, not a purchase. "Close" means within `NEAR_MISS_BAND` (0,15) below *your* bar, so a
  family that raised `purchasing.minNameScore` gets fewer of these lines, not more.
- A blocked line carries the closest the shelf has, and says which words it gave up to find it.
  Measured 2026-11-16 on this shelf: an ask no shelf line answers proposes its own shorter form,
  printed as `searched as "..."`, and a sliced-bread ask proposes the bare bread. One word is
  dropped at a time, the first word first, at most three reads of the shelf per blocked line, and
  the shorter phrase has to clear the family's own name bar with nothing taken off it. A one-word
  ask is never shortened. Nothing is bought: the proposal is one flag to read, and the family
  ignores it when the word that was dropped was the point. The product names behind that
  measurement stay in the family's own ignored files: this file describes the mechanism, not one
  household's basket.
- A printed flag must survive being pasted. A product name holding a double quote is flagged
  between single quotes (`--extra 'Grønt "Blandet":300 g'`), because a quote inside the name
  would otherwise end the quoted region and the shell would join the rest to the next argument.
  A name holding both quote kinds gets no flag at all: the line says so and gives the sku, and
  `--extra-file` is how to take it. The same rule covers the `accept with:` line of a
  substitution. No name is ever passed to a shell by this code - the text is read by a person.
- Verified: an 8-day dry run finished with 0 unresolved lines and the basket untouched.
  Not verified on your account: a real `apply.mjs` run writes the basket.

## Refresh

```bash
node mine-history.mjs            # after 5+ new orders
node pantry.mjs --write --prune  # compile the rebuy list and its stock schedule
node pin-skus.mjs --write        # re-pin favourite SKUs
node tools/mine-menu.mjs --snapshot data/plans/basket-before-order-*.json --dry
                                 # learn which dinners the corrected basket kept
node --test test/*.test.mjs      # the suite, incl. a stubbed search (no network)
node tools/scenario-check.mjs    # the battery: guards, arithmetic, notes, shop scenarios
node tools/scenario-check.mjs --pure   # the half that needs no data/ - this is what CI runs
rm -f data/product-cache.json    # if prices or ranges look stale
node doctor.mjs                  # one line per check, and the command that answers it
```

The battery writes its result into `data/quality/last-check.json`: when it ran, offline or live,
how many scenarios passed, the failing names with the sentence each one printed, and the commit.
`doctor.mjs` reads that stamp and grades a failure by who caused it. A failure the planner caused
is a STOP. The guards and the arithmetic cannot be trusted on that home until it is fixed. A
failure the shop caused is a warn: the shelf was out, and the plan already carried an alternative
or printed a near miss for that line. A failure whose kind the stamp does not name is treated as
one the planner caused, which is the safe reading of a stamp doctor does not understand. A stamp
older than 7 days is a warn, and no stamp at all is a warn: a machine that was never checked says
so out loud. A weekly line in `crontab -l` keeps it honest, or the `Quality` job in
`.github/workflows/quality.yml` runs the pure half plus the golden shelves on GitHub's clock - the
shop-facing half cannot run there, because `data/` is gitignored on purpose.

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
`--extra-portions`, `--max-minutes` and `--force`; `--force` rewrites a profile that already exists.
`--extra-portions N` (0-6, default 2) is how much more one cooking covers: 2 writes a profile
whose pot is eaten twice, 0 writes one where every dinner is cooked fresh. It lands in
`household.extraPortions`, which is what raises `peopleToShopFor` above the family as it is.

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

A pool smaller than the period makes the rotation bend its own rules, in the order a family
would: wait out a cooldown, then one protein more often, then two versions of a dinner, and
only then cook one dish twice - never three times. Every bend is printed under `What the
rotation decided, and what it bent`, and the dish cooked twice says so on both of its evenings.
A cooking asks for the food of its own evenings, so a dish cooked twice is bought twice. When
`poolTooSmallForThePeriod` is the rule that bent, the fix is the pool. The rotation may fill
`rotation.maxPerProtein` x the proteins in the pool x `dinners.maxNightsPerDinner` evenings;
raise `rotation.poolSize` in the family profile above that need and rebuild.

`pick-recipe-pool.mjs` reads the pool's shape from the profile, not from itself:
`rotation.poolSize` (21), `rotation.minFreshDinners` (8 of them new), `dinners.maxRecipeMinutes`
(30 - how long a NEW dish may be, and how long a recipe `mine-recipe-pool.mjs` collects) and
`rotation.maxHistoryMinutes` (45 - a dish you already cook stays whatever it costs). The numbers
it used are written into the pool file under `limits`, so a pool can be read back and traced.
`--covers 3` overrides `dinners.maxNightsPerDinner` for one run: the same dinner is eaten over
three evenings, so the pot and the ask grow with it. `--cores` is the pinned menu of
`profiles/dinners.json` and keeps the hole the rotation fills - when the pinned cores run out the
plan prints `WARNING: N evening(s) have no dinner` and buys nothing for them, because a pinned
menu is pinned on purpose.

Rebuild the generated data with these, in this order, about once a month:

```bash
node mine-history.mjs            # order history to data/staples.json, history-raw.json, recipes.json, patterns.json
node pantry.mjs --write --prune  # merge the rebuy evidence into profiles/pantry.json
node exclusions.mjs --learn --write  # drop a word the last orders actually bought
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

That interval has a listener: `doctor.mjs` grades the age of `profiles/recipe-pool.json`,
`profiles/amounts.json` and `data/order-lines-raw.jsonl`, by the `at` the writer left in them and
by their modification time otherwise. Past 31 days it is a `warn` with the rebuild command, never
a block - a plan built on a month-old pool still feeds the family.


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
  never consumes the rotation. A meal cooked without ordering it is recorded with
  `node log-dinner.mjs --dish "<name from the menu>"`, which appends `data/cooked-log.jsonl`;
  a plan that was only printed moves nothing. `--cores` goes back to the pinned cores in
  `profiles/dinners.json`; `--covers 2`, `--max-per-protein 2` and `--dinners <name>`
  steer the rotation.

