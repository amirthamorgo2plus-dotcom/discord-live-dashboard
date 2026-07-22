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

**Signal formats parsed** (`lib/parse.js`)

| Format | Example | Result |
| ------ | ------- | ------ |
| Options shorthand | `AAPL 420C 7/17 2.5` | limit buy on the OCC contract at the premium |
| Options keyworded (The Option Haven) | `NVDA 215C AVG .64 EXP 7/15 - use 209.6 as stops` | same, + underlying stop noted |
| Options labeled (Market Bishop) | `Option: CEL 18 P 7/11` / `Entry: 0.59` | same |
| Exit | `NVDA 215c TRIMMED AT 44%`, `AAPL 315C ALL OUT AT 226%` | sell-to-close a matching held position |
| Stock alert w/ target + stop | verbose | bracket order (entry + take-profit + stop-loss) |
| Stock alert without direction | — | refused, never guessed |

**Manual paste** — for alerts from servers the bot can't read: paste the text,
it parses/previews/places through the same safe path. Idempotency key is a hash
of the pasted text, so pasting the same signal twice is refused by Alpaca.

**Exits** name a contract but no expiry, so they are matched against your actual
open positions by ticker/strike/type. A full close sells everything; a trim
suggests half and you adjust. Multiple matching expiries → close manually.

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
