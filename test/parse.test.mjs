// Parser tests: node --test test/parse.test.mjs
// The parser decides what gets sent to a broker, so both what it MUST parse
// and what it MUST REFUSE to parse are covered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSignal, parseOptionsSignal, parseStockSignal, parseExitSignal, parseLabeledOptionSignal, toOccSymbol } from "../lib/parse.js";

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

/* ---------- The Option Haven: keyworded options ---------- */

test("TOH: AVG premium + EXP date + underlying stop", () => {
  const s = parseSignal("NVDA 215C AVG .64 EXP 7/15 - use 209.6 as stops", NOW);
  assert.equal(s.kind, "option");
  assert.equal(s.ticker, "NVDA");
  assert.equal(s.strike, 215);
  assert.equal(s.type, "C");
  assert.equal(s.premium, 0.64, "AVG value is the premium");
  // 7/15 is before NOW (7/16) -> rolls to next year (never an expired contract).
  assert.equal(s.expiry, "2027-07-15");
  assert.equal(s.underlyingStop, 209.6);
  assert.equal(s.occ, "NVDA270715C00215000");
});

test("TOH: trailing STOPS number", () => {
  const s = parseSignal("DELL 410C AVG 8.45 EXP 7/17 STOPS 399", NOW);
  assert.equal(s.ticker, "DELL");
  assert.equal(s.strike, 410);
  assert.equal(s.premium, 8.45);
  assert.equal(s.underlyingStop, 399);
  assert.equal(s.occ, "DELL260717C00410000");
});

test("TOH: EXP before AVG (order-independent)", () => {
  const s = parseSignal("HOOD 117C EXP 7/24 AVG 2.75", NOW);
  assert.equal(s.ticker, "HOOD");
  assert.equal(s.strike, 117);
  assert.equal(s.premium, 2.75);
  assert.equal(s.expiry, "2026-07-24");
});

test("TOH: 'BE' ticker is not swallowed as a stopword", () => {
  const s = parseSignal("BE 250C AVG 33.2 EXP 7/31", NOW);
  assert.equal(s.ticker, "BE");
  assert.equal(s.strike, 250);
  assert.equal(s.premium, 33.2);
});

test("TOH: multi-line message parses the entry line", () => {
  const s = parseSignal("BE 250C AVG 33.2 EXP 7/31\nWill add more if it dips to 231\n\nSTOPS 225 @everyone", NOW);
  assert.equal(s.kind, "option");
  assert.equal(s.ticker, "BE");
});

/* ---------- Market Bishop: labeled options ---------- */

test("Bishop: Option/Entry labels", () => {
  const s = parseSignal("Option: CEL 18 P 7/11\nEntry: 0.59\nNotes: LIGHTRISKY", NOW);
  assert.equal(s.kind, "option");
  assert.equal(s.ticker, "CEL");
  assert.equal(s.strike, 18);
  assert.equal(s.type, "P");
  assert.equal(s.premium, 0.59);
  // 7/11 is before NOW (7/16), so it correctly rolls to next year rather than
  // resolving to an already-expired contract.
  assert.equal(s.expiry, "2027-07-11");
  assert.equal(s.occ, "CEL270711P00018000");
});

/* ---------- exit signals ---------- */

test("exit: TRIMMED AT is a partial sell-to-close", () => {
  const s = parseSignal("NVDA 215c TRIMMED AT 44%", NOW);
  assert.equal(s.kind, "exit");
  assert.equal(s.ticker, "NVDA");
  assert.equal(s.strike, 215);
  assert.equal(s.type, "C");
  assert.equal(s.action, "trim");
  assert.equal(s.side, "sell");
  assert.equal(s.pct, 44);
});

test("exit: ALL OUT is a full close", () => {
  const s = parseSignal("AAPL 315C ALL OUT AT 226%", NOW);
  assert.equal(s.action, "close");
  assert.equal(s.ticker, "AAPL");
  assert.equal(s.pct, 226);
});

test("exit: 'AL OUT' typo still recognised as full close", () => {
  assert.equal(parseSignal("AAPL 315C AL OUT AT 226%", NOW).action, "close");
});

test("exit: TRIMMED MAX", () => {
  const s = parseSignal("HOOD 117C TRIMMED MAX AT 50%", NOW);
  assert.equal(s.action, "trim");
  assert.equal(s.strike, 117);
});

test("entry with STOPS is NOT misread as an exit", () => {
  // "STOPS 399" is a stop level on an entry, not a TRIMMED/ALL-OUT exit.
  assert.equal(parseSignal("DELL 410C AVG 8.45 EXP 7/17 STOPS 399", NOW).kind, "option");
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
