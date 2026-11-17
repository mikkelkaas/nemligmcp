#!/usr/bin/env node
// slots.mjs — list real Namlig delivery timeslots and rank them for this family.
//
// Usage:
//   node slots.mjs [--days 8] [--from 2026-11-12] [--json] [--limit 12]
//
// Reads the delivery preference from profiles/household.json. Prints one line per
// bookable slot with weekday, date, window, hours, price, and the reason it ranked
// where it does. Exit code 2 when nothing is bookable, so a caller can react.
//
// Read-only: this script only calls get_timeslots. It never reserves anything.
import { readFileSync } from "node:fs";
import { connectGated, warnUnknownFlags } from "./lib.mjs";
import { loadFamily } from "./family.mjs";
// What this script understands, so a typo in a flag is named instead of ignored.
const SLOTS_FLAGS = ["days", "from", "limit", "json", "family", "help", "debug"];
const CALL_TIMEOUT = 60000;
const WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

function i18nArg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : null;
}

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

/** Flatten the nested DayRangeHours structure into one object per slot. */
export function flatten(slotsJson) {
  const out = [];
  for (const day of (slotsJson && slotsJson.DayRangeHours) || []) {
    for (const h of day.DayHours || []) {
      const iso = String(h.Date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
      out.push({
        id: h.Id,
        iso,
        weekday: WEEKDAYS[new Date(iso + "T12:00:00Z").getUTCDay()] || "?",
        start: h.StartHour,
        end: h.EndHour,
        hours: Number(h.NumberOfHours || 0),
        price: Number(h.DeliveryPrice ?? 0),
        originalPrice: h.OriginalDeliveryPrice ?? null,
        cheap: !!h.IsCheapHour,
        free: !!h.IsFreeHour,
        event: !!h.IsEventSlot,
        availability: h.Availability,
        type: h.Type,
        attended: h.Type === 0,
        selected: !!h.IsSelected,
        deadline: h.Deadline,
        dayFlags: {
          cheapDay: !!day.IsCheapDay,
          freeAttended: !!day.IsFreeDayAttended,
          freeUnattended: !!day.IsFreeDayUnattended,
        },
      });
    }
  }
  return out;
}

/** Copenhagen wall clock as "YYYY-MM-DDTHH:MM", the shape Namlig sends deadlines in. */
export function copenhagenNow(date = new Date()) {
  const local = date.toLocaleString("sv-SE", { timeZone: "Europe/Copenhagen", hour12: false });
  const m = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/.exec(local);
  if (!m) throw new Error("could not build the Copenhagen clock from " + local);
  return m[1] + "T" + m[2];
}

/** Namlig deadlines carry no time zone: they are Copenhagen time. Compare as strings. */
export function deadlinePassed(deadline, nowIso) {
  const d = String(deadline || "").slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d)) return false;
  return d <= String(nowIso).slice(0, 16);
}

/** Namlig Availability codes as the shop sends them (verified live 2026-11-17):
 * 0 = ledig (bookable), 1 = deadline passed, 2 = sold out, 3 = not active. */
export function bookable(s, { deliveryType = "attended", minHours = 0 } = {}) {
  if (s.availability !== 0) return false;
  if (s.event) return false;
  if (deliveryType === "attended" && s.type !== 0) return false;
  if (deliveryType === "unattended" && s.type !== 1) return false;
  if (minHours && s.hours < minHours) return false;
  return true;
}

/**
 * Score a slot against the family preference. Lower is better.
 * Weights are deliberately coarse: price dominates, then window fit, then duration.
 */
export function score(s, pref) {
  const why = [];
  let v = 0;
  v += (Number(s.price) || 0) * (pref.pricePriority === "time-over-cheap" ? 0.2 : 1);
  if (s.price === 0) why.push("free delivery");
  else if (s.cheap) why.push("cheap-hour price");
  const win = String(pref.windowPrefer || "");
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(win);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    const overlap = Math.max(0, Math.min(s.end, hi) - Math.max(s.start, lo));
    if (overlap > 0) why.push("fits preferred window " + win);
    else v += 25;
    if (overlap === 0) why.push("outside preferred window " + win);
  }
  if (Array.isArray(pref.weekdayPrefer) && pref.weekdayPrefer.includes(s.weekday)) {
    v -= 10;
    why.push("preferred weekday (" + s.weekday + ")");
  } else {
    why.push("not a preferred weekday");
  }
  if (s.hours >= 3) {
    v -= 6;
    why.push(s.hours + " h window");
  } else if (s.hours <= 1) {
    v += 8;
    why.push("only 1 h - tight with small children");
  }
  if (s.availability === 2) {
    v += 3;
    why.push("few places left");
  }
  return { value: Number(v.toFixed(2)), why };
}

