// Alpaca client + order construction.
//
// Env vars (set in Vercel, never in code):
//   ALPACA_KEY_ID      : API key id
//   ALPACA_SECRET_KEY  : API secret key
//   ALPACA_PAPER       : "true" (default) -> paper account. Must be set to the
//                        literal string "false" to reach the live money API.
//
// Defaults to PAPER. Trading real money requires a deliberate env change.

const PAPER_URL = "https://paper-api.alpaca.markets";
const LIVE_URL = "https://api.alpaca.markets";

// Guard rails against fat-finger / runaway quantities.
export const MAX_QTY = 100;

export function isPaper() {
  return String(process.env.ALPACA_PAPER ?? "true").trim().toLowerCase() !== "false";
}

export function baseUrl() {
  return isPaper() ? PAPER_URL : LIVE_URL;
}

function keys() {
  const id = process.env.ALPACA_KEY_ID;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!id || !secret) {
    throw new Error("Server missing ALPACA_KEY_ID / ALPACA_SECRET_KEY environment variables.");
  }
  return { id, secret };
}

export async function alpaca(path, { method = "GET", body } = {}) {
  const { id, secret } = keys();
  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      "APCA-API-KEY-ID": id,
      "APCA-API-SECRET-KEY": secret,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

  if (!res.ok) {
    const err = new Error(json?.message || `Alpaca returned ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Turn a parsed signal into an Alpaca order payload.
 * Throws rather than guessing when the signal lacks what an order requires.
 */
export function buildOrder(signal, qty, clientOrderId) {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new Error(`Quantity must be a whole number between 1 and ${MAX_QTY}.`);
  }

  if (signal.kind === "option") {
    // Options shorthand carries no stop/target, so a bracket is impossible.
    // The quoted premium becomes the limit price.
    return {
      symbol: signal.occ,
      qty: String(qty),
      side: "buy",
      type: "limit",
      limit_price: String(signal.premium),
      time_in_force: "day",
      client_order_id: clientOrderId,
    };
  }

  if (signal.kind === "stock") {
    if (!signal.side) throw new Error("Signal has no stated direction — refusing to guess buy vs sell.");

    const order = {
      symbol: signal.ticker,
      qty: String(qty),
      side: signal.side,
      time_in_force: "gtc",
      client_order_id: clientOrderId,
    };

    if (signal.entryNum != null) {
      order.type = "limit";
      order.limit_price = String(signal.entryNum);
    } else {
      order.type = "market";
    }

    // Attach target + stop as a bracket when the signal supplies both.
    if (signal.t1 != null && signal.stop != null) {
      order.order_class = "bracket";
      order.take_profit = { limit_price: String(signal.t1) };
      order.stop_loss = { stop_price: String(signal.stop) };
    }
    return order;
  }

  throw new Error(`Unsupported signal kind: ${signal.kind}`);
}

/** Parse an OCC option symbol back into its parts (inverse of toOccSymbol in parse.js). */
export function parseOcc(symbol) {
  const m = String(symbol).match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    ticker: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5],
    strike: parseInt(m[6], 10) / 1000,
  };
}

/** Find open option positions matching an exit signal by ticker/strike/type (expiry-agnostic). */
export function matchExitPositions(signal, positions) {
  return (positions || []).filter((p) => {
    const occ = parseOcc(p.symbol);
    return occ && occ.ticker === signal.ticker && occ.type === signal.type && Number(occ.strike) === Number(signal.strike);
  });
}

/** Build a sell-to-close order for a held option/stock position. */
export function buildCloseOrder(position, qty, clientOrderId) {
  const held = Math.abs(parseInt(position.qty, 10));
  if (!Number.isInteger(qty) || qty < 1 || qty > held) {
    throw new Error(`Quantity to close must be a whole number between 1 and ${held} (held).`);
  }
  return {
    symbol: position.symbol,
    qty: String(qty),
    side: "sell",
    type: "market",          // closing an option: fill reliably, no price in the exit signal
    time_in_force: "day",
    client_order_id: clientOrderId,
  };
}

/** Rough cash outlay. Options are priced per share but sold in 100-share contracts. */
export function estimateCost(signal, qty) {
  if (signal.kind === "option") return signal.premium * 100 * qty;
  if (signal.kind === "stock" && signal.entryNum != null) return signal.entryNum * qty;
  return null;
}

/** Plain-English description of what will be sent, for the confirmation step. */
export function describeOrder(signal, qty) {
  if (signal.kind === "option") {
    const kind = signal.type === "C" ? "CALL" : "PUT";
    return `BUY ${qty} × ${signal.ticker} $${signal.strike} ${kind} expiring ${signal.expiry} — limit $${signal.premium.toFixed(2)} per contract`;
  }
  const bracket = signal.t1 != null && signal.stop != null
    ? `, take-profit $${signal.t1}, stop-loss $${signal.stop}`
    : "";
  const price = signal.entryNum != null ? `limit $${signal.entryNum}` : "market price";
  return `${signal.side.toUpperCase()} ${qty} × ${signal.ticker} at ${price}${bracket}`;
}
