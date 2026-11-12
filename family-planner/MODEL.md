# The plan model

What a plan is, and why each number is there. Written so a family that is not ours can
change every number without reading code.

## The chain

```
household          -> portions a night
evenings in period -> dinners, each running the nights it keeps
dinners            -> needs in measures (grams, litres, pieces)
needs              -> packs, by what the pack actually holds
packs              -> cost, checked against this family's own basket history
```

Nothing in the chain is a fixed constant. Each step reads the step before it.

## 1. Household: portions, not heads

The profile lists who eats and how much, under `dinners.members` (`family.mjs:72`):

```json
"members": [ { "role": "adult", "count": 2, "appetite": 1.0 },
             { "role": "child", "count": 1, "appetite": 0.6 } ]
```

2 x 1.0 + 1 x 0.6 = **2.6 portions a night**. A family with two teenagers is
`[{adult,2,1.0},{teen,2,1.2}]` = 4.4. Appetite is the only diet knob that matters for
quantity; what the family eats is handled by the exclusions and the meat rules.
`init-family.mjs` writes the simpler `household.adults` plus `household.children` pair; the
planner then derives portions a night from `dinners.servingsPerDinner` divided by
`dinners.daysPerDinner` (`family.mjs:47-49`).

## 2. Dinners: nights, decided per dish

A dinner is cooked once and eaten for as many nights as it keeps. Keeping quality is a
property of the dish's format, mapped in the profile:

```json
"dinners": { "preferLeftovers": true, "maxNightsPerDinner": 2,
  "reheatByFormat": { "gryde": "great", "suppe": "great", "fad": "great", "pasta": "ok",
                      "pizza": "fresh", "aeg": "fresh", "wrap": "fresh", "ovn": "fresh" },
  "nightsOverride": { "/opskrifter/...": 1 } }
```

"great" and "ok" run the full `maxNightsPerDinner`; "fresh" runs one night. A curry is two
nights because it tastes better on day two; a pizza is one because it does not exist on
day two. One recipe can be pinned to one night in `nightsOverride` without touching code.

So an 8-evening period is **4 recipes** when they all keep, and 5 when one of them is
fresh. Portions per dinner follow: 2.6 x 2 = 5,2 rounded to 5 for a two-night dinner, 2,6
rounded to 3 for a one-night dinner, and the ingredients scale with it. The old hard-coded
"5 servings" was this number, written down instead of derived.

## 3. Needs: measures, never pack counts

Every line the plan buys is a measure — grams, litres or pieces — with the arithmetic kept
next to it: "250 g for 4 in the recipe -> 500 g for 5 portions (2 nights, 2.6 portions a
night)". A pantry line says the same way: "1 pære per lunch box" is 3 pieces over the
period, not 3 bags.

## 4. Packs: what the pack holds

`units.mjs` satisfies a measure with the smallest number of packs that covers it:

- same unit: divide — 8 eggs out of a 10-pack is 1 pack;
- pieces against a weighed pack: convert with the piece weight (a pære is about 190 g, so
  3 pieces fit one 1 kg bag);
- only a pack whose size cannot be read falls back to one pack per piece.

### Which pack, chosen from the whole shelf

`choosePack()` in `units.mjs` makes that buy once, over every offer the name matches:

- the option that costs the **least in total** wins. A better price per unit is never a
  reason to pay more kroner. Twelve eggs take the 15-pack at 54,95 kr, because two
  10-packs cost 83,90 kr; four eggs take the 10-pack even though the 15-pack is the
  cheaper per egg;
- slack is bounded. A fresh product may overrun the need by `overshootPctFresh` (25 %);
  a product listed in `stableWords` by `overshootPctStable` (400 %), because the price
  rule above already stops a keepsake from costing more. Eggs keep for weeks, so 15 of
  them for a need of 12 is a saving; 400 g of smoked salmon for a need of 300 g is
  waste;
- a pack-count need ("1 stk smør") is never compared with a weighed pack: one pack is
  one pack, so the cheapest pack on the shelf wins and a 100 x 8 g catering tub cannot
  sneak in as "1 stk";
- within the tie, an offer on sale beats a cheaper-per-unit one;
- two options within `tieBreakKr` (3 kr) of each other: the one that wastes less wins;
- if no offer fits inside the limits, the cheapest covering option is taken and the
  plan says so. The limits shape the choice, they never lose a meal.