function fmt(s, scored) {
  const win = String(s.start).padStart(2, "0") + "-" + String(s.end).padStart(2, "0");
  return [
    s.weekday.padEnd(8), s.iso, win.padEnd(6), (s.hours + "t").padEnd(3),
    (s.price + " kr").padStart(6), (s.attended ? "betjent" : "ubetjent").padEnd(9),
    "id=" + s.id, "score=" + scored.value, "| " + scored.why.join(", "),
  ].join(" ");
}

async function main() {
  // --help answers before the shop is contacted.
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log('usage: node slots.mjs [--days 8] [--from 2026-11-12] [--limit 12] [--json] [--family <name>]');
    console.log("Read-only: it lists bookable delivery slots and ranks them. It never reserves one. Exit 2 when nothing is bookable.");
    return;
  }
  warnUnknownFlags(process.argv, SLOTS_FLAGS);
  const days = Math.max(1, Math.min(14, Number(arg("days", "8")) || 8));
  const from = arg("from", null);
  const limit = Number(arg("limit", "12")) || 12;
  const asJson = process.argv.includes("--json");
  const pref = loadFamily({ name: i18nArg("family") }).household.deliveryPreference || {};
  const { mcp } = await connectGated({ minIntervalMs: 200 });
  const args = { days };
  if (from) args.startDate = from;
  const r = await mcp.call("get_timeslots", args, { timeoutMs: CALL_TIMEOUT });
  if (r.isError) throw new Error("get_timeslots failed: " + r.text.slice(0, 200));
  const all = flatten(r.json);
  const nowIso = copenhagenNow();
  const open = all.filter((s) => !deadlinePassed(s.deadline, nowIso));
  const chosen = all.filter((s) => s.selected).map((s) => `${s.weekday} ${s.iso} ${String(s.start).padStart(2, "0")}-${String(s.end).padStart(2, "0")} (${s.price} kr, id ${s.id})`);
  const minHours = Number(pref.minWindowHours || 0);
  let usable = open.filter((s) => bookable(s, { deliveryType: pref.deliveryType, minHours }));
  let narrowNote = null;
  if (usable.length === 0 && minHours > 0) {
    usable = open.filter((s) => bookable(s, { deliveryType: pref.deliveryType }));
    narrowNote = `no slot is ${minHours} h or longer - showing shorter ones too`;
  }
  const ranked = usable.map((s) => ({ ...s, ...score(s, pref) })).sort((a, b) => a.value - b.value || a.price - b.price || a.iso.localeCompare(b.iso));
  if (asJson) {
    console.log(JSON.stringify({ preference: pref, count: ranked.length, slots: ranked.slice(0, limit) }, null, 1));
  } else {
    console.log(`Bookable ${pref.deliveryType || "attended"} slots: ${ranked.length} of ${all.length} listed in ${days} days`);
    console.log(`Preference: ${pref.windowPrefer || "no window"} window, weekdays ${(pref.weekdayPrefer || []).join("/")}, min ${pref.minWindowHours || 1} h, ${pref.pricePriority || "cheap-over-time"}`);
    if (chosen.length) console.log(`Currently selected in the basket: ${chosen.join("; ")}`);
    if (narrowNote) console.log(`Note: ${narrowNote}`);
    console.log(`Closed for booking (deadline passed ${nowIso.replace("T", " ")} Copenhagen): ${all.length - open.length} of ${all.length}`);
    console.log("");
    if (ranked.length) console.log(recommendation(ranked[0], ranked, pref));
    console.log("");
    for (const s of ranked.slice(0, limit)) console.log(fmt(s, s));
    const cheapest = [...usable].sort((a, b) => a.price - b.price)[0];
    if (cheapest) console.log(`\nCheapest overall: ${cheapest.weekday} ${cheapest.iso} ${cheapest.start}-${cheapest.end} for ${cheapest.price} kr (id ${cheapest.id})`);
  }
  if (ranked.length === 0) process.exitCode = 2;
}

/** One-line answer for a person deciding now: which slot to book, and what it costs against the cheapest. */
function recommendation(top, ranked, pref) {
  const win = String(top.start).padStart(2, "0") + "-" + String(top.end).padStart(2, "0");
  const cheaper = ranked.filter((s) => s.price < top.price);
  const delta = cheaper.length ? ` Cheaper option: ${cheapestOf(cheaper).price} kr, ${cheapestOf(cheaper).weekday} ${cheapestOf(cheaper).iso}.` : " It is also the cheapest of the ranked list.";
  return [
    `ANBEFALET: ${top.weekday} ${top.iso} kl. ${win} (${top.hours} t, ${top.price} kr, ${top.attended ? "betjent" : "ubetjent"}) id=${top.id}.`,
    `Why: ${top.why.join(", ")}.${delta}`,
  ].join("\n");
}

function cheapestOf(list) {
  return [...list].sort((a, b) => a.price - b.price)[0];
}

if (import.meta.url === "file://" + process.argv[1]) main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
