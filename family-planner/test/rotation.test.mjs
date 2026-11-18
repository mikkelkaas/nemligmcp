// rotation.test.mjs — what the rotating menu promises, tested on fixtures instead of on the
// live shop. Every case here is a rule the README states or the profile carries: least
// recently cooked first, new dish alternating with a known one, at most N dinners per
// protein, fish about once a week, one dinner cooked for the evenings it actually runs.
// The first case is the one that made the menu move on every run: a plan that was only
// printed is not dinner, and must not be read as if it were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chooseDinners, readRotation, daysSince } from "../dinners.mjs";

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// Gryde, fad, suppe keep well (two nights); pizza and aeg do not (one night).
const GRYDE = { minutes: 30, format: "gryde", servings: 4 };
const PIZZA = { minutes: 20, format: "pizza", servings: 4 };
const poolOf = (list) => list.map((d) => ({ ...GRYDE, score: 10, ...d }));

test("a plan that was only printed is not dinner, so it does not move the queue", () => {
  const dir = mkdtempSync(join(tmpdir(), "rotation-plans-"));
  writeFileSync(join(dir, "plan-2026-11-1521071.json"), JSON.stringify({
    dinnerMenu: [{ url: "/never-cooked-only-planned", name: "Dish from a dry run" }],
  }));
  const missing = join(dir, "nothing-here.jsonl");
  const rank = readRotation({ plansDir: dir, linesFile: missing, rotationFile: missing, cookedFile: missing });
  assert.ok(!("/never-cooked-only-planned" in rank),
    "a printed plan must not read as cooked: the next run would then choose a different menu from the same state");

  const applied = join(dir, "rotation.json");
  writeFileSync(applied, JSON.stringify({ schemaVersion: 1, used: { "/bought-and-eaten": daysAgo(3) } }));
  const withApply = readRotation({ plansDir: dir, linesFile: missing, rotationFile: applied, cookedFile: missing });
  assert.equal(withApply["/bought-and-eaten"], daysAgo(3), "an applied basket IS dinner and does move the queue");
  rmSync(dir, { recursive: true, force: true });
});

test("the same state and the same command give the same menu", () => {
  const pool = poolOf([
    { url: "/a", name: "A", protein: "oksekod", score: 50 },
    { url: "/b", name: "B", protein: "kylling", score: 40 },
    { url: "/c", name: "C", protein: "fisk", score: 10 },
  ]);
  const opts = { days: 6, coversDays: 2, lastUsed: { "/a": daysAgo(4) }, maxPerProtein: 3, minFish: 0 };
  const first = chooseDinners(pool, opts).chosen.map((c) => c.url).join(",");
  const second = chooseDinners(pool, opts).chosen.map((c) => c.url).join(",");
  assert.equal(second, first, "nothing in the run itself may change what the next run chooses");
});

test("the last dinner cooks only for the evenings that are left", () => {
  const pool = poolOf([
    { url: "/a", name: "A", protein: "oksekod" },
    { url: "/b", name: "B", protein: "kylling" },
    { url: "/c", name: "C", protein: "fisk" },
    { url: "/d", name: "D", protein: "svinepolse" },
  ]);
  const pick = chooseDinners(pool, { days: 7, coversDays: 2, lastUsed: {}, maxPerProtein: 2, minFish: 0 });
  const covers = pick.menu.reduce((n, m) => n + m.covers, 0);
  assert.equal(covers, 7, "seven evenings are bought for, not eight: " + pick.menu.map((m) => m.covers).join("+"));
  assert.equal(pick.coveredDays, 7);
  assert.equal(pick.uncoveredDays, 0);
  const last = pick.menu[pick.menu.length - 1];
  assert.equal(last.covers, 1, "the tail of a 7-evening period is one evening of leftovers, not two");
  assert.equal(last.nights, 1, "and the pot is sized to that evening, because the portions come from nights");
  assert.equal(last.clipped, true, "and the plan says this dish was cut short by the end of the period");
});

