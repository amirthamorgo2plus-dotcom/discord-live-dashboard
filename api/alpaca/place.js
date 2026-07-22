// POST /api/alpaca/place
//   body: { message_id, channel_id, qty, confirm }   (from a Discord message)
//     or: { text, qty, confirm }                      (manually pasted signal)
//
//   confirm: false|absent -> returns a PREVIEW only, places nothing
//   confirm: true         -> places the order
//
// SECURITY: the client never supplies order details — only WHICH signal to trade
// (a Discord message reference, or pasted text) and how many. The server re-derives
// the signal and builds the order itself, so a tampered client cannot inject an
// arbitrary trade. Preview and placement share one code path.

import crypto from "node:crypto";
import { requireAuth } from "../../lib/auth.js";
import { parseSignal } from "../../lib/parse.js";
import { getWatchedChannels } from "../../lib/settings.js";
import { alpaca, buildOrder, buildCloseOrder, matchExitPositions, estimateCost, describeOrder, isPaper, MAX_QTY } from "../../lib/alpaca.js";

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
  const { message_id, channel_id, text, qty, confirm } = body || {};

  const isManual = typeof text === "string" && text.trim().length > 0;

  // qty is optional: on the first exit preview the server suggests a default
  // (held qty for a full close, half for a trim). When present it must be valid.
  let n = null;
  if (qty !== undefined && qty !== null && qty !== "") {
    n = Number(qty);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) {
      res.status(400).json({ error: `Quantity must be a whole number between 1 and ${MAX_QTY}.` });
      return;
    }
  }

  // Resolve the signal + idempotency key from whichever source was given.
  let signal, clientOrderId, sourceMsg;
  const token = process.env.DISCORD_TOKEN;

  try {
    if (isManual) {
      if (text.length > 500) { res.status(400).json({ error: "Pasted text too long." }); return; }
      signal = parseSignal(text);
      // Hash of the normalized text is the idempotency key, so pasting the same
      // signal twice is refused by Alpaca just like a repeated Discord message.
      const hash = crypto.createHash("sha1").update(text.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex").slice(0, 16);
      clientOrderId = `paste-${hash}`;
      sourceMsg = { id: null, content: text, author: "manual", manual: true };
    } else {
      const { channels: allowed } = await getWatchedChannels();
      if (!allowed.includes(String(channel_id))) { res.status(400).json({ error: "Unknown channel." }); return; }
      if (!/^\d{5,25}$/.test(String(message_id || ""))) { res.status(400).json({ error: "Invalid message id." }); return; }
      if (!token) { res.status(500).json({ error: "Server missing DISCORD_TOKEN." }); return; }
      const msg = await fetchDiscordMessage(channel_id, message_id, token);
      signal = parseSignal(msg.content ?? "");
      clientOrderId = `dash-${message_id}`;
      sourceMsg = { id: msg.id, content: msg.content, author: msg.author?.username };
    }

    if (!signal) {
      res.status(400).json({ error: "That message does not parse as a tradable signal." });
      return;
    }

    let order, description, estimated_cost, exitInfo = null;

    if (signal.kind === "exit") {
      // An exit names a contract to sell but no expiry, so it must be matched
      // against an actually-held position before an order can exist.
      const positions = await alpaca("/v2/positions").catch(() => []);
      const matches = matchExitPositions(signal, positions);
      if (!matches.length) {
        res.status(400).json({ error: `No open position matches this exit (${signal.ticker} $${signal.strike} ${signal.type}).` });
        return;
      }
      if (matches.length > 1) {
        res.status(409).json({
          error: `Multiple held contracts match ${signal.ticker} $${signal.strike} ${signal.type} (different expiries). Close manually.`,
          matches: matches.map((p) => ({ symbol: p.symbol, qty: p.qty })),
        });
        return;
      }
      const pos = matches[0];
      const held = Math.abs(parseInt(pos.qty, 10));
      // Default: full close sells everything; a trim suggests half (the message
      // gives a % gain, not a size), and the user adjusts in the modal.
      const suggested = signal.action === "close" ? held : Math.max(1, Math.floor(held / 2));
      const closeQty = Math.min(n ?? suggested, held);
      order = buildCloseOrder(pos, closeQty, clientOrderId);
      description = `SELL ${order.qty} × ${pos.symbol} to close (held ${held})${signal.action === "trim" ? " — TRIM: adjust the quantity" : ""}`;
      estimated_cost = null;
      exitInfo = { held, suggested, action: signal.action };
    } else {
      const qtyToUse = n ?? 1;
      order = buildOrder(signal, qtyToUse, clientOrderId);
      description = describeOrder(signal, qtyToUse);
      estimated_cost = estimateCost(signal, qtyToUse);
    }

    const preview = {
      paper: isPaper(),
      signal,
      order,
      description,
      estimated_cost,
      exit: exitInfo,
      source_message: sourceMsg,
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