The need is added **before** anything is bought. Two dinners asking for 4 eggs make one
need of 8 and one pack, not two roundings of a half pack. Two different names that land
on the same shelf item (a recipe's "Æg", the breakfast "Skrabeæg") are decided again on
the summed weight. Both sums are printed in the plan file, so the arithmetic can be
checked against the recipes.

```json
"purchasing": { "overshootPctFresh": 25, "overshootPctStable": 400, "tieBreakKr": 3,
                "stableWords": ["æg", "ris", "pasta", "mel", "sukker", "toilet"],
                "freshWords": ["mælk", "smør", "ost", "fisk", "spinat"] }
```

`freshWords` is checked first and always wins, because a short word hides inside a long
one: "salt" sits inside "saltet", and salted butter must not read as a keepsake. What
neither list names is treated as fresh.

Piece weights live in `PIECE_GRAMS` in `units.mjs`. They are estimates of what the shop
sells loose; when the shop reports the declared weight, that number should replace them.

## 5. Budget: measured against this family, not a guess

`budget.softCapKr` warns; it is derived by `init-family.mjs` from the family's own median
order and their gap between orders. The history also gives a sanity check the planner
should keep using: kr per product and portions per kr, compared with what this family has
actually paid. A plan that costs 1,4 times the family's own median basket is too big, no
matter what the absolute number is.

## 6. The loop: the plan learns from the basket you approved

The plan is meant to be about 95 % right. The last 5 % is yours: in the app you take two
things out, put yoghurt in, change a quantity, then check out. That edit is the clearest
statement of your family's taste there is, and it is already stored - in your order
history. `learn.mjs` reads the last plans and the orders that followed them and writes
`profiles/learned.json`:

- a product you take out of the basket in `minObservations` separate periods is left out
  afterwards, and named in the plan file, so it never disappears silently;
- how much you actually buy becomes a factor on that product, capped at
  `maxQuantityFactor`, and the line's rationale says so;
- what you keep adding yourself is bought next time with its evidence next to it,
  `autoAddMissing`;
- which recipe cards you kept is counted, and `node learn.mjs --rate "<url>" good|bad`
  is the human version of the same signal.

The comparison is over the **period**: a plan covers 8 days and you shop in two baskets, so
"did we buy it" is asked of both. Asking only the first one turns a late purchase into a
rejection - that was the first version of this loop, and a test now guards it.

Variation comes from the same file. A dish cooked `exploration.cooldownTimes` or more inside
`cooldownDays` waits at the back of the queue, refused dishes never come back by themselves,
and liked dishes come sooner. Nobody maintains a list.

`learned.json` is generated. `profiles/family-*.json` always outranks it, and
`learning.enabled: false` turns the loop off. Run it with `node refresh.mjs`.

## 7. Traffic: how the shop is asked

The planner asks Namlig about 50-70 products per run. That is the whole runtime, so the
rules about asking live in one place (`Limiter` in `lib.mjs`) and every script uses them:

- A bounded number of calls at once (4, `NEMLIG_CONCURRENCY` 1-8), at least 120 ms between
  two starts, plus a little jitter. A person does not fire 60 requests in one second.
- One query is searched once per run even when four lanes want it: the first caller's
  answer is handed to the others, and the 24 h price cache carries it to the next run.
- Trouble makes the gate slower and narrower: exponential backoff (1,5 s up to 30 s), one
  lane until it settles, and after 8 failed calls in a row the run stops with the shop's
  error instead of burning a minute of timeouts per intent.
- A wall-clock deadline (`--max-minutes`, default 15) ends a slow evening with a message.
- Reads are retried, writes never are. `add_to_basket` is not idempotent, and a duplicate
  product in a real basket is worse than a plan you re-run.
- `--serial` is the polite switch: one call at a time, 400 ms apart. Measured cost: 24 s
  against 10 s for the same cold 8-day plan.
- A budget of calls, not only of time: `NEMLIG_MAX_CALLS` (default 400). More than that is a
  bug or a scrape, so the run stops.
- A query the shop cannot answer falls back to the shelf from the previous run, at most a
  week old, marked as stale in the plan and named in the summary. That keeps a hiccup from
  killing a plan, and keeps a stale answer visible.
- The breaker opens after 8 consecutive failures and half-opens after 15 s: one call may
  try again, and a success closes it. A shop that answers every call with an error is
  counted as a failure too, because a tool error is an answer nobody wanted.

## What is generated and what is taste

Generated by the miners and the loop, do not edit by hand: `data/staples.json`, `data/patterns.json`, `profiles/learned.json`,
`profiles/amounts.json`, `profiles/recipe-pool.json`, `profiles/pantry.json`, and the
evidence inside `meat.json` and `exclusions.json`.

Taste, all in `profiles/family-*.json`: members and appetites, nights and keeping quality,
budget, rotation caps, meat rules and ceilings, the three recipe filters, the pack limits
(`purchasing`), delivery, basket policy.

## Portable by construction

The code contains no customer names, no Danish product names and no fixed family size.
Danish words live in the profile (exclusions, aliases, meat queries) or in the data the
miners pull from the family's own orders. `test/hygiene.test.mjs` is the guard: it greps
every tracked file for these patterns, so the sentence above is checked and not hoped for.
Two collectors keep a word list of shelf names to filter out: `HERB_WORDS` and `PANTRY_WORDS`
in `init-family.mjs`, `HERB_WORDS` and `ODD_WORDS` in `pick-recipe-pool.mjs`. Nothing in such
a list is bought by name; it only says what a recipe line must not become.

A new family, in the order the scripts need. Each step reads what the step before it wrote,
and the first three need the shop, so read the `.env` rows in `README.md` first:

```bash
cp .env.example .env              # your login and your own MCP_SECRET
node mine-history.mjs && node mine-recipes.mjs && node mine-recipes-fetch.mjs
node mine-recipes-analyze.mjs
node init-family.mjs --name <your-name> --adults 2 --children 2 --days 8
node doctor.mjs                   # one line per check; exit 1 when something blocks
node plan.mjs --family <your-name> --days 8
node refresh.mjs            # after shopping twice from a plan: re-read the orders, learn from them
```

The shop itself is abstracted behind the MCP tools (`search_products`, `add_to_basket`) and
the one web endpoint used for recipe cards, so another grocery service means writing that
thin layer, not the planner.

## Still open

1. Lunch-box and breakfast lines still count `qtyPerCycle` per period. They should read
   `per: "person-day"` so they grow with the household the same way dinners do.
2. `budget.maxKrPerPlan` should trim a plan instead of warning, in a fixed order: never
   bought before, then premium versions of a product the family does buy, then extras.
3. The sale rule must compare against the SKU this family actually buys, not only the
   cheapest item on the shelf.
4. Piece weights should come from the shop's declared pack weight when it exposes one.
5. The name threshold (`purchasing.minNameScore`, 0,7) blocked lines whose words did not fit
   the shop's name. Measured 2026-11-12 over the cached shelf (187 queries, their 6 top names
   each): most blocks were a dirty query, not a wrong threshold. "Spinat alternativt grønkål"
   asks for spinach and names a fallback, so the query was spinach plus two words no product
   carries. The query is now cut at such a connective (`cleanQuery`, family wording in
   `exclusions.queryAsides`), and one 8-day plan went from 6 blocked lines to 2. The two left
   are honest: "Oregano tørret" has nothing on the shelf, and "Ris" against "Parboiled ris" is
   blocked by the head-noun guard because that is another product. Two alternatives were
   measured and refused: lowering the number accepts specs the shopper wrote on purpose, and
   splitting a name on "/" for "Courgette / squash" also accepts "Fransk tærte m. laks/porrer"
   when the query is "porrer". Cutting the query fixes 26 of 28 such pairs and buys nothing wrong.
   The rice case was settled by the family, not by the number: they buy parboiled and basmati and
   choose per recipe, so no query alias could stand - one rewrite would decide for them every
   week. The profile instead says which words do not change what rice is (`purchasing
   .qualifierWords`), the guard skips those, and the price rule picks between them - today 1 kg
   parboiled at 11,95 kr on sale against the 500 g need. Dried oregano went to `pantryWords`
   with the other dried spices, because the cupboard has it and `--extra` buys it when it is dry.
6. A dish that repeats is cooked at one size, whatever the household. `dinners.members` gives
   portions per night, and a pot is sized by `dinners.servingsPerDinner`; when the same dish
   runs for `maxNightsPerDinner` nights the portions are not multiplied by those nights, so a
   family of two teenagers and a family of one adult get the same number of packs for a curry
   cooked twice. Found while writing the golden cases `one-adult` and `two-teenagers`, which
   work around it through `cookServings` in `profiles/amounts.json`. A fix has to say which
   number is the ask: portions a night times the nights this dish runs, then compared with what
   one pot covers - and the same dish on two days in a row is leftovers, not a second pot.
   Untouched until that is settled, because both readings change every pack count in the suite.
