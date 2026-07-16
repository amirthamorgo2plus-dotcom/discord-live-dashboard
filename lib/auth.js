// Shared auth helpers: passcode check + signed session cookie.
// Zero dependencies — uses Node's built-in crypto.
//
// Env vars:
//   DASHBOARD_PASSCODE : the shared passcode users type to get in (required)
//   SESSION_SECRET     : random string used to sign cookies (recommended; falls back to passcode)

import crypto from "node:crypto";

const COOKIE = "dash_session";
const MAX_AGE = 60 * 60 * 12; // 12 hours

function secret() {
  const s = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSCODE;
  if (!s) throw new Error("SESSION_SECRET or DASHBOARD_PASSCODE must be set");
  return s;
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

// Constant-time string compare that never leaks length via early return timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  // Hash both first so differing lengths still compare in constant time.
  const ha = crypto.createHash("sha256").update(ba).digest();
  const hb = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPasscode(input) {
  const pass = process.env.DASHBOARD_PASSCODE || "";
  if (!pass) return false;
  return safeEqual(input, pass);
}

function isLocal(req) {
  return /^(localhost|127\.0\.0\.1)/.test(req.headers?.host || "");
}

export function createSessionCookie(req) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + MAX_AGE * 1000 })).toString("base64url");
  const value = `${payload}.${sign(payload)}`;
  // Secure is omitted on localhost so the cookie works over plain http in local dev.
  return `${COOKIE}=${value}; HttpOnly; ${isLocal(req) ? "" : "Secure; "}SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
}

export function clearSessionCookie(req) {
  return `${COOKIE}=; HttpOnly; ${isLocal(req) ? "" : "Secure; "}SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function isAuthed(req) {
  try {
    const raw = parseCookies(req.headers?.cookie)[COOKIE];
    if (!raw) return false;
    const [payload, sig] = raw.split(".");
    if (!payload || !sig) return false;
    if (!safeEqual(sig, sign(payload))) return false;
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
}

// Guard for protected endpoints. Returns true if the request may proceed.
export function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}
