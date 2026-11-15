# CGS Portfolio

Dashboard for a Capital Growth System portfolio (replaces the "CGS" tab of
the Google Sheet). Not related to sheliutsin.capital.

```bash
python3 server.py            # http://localhost:8787
./deploy.sh                  # publish to Cloudflare Pages (cgs-dashboard.pages.dev)
```

Everything runs in the browser: whoever opens the page fetches their own
wallets' positions straight from the protocols' APIs, and wallets, manual rows,
zones, targets and history live in that browser's localStorage. The
server serves `static/`, `keys.json` (is Zerion set up, WalletConnect ID) and a Zerion
proxy that adds the key from `.env` (open it via http, not file://, so wallet extensions
can see the page). Zerion answers browsers only from localhost, hence the proxy.

`/` is the one-screen view (everything fits 1280×760 and up, like the sheet):
KPI strip, Growth Zone beside the signal, "К HF" and deposit boxes (same height),
Yield and Stability full width below (the crash test lives on the long pages); manual
rows are edited inline in their zone table (sums like `2500 + 707` work). The ☀/☾
button switches between a light DeBank theme and a dark Pendle one.

- `static/data.js` — the data engine: sources, refresh schedule, storage, CGS summary.
  The views still call `api("/api/…")`; it answers locally.
- `static/wallets.js` — the «Кошельки» dialog: add EVM / Solana wallets by address or by
  connecting MetaMask, Rabby, Phantom or WalletConnect (address only, nothing is signed),
  rename, remove.
- `static/core.js` — formatting and CGS maths; `compact.js` only renders.

- **Fetched**, per wallet, when the page opens and on ⟳ (no background polling): Aave V3 and V4 (official APIs), Kamino (API),
  GMX GM/GLV on Arbitrum (indexer + on-chain balances), Solana wallet (Jupiter balances
  and prices — public Solana RPCs refuse token lookups from browsers), everything else
  on EVM wallets via Zerion (only with a key). Several open tabs share results through localStorage.
- **Keys**: one set for everyone who opens this copy: locally from `.env` (not committed),
  on the hosted copy from the Cloudflare Pages project's secrets of the same names. The
  Zerion key stays on the server (`/zerion/…` proxy); the page only learns that it exists.
  `ZERION_API_KEY` (free at zerion.io/api; EVM positions outside Aave/GMX) and `WALLETCONNECT_PROJECT_ID` (free at cloud.reown.com; without it the
  WalletConnect button is hidden). The page has no key fields.
- **Manual**: TON, loan, poker, corrections — edited on the page.
- **History**: a snapshot on open / ⟳ when the last one is over an hour old and every source answered.

A new person's copy has no `data/`, so their page opens empty and fills as they add
wallets. On the owner's computer `data/` (`config.json`, `manual.json`, `history.jsonl`)
is a backup: a browser with no saved state takes it via `/api/seed` and opens set up. `data/` and `.env` are not committed.

To move one's setup to another browser or to the hosted site: «Параметры» → «Скачать
копию», then «Загрузить» there (wallets, manual rows, zones, targets, history).

## Hosting

`./deploy.sh` uploads `static/` and `functions/` to the Cloudflare Pages project
`cgs-dashboard` (direct upload, no git connection), https://cgs-dashboard.pages.dev.
`functions/zerion/[[path]].js` is the Zerion proxy, `functions/keys.json.js` says what is
set up; `functions/api/seed.js` answers 404, so every browser
there starts empty until it loads a copy. One-time setup: `npx wrangler login`, then
`npx wrangler pages secret put ZERION_API_KEY --project-name cgs-dashboard`.

## CGS rules on the page

- Zones are assigned by rules (`autoZone` in `static/data.js`):
  - Growth — BTC / ETH / SOL or their derivatives as collateral, stables as debt;
  - Yield — GMX GM/GLV pools of BTC/USD and ETH/USD;
  - Stability — stablecoin loops, stables supplied to Aave / Kamino, stable GMX pools;
  - Вне CGS — everything else (wallets, other protocols, other GMX pools).
  A zone picked by hand wins and is kept in the browser (dashed picker; "↺ Авто" undoes
  it). When the rules changed, positions already on the page kept their zones as picks.

- Trigger: common health factor = Σ(collateral × liquidation threshold) / Σ debt over
  the Growth Zone. Below 1.4: sell from the Stability and Yield zones and buy collateral;
  above 2.0: borrow more into the Stability Zone. The amounts bring it back to the
  target (1.7 by default).
- The "К HF 1,70" box always shows that move. Below the target the money comes first
  from whichever of Stability / Yield is further above its target (S/G vs Y/L % of
  target, after the purchase), then from both so they end at the same % of target.
- S/G = Stability / Growth collateral, shown in % (target 30/70 = 42.9%). Y/L = Yield / Loan,
  target 100%. The strip leads with each ratio's % of target.
- The deposit planner fills the Y/L and S/G gaps first, then splits the rest 30/70.