test("the menu tiles the period with no gap and no overlap", () => {
  const pool = poolOf([
    { url: "/a", name: "A", protein: "oksekod" },
    { url: "/b", name: "B", protein: "kylling" },
    { url: "/c", name: "C", protein: "fisk" },
    { url: "/p", name: "P", protein: "andet", ...PIZZA },
  ]);
  const pick = chooseDinners(pool, { days: 6, coversDays: 2, lastUsed: {}, maxPerProtein: 2, minFish: 0 });
  let next = 1;
  for (const m of pick.menu) {
    const [from, to] = String(m.days).split("-").map(Number);
    assert.equal(from, next, `the menu jumps over evening(s) at ${m.name}: expected start ${next}`);
    assert.equal(to - from + 1, m.covers, `${m.name} says it runs ${m.covers} nights and its evenings are ${m.days}`);
    next = to + 1;
  }
  assert.equal(next - 1, 6, "the last dinner ends on the last evening of the period");
});

test("the protein cap bends before an evening goes without a dinner", () => {
  const pool = poolOf([
    { url: "/a", name: "A", protein: "oksekod" },
    { url: "/b", name: "B", protein: "oksekod" },
    { url: "/c", name: "C", protein: "oksekod" },
    { url: "/d", name: "D", protein: "kylling" },
  ]);
  const pick = chooseDinners(pool, { days: 8, coversDays: 2, lastUsed: {}, maxPerProtein: 2, minFish: 0 });
  assert.equal(pick.uncoveredDays, 0, "a pool of one protein still has to cover the week: " + JSON.stringify(pick.menu.map((m) => m.name)));
  assert.ok((pick.relaxed || []).some((r) => /protein/i.test(r.rule)),
    "and the plan says the cap was bent, because a family that reads maxPerProtein 2 expects 2: " + JSON.stringify(pick.relaxed));
});

test("fish once a week is counted in dishes, and it survives a bent cap", () => {
  // Four dinners rank above the fish one and fill all eight evenings between them, so nothing
  // puts the fish in the menu by itself: the rule has to swap it in and say what it displaced.
  const pool = poolOf([
    { url: "/a", name: "A", protein: "kylling", format: "gryde", score: 9 },
    { url: "/b", name: "B", protein: "kylling", format: "fad", score: 8 },
    { url: "/c", name: "C", protein: "svinepolse", format: "gryde", score: 7 },
    { url: "/d", name: "D", protein: "svinepolse", format: "fad", score: 6 },
    { url: "/f", name: "F", protein: "fisk", format: "gryde", score: 1 },
  ]);
  const pick = chooseDinners(pool, { days: 8, coversDays: 2, lastUsed: {}, maxPerProtein: 2, minFish: 1 });
  assert.equal(pick.uncoveredDays, 0, "every evening has a dinner: " + pick.menu.map((m) => m.name).join(","));
  assert.ok(pick.menu.some((m) => m.protein === "fisk"), "the fish dish is in the menu: " + pick.menu.map((m) => m.protein).join(","));
  assert.ok(pick.fishSwap && pick.fishSwap.in === "F", "and the swap that put it there is reported: " + JSON.stringify(pick.fishSwap));
  assert.equal(pick.fishSwap.nights, 2, "the swapped dish keeps the evenings it took over");
});

test("alternateNewAndKnown is a rule the family can turn off", () => {
  const pool = poolOf([
    { url: "/a", name: "Known A", protein: "oksekod", score: 50 },
    { url: "/b", name: "Known B", protein: "kylling", score: 40 },
    { url: "/c", name: "New C", protein: "fisk", score: 10 },
    { url: "/d", name: "New D", protein: "svinepolse", score: 9 },
  ]);
  const lastUsed = { "/a": daysAgo(300), "/b": daysAgo(200) };
  const base = { days: 8, coversDays: 2, lastUsed, maxPerProtein: 2, minFish: 0 };
  const mixed = chooseDinners(pool, base).chosen.map((c) => c.url).join(",");
  const queued = chooseDinners(pool, { ...base, alternateNewAndKnown: false }).chosen.map((c) => c.url).join(",");
  assert.equal(queued, "/c,/d,/a,/b", "off means the queue is cook order, untouched: " + queued);
  assert.equal(mixed, "/c,/a,/d,/b", "on is what the README describes: a new dish between two known ones: " + mixed);
});

