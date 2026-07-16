// GET /api/alpaca/orders -> orders placed by this dashboard, plus open positions.
//
// Alpaca is the source of truth, so no local database is needed: every order this
// dashboard places carries client_order_id = "dash-<discord message id>", which
// lets each order be mapped back to the message that produced it.

import { requireAuth } from "../../lib/auth.js";
import { alpaca, isPaper } from "../../lib/alpaca.js";

const PREFIX = "dash-";

// Statuses Alpaca considers finished; anything else is still working.
const CLOSED = new Set(["filled", "canceled", "expired", "rejected", "done_for_day", "replaced"]);

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  try {
    const [orders, positions] = await Promise.all([
      alpaca("/v2/orders?status=all&limit=200&direction=desc"),
      alpaca("/v2/positions").catch(() => []),
    ]);

    const mine = (orders || []).filter((o) => (o.client_order_id || "").startsWith(PREFIX));

    // Position lookup so a filled order can show live P&L.
    const posBySymbol = new Map((positions || []).map((p) => [p.symbol, p]));

    const byMessage = {};
    for (const o of mine) {
      const messageId = o.client_order_id.slice(PREFIX.length);
      const pos = posBySymbol.get(o.symbol);
      // Orders come back newest-first; keep the first seen per message.
      if (byMessage[messageId]) continue;
      byMessage[messageId] = {
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        filled_qty: o.filled_qty,
        filled_avg_price: o.filled_avg_price,
        limit_price: o.limit_price,
        type: o.type,
        status: o.status,
        open: !CLOSED.has(o.status),
        submitted_at: o.submitted_at,
        filled_at: o.filled_at,
        position: pos
          ? {
              qty: pos.qty,
              avg_entry_price: pos.avg_entry_price,
              current_price: pos.current_price,
              market_value: pos.market_value,
              unrealized_pl: pos.unrealized_pl,
              unrealized_plpc: pos.unrealized_plpc,
            }
          : null,
      };
    }

    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      paper: isPaper(),
      byMessage,
      count: mine.length,
      positions: (positions || []).map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        side: p.side,
        avg_entry_price: p.avg_entry_price,
        current_price: p.current_price,
        market_value: p.market_value,
        unrealized_pl: p.unrealized_pl,
        unrealized_plpc: p.unrealized_plpc,
      })),
    });
  } catch (e) {
    res.status(e.status === 401 || e.status === 403 ? 401 : 502).json({ error: e.message });
  }
}
