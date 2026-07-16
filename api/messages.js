// Vercel serverless function: GET /api/messages
// Fetches recent messages from Discord using a SECRET bot token (env var),
// enriches them with trade-signal parsing, and returns JSON to the browser.
//
// Required environment variables (set these in the Vercel dashboard, NOT in code):
//   DISCORD_TOKEN  = your bot token
//   CHANNEL_ID     = one channel id, or several comma-separated
//
// Requires a valid session cookie — see lib/auth.js.

import { requireAuth } from "../lib/auth.js";

const API = "https://discord.com/api/v10";

// Small in-memory cache so rapid page polls don't hammer Discord's rate limit.
let cache = { t: 0, data: null };
const TTL_MS = 10_000;

function classify(text) {
  const t = text.toLowerCase();
  if (text.includes("📈") || t.includes("trade alert")) return "alert";
  if (text.includes("✅") || t.includes("trade update")) return "update";
  if (text.includes("⚠️") || t.includes("reminder") || t.includes("not financial advice")) return "reminder";
  return "general";
}

function parseTrade(text) {
  const field = (label) => {
    const m = text.match(new RegExp(label + "\\s*:?\\s*([^\\n]+)", "i"));
    return m ? m[1].trim() : null;
  };
  const num = (s) => {
    if (!s) return null;
    const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const ticker = (text.match(/\$([A-Z]{1,6})\b/) || [])[1] || null;
  if (!ticker && !/ticker\s*:/i.test(text)) return null;
  const entry = num(field("Entry"));
  const t1 = num(field("Target ?1"));
  const stop = num(field("Stop Loss"));
  let rr = null;
  if (entry != null && t1 != null && stop != null && entry !== stop) {
    rr = Math.abs((t1 - entry) / (entry - stop));
  }
  return {
    ticker,
    direction: field("Direction"),
    entry: field("Entry"),
    t1: field("Target ?1"),
    t2: field("Target ?2"),
    stop: field("Stop Loss"),
    rr: rr != null ? rr.toFixed(2) : null,
  };
}

async function dfetch(endpoint, token) {
  const res = await fetch(`${API}${endpoint}`, { headers: { Authorization: `Bot ${token}` } });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    await new Promise((r) => setTimeout(r, (body.retry_after ?? 1) * 1000 + 100));
    return dfetch(endpoint, token);
  }
  if (!res.ok) throw new Error(`Discord ${res.status} on ${endpoint}: ${await res.text()}`);
  return res.json();
}

async function fetchRecent(channelId, token) {
  // Latest 100 messages (one request) — fast, low rate-limit risk for a live view.
  let name = channelId;
  try { name = (await dfetch(`/channels/${channelId}`, token)).name ?? channelId; } catch {}
  const batch = await dfetch(`/channels/${channelId}/messages?limit=100`, token);
  return batch.map((m) => ({
    id: m.id,
    channel_id: channelId,
    channel_name: name,
    author: m.author?.global_name || m.author?.username || "unknown",
    is_bot: !!m.author?.bot,
    content: m.content ?? "",
    timestamp: m.timestamp,
    attachments: (m.attachments || []).map((a) => ({ name: a.filename, url: a.url })),
    reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji?.name, count: r.count })),
  }));
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  const token = process.env.DISCORD_TOKEN;
  const channelIds = (process.env.CHANNEL_ID || "").split(",").map((s) => s.trim()).filter(Boolean);

  if (!token || !channelIds.length) {
    res.status(500).json({ error: "Server missing DISCORD_TOKEN and/or CHANNEL_ID environment variables." });
    return;
  }

  if (cache.data && Date.now() - cache.t < TTL_MS) {
    res.setHeader("x-cache", "HIT");
    res.status(200).json(cache.data);
    return;
  }

  try {
    let msgs = [];
    for (const c of channelIds) msgs = msgs.concat(await fetchRecent(c, token));
    msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const enriched = msgs.map((m) => ({ ...m, type: classify(m.content), trade: parseTrade(m.content) }));
    const data = { messages: enriched, fetchedAt: new Date().toISOString() };
    cache = { t: Date.now(), data };
    res.setHeader("cache-control", "no-store");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
