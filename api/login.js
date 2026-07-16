// POST /api/login  { passcode }  -> sets signed session cookie
import { checkPasscode, createSessionCookie } from "../lib/auth.js";

// Best-effort in-memory throttle. Serverless instances are ephemeral, so this
// slows casual guessing rather than guaranteeing a global limit.
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

function tooMany(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILS;
}

function recordFail(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!process.env.DASHBOARD_PASSCODE) {
    res.status(500).json({ error: "Server missing DASHBOARD_PASSCODE environment variable." });
    return;
  }

  const ip = clientIp(req);
  if (tooMany(ip)) {
    res.status(429).json({ error: "Too many attempts. Wait 10 minutes and try again." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  // Constant-ish delay on every attempt to blunt timing/brute-force probing.
  await new Promise((r) => setTimeout(r, 400));

  if (!checkPasscode(body?.passcode)) {
    recordFail(ip);
    res.status(401).json({ error: "Incorrect passcode." });
    return;
  }

  attempts.delete(ip);
  res.setHeader("Set-Cookie", createSessionCookie(req));
  res.status(200).json({ ok: true });
}
