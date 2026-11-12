// nights.mjs — how many nights a dinner runs for, and what that means to buy.
//
// The old rule was a list of dish names that eat one night only. That does not travel:
// another family, another shop, another cuisine. The rule here is a property of the dish:
// how well it keeps. A curry or a stew tastes better on day two, a pizza or an æggekage
// does not exist on day two. The mapping from format to keeping quality lives in the
// family profile, so anyone can move a format from one column to the other.
//
// Portions come from the same idea: one night is one portion per person, scaled by how
// much each person eats. A family of 2 adults (1.0) and one small child (0.6) is 2.6
// portions a night, so a dinner that runs 2 nights is 5,2 portions cooked once - which is
// exactly the "5 servings" this planner has been using all along, now derived instead of
// written down.
import { dishFormat } from "./similarity.mjs";

/** Format -> keeping quality. Used when the profile does not say otherwise. */
export const REHEAT_BY_FORMAT = {
  gryde: "great", suppe: "great", fad: "great", pastasalat: "fresh", salat: "fresh",
  pizza: "fresh", aeg: "fresh", pandekage: "fresh", wrap: "fresh", ovn: "fresh",
  pasta: "ok", spaghetti: "ok", nudler: "ok", ris: "ok", kartoffel: "ok", kal: "ok", andet: "ok",
};

/** "great", "ok" or "fresh" - how well this dish keeps for a second night. */
export function reheatOf(dish, table = REHEAT_BY_FORMAT) {
  if (dish.reheat) return String(dish.reheat).toLowerCase();
  const format = dish.format || dishFormat(dish);
  const word = (table || {})[format];
  return word ? String(word).toLowerCase() : "ok";
}

/**
 * How many nights this dinner is cooked for. One night when it does not keep, otherwise
 * as many as the family wants leftovers for. A per-dish override always wins, so one
 * recipe can break the rule without touching code.
 */
export function nightsOf(dish, { preferLeftovers = true, maxNights = 2, overrides = {}, table = REHEAT_BY_FORMAT } = {}) {
  const key = dish.url || dish.name;
  const wanted = Number(overrides[key] ?? overrides[dish.name]);
  const cap = Math.max(1, Number(maxNights) || 2);
  if (Number.isFinite(wanted) && wanted > 0) return Math.min(cap, Math.round(wanted));
  if (!preferLeftovers) return 1;
  return reheatOf(dish, table) === "fresh" ? 1 : cap;
}

/** Portions one night needs, from the household's own appetites. */
export function portionsPerNight(members, fallback = 3) {
  const list = Array.isArray(members) && members.length ? members : null;
  if (!list) return Number(fallback) || 3;
  const sum = list.reduce((n, m) => n + (Number(m.count) || 0) * (Number(m.appetite) || 1), 0);
  return sum > 0 ? Number(sum.toFixed(2)) : (Number(fallback) || 3);
}

/** Portions to cook for one dinner: one night, times the nights it runs for. */
export function cookPortions(members, dish, opts) {
  return Number((portionsPerNight(members) * nightsOf(dish, opts)).toFixed(2));
}

/** Evenings the chosen dinners cover, and the recipe count that follows from them. */
export function coverEvenings(dishes, opts) {
  const nights = dishes.map((d) => nightsOf(d, opts));
  return { covered: nights.reduce((n, x) => n + x, 0), recipes: dishes.length, nights };
}
