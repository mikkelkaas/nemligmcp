# Namlig family basket planner

## Where this lives

This folder is part of the Namlig MCP repository (`nemligmcp/family-planner/`). On this
server it also answers to the older path `/opt/docker/scripts/nemlig`, which is a symlink
to it. Credentials come from the `.env` the MCP container reads; `paths.mjs` finds it, and
`NEMLIG_HOME` moves the whole folder somewhere else without an edit.

Nothing here needs installing: no `npm install`, the planner runs on plain Node.

## Recipe cards in the basket

`node recipes.mjs` adds the dinner recipe itself to the basket, so the card is openable in
the Namlig app while you cook. `POST /webapi/basket/AddRecipeToBasket` with
`{ RecipeId: "<guid>", NumberOfPeople: 5 }`; `GetBasket` then returns the card under
`Recipes[]` with Namlig's own `RecipeLineItems`. The GUID comes from `search_products`,
never from the recipe URL - the URL only holds the Umbraco number, which the endpoint
rejects. The run is a dry run until `--write --approve I-APPROVE-THIS-BASKET`.

Order matters: add the card, then `apply.mjs` overwrites the quantities. `AddToBasket` sets
an absolute quantity, so a plan line replaces the recipe's line instead of doubling it, and
a product the family profile rejects is set to 0. See `PR-RECIPE-TOOL.md` for the patch
that upstream needs (`add_recipe_to_basket` in `src/api/basket.ts`).

# Nemlig basket planner

Deterministic 7-8 day basket planner for namely.com (5 people, 30-minute recipes,
cheapest option). Skill entry point: `skill/SKILL.md`.

Credentials: `NEMLIG_USER` / `NEMLIG_PASS` in `/opt/docker/.env`, read by the
`nemligmcp` container. No script here prints them. `lib.mjs` finds the MCP endpoint
from `/opt/docker/.env` (`MCP_SECRET`, `HOST_IP`).

## Run it

