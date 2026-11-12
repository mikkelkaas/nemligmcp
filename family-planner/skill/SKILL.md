---
name: nemlig-basket
description: Use when asked to build, plan, suggest or add a Nemlig grocery basket for the next 7-8 days (dinner, breakfast, 3-year-old lunch boxes, snacks, household items), or to pick a delivery timeslot.
---

## What this does

Builds a deterministic basket plan for the next 7-8 days from the real Namlig order
history, shows it for approval, then writes it to the real basket. Nothing is ordered.
The family confirms in the app.

Scripts: `/opt/docker/scripts/nemlig/`. Read `MODEL.md` for the model (household -> nights -> needs -> packs -> budget) and `README.md` for the commands. Service: container
`nemligmcp`, compose service `nemligmcp` in `/opt/docker/infra-stack.yml`. Check it with
`hsudo docker compose -f /opt/docker/infra-stack.yml ps nemligmcp` and expect
`Up ... (healthy)`. Plain `docker compose` does not exist on this host - use `hsudo`.

**Only `apply.mjs` writes to the basket. Never call `add_to_basket`,
`set_basket_quantity`, `remove_from_basket` or `clear_basket` by hand.**

## Step 1 — ask the questions

Ask all five in one message. Pre-fill with the defaults in `profiles/household.json`.

1. **Days?** 7 or 8 (default 8). One dinner covers 2 days.
2. **Breakfast?** yes / no (default yes).
3. **Dinner?** "Choose for me" is the normal answer: the rotation picks the menu from
   `profiles/recipe-pool.json` and `plan.mjs` prints what it chose. Only when Marco names
   dishes add `--dinners "<name>,<name>"`, using a name from the plan's `## Menu` list or a
   recipe url. A pinned-core id works only together with `--cores`, which skips the
   rotation. An id the pool does not have is reported as `warn:` and skipped - never
   silently. Never offer a cold bread topping as dinner — the dinner list is warm evening food.
4. **Anything else?** Free text, one item per line. Optional — `--household auto`
   already covers toiletpaper, soap, diapers from `profiles/pantry.json`.
5. **Delivery?** Run `node slots.mjs --days 8`. Report the `ANBEFALET` line (day,
   window, hours, price, id) and the cheapest alternative with its price. The script
   already drops slots whose order deadline has passed and shows the slot currently
   selected in the basket. Then ask: book the recommended one, or pick another.
   If `slots.mjs` prints no `ANBEFALET` line or exits 2 (nothing bookable, 0 of N), say so
   in one line, plan without a slot, and do not retry or scrape the site.

Do not run `plan.mjs` before every answer is in. If nobody is reachable to answer, run
with the defaults above and open the report with "planned on defaults: 8 days, breakfast
yes, lunch box yes, snacks no, household auto, menu chosen by the rotation".

If the user says "do not touch my basket", that is a hard stop after Step 2: print the
plan, report the numbers, and do not mention Step 3 as an option you are about to take.

## Step 2 — plan (dry run, always first)

```bash
cd /opt/docker/scripts/nemlig
node plan.mjs --days 8 --breakfast yes --lunchbox yes --snacks no \
  --household auto --dinners pasta-bolognese,kyllingcurry-ris
```

`--dinners` only selects from the pinned cores, so add `--cores` to use it. Without
`--cores` the rotation pool decides the menu (`profiles/recipe-pool.json`) and `plan.mjs`
says so. Other flags: `--covers N` nights per dinner, `--family <name>`, `--soft-cap N`,
`--avoid "brand,word"`, `--extra "Name:qty"` for a substitution you accepted,
`--max-per-protein N`, `--fresh` (ignore the 24 h price cache), `--serial` (one request at
a time), `--max-minutes N` (stop the run, default 15).`--help` prints the usage and writes
nothing.

`plan.mjs` prints the profile it used: `profiles/family-*.json` is the one file a family
edits (members and appetites, nights per dinner, budget, rotation, meat, exclusions, pack
limits). Pass `--family <name>` when several profiles exist. The rotation refuses two
variants of the same dinner in one period — same format and same protein is one dinner
(`similarity.mjs`). A dinner runs as many nights as its format keeps (`nights.mjs`), and
a pack is chosen for the lowest total price, never the best price per unit
(`choosePack` in `units.mjs`). `MODEL.md` explains the chain end to end.

