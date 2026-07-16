// POST /api/alpaca/place
//   body: { message_id, channel_id, qty, confirm }
//
//   confirm: false|absent -> returns a PREVIEW only, places nothing
//   confirm: true         -> places the order
//
// SECURITY: the client never supplies order details — only which Discord message
// to trade and how many. The server re-fetches that message, re-parses it, and
// builds the order itself, so a tampered client cannot inject an arbitrary trade.
// Preview and placement share one code path, so what is approved is what is sent.

import { requireAuth } from "../../lib/auth.js";
import { parseSignal } from "../../lib/parse.js";
import { alpaca, buildOrder, estimateCost, describeOrder, isPaper, MAX_QTY } from "../../lib/alpaca.js";

const DISCORD_API = "https://discord.com/api/v10";

async function fetchDiscordMessage(channelId, messageId, token) {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`Could not read that Discord message (${res.status}).`);
  return res.json();
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { message_id, channel_id, qty, confirm } = body || {};

  // Only channels this dashboard is configured for may be traded.
  const allowed = (process.env.CHANNEL_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(String(channel_id))) {
    res.status(400).json({ error: "Unknown channel." });
    return;
  }
  if (!/^\d{5,25}$/.test(String(message_id || ""))) {
    res.status(400).json({ error: "Invalid message id." });
    return;
  }

  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) {
    res.status(400).json({ error: `Quantity must be a whole number between 1 and ${MAX_QTY}.` });
    return;
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server missing DISCORD_TOKEN." });
    return;
  }

  try {
    // Re-derive the signal from the source of truth rather than trusting the client.
    const msg = await fetchDiscordMessage(channel_id, message_id, token);
    const signal = parseSignal(msg.content ?? "");
    if (!signal) {
      res.status(400).json({ error: "That message does not parse as a tradable signal." });
      return;
    }

    // Discord message id doubles as the idempotency key: Alpaca rejects a repeated
    // client_order_id, so the same signal cannot be placed twice.
    const clientOrderId = `dash-${message_id}`;
    const order = buildOrder(signal, n, clientOrderId);

    const preview = {
      paper: isPaper(),
      signal,
      order,
      description: describeOrder(signal, n),
      estimated_cost: estimateCost(signal, n),
      source_message: { id: msg.id, content: msg.content, author: msg.author?.username },
      warnings: signal.warnings || [],
    };

    if (!confirm) {
      res.status(200).json({ preview, placed: null });
      return;
    }

    const placed = await alpaca("/v2/orders", { method: "POST", body: order });
    res.status(200).json({
      preview,
      placed: {
        id: placed.id,
        client_order_id: placed.client_order_id,
        symbol: placed.symbol,
        qty: placed.qty,
        side: placed.side,
        type: placed.type,
        limit_price: placed.limit_price,
        status: placed.status,
        submitted_at: placed.submitted_at,
      },
    });
  } catch (e) {
    const blob = JSON.stringify(e.body || {});
    if (e.status === 422 && /client_order_id/i.test(blob)) {
      res.status(409).json({ error: "This signal has already been placed.", duplicate: true });
      return;
    }
    res.status(e.status && e.status < 500 ? 400 : 502).json({ error: e.message, details: e.body ?? null });
  }
}
