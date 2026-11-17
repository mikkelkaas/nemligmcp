// Delivery slots: the bookable() gate, regression for the 2026-11-17 flip.
// The shop's live codes are 0 = bookable, 1 = deadline passed, 2 = sold out,
// 3 = not active. An older reading had 1 = open and filtered the whole shop
// out ("Bookable attended slots: 0 of 421" while tomorrow was full).
// Run: node --test test/slots.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { bookable } from "../slots.mjs";

const open = { availability: 0, event: false, type: 0, hours: 2 };

test("availability 0 is a bookable attended slot", () => {
  assert.equal(bookable(open), true);
  assert.equal(bookable({ ...open, type: 1 }, { deliveryType: "unattended" }), true);
});

test("codes 1, 2, 3 and a missing code are never bookable", () => {
  for (const availability of [1, 2, 3, undefined, null]) {
    assert.equal(bookable({ ...open, availability }), false, `code ${String(availability)}`);
  }
});

test("type and window gates still apply on top of an open code", () => {
  assert.equal(bookable({ ...open, event: true }), false);
  assert.equal(bookable({ ...open, type: 1 }), false);
  assert.equal(bookable(open, { minHours: 3 }), false);
});
