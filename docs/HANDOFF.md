# Discord Trade Dashboard — Developer Handoff

Live, auto-refreshing dashboard for Discord trade-signal channels, with
server-side signal parsing and **human-approved** Alpaca paper trading.

- **Repo:** github.com/amirthamorgo2plus-dotcom/discord-live-dashboard
- **Local:** `C:\Users\anith\Gaurav-Copy trading\discord-live-dashboard`
- **Deploy target:** Vercel (Hobby). Portable to AWS (see §11).
- **Status:** built + unit-tested (49 tests). Verified only against *mocked*
  Alpaca/Supabase. No real broker call has run yet. Live deploy unverified.

---

## 1. Purpose & scope

Read trade signals posted in Discord, parse them into structured orders, and let
a human review and place each one on Alpaca (paper). It is a **decision-support +
one-click-with-confirmation** tool, **not** an auto-trader. There is no code path
that places an order without an explicit user click.

## 2. Architecture

```
Browser (index.html, single file)
  │  polls /api/messages every 20s; calls /api/alpaca/* on demand
  ▼
Vercel serverless functions (api/*.js)  ── secrets via env vars ──►  Discord API
  │                                                                  Alpaca API
  ▼                                                                  Supabase (opt)
lib/*.js  (auth, parse, alpaca, settings)  — pure, dependency-free
```

**Security model (the important part).** The browser never sends an order. For a
trade it sends only a *reference* — `{message_id, channel_id}` (Discord) or
`{text}` (paste) — plus quantity. The server re-fetches/re-parses the signal and
builds the order itself. A tampered client that injects `symbol/qty/order` fields
is ignored (there is a test asserting this). Preview and placement share one code
path, so what the user approves is exactly what is sent.

## 3. Tech stack & rationale

- **Node ≥18 ESM, zero dependencies.** No framework, no SDKs. Reasons: no supply
  chain, trivial portability (the handlers are plain `(req,res)` — they run on
  Vercel, in a container, or under Lambda unchanged), and a ~120-line local
  emulator can host them for testing (see §10).
- **Vanilla single-file frontend** (`index.html`) — no build step.
- **Native `node:test`** for the suite. **Native `fetch`/`crypto`** only.

## 4. File reference

```
index.html                         Whole frontend: gate, feed, modals, polling
api/
  login.js         POST  passcode -> signed session cookie (+ in-mem throttle)
  logout.js        POST  clears cookie
  messages.js      GET   fetch watched channels, parse, cache 10s (keyed by set)
  alpaca/
    account.js     GET   account summary + positions (proves Alpaca link)
    place.js       POST  preview/place; source = Discord msg OR pasted text
    orders.js      GET   this dashboard's orders mapped to messages + P&L
  discord/
    channels.js    GET   list bot-visible channels + selection; POST save it
lib/
  auth.js          HMAC-signed cookie, constant-time passcode compare
  parse.js         All signal formats -> normalized signal objects (see §7)
  alpaca.js        Alpaca client, buildOrder/buildCloseOrder, OCC parse, costs
  settings.js      Watched-channel storage (Supabase optional; env fallback)
supabase/migrations/0001_dashboard_settings.sql   settings table (RLS, no policies)
test/
  parse.test.mjs     28 tests: every format + refusals + year-roll + OCC
  alpaca.test.mjs    16 tests: order construction, exits, paper default
  settings.test.mjs   6 tests: store save/read/fallback/outage (mock Supabase)
docs/HANDOFF.md    this file
README.md          user-facing setup + env vars
```

> Note: an **older static version** lives one directory up
> (`../discord-dashboard.html`, `../discord-fetch.mjs`, `../build-dashboard.mjs`).
> That is a separate, read-only snapshot generator and is **not** part of this
> repo. This app supersedes it.

## 5. API endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | `/api/login` | — | passcode → cookie |
| POST | `/api/logout` | — | clear cookie |
| GET  | `/api/messages` | ✓ | parsed messages for watched channels |
| GET  | `/api/alpaca/account` | ✓ | equity/buying power/positions |
| POST | `/api/alpaca/place` | ✓ | `{message_id,channel_id}` or `{text}`, `qty`, `confirm` |
| GET  | `/api/alpaca/orders` | ✓ | orders (client_order_id `dash-`/`paste-`) + P&L |
| GET/POST | `/api/discord/channels` | ✓ | list visible / save selection |