```bash
cd /opt/docker/scripts/nemlig
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

## Profiles (edit these, they are the memory)

- `profiles/household.json` — 5 people, 3-year-old lunch box, 1500 kr soft cap,
  `neverClearBasket`, delivery preference (15-21 window, søn/man/tir, min 3 t).
- `profiles/pantry.json` — rebuy staples per block: `breakfast`, `kidLunchbox`,
  `snacks`, `household`. Each item has `query`, `qtyPerCycle`, `everyNDays`, `mode`
  (`cheapest` or `history`), optional `sku` and `alt`.
- `profiles/dinners.json` — 6 dinner cores learned from the history, each ≤ 30 min,
  covering 2 days for 5 people, with `query`, `need` and optional `alt` per ingredient.

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
- `minNameScore` (0,7) is how sure the planner must be that a shelf name is the product
  the recipe asked for: the share of the query's words the name has to contain. Lower
  accepts closer names, higher blocks more lines into the plan's `NOT FOUND` list. The
  plan prints the best name and score it saw, so a blocked line is a decision you can
  read, not a guess. `apply.mjs` refuses a plan with such a line.
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

Five cores, each a warm evening meal for 5 covering 2 days: `pasta-bolognese`,
`kyllingcurry-ris`, `fiskefrikadeller`, `pizza-dej`, `tortellini-floede`.
Cold bread toppings (makrelsalat, spegepølse, ost) are lunch-box items in
`pantry.json` — they were moved out of the dinner list on 2026-11-11 after Marco
pointed out that a mackerel salad is not evening food.

## Guarantees and known limits

- Delivery slots whose deadline has passed are dropped before ranking (Copenhagen
  wall clock, because Namlig sends deadlines without a time zone). Slots shorter than
  `deliveryPreference.minWindowHours` are dropped too, unless nothing else is open.
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
- Verified: 8-day dry run on 2026-11-11 → 51 products, 1113,49 kr, 0 unresolved,
  basket untouched. Not verified: a real `apply.mjs` run (no basket write has been made).

## Refresh

```bash
node mine-history.mjs            # after 5+ new orders
node pin-skus.mjs --write        # re-pin favourite SKUs
node --test test/*.test.mjs      # 70 cases, incl. a stubbed search (no network)
rm -f data/product-cache.json    # if prices or ranges look stale
```

## One profile to tweak

`profiles/family-of-3.json` is the only file a family edits. It holds who you shop for,
portions per dinner, the soft budget, the rotation rules, the basket policy, the delivery
preference, the fat band and kr-per-kg ceiling per protein, and the three recipe filters
(fresh herbs, pantry staples, never-bought items) with their word lists. `family.mjs` reads
it and hands the rest of the planner the shapes it already knows, so the profile always
wins. `plan.mjs`, `apply.mjs` and `slots.mjs` print the profile they used; `--family of-4`
picks another one when several exist.

The other files in `profiles/` are generated data with the evidence next to the numbers, and
you leave them alone: `amounts.json` (mined quantities), `recipe-pool.json` (the rotation),
`pantry.json` (rebuy staples and pinned SKUs), `dinners.json`, `meat.json` and
`exclusions.json` (how many orders asked for and bought each word).

A new family gets their own profile like this, in this order:

```bash
node mine-history.mjs && node mine-recipes.mjs && node mine-recipes-fetch.mjs
node mine-recipes-analyze.mjs            # their own orders, so their own history first
node init-family.mjs --name family-of-4 --adults 2 --children 2 --days 8
node plan.mjs --family of-4 --days 8     # dry run
```

`init-family.mjs` fills the profile from the numbers it can measure - portions, the soft cap
from the median order and the gap between orders, the fat percentage and the 75th-percentile
price per kg of every protein they actually buy, the recipe words they have never bought, and
only those product aliases their own staples support - and it writes a `_note` where a miner
cannot know a taste. The herb rule is a taste: it leaves every fresh herb out and says which
words the family's own history contradicts.

## Recipe rotation

One dinner is cooked once and eaten twice, so a plan buys 5 servings for a household of
2 adults and 1 child. `profiles/recipe-pool.json` holds 21 dinners: 13 this family has
ordered before and 8 new ones from Namlig's recipes of 30 minutes or less. `plan.mjs`
takes them in rotation, least recently cooked first, alternating a new dish with a known
one, at most 2 dinners per protein and at least one fish dish in an 8-day plan.

Rebuild the generated data with these, in this order, about once a month:

```bash
node mine-history.mjs            # order history to data/staples.json + profiles/pantry.json
node mine-recipes.mjs            # every order's raw lines, recipe lines included
node mine-recipes-fetch.mjs      # the recipe page of every recipe we have ordered
node mine-recipes-analyze.mjs    # recipe ingredients vs what we actually bought
node mine-recipe-pool.mjs        # Namlig's quick main dishes, with ingredients
node pick-recipe-pool.mjs        # score them and write profiles/recipe-pool.json
node mine-amounts.mjs            # amounts per basket and per dinner, from 66 orders
node init-family.mjs --family-of-3 --force   # refresh the measured knobs, keep the taste
```

The clash rule lives in `similarity.mjs`: two dishes are the same dinner when the FORMAT
(spaghetti, pasta salad, noodles, pizza, wrap, rice, potato, stew, tray bake) and the PROTEIN
are the same. Spaghetti bolognese and spaghetti med koedboller may not share a week; chili con
carne and tortillas may, because the format differs. `pick-recipe-pool.mjs` drops a clashing
candidate while it builds the pool, and `chooseDinners` in `dinners.mjs` refuses a clash inside
one period. The protein comes from the dish name three times over the tags and once over the
ingredients, so a single "Rejer" line cannot turn "Nudler med kylling" into a fish dish.

- `profiles/meat.json` answers a recipe's protein with the fat band and the cheap cut per
  kg this family uses, and refuses anything above a kr-per-kg ceiling.
- `profiles/exclusions.json` leaves out fresh herbs (Marco's rule), pantry staples such as
  salt and oil, and products absent from 66 orders. What is left out is named in the plan.
  Dried spices belong to the same list (paprika, spidskommen, gurkemeje, kanel, oregano):
  the cupboard has them, and when it does not, `--extra "Oregano:1 pk"` buys them once.
  `queryAsides` adds words that open a second choice inside a recipe line ("Spinat
  alternativt grønkål"): the query is cut there, so the search is for spinach and the
  fallback is not bought. Ordinary Danish connectives are already known without a profile.
- `profiles/amounts.json` holds the mined amounts; every dinner line in the plan file
  prints the arithmetic behind its quantity.
- `data/rotation.json` is written by `apply.mjs` after a successful write, so a dry run
  never consumes the rotation. `--cores` goes back to the five pinned cores in
  `profiles/dinners.json`; `--covers 2`, `--max-per-protein 2` and `--dinners <name>`
  steer the rotation.

