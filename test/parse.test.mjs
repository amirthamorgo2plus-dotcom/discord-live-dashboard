// Parser tests: node --test test/parse.test.mjs
// The parser decides what gets sent to a broker, so both what it MUST parse
// and what it MUST REFUSE to parse are covered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSignal, parseOptionsSignal, parseStockSignal, toOccSymbol } from "../lib/parse.js";

// Fixed "now" so bare M/D expiries resolve deterministically.
const NOW = new Date("2026-07-16T12:00:00Z");

/* ---------- options shorthand: the three real orderings ---------- */

test("options: ticker strike+type expiry premium", () => {
  const s = parseSignal("AAPL 420C 7/17 2.5", NOW);
  assert.equal(s.kind, "option");
  assert.equal(s.ticker, "AAPL");
  assert.equal(s.type, "C");
  assert.equal(s.strike, 420);
  assert.equal(s.premium, 2.5);
  assert.equal(s.expiry, "2026-07-17");
  assert.equal(s.occ, "AAPL260717C00420000");
});

test("options: ticker expiry strike+type premium (and lowercase ticker)", () => {
  const s = parseSignal("GoOG 7/17 400C 1.8", NOW);
  assert.equal(s.ticker, "GOOG", "ticker should normalise to uppercase");
  assert.equal(s.strike, 400);
  assert.equal(s.premium, 1.8);
  assert.equal(s.occ, "GOOG260717C00400000");
});

test("options: ticker expiry type strike premium (detached type)", () => {
  const s = parseSignal("META 7/17 C 690 1.1", NOW);
  assert.equal(s.ticker, "META");
  assert.equal(s.type, "C");
  assert.equal(s.strike, 690, "larger number is the strike");
  assert.equal(s.premium, 1.1, "smaller number is the premium");
  assert.equal(s.occ, "META260717C00690000");
});

test("options: puts and explicit years", () => {
  assert.equal(parseSignal("TSLA 300P 8/21 4.2", NOW).type, "P");
  assert.equal(parseSignal("TSLA 300P 8/21/27 4.2", NOW).expiry, "2027-08-21");
  assert.equal(parseSignal("SPY 500 PUT 12/19 3.15", NOW).type, "P");
});

test("options: expiry already past this year rolls to next year", () => {
  // 1/5 is behind NOW (Jul 2026) -> should resolve to 2027
  assert.equal(parseSignal("AAPL 200C 1/5 1.5", NOW).expiry, "2027-01-05");
});

test("options: fractional strike encodes correctly in OCC", () => {
  assert.equal(toOccSymbol({ ticker: "F", expiry: "2026-07-17", type: "C", strike: 12.5 }), "F260717C00012500");
});

/* ---------- refusals: must NOT produce an order ---------- */

test("refuses chatter and non-signals", () => {
  for (const junk of ["Hi", "Hey guys", "gm", "", "   ", "Everyone welcome Dashboard Reader!"]) {
    assert.equal(parseSignal(junk, NOW), null, `should refuse: ${JSON.stringify(junk)}`);
  }
});

test("detached type: strike/premium recovered by magnitude regardless of order", () => {
  // Ambiguous ordering — 420 must be read as the strike, 2.5 as the premium,
  // since a $2.50 strike with a $420 premium is not a real contract.
  const s = parseSignal("AAPL 7/17 C 2.5 420", NOW);
  assert.equal(s.strike, 420);
  assert.equal(s.premium, 2.5);
  assert.ok(s.warnings.some(w => /inferred by magnitude/i.test(w)),
    "must warn that the assignment was inferred");
});

test("refuses implausible premium >= attached strike", () => {
  // Strike is explicit (2.5C), so no inference is possible and 420 cannot be a premium.
  assert.equal(parseSignal("AAPL 2.5C 7/17 420", NOW), null);
});

test("refuses options shorthand missing a required field", () => {
  assert.equal(parseSignal("AAPL 420C", NOW), null, "no expiry/premium");
  assert.equal(parseSignal("AAPL 7/17 2.5", NOW), null, "no strike/type");
  assert.equal(parseSignal("420C 7/17 2.5", NOW), null, "no ticker");
});

test("refuses prose that merely mentions a ticker", () => {
  assert.equal(parseSignal("I think $AAPL looks strong here", NOW), null);
  assert.equal(parseSignal("Watching $NVDA near resistance for a breakout", NOW), null);
});

/* ---------- verbose stock alerts ---------- */

test("stock: full long alert parses with correct R:R", () => {
  const s = parseSignal(`📈 Trade Alert

Ticker: $AAPL
Direction: Long
Entry: $225-$227
Target 1: $230
Target 2: $234
Stop Loss: $222`, NOW);
  assert.equal(s.kind, "stock");
  assert.equal(s.ticker, "AAPL");
  assert.equal(s.side, "buy");
  assert.equal(s.t1, 230);
  assert.equal(s.stop, 222);
  // entry 225, target 230 (+5), stop 222 (-3) -> 5/3 = 1.67
  assert.equal(s.rr, "1.67");
  assert.deepEqual(s.warnings, []);
});

test("stock: short setup detected as sell", () => {
  const s = parseSignal(`🔻 Short Trade Setup
Symbol: $TSLA
Entry: Below $310 after confirmation
Stop Loss: $318
Target 1: $300
Target 2: $292`, NOW);
  assert.equal(s.side, "sell");
  assert.equal(s.ticker, "TSLA");
  assert.equal(s.stop, 318);
  assert.deepEqual(s.warnings, [], "a short with stop above entry is correct — no warning expected");
});

test("stock: bullish bias maps to buy", () => {
  const s = parseSignal(`📊 Trade Setup
Symbol: $AMD
Bias: Bullish
Entry Zone: $165-$167
Stop Loss: $161
Target 1: $172`, NOW);
  assert.equal(s.side, "buy");
  assert.equal(s.ticker, "AMD");
});

/* ---------- safety warnings ---------- */

test("warns when a LONG has its stop above entry", () => {
  const s = parseSignal(`Ticker: $AAPL
Direction: Long
Entry: $220
Stop Loss: $230
Target 1: $240`, NOW);
  assert.ok(s.warnings.some(w => /stop loss is at or above entry/i.test(w)),
    "must flag an inverted stop on a long");
});

test("warns when direction is missing", () => {
  const s = parseSignal(`Ticker: $AAPL
Entry: $220
Stop Loss: $210`, NOW);
  assert.equal(s.side, null);
  assert.ok(s.warnings.some(w => /direction not stated/i.test(w)));
});

test("warns that a bare M/D expiry had its year assumed", () => {
  const s = parseSignal("AAPL 420C 7/17 2.5", NOW);
  assert.ok(s.warnings.some(w => /year not stated/i.test(w)));
});
