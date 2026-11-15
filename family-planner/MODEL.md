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
`init-family.mjs` writes the simpler `household.adults` plus `household.children` pair. With
no `members` list the planner falls back to `dinners.servingsPerDinner` divided by
`dinners.daysPerDinner` (`family.mjs:47-49`).

What a dinner buys. The ask for one dinner is portions a night times the nights that
dish runs (`portionsPerNight` x `nightsOf`, `nights.mjs:54`). It is divided by the pot the
recipe amounts were already scaled to: `household.cookServings` in `profiles/amounts.json`,
measured from the family's own orders (`dinners.mjs:88`, `plan.mjs:541`). Until 2026-11-13
both sides of that division carried the household's own appetite, so appetite cancelled out
and every family bought the identical pot whatever it ate. The bug survived here because one
family's numbers line up by accident: 2,6 x 2 = 5,2 portions against a mined pot of 5
servings, a 4 % error, and 48 lines on an 8-day plan moved by less than 1 %. Where the two
numbers do not line up the error is large. The golden case `one-night-dish` needs 2,9 portions and
was buying a 6-serving pot: 1032,45 kr against 632,45 kr for the correct ask, 63 % more food
than eight one-night dinners need. `two-teenagers` needs 6,8 portions, and writing that case
needed the pot hand-set to 10 servings before a bigger basket appeared at all. Both cases now
scale through `members` alone, and `one-adult` shrank 70,20 kr by itself.

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
night)". A pantry line says the same thing, and states what its quantity counts:

- `cycle` (the default): what THIS household buys per cycle. Every quantity measured out
  of an order history means this, so a family that marks nothing keeps the basket their
  history implies.
- `person-day`: one unit per person per day - the apple that goes in a lunch box.
- `person-cycle`: one unit per person per cycle - the cheese pack in that same box.

The head-count comes from `dinners.members`: everyone for breakfast, the child roles for
the lunch box and snacks, nobody for the paper block. A lunch box is a fixed kit, so it
scales with heads, not with appetite - a three-year-old and a teenager both put one apple
in a box. `household.blockPeople` in the profile overrides a single block, because the
planner cannot know whether the grown-ups take a lunch box too, and the plan output names
the block when it uses an override.

Measured by the pair `lunchbox-two-children` and `lunchbox-two-children-household-basis`:
the same two children over 8 days, one apple per box per day and one cheese pack per child
per cycle, cost 948,61 kr against 900,61 kr with every quantity read as a household total
- 48,00 kr, every other line identical. The cheese half moved nothing on its own: a dinner
in the same plan needs 200 g of that cheese too, and one 390 g pack covers the merged ask,
so a per-person mark only shows up where the pack maths was not already buying enough.

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
  plan says so. The limits shape the choice, they never lose a meal;
- a rule may set a floor on the pack size of one good (`minPackGrams`): 500 on an onion
  rule buys the 1 kg net at 12 kr for a need of 200 g, where two loose pieces at 5 kr
  would have covered the need for less. The floor holds only while a pack that size is on
  the shelf, so a habit never loses the meal, and the line prints what was left out.

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

A family can write its own rules for goods the mined evidence does not cover
(`purchasing.rules`): a grade, "cooking cream is the 4 % one", or a format, "onions and
garlic come in a net". A rule rewrites what is searched, keeps named products out (`avoid`),
may set the pack floor, and says which rule chose the product on the plan line. Its
`except` words mark where the rule's own word means something else, so a rule about "fløde"
stays off the whipping cream and one about "løg" stays off "rødløg". A rule may carry no
`query` at all, and then the recipe's word is searched: a rule about the size of a pack has
no product text to give, and an invented search string that the shop does not answer with
that product costs a call and lands on the alt. The words live in the profile and the
mechanism in the code, so a second family edits JSON and never a `.mjs`.

A piece is weighed with what the shop declares about the pack (`pieceWeightOf`,
`units.mjs`). Namlig prints the declaration in the description line: "4 x 125 g" is four
125 g bags, "2 stk. / 260 g" is two 130 g naan, "180 g / 10 skiver" is 18 g a slice. The
word table `PIECE_GRAMS` stays the fallback for what the shop does not say - loose pears,
eggs in a "15 stk." carton - and the two are not the same claim: one is read off the pack,
the other is an estimate of a thing sold loose. Both sides of a pack comparison use the
candidate's own number, so "3 pærer" against "4 stk. / 500 g" is 375 g wanted of 500 g
sold. What a candidate does not declare is never borrowed from another product: 65 g per
egg would turn a "2 stk" pizza base into a 130 g pack and make five of them look cheap.

