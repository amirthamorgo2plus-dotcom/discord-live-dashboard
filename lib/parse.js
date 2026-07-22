// Signal parsing for several Discord trade-alert formats.
//
//  A. OPTIONS SHORTHAND (Stryker), order-independent:
//       "AAPL 420C 7/17 2.5"      ticker, strike+type, expiry, premium
//       "GoOG 7/17 400C 1.8"      ticker, expiry, strike+type, premium
//
//  B. OPTIONS KEYWORDED (The Option Haven):
//       "NVDA 215C AVG .64 EXP 7/15 - use 209.6 as stops"
//       "DELL 410C AVG 8.45 EXP 7/17 STOPS 399"
//
//  C. OPTIONS LABELED (Market Bishop):
//       "Option: CEL 18 P 7/11 / Entry: 0.59 / Notes: LIGHTRISKY"
//
//  D. EXIT signals (The Option Haven):
//       "NVDA 215c TRIMMED AT 44%"     partial exit
//       "AAPL 315C ALL OUT AT 226%"    full exit
//
//  E. VERBOSE STOCK ALERT:
//       "Ticker: $AAPL / Direction: Long / Entry: $225-227 / Target 1: $230 / Stop Loss: $222"
//
// Parsing is best-effort on free-form chat text. Every result carries `warnings`
// and is meant to be CONFIRMED BY A HUMAN before any order is placed.

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

const NOT_TICKERS = new Set([
  "HI", "HEY", "OK", "BUY", "SELL", "LONG", "SHORT", "CALL", "PUT", "CALLS", "PUTS",
  "C", "P", "THE", "AND", "FOR", "AT", "IN", "TO", "ENTRY", "EXIT", "STOP", "STOPS",
  "TARGET", "ALERT", "TRADE", "UPDATE", "WATCH", "SETUP", "BIAS", "NOTE", "NOTES",
  "LOSS", "PROFIT", "AVG", "AVERAGE", "EXP", "EXPIRY", "USE", "AS", "OUT", "ALL",
  "MAX", "TRIMMED", "TRIM", "ADD", "WILL", "MORE", "IF", "IT", "DIPS", "BE",
]);
// "BE" is a real ticker but also the word — handled specially in keyworded parsing.

