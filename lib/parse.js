// Signal parsing for two message formats.
//
//  1. OPTIONS SHORTHAND (order-independent), e.g.
//       "AAPL 420C 7/17 2.5"      ticker, strike+type, expiry, premium
//       "GoOG 7/17 400C 1.8"      ticker, expiry, strike+type, premium
//       "META 7/17 C 690 1.1"     ticker, expiry, type, strike, premium
//
//  2. VERBOSE STOCK ALERT, e.g.
//       "📈 Trade Alert / Ticker: $AAPL / Direction: Long / Entry: $225-227
//        Target 1: $230 / Stop Loss: $222"
//
// Parsing is best-effort on free-form chat text. Every result carries `warnings`
// and is meant to be CONFIRMED BY A HUMAN before any order is placed.

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

// Words that look like tickers but aren't — keeps "Hi", "BUY", "CALL" out of the ticker slot.
const NOT_TICKERS = new Set([
  "HI", "HEY", "OK", "BUY", "SELL", "LONG", "SHORT", "CALL", "PUT", "CALLS", "PUTS",
  "C", "P", "THE", "AND", "FOR", "AT", "IN", "TO", "ENTRY", "EXIT", "STOP", "TARGET",
  "ALERT", "TRADE", "UPDATE", "WATCH", "SETUP", "BIAS", "NOTE", "LOSS", "PROFIT",
]);

export function classify(text) {
  const t = text.toLowerCase();
  if (text.includes("📈") || t.includes("trade alert")) return "alert";
  if (text.includes("✅") || t.includes("trade update")) return "update";
  if (text.includes("⚠️") || t.includes("reminder") || t.includes("not financial advice")) return "reminder";
  return "general";
}

/* ------------------------------------------------------------------ *
 * Options shorthand
 * ------------------------------------------------------------------ */

// "7/17", "07/17", "7/17/26", "7/17/2026" -> {month, day, year?}
function matchExpiry(tok) {
  const m = tok.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const month = +m[1], day = +m[2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = m[3] ? +m[3] : null;
  if (year != null && year < 100) year += 2000;
  return { month, day, year };
}

// Resolve a bare M/D to the next occurrence at or after today.
function resolveYear({ month, day, year }, now = new Date()) {
  if (year) return year;
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, month - 1, day, 23, 59, 59);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return candidate >= today ? y : y + 1;
}

// "420C" / "420c" / "420P" -> {strike:420, type:"C"}
function matchStrikeType(tok) {
  const m = tok.match(/^(\d+(?:\.\d+)?)([CP])$/i);
  return m ? { strike: parseFloat(m[1]), type: m[2].toUpperCase() } : null;
}

// standalone "C" | "P" | "CALL" | "PUT"
function matchType(tok) {
  const t = tok.toUpperCase();
  if (t === "C" || t === "CALL" || t === "CALLS") return "C";
  if (t === "P" || t === "PUT" || t === "PUTS") return "P";
  return null;
}

function matchNumber(tok) {
  return /^\$?\d+(?:\.\d+)?$/.test(tok) ? parseFloat(tok.replace("$", "")) : null;
}

/**
 * Parse options shorthand. Token-based and order-independent, because the
 * observed messages put the same fields in three different orders.
 */