## 5. Budget: measured against this family, not a guess

`budget.softCapKr` warns; it is derived by `init-family.mjs` from the family's own median
order and their gap between orders. The history also gives a sanity check the planner
should keep using: kr per product and portions per kr, compared with what this family has
actually paid. A plan that costs 1,4 times the family's own median basket is too big, no
matter what the absolute number is.

`budget.maxKrPerPlan` is different: it is a ceiling, and a ceiling gets met (`trim.mjs`).
Two moves, each printed and kept in the plan file under `trim`.

The brand first, never the product. The resolver hands over the rivals of what it picked
(`alternatives`, already filtered for delivery and the family's brand rules), so a cheaper
rival that passed the same name guard can be bought without a second call. Three things stop
a supposed saving. Under `budget.minSwapKr` a brand swap is churn, not money. A rival that
delivers under nine tenths of the original is a smaller shop, not a cheaper one — `delivered`
turns a pack into grams, litres or pieces, so 2 x 180 g is never traded for 2 x 430 g, and 10
eggs never for 15. And `budget.swapNeverWords` names products the family will not have
swapped: a diaper size, a medicine, the one bread a child eats.

Then, and only if the swaps were not enough, one line goes back on the shelf. Protection
comes from where a line is listed: treats 1, the household 2, breakfast 3, the child's lunch
box 4, an item asked for by hand 5, a dinner's own ingredient 0 and never cut. A line feeding
two blocks is protected by the stronger one, so a banana in the lunch box is not a treat to
cut. Inside a block the dearest line goes first, because that is how fewest lines are
touched. If it still does not fit, the plan writes itself whole and prints `trimShortfall`:
what no budget is allowed to take. A basket with a hole in the middle of dinner is not
cheaper, it is a second trip.

A tilbud is judged against what this family actually buys, not against the shelf's
cheapest (`saleBeatsPin`, `catalog.mjs`). A pinned favourite used to be bought whenever it
was in stock, so a discount on a rival was invisible to the planner. Now the usual sku is
the baseline and a rival takes its place only when four things hold: the rival is on sale,
it is cheaper for the SAME need (the family's total, not the label price - a six-pack on
sale can still cost more than one carton), nothing in `budget.swapNeverWords` names it, and
it keeps every word the family typed that its own usual product carries. The last one is
what a name score cannot do: "Mayonnaise" answers the query "Mayonnaise (let)" perfectly
well and is not the light mayonnaise. Each of these choices is printed on the plan line and
counted in the run summary, because it is the only place the planner overrides a favourite
on price.

A pinned favourite is still bound by the never-list (`attempt`, `catalog.mjs`). The rivals of
a pin were filtered by `avoidBrands` and `avoidWords`; the pin itself was not, so a family
that typed `--avoid "First Price"` got the First Price yoghurt on the plan anyway, printed as
"family favourite sku, still in stock". Measured live on 2026-11-14: that flag emptied every
rival of that brand on the shelf and still bought it, 1 line left of 7. Now the favourite
passes the same two filters as its rivals, and the line reads "usual sku 5006632 refused:
brand First Price - your own never-list outranks the favourite". The unit-price ceiling is
deliberately NOT one of those filters: a favourite is what a family buys at its own price, and
the comparison above already weighs it against the shelf. The plan's
`## Favourite SKUs not bought today` keeps the two reasons apart, because a favourite the
family refused and a favourite the shelf dropped are different conversations. The golden case
that refuses an invented brand (`over-cap-trim`) had its baseline re-recorded on 2026-11-14 for
exactly this reason: the refused milk no longer slips in as a favourite, so the case is 35
lines and 1740,94 kr against 36 lines and 1803,94 kr, with 3 unsolved lines instead of 2 - and
every one of them now reads "your own never-list refused them (brand Nordvang)" instead of
"not available".

`apply.mjs` reads the ledger back and checks the claim: the substitute of a swap must be in
the plan, a deferred line must not be, `trimAfter` must equal the items, and `trimShortfall`
must follow from the ceiling. The report prints both pack sizes of a swap: only a person can
tell a 20-pack of pants from 22 tapes, so the plan shows the number instead of deciding.

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
`profiles/amounts.json`, `profiles/recipe-pool.json`, and the evidence inside `meat.json`
and `exclusions.json`. `profiles/pantry.json` is the exception: nothing creates it, the
family writes it (`pin-skus.mjs` only fills the `sku` of lines that are already there), and
`profiles/pantry-EXAMPLE.json` is the shape to start from.

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

## Settled by measurement

Four things are written down here, because the measurement is the part worth keeping and
not the decision. Three sat on the open list until they were measured; the fourth arrived
as a taste on 2026-11-13.

- **A sale is measured against the family's own sku** (was: "the sale rule must compare
  against the SKU this family actually buys"). Implemented as `saleBeatsPin`, described in
  section 5. On this family's 8 days it found one candidate and refused it: First Price
  mayonnaise at 12,12 kr against their pinned light mayo at 26,25 kr, refused because the
  cheaper one is not the light one. The rivals of a pinned sku are kept on the plan line
  (`alternatives`), filtered for delivery and the family's brand rules, so both this rule
  and `trim.mjs` decide from what the shop can actually deliver.
- **A piece is weighed with the declared pack weight** (was: "piece weights should come
  from the shop's declared pack weight"). Implemented as `pieceWeightOf`, described in
  section 4. Measured on the 1891 products in this family's price cache: 297 descriptions
  name a piece count and 53 declare a multi-pack, all of them read now. It moved nothing
  in their 8-day basket (48 purchases, 1382,85 kr before and after), which is what a
  correct weight should do when the shop's numbers agree with the estimate.
- **A name is read together with what the shop says next to it.** (was: "some products are
  missing because the matcher reads only the first word of a name"). `match.mjs` required
  the name's first word to appear in the query, so a name that puts its brand first was
  never a candidate: `Polskey Vodka` and `Absolut vodka` both scored 0 against "Vodka", and
  the planner bought a third bottle 42,20 kr dearer. The shop's own words about a product -
  its brand and the shelf category it stands in (`shelfContext`: brand, main group, sub
  group) - now answer for both directions of the head-noun check, because they are the
  shop's claim and not a guess. A word no producer prints ("færdig", "almindelig") is no
  longer asked for at all: "Færdig pizzadej" is sold as "Pizzadej". Measured over the 191
  queries in this shelf's cache: 109 candidates came in, none went out, and on 42 of the
  queries the cheapest accepted candidate became cheaper (130,78 kr summed; the vodka line
  42,20 kr, pesto 15,49 kr, majs 17,05 kr). Every golden shelf moved 0,0 %.
  Two things this did NOT fix, and the honest reason: "hård ost" over the category
  "Specialost, hård" still reaches only half the query, because "ost" is three letters and
  the compound rule needs four, so that one is a family alias in their profile instead of a
  matcher rule; the price-axis case, which hid a 4 kr garlic head behind a 13,33 kr net
  bag, is settled by the entry below.
- **The name threshold was a dirty query, not a wrong number.** Measured 2026-11-12 over
  the cached shelf (187 queries, their 6 top names each): most blocks were a query carrying
  words no product has. "Spinat alternativt grønkål" asks for spinach and names a fallback,
  so the query was spinach plus two words nothing carries. The query is now cut at such a
  connective (`cleanQuery`, family wording in `exclusions.queryAsides`), and one 8-day plan
  went from 6 blocked lines to 2. The two left are honest: "Oregano tørret" has nothing on
  the shelf, and "Ris" against "Parboiled ris" was blocked by the head-noun guard because
  that is another product - until the family said what rice means to them: they buy
  parboiled and basmati and choose per recipe, so no query alias could stand, because one
  rewrite would decide for them every week. The profile instead lists the words that do not
  change what rice is (`purchasing.qualifierWords`), the guard skips those, and the price
  rule picks between them - today 1 kg parboiled at 11,95 kr on sale against the 500 g
  need. Dried oregano went to `pantryWords` with the other dried spices, because the
  cupboard has it and `--extra` buys it when it is dry. Two alternatives were measured and
  refused on the way: lowering `minNameScore` accepts specs the shopper wrote on purpose,
  and splitting a name on "/" for "Courgette / squash" also accepts "Fransk tærte m.
  laks/porrer" when the query is "porrer". Cutting the query fixes 26 of 28 such pairs and
  buys nothing wrong.

- **A part of a thing is weighed, and the whole shelf is compared.** (was: "two price axes
  never meet, so the cheapest cover can be invisible"). Two bugs stood behind the same
  absurd line - six cloves of garlic bought as four 200 g net bags, 800 g and 53,32 kr, when
  the shelf sells a head at 4,00 kr. First, a recipe counting PARTS was answered with that
  many PACKS: "6 fed" is six cloves off one head, and "stk" was all the need remembered
  about the word `fed`. A part is now weighed where the need is made (`SUBUNIT_GRAMS`, 5 g a
  clove, 25 g a slice), so the shelf is met with a measure like any other, and a family that
  reads a part differently says so once in `purchasing.pieceWeights` - bounded to a word of
  2-14 letters and 1 g to 2 kg, so a typo cannot weigh a clove at half a kilo. Second,
  `comparablePool` kept only the biggest price axis, so anything priced per piece was gone
  before the comparison: the head at 4,00 kr a piece never met the net bag at 66,65 kr a
  kilo. `cheapest` now returns the unit-price group it compares AND `shelf` - everything the
  filters left - and what to BUY is decided over that whole list on the total, as the model
  has always said it should. A line whose winner is priced on another axis says so.
  Measured on a pinned four-dinner menu, same shelf, same everything (`--cores` makes a run
  reproducible, which is what made this measurable at all): 1154,53 kr before, 1105,25 kr
  after, five lines moved. Garlic 13,33 -> 4,00 kr; cooking cream 59,00 -> 31,80 kr; three
  pears 30,00 -> 24,75 kr; carrots for dinner 20,00 -> 18,00 kr; dill 12,00 -> 10,00 kr.
  What this costs, and it is not nothing: a 1 kg net of onions at 12,00 kr now LOSES to three
  loose onions at 15,00 kr, because a kilo of fresh onions is 203 % more than the plan asked
  for and the overshoot cap calls that waste. A family that stores onions puts "løg" in
  `purchasing.stableWords` and the net wins again. Every golden shelf moved 0,0 %, which is
  the honest signal that the fixture shelves had no per-piece goods to hide: the two new
  tests are the coverage.
- **A family's grade and its format are a rule, not a code edit.** (asked for 2026-11-13:
  "for us cooking cream should be 4 %", "we prefer to buy a net of onions as well as a net of
  garlic"). `purchasing.rules` carries such a taste: `match` words in the ingredient line,
  `except` where that word means something else, an optional `query`, `avoid`, `alt`, and
  `minPackGrams`. Measured on this shelf, the same need with the rule off and on: 150 g of
  garlic took two loose heads at 8,00 kr off the rule and the 200 g net at 13,33 kr on it, so
  the habit costs 5,33 kr and the plan line names the rule that spent it. For 350 g of onions
  the 1 kg bag at 12,00 kr won either way; at 200 g the same rule refused three 5 kr pieces.
  The 4 % cream is today the cheapest cream on the shelf (7,95 kr per 250 ml), so what the
  rule buys there is that a discounted 15 % can no longer take the line: `avoid` refuses the
  grade and the alt cannot smuggle it back. `stableWords` gained "løg" and "hvidløg", which
  closes the loop the entry above left open - a net of onions is no longer read as waste.
  One dead query died on the way: "Løg i net" is answered by the same six products as bare
  "løg" and then refused by the matcher (best name "Løg Zittauer", score 0,5), so that rule
  carries the size in grams and searches the recipe's word - one search instead of two.
  And the rule exposed a bug worth its weight. The plan loop builds the request to the shop by
  hand, and `avoidWords`, `maxUnitPrice` and `minPackGrams` were not in that object:
  `git show HEAD:family-planner/plan.mjs` holds no occurrence of `avoidWords` at all. Every
  mined meat rule's `never` list was therefore decorative in a real run, because the plan
  printed the refusal and the basket filled with the product anyway. Measured on one shelf:
  with the field forwarded, a search for "Løg" refuses what the family refused (the 12 kr
  product is out, the 40 kr one is chosen); without it, the refused product is bought. That
  object is now a function (`searchIntentOf`) with a test over it - the tests that call
  `resolveIntent` pass the fields by hand and could never have seen this.

- **A flag word is believed, and a flag that cannot be believed says so.** (found while
  evaluating the whole codebase on 2026-11-14: 21 live scenarios, graded A-, one of them F).
  `yesNo` accepted `yes|no|ja|nej|true|false|1|0` and nothing else, while `--help` and README
  documented `--trim on|off`. So `--trim off` fell back to the default `on`. Measured on this
  family's shelf, two copies of one state, one 14-day menu: `--trim on` ended at 1499,30 kr
  against the 1500 kr ceiling, `--trim off` ended at the same 1499,30 kr, where the basket
  with no ceiling was 2469,61 kr. The same fall-back made `--breakfast off` buy breakfast.
  Both words now mean what the help text says, the ceiling is decided by one exported function
  (`capOf`), and a bound a flag carries is reported before a single shop call:
  `--days 99999 is outside 1-14 - this run uses 14 evenings instead`. Determinism was measured
  the same afternoon: the same command against an identical home gives an identical item
  sequence, and five runs against the live home gave three different baskets, because the menu
  alternates against the plan the previous run wrote. That plan is now named in the plan file
  (`menuAgainst`) and in the plan markdown, because an explained move is not a bug.
  Two more findings came out of the same battery, and both were silent and both were money.
  `planAgeHours` reached for a seventh capture group out of six, so a plan file carrying only
  its da-DK stamp was read as having no age at all and the 12 h gate never spoke; it now
  refuses a stamp it cannot read rather than taking it for fresh, and `--allow-stale` is still
  the way out. And the first probe of the plan file looked for the basket total under `total`
  and reported it missing: the field is `planTotal`, and `validatePlan` already checks it
  against the items - which is how a plan with no products was refused with `trimAfter 1333.8
  is not the 0 planned items, which add up to 0`. Name the field you measured, not the one you
  guessed.

An unresolved line used to be a dead end. The shelf had held something close, the resolver had
scored it, and the score was thrown away. The plan now keeps up to two of those names per
unresolved intent, filtered by the never-list and the unit-price ceiling, and prints each with
its pack, its price, its sku and the one `--extra` flag that takes it. `NEAR_MISS_BAND` is 0,15
*below that family's own bar*, not below the 0,7 default, so a family that raised
`purchasing.minNameScore` gets a narrower offer, not a wider one. The bar still refuses the
purchase - that is the point of having one. What changed is who decides: the family, with the
price in front of them, instead of a resolver guessing on their behalf. A printed flag is only
useful if pasting it buys the thing named. A name holding a double quote is therefore flagged
between single quotes, and a name holding both quote kinds is given no flag at all: the line says
so, gives the sku, and points at `--extra-file`. That choice was measured against the shelf, not
invented: 280 of 899 cached names have a realistic spelling variant inside the band, and the
commonest one by far is a Danish letter typed as `oe`, `aa` or `ae` (score 0,667 against a 0,7
bar), while dropping one word from a name stays above the bar. So the band catches spelling, and
a quote-hostile name is the rare case that must never be guessed at.

A check nobody schedules quietly stops happening, so the battery stamps what it found into
`data/quality/last-check.json`: the time, the mode, the counts, the failing names with the
sentence each one printed, and the commit. `doctor.mjs` reads that stamp and grades a failure by
who caused it. A failure the planner caused is a STOP: the guards and the arithmetic are the
thing a plan is trusted for, and a home that just failed one of them has not earned the pass. A
failure the shop caused is a warn, because the shelf was out and the plan already named the line
and carried something for it - on the measured day that was one rye bread, with a substitute
proposed. Blocking there would put the one readable line behind a stop sign, and a sold-out loaf
is not a broken planner. A failure whose kind the stamp does not name is read as the dangerous
one: an unknown shape is never taken as a pass. `--pure` is the half that needs nothing but the
repository: no home, no mined history, no shop call. The scheduled `Quality` job runs that half
with the golden shelves, which is where a matcher drifting away from the measured fixtures shows
up first. The shop-facing half stays on the machine that owns `data/`, once a week, by cron.

One loose end, and it is a family's to cut: their profile still maps `piskefløde` onto
"Fløde" in `queryAliases`, and the 4 % rule answers that line first, so the alias is dead
weight until they say what whipping cream means to them. Two lines that blocked the basket
one day were family facts, not code: a word the household never buys goes in
`exclusions.neverBought` and is named in the plan instead of blocking it, and pasta water is
tap water (`pantryWords`). When a plan does something wrong,
write the measurement here before fixing it, and move it up into the model when the number is
in.