// Strip Discord noise: mentions, custom emoji, markdown emphasis.
function clean(text) {
  return String(text || "")
    .replace(/<@[!&]?\d+>/g, " ")
    .replace(/<a?:\w+:\d+>/g, " ")
    .replace(/@everyone|@here/gi, " ")
    .replace(/[*_`~]/g, " ")
    .replace(/\(edited\)/gi, " ");
}

export function classify(text) {
  const t = text.toLowerCase();
  if (/\btrimmed\b|\ball out\b|\bal out\b|\bout at\b/i.test(text)) return "exit";
  if (text.includes("📈") || t.includes("trade alert")) return "alert";
  if (text.includes("✅") || t.includes("trade update")) return "update";
  if (text.includes("⚠️") || t.includes("reminder") || t.includes("not financial advice")) return "reminder";
  return "general";
}

/* ------------------------------------------------------------------ *
 * Shared token matchers
 * ------------------------------------------------------------------ */

function matchExpiry(tok) {
  const m = tok.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const month = +m[1], day = +m[2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = m[3] ? +m[3] : null;
  if (year != null && year < 100) year += 2000;
  return { month, day, year };
}

function resolveYear({ month, day, year }, now = new Date()) {
  if (year) return year;
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, month - 1, day, 23, 59, 59);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return candidate >= today ? y : y + 1;
}

function isoExpiry(exp, now) {
  const year = resolveYear(exp, now);
  return {
    iso: `${year}-${String(exp.month).padStart(2, "0")}-${String(exp.day).padStart(2, "0")}`,
    assumedYear: !exp.year ? year : null,
  };
}

function matchStrikeType(tok) {
  const m = tok.match(/^(\d+(?:\.\d+)?)([CP])$/i);
  return m ? { strike: parseFloat(m[1]), type: m[2].toUpperCase() } : null;
}

function matchType(tok) {
  const t = tok.toUpperCase();
  if (t === "C" || t === "CALL" || t === "CALLS") return "C";
  if (t === "P" || t === "PUT" || t === "PUTS") return "P";
  return null;
}

function matchNumber(tok) {
  // Accepts 2, 2.5, .64, $2.50 — leading-dot premiums (".64") are common.
  return /^\$?(?:\d+(?:\.\d+)?|\.\d+)$/.test(tok) ? parseFloat(tok.replace("$", "")) : null;
}

export function toOccSymbol({ ticker, expiry, type, strike }) {
  const [y, m, d] = expiry.split("-");
  const date = `${y.slice(2)}${m}${d}`;
  const strikePart = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${ticker.toUpperCase()}${date}${type.toUpperCase()}${strikePart}`;
}

function optionResult({ ticker, type, strike, premium, expiry, underlyingStop, warnings }, now) {
  const { iso, assumedYear } = isoExpiry(expiry, now);
  if (assumedYear) warnings.push(`Year not stated — assumed ${assumedYear}.`);
  if (underlyingStop != null) warnings.push(`Stop ${underlyingStop} is an underlying-price stop; the option order is a limit at the premium.`);
  return {
    kind: "option",
    ticker, type, side: "buy", strike, premium,
    expiry: iso,
    underlyingStop: underlyingStop ?? null,
    occ: toOccSymbol({ ticker, expiry: iso, type, strike }),
    label: `${ticker} $${strike} ${type === "C" ? "CALL" : "PUT"} exp ${iso} @ $${premium.toFixed(2)}`,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * A + B: options shorthand / keyworded (single line)
 * ------------------------------------------------------------------ */

function parseOptionsLine(rawLine, now) {
  let line = clean(rawLine).trim();
  if (!line || line.length > 90) return null;

  const warnings = [];
  let underlyingStop = null;

  // Extract an underlying-price stop first, then remove the phrase so its number
  // does not get mistaken for a strike/premium. Handles "STOPS 399",
  // "209.6 as stops", and "use 209.6 as stop".
  const stopPatterns = [
    /\bstops?\s+(\d+(?:\.\d+)?)/i,
    /\b(\d+(?:\.\d+)?)\s+as\s+stops?\b/i,
    /\buse\s+(\d+(?:\.\d+)?)\s+as\s+stops?\b/i,
  ];
  for (const re of stopPatterns) {
    const m = line.match(re);
    if (m) { underlyingStop = parseFloat(m[1]); line = line.replace(m[0], " "); break; }
  }

  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 14) return null;

  const upper = tokens.map((t) => t.toUpperCase());
  const consumed = new Array(tokens.length).fill(false);

  let premium = null, expiry = null, keyworded = underlyingStop != null;

  // Keyword pass: AVG <num>, EXP <date>.
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const w = upper[i];
    if ((w === "AVG" || w === "AVERAGE") && premium == null) {
      const n = matchNumber(tokens[i + 1] || "");
      if (n != null) { premium = n; consumed[i] = consumed[i + 1] = true; keyworded = true; }
    } else if ((w === "EXP" || w === "EXPIRY" || w === "EXPIRES" || w === "EXPIRATION") && !expiry) {
      const ex = matchExpiry(tokens[i + 1] || "");
      if (ex) { expiry = ex; consumed[i] = consumed[i + 1] = true; keyworded = true; }
    }
  }

  let ticker = null, type = null, strike = null;
  const numbers = [];

  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const tok = tokens[i];

    const st = matchStrikeType(tok);
    if (st && strike == null) { strike = st.strike; type = st.type; continue; }

    const ex = matchExpiry(tok);
    if (ex && !expiry) { expiry = ex; continue; }

    const ty = matchType(tok);
    if (ty && !type) { type = ty; continue; }

    const n = matchNumber(tok);
    if (n != null) { numbers.push(n); continue; }

    const c = tok.replace(/^\$/, "").toUpperCase();
    const tickerOk = /^[A-Z]{1,6}$/.test(c) && (!NOT_TICKERS.has(c) || c === "BE") && !MONTHS.test(c);
    if (!ticker && tickerOk) { ticker = c; continue; }

    // In keyworded mode, tolerate leftover prose ("use", "as", "-", "dips");
    // in bare shorthand mode, an unknown token means this isn't a signal.
    if (!keyworded) return null;
  }

  if (!ticker || !type || !expiry) return null;

  if (premium == null) {
    if (strike == null) {
      if (numbers.length < 2) return null;
      const sorted = [...numbers].sort((a, b) => b - a);
      strike = sorted[0]; premium = sorted[1];
      warnings.push("Strike/premium inferred by magnitude — verify against the message.");
    } else {
      if (numbers.length === 0) return null;
      premium = numbers[0];
    }
  } else if (strike == null) {
    if (numbers.length === 0) return null;
    strike = numbers[0];
  }

  if (strike == null || premium == null || premium >= strike) return null;
  return optionResult({ ticker, type, strike, premium, expiry, underlyingStop, warnings }, now);
}

export function parseOptionsSignal(text, now = new Date()) {
  for (const line of clean(text).split("\n")) {
    const r = parseOptionsLine(line, now);
    if (r) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * C: labeled options (Market Bishop)
 * ------------------------------------------------------------------ */

export function parseLabeledOptionSignal(text, now = new Date()) {
  const c = clean(text);
  const optM = c.match(/Option\s*:\s*([^\n]+)/i);
  if (!optM) return null;

  const toks = optM[1].trim().split(/\s+/).filter(Boolean);
  let ticker = null, type = null, strike = null, expiry = null;
  for (const tok of toks) {
    const st = matchStrikeType(tok);
    if (st && strike == null) { strike = st.strike; type = st.type; continue; }
    const ty = matchType(tok);
    if (ty && !type) { type = ty; continue; }
    const ex = matchExpiry(tok);
    if (ex && !expiry) { expiry = ex; continue; }
    const n = matchNumber(tok);
    if (n != null && strike == null) { strike = n; continue; }
    const cc = tok.replace(/^\$/, "").toUpperCase();
    if (!ticker && /^[A-Z]{1,6}$/.test(cc) && !NOT_TICKERS.has(cc)) { ticker = cc; continue; }
  }

  const entryM = c.match(/Entry\s*:\s*\$?(\d+(?:\.\d+)?)/i);
  const premium = entryM ? parseFloat(entryM[1]) : null;

  if (!ticker || !type || !strike || !expiry || premium == null) return null;
  if (premium >= strike) return null;
  return optionResult({ ticker, type, strike, premium, expiry, underlyingStop: null, warnings: [] }, now);
}

/* ------------------------------------------------------------------ *
 * D: exit signals
 * ------------------------------------------------------------------ */

export function parseExitSignal(text) {
  for (const rawLine of clean(text).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const isFull = /\ball\s*out\b|\bal\s*out\b/i.test(line);
    const isTrim = /\btrim(med)?\b/i.test(line);
    const isOutAt = /\bout\s+at\b/i.test(line);
    if (!isFull && !isTrim && !isOutAt) continue;

    // ticker + strike + type, e.g. "NVDA 215c"
    const m = line.match(/\b([A-Z]{1,6})\s+(\d+(?:\.\d+)?)\s*([CP])\b/i);
    if (!m) continue;
    const ticker = m[1].toUpperCase();
    if (NOT_TICKERS.has(ticker) && ticker !== "BE") continue;

    const pctM = line.match(/(-?\d+(?:\.\d+)?)\s*%/);
    const pct = pctM ? parseFloat(pctM[1]) : null;
    const action = isFull ? "close" : "trim"; // "out at" without "all" -> treat as trim

    const warnings = [
      "Exit signals have no expiry — the position to close is matched by ticker/strike/type.",
    ];
    if (action === "trim") warnings.push("This is a partial trim; set the quantity to close yourself.");

    return {
      kind: "exit",
      ticker,
      strike: parseFloat(m[2]),
      type: m[3].toUpperCase(),
      action,                 // "trim" | "close"
      side: "sell",           // closing a long option
      pct,
      label: `EXIT ${action === "close" ? "ALL" : "TRIM"} ${ticker} $${parseFloat(m[2])} ${m[3].toUpperCase()}${pct != null ? ` (${pct}%)` : ""}`,
      warnings,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * E: verbose stock alert
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
  if (side === "buy" && stop != null && entry != null && stop >= entry)
    warnings.push("Stop loss is at or above entry on a LONG — check the message.");
  if (side === "sell" && stop != null && entry != null && stop <= entry)
    warnings.push("Stop loss is at or below entry on a SHORT — check the message.");
  if (side === "buy" && t1 != null && entry != null && t1 <= entry)
    warnings.push("Target is at or below entry on a LONG — check the message.");
  if (!side) warnings.push("Direction not stated — defaulting to none; confirm manually.");

  return {
    kind: "stock",
    ticker, side,
    direction: dirRaw || null,
    entry: entryRaw, entryNum: entry,
    t1, t2, stop,
    rr: rr != null ? rr.toFixed(2) : null,
    label: `${ticker} ${side ? side.toUpperCase() : "?"} entry ${entryRaw ?? "?"}`,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Entry point — order matters: exits first, then labeled, shorthand, stock.
 * ------------------------------------------------------------------ */

export function parseSignal(text, now = new Date()) {
  if (!text || !text.trim()) return null;
  return (
    parseExitSignal(text) ||
    parseLabeledOptionSignal(text, now) ||
    parseOptionsSignal(text, now) ||
    parseStockSignal(text)
  );
}
