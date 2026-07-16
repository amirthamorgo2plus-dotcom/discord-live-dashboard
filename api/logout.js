// POST /api/logout -> clears the session cookie
import { clearSessionCookie } from "../lib/auth.js";

export default function handler(req, res) {
  res.setHeader("Set-Cookie", clearSessionCookie(req));
  res.status(200).json({ ok: true });
}
