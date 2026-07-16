# Discord Live Dashboard

A live, auto-refreshing dashboard for a Discord channel's messages, with server-side
trade-signal parsing (ticker / direction / entry / targets / stop / risk:reward).

- `index.html` — the browser dashboard (polls `/api/messages` every 20s).
- `api/messages.js` — Vercel serverless function that reads Discord using a **secret** bot token.

## Environment variables (set in Vercel, never in code)

| Name                | Required | Value                                                        |
| ------------------- | -------- | ------------------------------------------------------------ |
| `DISCORD_TOKEN`     | yes      | Discord bot token                                            |
| `CHANNEL_ID`        | yes      | channel id (or several, comma-separated)                     |
| `DASHBOARD_PASSCODE`| yes      | shared passcode required to open the dashboard               |
| `SESSION_SECRET`    | rec.     | random string used to sign session cookies                   |
| `ALPACA_KEY_ID`     | trading  | Alpaca API key id                                            |
| `ALPACA_SECRET_KEY` | trading  | Alpaca API secret key                                        |
| `ALPACA_PAPER`      | no       | defaults to paper. Only the literal `false` reaches live money |

## Trading

Signals are parsed from Discord (`lib/parse.js`) and can be placed on Alpaca
after **explicit human approval** in the UI. There is no auto-execution.

**How an order is placed safely**

- The browser sends only `{message_id, channel_id, qty}` — never an order.
  The server re-fetches that Discord message, re-parses it, and builds the
  order itself, so a tampered client cannot inject a trade.
- Preview and placement share one code path: what you approve is what is sent.
- `client_order_id` is the Discord message id, so Alpaca itself rejects a
  duplicate — the same signal cannot be placed twice.
- Quantity is capped (`MAX_QTY` in `lib/alpaca.js`).
- Paper is the default; live money requires deliberately setting `ALPACA_PAPER=false`.

**Order mapping**

| Signal | Alpaca order |
| ------ | ------------ |
| Options shorthand (`AAPL 420C 7/17 2.5`) | limit buy on the OCC contract at the quoted premium |
| Stock alert with target + stop | bracket order (entry limit + take-profit + stop-loss) |
| Stock alert without direction | refused — never guessed |

## Tests

```bash
node --test test/          # parser + order construction
```

## Deploy to Vercel (free Hobby tier)

### Option A — Vercel CLI (fastest)
```bash
npm i -g vercel
cd discord-live-dashboard
vercel                       # first run: log in + link project (accept defaults)
vercel env add DISCORD_TOKEN # paste token when prompted (choose all environments)
vercel env add CHANNEL_ID    # e.g. 1526644506068258981
vercel --prod                # deploy to your live URL
```

### Option B — GitHub + Vercel dashboard
1. Push this folder to a GitHub repo.
2. vercel.com → **Add New… → Project** → import the repo.
3. **Settings → Environment Variables** → add `DISCORD_TOKEN` and `CHANNEL_ID`.
4. **Deploy** (and redeploy after adding env vars so they take effect).

## Local testing
```bash
vercel dev   # runs the function + static page locally at http://localhost:3000
```

## Notes
- The bot must be in the server and have **View Channel** + **Read Message History**.
- The live view fetches the latest 100 messages per channel (fast, low rate-limit risk).
- Signal parsing is best-effort text matching — **not financial advice.**
