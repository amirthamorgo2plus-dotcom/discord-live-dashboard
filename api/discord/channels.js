// GET  /api/discord/channels -> every text channel the bot can see, grouped by server
// POST /api/discord/channels -> save the watched selection { channels: [id, ...] }
//
// A bot can only read channels it has been invited to, so this list is exactly
// what is reachable. Selections are validated against it before being saved.

import { requireAuth } from "../../lib/auth.js";
import { getWatchedChannels, setWatchedChannels, hasStore } from "../../lib/settings.js";

const API = "https://discord.com/api/v10";
const TEXT_TYPES = new Set([0, 5]); // 0 = text, 5 = announcement

// The channel list changes rarely; cache it so opening Settings (and saving
// straight after) doesn't trip Discord's rate limit on /users/@me/guilds.
let cache = { t: 0, data: null };
const TTL_MS = 60_000;

async function dfetch(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
  if (!res.ok) {
    if (res.status === 429) throw new Error("Discord rate limit — wait a moment and try again.");
    throw new Error(`Discord ${res.status} on ${path}`);
  }
  return res.json();
}

async function listVisibleChannels(token) {
  if (cache.data && Date.now() - cache.t < TTL_MS) return cache.data;
  const guilds = await dfetch("/users/@me/guilds", token);
  const out = [];
  for (const g of guilds) {
    try {
      const channels = await dfetch(`/guilds/${g.id}/channels`, token);
      out.push({
        guild_id: g.id,
        guild_name: g.name,
        channels: channels
          .filter((c) => TEXT_TYPES.has(c.type))
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((c) => ({ id: c.id, name: c.name })),
      });
    } catch {
      // Skip guilds the bot cannot enumerate rather than failing the whole list.
    }
  }
  cache = { t: Date.now(), data: out };
  return out;
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server missing DISCORD_TOKEN." });
    return;
  }

  try {
    if (req.method === "GET") {
      const [guilds, watched] = await Promise.all([listVisibleChannels(token), getWatchedChannels()]);
      res.setHeader("cache-control", "no-store");
      res.status(200).json({
        guilds,
        selected: watched.channels,
        source: watched.source,
        canSave: hasStore(),
        note: hasStore()
          ? null
          : "Selection cannot be saved: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. Falling back to the CHANNEL_ID env var.",
      });
      return;
    }

    if (req.method === "POST") {
      // Fail fast on configuration before doing any network work.
      if (!hasStore()) {
        res.status(400).json({
          error: "No datastore configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to save channel selections.",
        });
        return;
      }

      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const wanted = Array.isArray(body?.channels) ? body.channels.map(String) : null;
      if (!wanted) {
        res.status(400).json({ error: "Expected { channels: [id, ...] }." });
        return;
      }

      // Only channels the bot can actually read may be selected.
      const guilds = await listVisibleChannels(token);
      const visible = new Set(guilds.flatMap((g) => g.channels.map((c) => c.id)));
      const invalid = wanted.filter((id) => !visible.has(id));
      if (invalid.length) {
        res.status(400).json({ error: `Not visible to the bot: ${invalid.join(", ")}` });
        return;
      }

      const saved = await setWatchedChannels(wanted);
      res.status(200).json({ ok: true, selected: saved });
      return;
    }

    res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
