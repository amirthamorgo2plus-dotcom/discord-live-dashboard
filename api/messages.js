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
import { classify, parseSignal } from "../lib/parse.js";
import { getWatchedChannels } from "../lib/settings.js";

const API = "https://discord.com/api/v10";

// Small in-memory cache so rapid page polls don't hammer Discord's rate limit.
let cache = { t: 0, key: null, data: null };
const TTL_MS = 10_000;

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
  const { channels: channelIds, source } = await getWatchedChannels();

  if (!token || !channelIds.length) {
    res.status(500).json({ error: "No channels configured. Set CHANNEL_ID, or pick channels in Settings." });
    return;
  }

  // Cache key includes the channel set so changing the selection takes effect at once.
  const key = channelIds.join(",");
  if (cache.data && cache.key === key && Date.now() - cache.t < TTL_MS) {
    res.setHeader("x-cache", "HIT");
    res.status(200).json(cache.data);
    return;
  }

  try {
    let msgs = [];
    for (const c of channelIds) msgs = msgs.concat(await fetchRecent(c, token));
    msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const enriched = msgs.map((m) => ({ ...m, type: classify(m.content), trade: parseSignal(m.content) }));
    const data = { messages: enriched, fetchedAt: new Date().toISOString(), channelSource: source };
    cache = { t: Date.now(), key, data };
    res.setHeader("cache-control", "no-store");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
