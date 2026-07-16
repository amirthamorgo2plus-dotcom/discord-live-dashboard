// Watched-channel settings, stored in Supabase when configured.
//
// Optional env vars:
//   SUPABASE_URL               : https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  : service role key (server-side only — bypasses RLS)
//
// Without them the dashboard falls back to the CHANNEL_ID env var, so the app
// keeps working and channel selection simply cannot be saved from the UI.
//
// The Discord bot token deliberately stays in the env secret store and is NOT
// configurable here: a database is a weaker place to keep a live credential.

const TABLE = "dashboard_settings";
const KEY = "watched_channels";

export function hasStore() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function envChannels() {
  return (process.env.CHANNEL_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function supa(path, opts = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Channels the dashboard should read. Falls back to env when unset/unavailable. */
export async function getWatchedChannels() {
  if (!hasStore()) return { channels: envChannels(), source: "env", editable: false };
  try {
    const rows = await supa(`${TABLE}?key=eq.${KEY}&select=value`);
    const value = rows?.[0]?.value;
    if (Array.isArray(value) && value.length) {
      return { channels: value.map(String), source: "db", editable: true };
    }
    // Stored but empty -> fall back so the dashboard is never blank by accident.
    return { channels: envChannels(), source: "env", editable: true };
  } catch {
    // A datastore hiccup must not take the dashboard down.
    return { channels: envChannels(), source: "env", editable: true };
  }
}

export async function setWatchedChannels(ids) {
  if (!hasStore()) {
    throw new Error("No datastore configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to save channel selections.");
  }
  const clean = [...new Set(ids.map(String))].filter((id) => /^\d{5,25}$/.test(id));
  if (!clean.length) throw new Error("Select at least one channel.");
  await supa(`${TABLE}?on_conflict=key`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: KEY, value: clean, updated_at: new Date().toISOString() }),
  });
  return clean;
}
