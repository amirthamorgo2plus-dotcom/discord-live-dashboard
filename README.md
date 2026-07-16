# Discord Live Dashboard

A live, auto-refreshing dashboard for a Discord channel's messages, with server-side
trade-signal parsing (ticker / direction / entry / targets / stop / risk:reward).

- `index.html` — the browser dashboard (polls `/api/messages` every 20s).
- `api/messages.js` — Vercel serverless function that reads Discord using a **secret** bot token.

## Environment variables (set in Vercel, never in code)

| Name            | Value                                             |
| --------------- | ------------------------------------------------- |
| `DISCORD_TOKEN` | your Discord bot token                            |
| `CHANNEL_ID`    | channel id (or several, comma-separated)          |

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