export function parseOptionsSignal(text, now = new Date()) {
  // Single-line, short messages only — avoids matching prose paragraphs.
  const line = text.trim();
  if (line.includes("\n") || line.length > 60) return null;

  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 7) return null;

  let ticker = null, expiry = null, type = null, strike = null;
  const numbers = [];
  const warnings = [];

  for (const tok of tokens) {
    const st = matchStrikeType(tok);
    if (st && strike == null) { strike = st.strike; type = st.type; continue; }

    const ex = matchExpiry(tok);
    if (ex && !expiry) { expiry = ex; continue; }

    const ty = matchType(tok);
    if (ty && !type) { type = ty; continue; }

    const n = matchNumber(tok);
    if (n != null) { numbers.push(n); continue; }

    const clean = tok.replace(/^\$/, "").toUpperCase();
    if (!ticker && /^[A-Z]{1,6}$/.test(clean) && !NOT_TICKERS.has(clean) && !MONTHS.test(clean)) {
      ticker = clean; // normalises casing, e.g. "GoOG" -> "GOOG"
      continue;
    }
    return null; // unrecognised token -> not this format
  }

  if (!ticker || !type || !expiry) return null;

  // Assign leftover bare numbers to strike/premium.
  let premium = null;
  if (strike == null) {
    if (numbers.length < 2) return null;
    // Strike is the larger value; an option's premium is always well below its strike.
    const sorted = [...numbers].sort((a, b) => b - a);
    strike = sorted[0];
    premium = sorted[1];
    warnings.push("Strike/premium inferred by magnitude — verify against the message.");
  } else {
    if (numbers.length === 0) return null;
    premium = numbers[0];
  }
  if (strike == null || premium == null) return null;
  if (premium >= strike) return null; // implausible -> refuse rather than guess

  const year = resolveYear(expiry, now);
  if (!expiry.year) warnings.push(`Year not stated — assumed ${year}.`);

  const iso = `${year}-${String(expiry.month).padStart(2, "0")}-${String(expiry.day).padStart(2, "0")}`;
  return {
    kind: "option",
    ticker,
    type,                       // "C" | "P"
    side: "buy",                // shorthand implies opening a long option position
    strike,
    premium,                    // used as the limit price
    expiry: iso,
    occ: toOccSymbol({ ticker, expiry: iso, type, strike }),
    label: `${ticker} $${strike} ${type === "C" ? "CALL" : "PUT"} exp ${iso} @ $${premium.toFixed(2)}`,
    warnings,
  };
}

/**
 * OCC option symbol: ROOT + YYMMDD + C/P + strike*1000 zero-padded to 8.
 *   AAPL, 2026-07-17, C, 420 -> "AAPL260717C00420000"
 */
export function toOccSymbol({ ticker, expiry, type, strike }) {
  const [y, m, d] = expiry.split("-");
  const date = `${y.slice(2)}${m}${d}`;
  const strikePart = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${ticker.toUpperCase()}${date}${type.toUpperCase()}${strikePart}`;
}

/* ------------------------------------------------------------------ *
 * Verbose stock alert
 * ------------------------------------------------------------------ */

export function parseStockSignal(text) {
  const field = (label) => {
    const m = text.match(new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i"));
    return m ? m[1].trim() : null;
  };
  const num = (s) => {
    if (!s) return null;
    const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  // Require explicit labels; prose that merely mentions $AAPL is not a signal.
  const tickerField = field("Ticker") || field("Symbol");
  const entryRaw = field("Entry") || field("Entry Zone");
  if (!tickerField && !entryRaw) return null;

  const ticker = ((tickerField || text).match(/\$?([A-Z]{1,6})\b/) || [])[1] || null;
  if (!ticker || NOT_TICKERS.has(ticker)) return null;

  const dirRaw = field("Direction") || field("Bias") || "";
  let side = null;
  if (/long|bull|buy/i.test(dirRaw)) side = "buy";
  else if (/short|bear|sell/i.test(dirRaw)) side = "sell";
  else if (/short trade/i.test(text)) side = "sell";
  else if (/long trade/i.test(text)) side = "buy";

  const entry = num(entryRaw);
  const t1 = num(field("Target ?1") || field("Target"));
  const t2 = num(field("Target ?2"));
  const stop = num(field("Stop Loss") || field("Stop"));
  if (entry == null && t1 == null && stop == null) return null;

  const warnings = [];
  let rr = null;
  if (entry != null && t1 != null && stop != null && entry !== stop) {
    rr = Math.abs((t1 - entry) / (entry - stop));
  }

  // Sanity checks — a wrong-side stop is the classic way to lose more than intended.
  if (side === "buy" && stop != null && entry != null && stop >= entry)
    warnings.push("Stop loss is at or above entry on a LONG — check the message.");
  if (side === "sell" && stop != null && entry != null && stop <= entry)
    warnings.push("Stop loss is at or below entry on a SHORT — check the message.");
  if (side === "buy" && t1 != null && entry != null && t1 <= entry)
    warnings.push("Target is at or below entry on a LONG — check the message.");
  if (!side) warnings.push("Direction not stated — defaulting to none; confirm manually.");

  return {
    kind: "stock",
    ticker,
    side,
    direction: dirRaw || null,
    entry: entryRaw,
    entryNum: entry,
    t1, t2, stop,
    rr: rr != null ? rr.toFixed(2) : null,
    label: `${ticker} ${side ? side.toUpperCase() : "?"} entry ${entryRaw ?? "?"}`,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function parseSignal(text, now = new Date()) {
  if (!text || !text.trim()) return null;
  return parseOptionsSignal(text, now) || parseStockSignal(text);
}
