// Settings/storage tests: node --test test/settings.test.mjs
// Runs against a mock Supabase REST endpoint — no real project needed.

import { test } from "node:test";
import assert from "node:assert/strict";

const ENV_A = "1526644506068258981";
const ENV_B = "1527355635371610162";
const DB_A = "1527355719714865263";
const DB_B = "1526644438590423042";

process.env.CHANNEL_ID = `${ENV_A},${ENV_B}`;

const store = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes("mock-supabase")) return realFetch(url, opts);
  const json = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

  if ((opts.method || "GET") === "GET") {
    const row = store.get("watched_channels");
    return json(row ? [{ value: row }] : []);
  }
  if (opts.method === "POST") {
    const b = JSON.parse(opts.body);
    store.set(b.key, b.value);
    return json([b], 201);
  }
  return json({}, 405);
};

const { getWatchedChannels, setWatchedChannels, hasStore } = await import("../lib/settings.js");

test("falls back to CHANNEL_ID env when no store is configured", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal(hasStore(), false);
  const r = await getWatchedChannels();
  assert.deepEqual(r.channels, [ENV_A, ENV_B]);
  assert.equal(r.source, "env");
  assert.equal(r.editable, false);
});

test("refuses to save without a store", async () => {
  await assert.rejects(() => setWatchedChannels([DB_A]), /No datastore configured/i);
});

test("saves and reads back, and the stored selection wins over env", async () => {
  process.env.SUPABASE_URL = "https://mock-supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-key";
  assert.equal(hasStore(), true);

  await setWatchedChannels([DB_A, DB_B]);
  const r = await getWatchedChannels();
  assert.deepEqual(r.channels, [DB_A, DB_B]);
  assert.equal(r.source, "db");
  assert.equal(r.editable, true);
});

test("deduplicates and drops non-numeric ids", async () => {
  await setWatchedChannels([DB_A, DB_A, "not-an-id", DB_B]);
  assert.deepEqual((await getWatchedChannels()).channels, [DB_A, DB_B]);
});

test("refuses an empty or entirely invalid selection", async () => {
  await assert.rejects(() => setWatchedChannels([]), /at least one channel/i);
  await assert.rejects(() => setWatchedChannels(["bad"]), /at least one channel/i);
});

test("a store outage falls back to env instead of breaking the dashboard", async () => {
  process.env.SUPABASE_URL = "https://mock-supabase-down.co";
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  const r = await getWatchedChannels();
  assert.deepEqual(r.channels, [ENV_A, ENV_B], "must fall back to env");
  assert.equal(r.source, "env");
  globalThis.fetch = saved;
});