test("neverTwoVariantsOfTheSameDinner is a rule the family can turn off", () => {
  // Enough distinct dinners that the strict week never has to bend: the difference between the
  // two runs below is the knob, not the size of the pool.
  const pool = poolOf([
    { url: "/a", name: "Oksekød gryde A", protein: "oksekod", score: 9 },
    { url: "/b", name: "Oksekød gryde B", protein: "oksekod", score: 8 },
    { url: "/c", name: "Kylling gryde", protein: "kylling", score: 7 },
    { url: "/d", name: "Fisk gryde", protein: "fisk", score: 6 },
    { url: "/e", name: "Svinekød gryde", protein: "svinepolse", score: 5 },
  ]);
  const base = { days: 6, coversDays: 2, lastUsed: {}, maxPerProtein: 3, minFish: 0 };
  const strict = chooseDinners(pool, base);
  const strictUrls = strict.chosen.map((c) => c.url);
  assert.ok(!(strictUrls.includes("/a") && strictUrls.includes("/b")),
    "two versions of the same dinner in one week is what the profile forbids: " + strictUrls.join(","));
  assert.equal(strict.relaxed.length, 0, "a pool with five proteins never needs to bend a rule: " + JSON.stringify(strict.relaxed));
  const loose = chooseDinners(pool, { ...base, neverTwoVariantsOfTheSameDinner: false }).chosen.map((c) => c.url);
  assert.ok(loose.includes("/a") && loose.includes("/b"),
    "turned off, the family that eats beef twice a week gets beef twice: " + loose.join(","));
});

test("every dinner says how it got its place in the week", () => {
  const pool = poolOf([
    { url: "/a", name: "A", protein: "oksekod" },
    { url: "/b", name: "B", protein: "kylling" },
    { url: "/c", name: "C", protein: "fisk" },
  ]);
  const pick = chooseDinners(pool, { days: 6, coversDays: 2, lastUsed: { "/a": daysAgo(40) }, maxPerProtein: 2, minFish: 0 });
  for (const m of pick.menu) {
    assert.ok("cookedAgo" in m, `${m.name} has no evidence of when it was last cooked`);
    if (m.url === "/a") assert.equal(m.cookedAgo, 40, "a dish cooked 40 days ago says 40");
    else assert.equal(m.cookedAgo, "never", "a dish the family has never cooked says never, not a made-up date");
  }
});

test("when the pool runs out, a dinner is cooked twice instead of an evening going empty", () => {
  // Four dinners at two nights each is eight evenings; the period asks for ten. Before this
  // rule the last two evenings had no dinner and the plan said only "WARNING".
  const pool = poolOf([
    { url: "/a", name: "A", protein: "oksekod", score: 9 },
    { url: "/b", name: "B", protein: "kylling", score: 8 },
    { url: "/c", name: "C", protein: "fisk", score: 7 },
    { url: "/d", name: "D", protein: "svinepolse", score: 6 },
  ]);
  const pick = chooseDinners(pool, { days: 10, coversDays: 2, lastUsed: {}, maxPerProtein: 2, minFish: 0 });
  assert.equal(pick.uncoveredDays, 0, "ten evenings have a dinner: " + pick.menu.map((m) => m.name + ":" + m.days).join(" "));
  const urls = pick.chosen.map((c) => c.url);
  assert.equal(urls.length, 5, "five cookings for ten evenings: " + urls.join(","));
  const twice = urls.filter((u) => urls.filter((x) => x === u).length > 1);
  assert.equal(new Set(twice).size, 1, "exactly one dish is cooked twice: " + urls.join(","));
  assert.ok(urls.every((u) => urls.filter((x) => x === u).length <= 2), "no dish is cooked three times in a week");
  assert.ok(pick.menu.some((m) => m.repeated), "and the plan prints which cooking is the second one");
  const bent = (pick.relaxed || []).find((r) => r.rule === "poolTooSmallForThePeriod");
  assert.ok(bent, "the rule bent is named, because a family that reads four dinners expects four: " + JSON.stringify(pick.relaxed));
  assert.match(bent.because, /pick-recipe-pool/, "and the reason says how to stop it happening again: " + bent.because);
  let next = 1;
  for (const m of pick.menu) {
    const [from, to] = String(m.days).split("-").map(Number);
    assert.equal(from, next, `the reused dish left a gap at evening ${next}`);
    next = to + 1;
  }
  assert.equal(next - 1, 10, "the cookings tile the whole period, the reused one included");
});

