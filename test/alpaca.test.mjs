// Order construction tests: node --test test/alpaca.test.mjs
// These payloads are what would reach a broker, so the exact fields matter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSignal } from "../lib/parse.js";
import { buildOrder, estimateCost, describeOrder, isPaper, MAX_QTY } from "../lib/alpaca.js";

const NOW = new Date("2026-07-16T12:00:00Z");

test("defaults to the paper account", () => {
  delete process.env.ALPACA_PAPER;
  assert.equal(isPaper(), true, "must default to paper when unset");
  process.env.ALPACA_PAPER = "true";
  assert.equal(isPaper(), true);
  process.env.ALPACA_PAPER = "TRUE";
  assert.equal(isPaper(), true);
  // Only the explicit string "false" may reach live money.
  process.env.ALPACA_PAPER = "false";
  assert.equal(isPaper(), false);
  process.env.ALPACA_PAPER = "true";
});

test("option order: limit at the quoted premium", () => {
  const s = parseSignal("AAPL 420C 7/17 2.5", NOW);
  const o = buildOrder(s, 2, "dash-123");
  assert.deepEqual(o, {
    symbol: "AAPL260717C00420000",
    qty: "2",
    side: "buy",
    type: "limit",
    limit_price: "2.5",
    time_in_force: "day",
    client_order_id: "dash-123",
  });
});

test("option order has no bracket (shorthand carries no stop/target)", () => {
  const o = buildOrder(parseSignal("GoOG 7/17 400C 1.8", NOW), 1, "dash-1");
  assert.equal(o.order_class, undefined);
  assert.equal(o.stop_loss, undefined);
  assert.equal(o.take_profit, undefined);
});

test("stock order: long becomes a bracket with target and stop", () => {
  const s = parseSignal(`Ticker: $AAPL
Direction: Long
Entry: $225
Target 1: $230
Stop Loss: $222`, NOW);
  const o = buildOrder(s, 4, "dash-abc");
  assert.equal(o.symbol, "AAPL");
  assert.equal(o.side, "buy");
  assert.equal(o.order_class, "bracket");
  assert.equal(o.type, "limit");
  assert.equal(o.limit_price, "225");
  assert.deepEqual(o.take_profit, { limit_price: "230" });
  assert.deepEqual(o.stop_loss, { stop_price: "222" });
});

test("stock order: short setup places a sell", () => {
  const s = parseSignal(`🔻 Short Trade Setup
Symbol: $TSLA
Entry: Below $310 after confirmation
Stop Loss: $318
Target 1: $300`, NOW);
  const o = buildOrder(s, 1, "dash-x");
  assert.equal(o.side, "sell");
  assert.equal(o.symbol, "TSLA");
});

test("refuses to guess direction when the signal omits it", () => {
  const s = parseSignal(`Ticker: $AAPL
Entry: $220
Stop Loss: $210`, NOW);
  assert.equal(s.side, null);
  assert.throws(() => buildOrder(s, 1, "dash-y"), /no stated direction/i);
});

test("rejects invalid quantities", () => {
  const s = parseSignal("AAPL 420C 7/17 2.5", NOW);
  for (const bad of [0, -1, 1.5, NaN, MAX_QTY + 1, "2"]) {
    assert.throws(() => buildOrder(s, bad, "dash-z"), /Quantity must be/i, `should reject qty=${bad}`);
  }
});

test("option cost accounts for the 100-share contract multiplier", () => {
  const s = parseSignal("AAPL 420C 7/17 2.5", NOW);
  assert.equal(estimateCost(s, 2), 500); // $2.50 x 100 x 2
});

test("stock cost is price x quantity", () => {
  const s = parseSignal(`Ticker: $AAPL
Direction: Long
Entry: $225
Target 1: $230
Stop Loss: $222`, NOW);
  assert.equal(estimateCost(s, 4), 900);
});

test("description reads as plain English for confirmation", () => {
  const s = parseSignal("AAPL 420C 7/17 2.5", NOW);
  assert.equal(describeOrder(s, 2),
    "BUY 2 × AAPL $420 CALL expiring 2026-07-17 — limit $2.50 per contract");
});

test("client_order_id is carried through for idempotency", () => {
  const s = parseSignal("META 7/17 C 690 1.1", NOW);
  assert.equal(buildOrder(s, 1, "dash-999").client_order_id, "dash-999");
});