Read `data/plans/plan-latest.md`, then report:

- the dinners and the day pairs they cover;
- item count and total in kr;
- anything above the 1500 kr soft cap;
- every `NOT FOUND` intent that is not a recipe line — these block `apply.mjs`. A line a
  recipe names that Namlig has nothing for at all is listed under `Left out of the
  recipes` and does not block;
- every line under `Proposed substitution` (out-of-stock: the cheapest alternative is
  suggested, NOT added). Ask Marco to accept or ignore; on accept, re-run the plan
  with the printed `--extra "Name:qty"` flag;
- every line under `Bulk offers` and `Stale favourite SKUs` — one short line each;
- the `## Menu` list: it names the dinner per day pair with the protein and a link to the
  Namlig recipe, and it alternates a dish the family has never cooked with a known one;
- the `## Left out of the recipes` list: fresh herbs and things we never buy, per recipe.
  Mention it in one line; it is Marco's call if he wants any of them anyway;
- every line under `Swapped by the profile's alt queries` — say what was swapped;
- the count of products on sale, and the `valgt pga. tilbud` notes;
- the approval line at the end of the plan file.

If an intent is unresolved, the plan names the query it searched and the best name and
score it saw. Then fix the profile: a shelf product that is ours under another word goes
to `exclusions.queryAliases`; a recipe line that carries a second choice ("Spinat
alternativt grønkål") is cut at `exclusions.queryAsides`; a family that wants closer names
accepted lowers `purchasing.minNameScore` from its 0,7. A line we must have today goes in
`--extra "Name:qty"`. Re-plan after any of these.
Do not swap in a product Marco did not ask for. If the task forbids editing a profile,
report the unresolved lines and stop - `apply.mjs` refuses them anyway.

A section of the plan file that is not there was empty, not skipped: no substitutions, no
bulk offers, no stale favourites, no learnings yet.

## Step 3 — wait for approval

Say the basket was not touched, and wait. Only after Marco approves in chat:

```bash
cd /opt/docker/scripts/nemlig
node apply.mjs --plan data/plans/plan-latest.json --approve I-APPROVE-THIS-BASKET --slot <id>
```

`--slot` takes the id Marco chose. It is optional; without it the delivery stays as it
is in the app.

## Step 4 — report

From the `APPLIED` line and `data/plans/applied-*.json`:

- what you will eat (dinners with day pairs);
- what else went in, grouped (breakfast, lunch box, household);
- lines added, product total, delivery fee, total, minimum-order status;
- the verification line — it must read "all added products present at the planned quantity";
- the sentence "No order was placed — confirm in the app."

Report every `FAIL` line with product name and error text.

## Guardrails

- Never clear or reduce the basket. `apply.mjs` is keep-and-top-up only.
- Never place an order, never confirm payment, never change the delivery address.
- Never print `NEMLIG_PASS`. Never copy `/opt/docker/.env` anywhere.
- Never add alcohol, medicine or gift cards unless Marco named the item in chat.
- Prices and stock change daily: re-plan any plan older than 2 hours before apply.
- If the container is unhealthy or login fails, say so and stop. Do not scrape the
  website as a fallback.

## Maintenance

- Learn new staples: `node mine-history.mjs` (writes `data/staples.json` and
  `profiles/pantry.json`). Run after 5 or more new orders.
- Re-pin favourite SKUs: `node pin-skus.mjs --write`.
- Regression suite: `node --test test/*.test.mjs` (matcher, packs, learning, the traffic
  gate, the plan check, and the golden set of scored decisions - all without network).
  After a change you intend to the behaviour, refresh the golden baselines with
  `node tools/golden-baseline.mjs --write` and read the diff before committing.
- Search cache: `data/product-cache.json`, 24 h, pruned after a week. Force live search with
  `--fresh`. A warm run takes seconds, a fresh one tens of seconds.
- Shop traffic is gated: 4 calls at once (1-8 with `NEMLIG_CONCURRENCY`), 120 ms between
  starts, backoff then one lane on trouble, breaker after 8 failed calls, `--serial` for
  one lane on purpose, `--max-minutes` (default 15) as the stop. Reads retry, basket
  writes never retry. `apply.mjs` validates the plan file and holds `data/locks/apply.lock`.
- The plan prints its own timing line: connect, catalog, intents, cache answers, gate work.
- All files, logs and times are Europe/Copenhagen.