// The pool's own shape used to be constants inside pick-recipe-pool.mjs, so the two numbers the
// profile documented changed nothing. These two cases are the pin that they are read now.
test("the pool is built from the numbers the family edits", async () => {
  const { poolLimits } = await import("../pick-recipe-pool.mjs");
  const today = poolLimits({});
  assert.deepEqual([today.poolSize, today.minFresh, today.maxProven, today.maxRecipeMinutes, today.maxHistoryMinutes],
    [21, 8, 13, 30, 45],
    "the defaults are the numbers the pool on this home was built from, so wiring them moves nothing: " + JSON.stringify(today));
  const asked = poolLimits({ rotation: { poolSize: 9 }, dinners: { maxRecipeMinutes: 20 } });
  assert.equal(asked.poolSize, 9, "rotation.poolSize is how many dinners the rotation gets");
  assert.equal(asked.maxRecipeMinutes, 20, "dinners.maxRecipeMinutes is how long a new dish may be");
  assert.equal(asked.minFresh + asked.maxProven, asked.poolSize, "the new/known split adds up to the pool the family asked for");
  assert.equal(poolLimits({ rotation: { poolSize: 2 } }).poolSize, 6, "under six there is no rotation left, so six is the floor");
});

test("the picker stops at the size the family asked for", async () => {
  const { selectPool } = await import("../pick-recipe-pool.mjs");
  const names = ["Oksekød gryde", "Kylling i fad", "Laks i ovn", "Svinekød i fad", "Pizza med grønt",
    "Æggekage med ost", "Ris med kylling", "Pasta med oksekød"];
  const scored = names.map((name, i) => ({ url: `/opskrifter/pin-${i}`, name, minutes: 25, score: 100 - i,
    historyOrders: 0, coverageBuyablePct: 95, oddAsks: [], servings: 4 }));
  const got = selectPool(scored, { poolSize: 6, minFresh: 3, maxProven: 4, maxRecipeMinutes: 30, maxHistoryMinutes: 45 });
  assert.equal(got.length, 6, "the pool holds the six the profile asked for, not the twenty-one it used to: " + got.map((p) => p.name).join(","));
});

test("--covers is how many evenings one dinner is eaten over", () => {
  const pool = poolOf([
    { url: "/a", name: "A", protein: "oksekod" },
    { url: "/b", name: "B", protein: "kylling" },
    { url: "/c", name: "C", protein: "fisk" },
  ]);
  const base = { days: 9, coversDays: 2, lastUsed: {}, maxPerProtein: 3, minFish: 0 };
  const two = chooseDinners(pool, { ...base, maxNights: 2 });
  const three = chooseDinners(pool, { ...base, coversDays: 3, maxNights: 3 });
  const long = (p) => Math.max(...p.menu.map((m) => m.nights));
  assert.equal(long(two), 2, "two is what the profile says today: " + two.menu.map((m) => m.nights).join("+"));
  assert.equal(long(three), 3, "the flag raises the nights a dish that keeps runs, and the pot grows with it: " + three.menu.map((m) => m.nights).join("+"));
});

test("a dish cooked 40 days ago says 40 in the morning too", () => {
  // The number used to be counted from a wall instant against a noon reference, so every
  // morning until noon the plan told the family a dish had been waiting one day less than it had.
  const morning = Date.parse("2026-11-16T07:33:00+01:00");
  const evening = Date.parse("2026-11-16T20:00:00+01:00");
  assert.equal(daysSince("2026-10-07", morning), 40, "07:33 in Copenhagen says 40, not 39");
  assert.equal(daysSince("2026-10-07", evening), 40, "and the evening says the same");
  assert.equal(daysSince("2026-11-15", Date.parse("2026-11-16T00:30:00+01:00")), 1,
    "half past midnight in Copenhagen is already the next evening, the day the cooked log writes");
  assert.equal(daysSince(null), 9999, "a dish with no date stays at the back of the queue");
  assert.equal(daysSince("not a date"), 9999, "and a broken date is refused, not read as today");
});
