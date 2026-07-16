// GET /api/alpaca/account -> account summary + open positions
// Read-only. Confirms the Alpaca link works before any order is placed.

import { requireAuth } from "../../lib/auth.js";
import { alpaca, isPaper } from "../../lib/alpaca.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  try {
    const [account, positions] = await Promise.all([
      alpaca("/v2/account"),
      alpaca("/v2/positions").catch(() => []),
    ]);

    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      paper: isPaper(),
      account: {
        status: account.status,
        currency: account.currency,
        equity: account.equity,
        cash: account.cash,
        buying_power: account.buying_power,
        options_approved_level: account.options_approved_level ?? null,
        options_trading_level: account.options_trading_level ?? null,
        trading_blocked: account.trading_blocked,
        account_blocked: account.account_blocked,
      },
      positions: (positions || []).map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        side: p.side,
        avg_entry_price: p.avg_entry_price,
        current_price: p.current_price,
        unrealized_pl: p.unrealized_pl,
        market_value: p.market_value,
      })),
    });
  } catch (e) {
    res.status(e.status === 401 || e.status === 403 ? 401 : 502).json({
      error: e.message,
      hint: "Check ALPACA_KEY_ID / ALPACA_SECRET_KEY, and that the keys match the paper/live mode set by ALPACA_PAPER.",
    });
  }
}