`place` returns `{preview, placed}`. `confirm:false` → preview only. `qty` is
optional (server suggests a default for exits). Idempotency: `client_order_id`
is `dash-<messageId>` or `paste-<sha1(normalizedText)>`; Alpaca rejects repeats
→ 409.

## 6. Environment variables

| Name | Required | Notes |
| ---- | -------- | ----- |
| `DISCORD_TOKEN` | yes | bot token (Message Content intent ON) |
| `CHANNEL_ID` | yes* | comma-separated ids; fallback if Supabase unset |
| `DASHBOARD_PASSCODE` | yes | login passcode — **without it, login 500s** |
| `SESSION_SECRET` | rec. | cookie signing secret (falls back to passcode) |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | for trading | paper keys; options level 1 |
| `ALPACA_PAPER` | no | defaults paper; only literal `false` → live money |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | optional | enables UI channel config |

## 7. Signal formats (`lib/parse.js`)

`parseSignal(text, now)` tries, in order: **exit → labeled → shorthand/keyworded
→ stock**. Returns a normalized object or `null`. Every object carries
`warnings[]` for the approval UI. The parser **refuses** rather than guesses
(chatter, prose mentioning a ticker, implausible strike/premium, ambiguous).

| Kind | Example | Key fields |
| ---- | ------- | ---------- |
| `option` (shorthand) | `AAPL 420C 7/17 2.5` | ticker/type/strike/premium/expiry/occ |
| `option` (keyworded, TOH) | `NVDA 215C AVG .64 EXP 7/15 - use 209.6 as stops` | + `underlyingStop` |
| `option` (labeled, Bishop) | `Option: CEL 18 P 7/11` + `Entry: 0.59` | same |
| `exit` | `NVDA 215c TRIMMED AT 44%` / `ALL OUT AT 226%` | ticker/strike/type, `action` trim/close, `pct` |
| `stock` | verbose Ticker/Direction/Entry/Target/Stop | side, entry, t1/t2, stop, rr |

OCC symbol encoding: `ROOT + YYMMDD + C/P + strike*1000 (8 digits)`.
Bare `M/D` expiries resolve to the next occurrence at/after `now` (never an
already-expired contract). Order-independent token matching handles the three
observed field orderings.

## 8. Trading flow

1. Card shows a **Review Trade →** (or **Review Exit →**) button per parsed signal.
2. Modal calls `place` with `confirm:false` → shows plain-English description,
   the literal JSON payload, quantity, est. cost, and warnings.
3. User adjusts qty, clicks **Place Order** → `place` with `confirm:true`.
4. `orders` is re-pulled; the card flips to live fill status + P&L.

**Order mapping:** option → limit buy at premium (no bracket; shorthand has no
stop/target). Stock w/ target+stop → bracket. Exit → market sell-to-close of a
**held position matched by ticker/strike/type** (exits carry no expiry); full
close sells all, trim suggests half, multiple matching expiries → refuse.

**Safety guarantees (all tested):** paper by default; qty capped (`MAX_QTY=100`);
unknown channel / bad qty / missing direction / no matching position → refused;
duplicate → 409; client-supplied order fields ignored.

## 9. Data storage

Only **watched-channel selection** is stored, in Supabase via its REST API
(`lib/settings.js`). It is **optional** — without `SUPABASE_*`, `CHANNEL_ID` is
used and the Settings UI is read-only. A store outage falls back to env (tested).
The migration enables RLS with **no policies** (deny-by-default; only the service
role touches the table). **The Discord bot token is intentionally NOT stored or
UI-editable** — a DB is a weaker home for a live credential, and it would make
the dashboard passcode as sensitive as the token.

## 10. Local development & testing

```bash
node --test test/         # full unit suite (49)
```

There is a **local emulator** at
`…/scratchpad/local-server.mjs` (outside the repo) that hosts the real handlers
with `res.status().json()` shims and **mocks Alpaca + Supabase** via a `fetch`
override, so the entire flow (login → parse → preview → place → fill → P&L →
settings save) can be exercised **without any real keys**. It listens on
`http://localhost:8771`.

> Windows gotcha: `pkill` does **not** reach node here. Free the port with
> PowerShell `Get-NetTCPConnection -LocalPort 8771 | Stop-Process`.

## 11. Deployment

**Current:** GitHub → Vercel. Zero-config (static `index.html` + `api/*`
functions). Add env vars in Vercel → Settings → Environment Variables →
**Redeploy** (env changes need a rebuild).

**Vercel commit-author gotcha (inherited from the org's other apps):** deploys are
blocked unless the commit author is the repo-owner identity
`amirthamorgo2plus-dotcom`. This repo's local git identity is already set to it.
If a deploy is "Blocked — commit author did not have contributing access":
`git commit --amend --reset-author --no-edit && git push --force-with-lease`.

**AWS (future, planned).** Because handlers are plain `(req,res)` with no Vercel
APIs, porting is: keep `lib/*`, wrap handlers in a small HTTP server (the emulator
is 90% of it) or an `aws-lambda` adapter, Dockerfile + Caddy route (matches the
org's existing Lightsail pattern), move secrets to SSM/Secrets Manager. Avoid
Vercel-specific features (none used today) to keep this cheap. **Commercial-use
note:** Vercel Hobby prohibits commercial use — if client-facing, this needs
Vercel Pro or the AWS move.

## 12. Done (with commits)

| Commit | Feature |
| ------ | ------- |
| `b2d460a` | Initial live dashboard (messages feed, polling) |
| `b6211cf` | Passcode gate + multi-channel + per-channel tabs |
| `b07fc97` | Parser: options shorthand + verbose stock |
| `980a43b` | Alpaca paper trading with human approval |
| `de7938b` | Order/fill/P&L tracking from Alpaca (survives reload) |
| `360fc52` | UI channel config (Supabase-backed, optional) |
| `89b007c` | TOH + Bishop formats, exit signals, manual-paste mode |

## 13. Pending / backlog

**Blocking go-live (user actions):**
- [ ] Verify the live Vercel deploy (URL not yet shared).
- [ ] Set `DASHBOARD_PASSCODE` + `SESSION_SECRET` in Vercel — **without these the
      live site locks everyone out** (login 500).
- [ ] Add Alpaca paper keys + enable options level 1; run the **first real paper
      order** (all testing so far is mocked — real broker may surface options
      approval, market-hours, or nonexistent-contract issues).

**Optional / not built:**
- [ ] **Signal outcome tracking / win-rate over time** — needs Supabase; the
      "is this source profitable?" feature. Offered, not started.
- [ ] Supabase project for channel config (works without it via `CHANNEL_ID`).
- [ ] Discord **Follow** onboarding for announcement channels (the only legit way
      to auto-ingest 3rd-party servers like The Option Haven; currently handled by
      manual-paste).
- [ ] `STOPS 225`-style stop-update messages are parsed as nothing; could update
      the stop on an existing position.
- [ ] Exit with multiple matching expiries → currently refused; could add a picker.
- [ ] AWS migration (see §11).

## 14. Known limitations & risks

- **Parser is best-effort** on free-form chat. It surfaces warnings and refuses
  ambiguity, but the human **must** verify the modal — do not rubber-stamp. The
  approval modal shows the exact payload for this reason.
- **Only mocked Alpaca has been exercised.** The real broker is untested.
- **Live view fetches latest 100 messages/channel** (one request) — older signals
  fall off the live feed. The separate static builder does full history.
- **Serverless in-memory cache/throttle is per-instance** — fine at this scale,
  not a global guarantee.
- **Public URL** unless the passcode is set; Vercel's built-in password protection
  is a paid feature (we ship our own gate instead).
- **Access:** a bot can only read channels it's invited to. Paid servers (TOH,
  Bishop) can't be auto-connected; self-botting is a ToS ban and is not supported.

## 15. Suggested next steps

1. User sets env vars + shares Vercel URL → verify live.
2. First real paper order end-to-end; fix whatever the real broker surfaces.
3. If desired: Supabase project → channel config + build win-rate tracking.
4. When commercial/ready: plan the AWS Lightsail/Lambda port.
