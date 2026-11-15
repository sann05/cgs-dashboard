"use strict";
/* The data engine, running in the browser: every person who opens the page
   fetches their own wallets' positions straight from the protocols' public
   APIs and keeps everything (wallets, manual rows, zones, targets, history,
   …) in this browser's localStorage. The only thing the local server adds is
   whether Zerion is set up (keys.json) and a proxy to it that adds the key
   (/zerion/…: server.py locally, functions/ on the hosted copy).

   Each position has one shape:
     asset    {id, kind: "asset", source, protocol, chain, name, symbols, amount, value}
     lending  {id, kind: "lending", source, protocol, chain, name,
               collateral: [{symbol, amount, value, price, lt}], debt: [{symbol, amount, value}], hf}
   plus the wallet it came from. Protocols are read from their own APIs (Aave
   V3 and V4, Kamino lending and Earn, GMX, GMTrade, Morpho, Fluid, Pendle, Jupiter),
   Compound V3 and stablecoins on EVM wallets straight from the chain; Zerion (optional, needs a key) covers whatever else
   sits on an EVM wallet. Zerion misprices Aave and GMX and lists
   Aave aTokens as wallet tokens, so those are skipped.

   Zones come from one set of rules (autoZone below); the person's own choice
   for a position is kept in config.zones and wins over the rules.

   The views keep calling api("/api/…") as before; CGS.api answers locally. */

const CGS = (() => {
  /* ---------------------------------------------------------- storage */
  const KEY = { wallets: "cgs.wallets", manual: "cgs.manual", config: "cgs.config", history: "cgs.history", cache: "cgs.cache" };
  const load = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v ?? structuredClone(d);
    } catch { return structuredClone(d); }
  };
  const save = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / quota: keep in memory */ }
  };

  const DEFAULT_CONFIG = {
    // hfLow/hfHigh: the action corridor; hfTarget: where an action should bring
    // the common HF; stabilityShare: S/(S+G) target in %, i.e. 30 = S/G 30/70.
    targets: { hfLow: 1.4, hfHigh: 2.0, hfTarget: 1.7, stabilityShare: 30, ylTarget: 100 },
    // Crash test: % drop per collateral class.
    crash: { BTC: 70, ETH: 85, SOL: 85 },
    zones: {},  // position id -> zone override
    // decimals for $ and % on the page; null = automatic
    format: { usd: null, pct: null },
  };
  const withDefaults = (c) => {
    const out = { ...structuredClone(DEFAULT_CONFIG), ...c };
    for (const k of ["targets", "crash", "zones", "format"]) out[k] = { ...DEFAULT_CONFIG[k], ...(c?.[k] || {}) };
    // manual rows keep their zone on the row; these keys were left by a bug that wrote them here
    for (const id of Object.keys(out.zones)) if (id.startsWith("manual:")) delete out.zones[id];
    return out;
  };

  let config = withDefaults(load(KEY.config, {}));
  let wallets = load(KEY.wallets, []);
  let manual = load(KEY.manual, []);
  let history = load(KEY.history, []);
  /* task key "source:address" -> {positions, okAt, error, errorAt} (seconds) */
  let cache = load(KEY.cache, {});

  /* Another tab (or view) fetched or edited something: adopt it. */
  window.addEventListener("storage", (e) => {
    if (e.key === KEY.cache) {
      const theirs = load(KEY.cache, {});
      for (const [k, v] of Object.entries(theirs)) if (!cache[k] || (v.okAt || 0) >= (cache[k].okAt || 0)) cache[k] = v;
    } else if (e.key === KEY.config) config = withDefaults(load(KEY.config, {}));
    else if (e.key === KEY.wallets) wallets = load(KEY.wallets, []);
    else if (e.key === KEY.manual) manual = load(KEY.manual, []);
    else if (e.key === KEY.history) history = load(KEY.history, []);
    else return;
    changed();
  });

  const changed = () => window.dispatchEvent(new Event("cgs:update"));
  const now = () => Date.now() / 1000;

  /* ------------------------------------------------------------- http */
  class SourceError extends Error {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = (url) => (url.startsWith("zerion/") ? "api.zerion.io" : new URL(url).host);

  async function http(url, { body, headers, attempts = 3, timeout = 25000 } = {}) {
    let err = "";
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        if (r.ok) return await r.json();
        if (r.status !== 429 && r.status < 500) throw new SourceError(`${host(url)}: HTTP ${r.status}`);
        err = `HTTP ${r.status}`;
      } catch (e) {
        if (e instanceof SourceError) throw e;
        err = e.name === "TimeoutError" ? "нет ответа" : e.message;
      }
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
    throw new SourceError(`${host(url)}: ${err}`);
  }

  /* run fn over items, n at a time */
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }));
    return out;
  }

  const STABLES = new Set(["USDC", "USDT", "USDT0", "USD₮", "USD₮0", "USDG", "DAI", "USDE", "PYUSD", "USDS", "GHO",
    "FDUSD", "USDH", "USD1", "CASH", "USDC.E", "USDBC", "SUSDE", "SUSDS", "SDAI", "SYRUPUSDC", "SYRUPUSDT", "CRVUSD",
    "FRAX", "LUSD", "USDTB", "RLUSD", "USDAI", "USDX", "AUSD"]);
  // Pendle PTs of a stable count as that stable: "PT-sUSDE-25SEP2025"
  const isStable = (sym) => STABLES.has(sym.toUpperCase().replace(/^PT-(.+?)(-\d+[A-Z]{3}\d+)?$/, "$1"));

  /* ---------------------------------------------------------- Aave V3 */
  const aaveMarkets = { at: 0, list: [] };
  async function aaveQ(query, variables = {}) {
    const d = await http("https://api.v3.aave.com/graphql", { body: { query, variables } });
    if (d.errors) throw new SourceError(`Aave API: ${d.errors[0].message}`);
    return d.data;
  }

  /* Positions come from userSupplies/userBorrows over every market; HF and the
     liquidation threshold from userMarketState per active market (the
     multi-chain `markets { userState }` query returns zeros for some chains). */
  async function aaveV3(wallet) {
    if (now() - aaveMarkets.at > 3600 || !aaveMarkets.list.length) {
      const chains = (await aaveQ("{ chains { chainId } }")).chains.map((x) => x.chainId);
      aaveMarkets.list = (await aaveQ("query($c:[ChainId!]!){ markets(request:{chainIds:$c}) { name address chain { chainId name } } }", { c: chains })).markets;
      aaveMarkets.at = now();
    }
    const key = (chainId, address) => `${chainId}:${address.toLowerCase()}`;
    const markets = Object.fromEntries(aaveMarkets.list.map((m) => [key(m.chain.chainId, m.address), m]));
    const d = await aaveQ(
      "query($m:[MarketInput!]!,$u:EvmAddress!){" +
      " userSupplies(request:{markets:$m,user:$u}) { market { address chain { chainId } } currency { symbol }" +
      "   balance { amount { value } usd usdPerToken } isCollateral }" +
      " userBorrows(request:{markets:$m,user:$u}) { market { address chain { chainId } } currency { symbol }" +
      "   debt { amount { value } usd } } }",
      { m: aaveMarkets.list.map((m) => ({ address: m.address, chainId: m.chain.chainId })), u: wallet });
    const keyOf = (x) => key(x.market.chain.chainId, x.market.address);
    const active = [...new Set([...d.userSupplies, ...d.userBorrows].map(keyOf))];
    const states = Object.fromEntries(await pool(active, 8, async (k) => {
      const [chainId, address] = k.split(":");
      const q = "query($m:EvmAddress!,$u:EvmAddress!,$c:ChainId!){ userMarketState(request:{market:$m,user:$u,chainId:$c})" +
        " { healthFactor currentLiquidationThreshold { value } } }";
      return [k, (await aaveQ(q, { m: address, u: wallet, c: Number(chainId) })).userMarketState];
    }));
    const out = [];
    for (const k of active) {
      const m = markets[k], s = states[k];
      const lt = Number(s.currentLiquidationThreshold.value);
      const chain = m.chain.name;
      const label = m.name.replace("AaveV3", "") || chain;
      const supplies = d.userSupplies.filter((x) => keyOf(x) === k && Number(x.balance.usd) > 0.01);
      const borrows = d.userBorrows.filter((x) => keyOf(x) === k && Number(x.debt.usd) > 0.01);
      const coll = borrows.length ? supplies.filter((x) => x.isCollateral) : [];
      for (const x of supplies) {
        if (coll.includes(x)) continue;
        const sym = x.currency.symbol;
        out.push({
          id: `aave3:${wallet}:${k}:${sym}`, kind: "asset", source: "aave", protocol: "Aave V3", chain,
          name: `${sym} supply`, symbols: [sym], amount: Number(x.balance.amount.value), value: Number(x.balance.usd),
        });
      }
      if (borrows.length) {
        out.push({
          id: `aave3:${wallet}:${k}`, kind: "lending", source: "aave", protocol: "Aave V3", chain, name: label,
          collateral: coll.map((x) => ({ symbol: x.currency.symbol, amount: Number(x.balance.amount.value),
            value: Number(x.balance.usd), price: Number(x.balance.usdPerToken), lt })),
          debt: borrows.map((x) => ({ symbol: x.currency.symbol.replace("₮", "T"), amount: Number(x.debt.amount.value), value: Number(x.debt.usd) })),
          hf: s.healthFactor ? Number(s.healthFactor) : null,
        });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------- Aave V4 */
  /* V4 positions live per spoke ("Main", "Bluechip", …); the collateral factor
     plays V3's liquidation threshold. */
  const aaveV4Chains = { at: 0, ids: [] };
  async function aaveV4(wallet) {
    const q = async (query, variables) => {
      const d = await http("https://api.v4.aave.com/graphql", { body: { query, variables } });
      if (d.errors) throw new SourceError(`Aave V4 API: ${d.errors[0].message}`);
      return d.data;
    };
    if (now() - aaveV4Chains.at > 3600 || !aaveV4Chains.ids.length) {
      aaveV4Chains.ids = (await q("{ chains(request:{query:{filter:ALL}}) { chainId isTestnet } }")).chains.filter((c) => !c.isTestnet).map((c) => c.chainId);
      aaveV4Chains.at = now();
    }
    const amount = "{ amount { value } exchange { value } exchangeRate { value } token { info { symbol } } }";
    const d = await q(
      "query($u:EvmAddress!,$c:[ChainId!]!){" +
      " userPositions(request:{user:$u,filter:{chainIds:$c}}) { spoke { address name chain { chainId name } } healthFactor { current } }" +
      ` userSupplies(request:{query:{userChains:{user:$u,chainIds:$c}}}) { isCollateral reserve { spoke { address } settings { collateralFactor { value } } } balance ${amount} }` +
      ` userBorrows(request:{query:{userChains:{user:$u,chainIds:$c}}}) { reserve { spoke { address } } debt ${amount} } }`,
      { u: wallet, c: aaveV4Chains.ids });
    const leg = (a) => ({ symbol: a.token.info.symbol, amount: Number(a.amount.value), value: Number(a.exchange.value), price: Number(a.exchangeRate.value) });
    const out = [];
    for (const pos of d.userPositions) {
      const sp = pos.spoke, chain = sp.chain.name, key = `${sp.chain.chainId}:${sp.address.toLowerCase()}`;
      const mine = (x) => x.reserve.spoke.address.toLowerCase() === sp.address.toLowerCase();
      const supplies = d.userSupplies.filter((x) => mine(x) && Number(x.balance.exchange.value) > 0.01);
      const borrows = d.userBorrows.filter((x) => mine(x) && Number(x.debt.exchange.value) > 0.01);
      const coll = borrows.length ? supplies.filter((x) => x.isCollateral) : [];
      for (const x of supplies) {
        if (coll.includes(x)) continue;
        const l = leg(x.balance);
        out.push({
          id: `aave4:${wallet}:${key}:${l.symbol}`, kind: "asset", source: "aave4", protocol: "Aave V4", chain,
          name: `${l.symbol} supply${sp.name === "Main" ? "" : ` · ${sp.name}`}`, symbols: [l.symbol], amount: l.amount, value: l.value,
        });
      }
      if (borrows.length) {
        out.push({
          id: `aave4:${wallet}:${key}`, kind: "lending", source: "aave4", protocol: "Aave V4", chain, name: `V4 ${sp.name}`,
          collateral: coll.map((x) => ({ ...leg(x.balance), lt: Number(x.reserve.settings.collateralFactor.value) || null })),
          debt: borrows.map((x) => { const { symbol, amount: a, value } = leg(x.debt); return { symbol, amount: a, value }; }),
          hf: pos.healthFactor.current ? Number(pos.healthFactor.current) : null,
        });
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- Kamino */
  const EMPTY_PUBKEY = "11111111111111111111111111111111";
  const kaminoCache = {};  // wallet -> {at, markets: {addr: name}, reserves: {reserve: [symbol, mint]}}
  const KAMINO = "https://api.kamino.finance";

  /* Markets where the wallet has obligations, with each market's reserve ->
     (symbol, mint) map. Discovery walks every market, so it is cached. */
  async function kaminoMarkets(wallet) {
    const c = kaminoCache[wallet];
    if (c && now() - c.at < 1800) return c;
    const all = await http(`${KAMINO}/v2/kamino-market`);
    const found = {};
    await pool(all, 8, async (m) => {
      const obs = await http(`${KAMINO}/kamino-market/${m.lendingMarket}/users/${wallet}/obligations`);
      if (obs.length) found[m.lendingMarket] = m.name;
    });
    const reserves = {};
    for (const addr of Object.keys(found)) {
      for (const r of await http(`${KAMINO}/kamino-market/${addr}/reserves/metrics`)) reserves[r.reserve] = [r.liquidityToken, r.liquidityTokenMint];
    }
    return (kaminoCache[wallet] = { at: now(), markets: found, reserves });
  }

  async function jupiterPrices(mints) {
    const ids = [...new Set(mints)].sort();
    if (!ids.length) return {};
    const d = await http(`https://lite-api.jup.ag/price/v3?ids=${ids.join(",")}`);
    return Object.fromEntries(Object.entries(d).filter(([, v]) => v).map(([m, v]) => [m, Number(v.usdPrice)]));
  }

  async function kamino(wallet) {
    const { markets, reserves } = await kaminoMarkets(wallet);
    const obligations = [];
    for (const [addr, name] of Object.entries(markets)) {
      for (const o of await http(`${KAMINO}/kamino-market/${addr}/users/${wallet}/obligations`)) obligations.push([name, o]);
    }
    const mints = obligations.flatMap(([, o]) => [
      ...o.state.deposits.map((x) => reserves[x.depositReserve]?.[1]),
      ...o.state.borrows.map((x) => reserves[x.borrowReserve]?.[1]),
    ]).filter(Boolean);
    const prices = await jupiterPrices(mints);

    /* Split the refreshed USD total across legs by their on-chain market value
       (the state snapshot is stale; refreshedStats is current). A snapshot can
       hold a leg with an amount but marketValueSf 0 — then split evenly. */
    const legs = (items, reserveKey, total) => {
      const live = items.filter((x) => x[reserveKey] !== EMPTY_PUBKEY &&
        (Number(x.marketValueSf) > 0 || Number(x.depositedAmount ?? x.borrowedAmountSf) > 0));
      const mv = live.reduce((a, x) => a + Number(x.marketValueSf), 0);
      const share = (x) => (mv > 0 ? Number(x.marketValueSf) / mv : 1 / live.length);
      return live.map((x) => {
        const [symbol, mint] = reserves[x[reserveKey]] || ["?", null];
        const value = total * share(x);
        const price = prices[mint] ?? null;
        return { symbol, value, price, amount: price ? value / price : null };
      });
    };

    const out = [];
    for (const [market, o] of obligations) {
      const st = o.refreshedStats;
      const deposit = Number(st.userTotalDeposit), borrow = Number(st.userTotalBorrow);
      if (deposit < 0.01) continue;
      const lt = Number(st.liquidationLtv);
      const coll = legs(o.state.deposits, "depositReserve", deposit).map((c) => ({ ...c, lt }));
      const debt = borrow > 0.01 ? legs(o.state.borrows, "borrowReserve", borrow) : [];
      const tag = o.humanTag || "";
      out.push({
        id: `kamino:${o.obligationAddress}`, kind: "lending", source: "kamino", protocol: "Kamino", chain: "Solana",
        name: market.replace(" Market", "") + (tag && tag !== "Vanilla" ? ` · ${tag}` : ""),
        collateral: coll, debt: debt.map(({ symbol, amount, value }) => ({ symbol, amount, value })),
        hf: borrow > 0.01 ? Number(st.borrowLiquidationLimit) / borrow : null,
      });
    }
    return [...out, ...await kaminoEarn(wallet)];
  }

  /* Kamino Earn vaults (kVaults): shares, staked in the vault's farm or not,
     × tokens per share × token price. Names and tokens come from the vault
     list (large, so cached for an hour). */
  const kvaults = { at: 0, map: {} };
  async function kaminoEarn(wallet) {
    const held = (await http(`${KAMINO}/kvaults/users/${wallet}/positions`)).filter((p) => Number(p.totalShares) > 0);
    if (!held.length) return [];
    if (now() - kvaults.at > 3600 || held.some((p) => !kvaults.map[p.vaultAddress])) {
      kvaults.map = Object.fromEntries((await http(`${KAMINO}/kvaults/vaults`)).map((v) => [v.address, { name: v.state.name, mint: v.state.tokenMint }]));
      kvaults.at = now();
    }
    const symbols = await solanaSymbols(held.map((p) => kvaults.map[p.vaultAddress]?.mint).filter(Boolean));
    return pool(held, 4, async (p) => {
      const m = await http(`${KAMINO}/kvaults/${p.vaultAddress}/metrics`);
      const v = kvaults.map[p.vaultAddress] || {};
      const amount = Number(p.totalShares) * Number(m.tokensPerShare);
      const symbol = symbols[v.mint] || "?";
      return { id: `kamino:earn:${wallet}:${p.vaultAddress}`, kind: "asset", source: "kamino", protocol: "Kamino", chain: "Solana",
        name: v.name || `Kamino Earn ${symbol}`, symbols: [symbol], amount, value: amount * Number(m.tokenPrice) };
    });
  }

  /* mint -> symbol: the known ones, else Jupiter's token list */
  async function solanaSymbols(mints) {
    const out = { [SOL_MINT]: "SOL", ...SOLANA_TOKENS };
    const rest = [...new Set(mints)].filter((m) => !out[m]);
    if (rest.length) for (const t of await http(`https://lite-api.jup.ag/tokens/v2/search?query=${rest.join(",")}`)) out[t.id] = t.symbol;
    return out;
  }

  /* ---------------------------------------------------- Solana wallet */
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  // Wallet tokens valued besides SOL (wallets also hold airdropped spam).
  const SOLANA_TOKENS = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
    "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": "USDG",
  };

  /* Balances come from Jupiter: public Solana RPCs refuse token-account
     lookups (getTokenAccountsByOwner) from browsers. */
  async function solanaWallet(wallet) {
    const bal = await http(`https://lite-api.jup.ag/ultra/v1/balances/${wallet}`);
    const amounts = { [SOL_MINT]: Number(bal.SOL?.uiAmount || 0) };
    for (const mint of Object.keys(SOLANA_TOKENS)) if (bal[mint]) amounts[mint] = Number(bal[mint].uiAmount || 0);
    const held = Object.keys(amounts).filter((m) => amounts[m]);
    const prices = await jupiterPrices(held);
    return [{
      id: `solana:${wallet}`, kind: "asset", source: "solana", protocol: "Wallet", chain: "Solana",
      name: "Кошелёк Solana", symbols: held.map((m) => SOLANA_TOKENS[m] || "SOL"), amount: null,
      value: held.reduce((a, m) => a + amounts[m] * (prices[m] || 0), 0),
      prices: { SOL: prices[SOL_MINT] },
    }];
  }

  /* --------------------------------------------------------- GMTrade */
  /* GMX on Solana (gmtrade.xyz): GLV tokens on the wallet and GLV staked for
     GT rewards. A stake is a Position account of the liquidity-provider
     program with a random id, so it can only be found by owner: the GMTrade
     indexer lists stakes by owner and the current GLV prices; the staked
     amount is the balance of the position's escrow (public RPCs refuse
     owner-wide lookups from browsers). Position: 8-byte discriminator, then
     owner, controller, lp_mint, vault (32 bytes each). */
  const GMTRADE_SQUID = "https://gmx-solana-sqd.squids.live/gmx-solana-base:prod/api/graphql";
  const SOLANA_RPC = "https://solana-rpc.publicnode.com";
  const GMTRADE_GLV = {  // mint -> name, tokens the vault's markets hold
    "7uwzUKKbXHNmpC5x67apE7JgAmPoWWQpCf7jJZRTqjMk": ["GLV Crypto [USDC]", ["USDC"]],
    "3JSkb3H1kP8F1HKhCiYa9FUnUa5mS2m9RnP8c2uiqCAF": ["GLV Forex [USDC]", ["USDC"]],
    "GYWBcNWvTHeKiQpV9P3gMpLAioZrx38NGBwmR7puLg9a": ["GLV Commodity [USDC]", ["USDC"]],
    "ERHvgcB3PRqvPSPGBWckhzatM7Xzgifpp6FeawxShd7o": ["GLV RWA [USDC]", ["USDC"]],
    "7r3XADNMW12k8QiLPaFjW1giYMJNZzUjmDA5HiK7hAPu": ["GLV [SOL-USDC]", ["SOL", "USDC"]],
    "HhVNkJ9EWi64j645aVfnNBqXguXvhvKHk7wRnS4wAYmz": ["GLV [GMX-USDC]", ["GMX", "USDC"]],
  };
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) {
    let n = bytes.reduce((a, b) => a * 256n + BigInt(b), 0n), s = "";
    while (n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b) break; s = "1" + s; }
    return s;
  }
  async function solanaAccounts(addresses, encoding) {
    const d = await http(SOLANA_RPC, { body: { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addresses, { encoding }] } });
    if (d.error) throw new SourceError(`Solana RPC: ${d.error.message}`);
    return d.result.value;
  }

  async function gmtrade(wallet) {
    const [d, bal] = await Promise.all([
      http(GMTRADE_SQUID, { body: { query: `{ stakeGmGlvs(where:{owner_eq:"${wallet}"}) { position } glvInfos { id glvPriceNow } }` } }),
      http(`https://lite-api.jup.ag/ultra/v1/balances/${wallet}`),
    ]);
    if (d.errors) throw new SourceError(`GMTrade indexer: ${d.errors[0].message}`);
    const amounts = {}, staked = new Set();
    for (const mint of Object.keys(GMTRADE_GLV)) if (Number(bal[mint]?.uiAmount)) amounts[mint] = Number(bal[mint].uiAmount);
    const positions = [...new Set(d.data.stakeGmGlvs.map((s) => s.position))];
    if (positions.length) {
      // closed (unstaked) positions come back null
      const accs = (await solanaAccounts(positions, "base64")).filter(Boolean)
        .map((a) => Uint8Array.from(atob(a.data[0]), (ch) => ch.charCodeAt(0)));
      const vaults = accs.map((b) => base58(b.slice(104, 136)));
      for (const v of vaults.length ? await solanaAccounts(vaults, "jsonParsed") : []) {
        const info = v?.data?.parsed?.info;
        if (!info || !Number(info.tokenAmount.uiAmount)) continue;
        amounts[info.mint] = (amounts[info.mint] || 0) + Number(info.tokenAmount.uiAmount);
        staked.add(info.mint);
      }
    }
    const prices = Object.fromEntries(d.data.glvInfos.map((g) => [g.id, Number(g.glvPriceNow) / 1e11]));
    const out = [];
    for (const [mint, amount] of Object.entries(amounts)) {
      if (!prices[mint]) throw new SourceError(`GMTrade: нет цены GLV ${mint.slice(0, 6)}…`);
      const [name, symbols] = GMTRADE_GLV[mint] || [`GLV ${mint.slice(0, 6)}…`, []];
      out.push({ id: `gmtrade:${wallet}:${mint}`, kind: "asset", source: "gmtrade", protocol: "GMTrade", chain: "Solana",
        name: staked.has(mint) ? `${name} · стейк` : name, symbols, amount: null, tokens: amount, value: amount * prices[mint] });
    }
    return out;
  }

  /* ---------------------------------------------------- GMX (Arbitrum) */
  const ARBITRUM_RPC = "https://arbitrum-one-rpc.publicnode.com";
  const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
  const GMX_SQUID = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
  const GMX_API = "https://arbitrum-api.gmxinfra.io";
  const pad = (h) => h.padStart(64, "0");

  /* balanceOf(wallet) and totalSupply() for every token in one Multicall3
     aggregate() call, ABI-encoded by hand. */
  async function multicallBalances(tokens, wallet) {
    const calls = [...tokens.map((t) => [t, "70a08231" + pad(wallet.slice(2).toLowerCase())]), ...tokens.map((t) => [t, "18160ddd"])];
    const words = ["20", calls.length.toString(16), ...calls.map((_, i) => (32 * calls.length + 160 * i).toString(16))];
    for (const [target, data] of calls) {
      const padded = data.padEnd(128, "0");
      words.push(target.slice(2).toLowerCase(), "40", (data.length / 2).toString(16), padded.slice(0, 64), padded.slice(64));
    }
    const d = await http(ARBITRUM_RPC, { body: { jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: MULTICALL3, data: "0x252dba42" + words.map(pad).join("") }, "latest"] } });
    if (d.error) throw new SourceError(`Arbitrum RPC: ${d.error.message}`);
    const raw = d.result.slice(2);
    const word = (i) => BigInt("0x" + raw.slice(64 * i, 64 * (i + 1)));
    const arr = Number(word(1) / 32n);
    const results = [];
    for (let i = 0; i < Number(word(arr)); i++) {
      const at = arr + 1 + Number(word(arr + 1 + i) / 32n);
      results.push(word(at) ? word(at + 1) : 0n);
    }
    const n = tokens.length;
    return [Object.fromEntries(tokens.map((t, i) => [t, results[i]])), Object.fromEntries(tokens.map((t, i) => [t, results[n + i]]))];
  }

  const symbolsOf = (name) => name.split("[").at(-1).match(/[A-Za-z0-9.]+/g) || [];

  /* GM price = poolValue / supply (GMX indexer); GLV price = USD of the GM
     tokens it holds (GMX API) / supply. */
  async function gmx(wallet) {
    const [squid, marketList, glvs] = await Promise.all([
      http(GMX_SQUID, { body: { query: "{ marketInfos(limit: 1000) { marketTokenAddress poolValue } }" } }),
      http(`${GMX_API}/markets`), http(`${GMX_API}/glvs/info`),
    ]);
    if (squid.errors) throw new SourceError(`GMX indexer: ${squid.errors[0].message}`);
    const usd = Object.fromEntries(squid.data.marketInfos.map((m) => [m.marketTokenAddress.toLowerCase(), Number(m.poolValue) / 1e30]));
    const names = Object.fromEntries(marketList.markets.map((m) => [m.marketToken.toLowerCase(), m.name]));
    for (const g of glvs.glvs) {
      const t = g.glvToken.toLowerCase();
      usd[t] = g.markets.reduce((a, m) => a + Number(m.balanceUsd), 0) / 1e30;
      names[t] = g.name.startsWith("GLV") ? g.name : `GLV ${g.name}`;
    }
    const tokens = Object.keys(usd);
    const [balances, supply] = await multicallBalances(tokens, wallet);
    const out = [];
    for (const t of tokens) {
      const bal = balances[t];
      if (!bal || !supply[t]) continue;
      const value = (Number(bal) / Number(supply[t])) * usd[t];
      if (value < 1) continue;
      let name = names[t] || `GM ${t.slice(0, 10)}`;
      if (!name.startsWith("GLV")) name = `GM ${name}`;
      out.push({
        id: `gmx:arbitrum:${wallet}:${t}`, kind: "asset", source: "gmx", protocol: "GMX V2", chain: "Arbitrum",
        name, symbols: symbolsOf(name), amount: null, tokens: Number(bal) / 1e18, value,
      });
    }
    return out;
  }

  /* ----------------------------------------------------------- Morpho */
  /* Morpho's own API: markets (collateral + loan, LLTV, HF) and vaults V1 / V2
     on every chain it runs. V2 vault positions are only listed per chain. */
  const MORPHO = "https://api.morpho.org/graphql";
  const morphoChains = { at: 0, list: [] };
  async function morpho(wallet) {
    const q = async (query, variables) => {
      const d = await http(MORPHO, { body: { query, variables } });
      if (d.errors && !d.data) throw new SourceError(`Morpho API: ${d.errors[0].message}`);
      return d.data;
    };
    if (now() - morphoChains.at > 3600 || !morphoChains.list.length) {
      morphoChains.list = (await q("{ chains { id network } }")).chains;
      morphoChains.at = now();
    }
    const asset = "symbol decimals";
    const d = await q("query($u:[String!]!,$a:String!){" +
      ` marketPositions(first:200, where:{userAddress_in:$u}) { items { healthFactor market { marketId lltv chain { network } loanAsset { ${asset} } collateralAsset { ${asset} } } state { collateral collateralUsd borrowAssets borrowAssetsUsd supplyAssets supplyAssetsUsd } } }` +
      " vaultPositions(first:200, where:{userAddress_in:$u}) { items { vault { address name chain { network } asset { symbol decimals } } state { assets assetsUsd } } }" +
      morphoChains.list.map((c) => ` c${c.id}: userByAddress(address:$a, chainId:${c.id}) { vaultV2Positions { assets assetsUsd vault { address name chain { network } asset { symbol decimals } } } }`).join("") + " }",
      { u: [wallet], a: wallet });
    const chainOf = (n) => (n === "Arbitrum One" ? "Arbitrum" : n === "OP Mainnet" ? "Optimism" : n);
    const units = (raw, dec) => Number(raw) / 10 ** (dec ?? 18);
    const out = [];
    for (const m of d.marketPositions?.items || []) {
      const { market: mk, state: st } = m;
      const chain = chainOf(mk.chain.network), loan = mk.loanAsset, col = mk.collateralAsset;
      const borrow = Number(st.borrowAssetsUsd || 0), coll = Number(st.collateralUsd || 0), supply = Number(st.supplyAssetsUsd || 0);
      if (supply >= 1) {
        out.push({ id: `morpho:${wallet}:${mk.marketId}:supply`, kind: "asset", source: "morpho", protocol: "Morpho", chain,
          name: `${loan.symbol} supply · ${col?.symbol || "idle"}`, symbols: [loan.symbol], amount: units(st.supplyAssets, loan.decimals), value: supply });
      }
      if (coll < 1 && borrow < 1) continue;
      const amount = units(st.collateral, col.decimals);
      const leg = { symbol: col.symbol, amount, value: coll, price: amount ? coll / amount : null, lt: Number(mk.lltv) / 1e18 };
      if (borrow < 1) {
        out.push({ id: `morpho:${wallet}:${mk.marketId}`, kind: "asset", source: "morpho", protocol: "Morpho", chain,
          name: `${col.symbol} collateral`, symbols: [col.symbol], amount, value: coll });
        continue;
      }
      out.push({ id: `morpho:${wallet}:${mk.marketId}`, kind: "lending", source: "morpho", protocol: "Morpho", chain,
        name: `${col.symbol}/${loan.symbol}`, collateral: [leg],
        debt: [{ symbol: loan.symbol, amount: units(st.borrowAssets, loan.decimals), value: borrow }],
        hf: ok(m.healthFactor) ? Number(m.healthFactor) : null });
    }
    const vaults = [...(d.vaultPositions?.items || []).map((v) => ({ ...v, assets: v.state.assets, assetsUsd: v.state.assetsUsd })),
      ...morphoChains.list.flatMap((c) => d[`c${c.id}`]?.vaultV2Positions || [])];
    for (const v of vaults) {
      const value = Number(v.assetsUsd || 0);
      if (value < 1) continue;
      out.push({ id: `morpho:${wallet}:vault:${v.vault.address.toLowerCase()}`, kind: "asset", source: "morpho", protocol: "Morpho",
        chain: chainOf(v.vault.chain.network), name: v.vault.name, symbols: [v.vault.asset.symbol],
        amount: units(v.assets, v.vault.asset.decimals), value });
    }
    return out;
  }

  /* ----------------------------------------------------------- Pendle */
  /* Pendle's dashboard API values every open PT / YT / LP across its chains;
     Zerion prices PTs at $0. Market names come from each market's own record. */
  const PENDLE = "https://api-v2.pendle.finance/core";
  const PENDLE_CHAINS = { 1: "Ethereum", 10: "Optimism", 56: "BNB", 146: "Sonic", 999: "HyperEVM", 5000: "Mantle",
    8453: "Base", 9745: "Plasma", 42161: "Arbitrum", 80094: "Berachain" };
  const pendleMarkets = {};  // "chainId-address" -> market record
  async function pendle(wallet) {
    const d = await http(`${PENDLE}/v1/dashboard/positions/database/${wallet}?filterUsd=0.1`);
    const out = [];
    for (const c of d.positions || []) {
      for (const pos of c.openPositions || []) {
        const [chainId, address] = pos.marketId.split("-");
        pendleMarkets[pos.marketId] ??= await http(`${PENDLE}/v1/${chainId}/markets/${address}`);
        const m = pendleMarkets[pos.marketId];
        const stable = isStable(m.accountingAsset?.symbol || m.underlyingAsset?.symbol || "");
        const legs = [["pt", m.pt?.symbol || `PT-${m.proName}`], ["yt", m.yt?.symbol || `YT-${m.proName}`], ["lp", `LP ${m.proName}`]];
        for (const [leg, symbol] of legs) {
          const value = Number(pos[leg]?.valuation || 0);
          if (value < 1) continue;
          out.push({
            id: `pendle:${wallet}:${pos.marketId}:${leg}`, kind: "asset", source: "pendle", protocol: "Pendle",
            chain: PENDLE_CHAINS[chainId] || `Chain ${chainId}`, name: symbol, symbols: [symbol], leg, stable,
            amount: Number(pos[leg].balance) / 10 ** (m[leg]?.decimals ?? 18), value,
          });
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ Fluid */
  /* Fluid vault positions are NFTs; the API lists a wallet's NFTs per chain
     together with the vault (tokens with prices, liquidation threshold, oracle).
     Smart vaults hold DEX shares on the collateral (type 2), debt (type 3) or
     both (type 4) side: token amount = shares × tokenNPerShare / 1e18. HF uses
     the vault oracle, as Fluid's own liquidation check: raw collateral × oracle
     / 1e27 is the collateral in raw debt units. */
  const FLUID_CHAINS = [[1, "Ethereum", "ethereum"], [42161, "Arbitrum", "arbitrum"], [8453, "Base", "base"],
    [137, "Polygon", "polygon"], [56, "BNB Chain", "binance-smart-chain"], [9745, "Plasma", "plasma"]];
  const FLUID_ZERION = new Set(FLUID_CHAINS.map(([, , z]) => z));
  async function fluid(wallet) {
    const out = [];
    await pool(FLUID_CHAINS, 3, async ([chainId, chain]) => {
      for (const n of await http(`https://api.fluid.instadapp.io/v2/${chainId}/users/${wallet}/nfts`)) {
        const v = n.vault, type = Number(v.type);
        const legs = (side, dex, raw, smart) => [v[side].token0, v[side].token1]
          .map((t, i) => {
            if (!t?.symbol || (!smart && i)) return null;
            const units = smart ? (Number(raw) * Number(v[dex][`token${i}PerShare`])) / 1e18 : Number(raw);
            const amount = units / 10 ** t.decimals, price = Number(t.price) || null;
            return { symbol: t.symbol, amount, price, value: price ? amount * price : 0 };
          })
          .filter((l) => l && l.amount > 0);
        const coll = legs("supplyToken", "supplyDexData", n.supply, type === 2 || type === 4);
        const debt = legs("borrowToken", "borrowDexData", n.borrow, type === 3 || type === 4);
        const cv = coll.reduce((a, l) => a + l.value, 0), dv = debt.reduce((a, l) => a + l.value, 0);
        if (cv < 1 && dv < 1) continue;
        const id = `fluid:${wallet}:${chainId}:${n.id}`;
        const syms = [...new Set(coll.map((l) => l.symbol))];
        if (dv < 1) {
          out.push({ id, kind: "asset", source: "fluid", protocol: "Fluid", chain, name: `${syms.join(" + ")} · Fluid #${n.id}`, symbols: syms,
            amount: coll.length === 1 ? coll[0].amount : null, value: cv });
          continue;
        }
        const lt = Number(v.liquidationThreshold) / 1e4;
        out.push({ id, kind: "lending", source: "fluid", protocol: "Fluid", chain, name: `Fluid #${n.id}`,
          collateral: coll.map((l) => ({ ...l, lt })),
          debt: debt.map(({ symbol, amount, value }) => ({ symbol, amount, value })),
          hf: (Number(n.supply) * Number(v.oraclePriceLiquidate) / 1e27 * lt) / Number(n.borrow) });
      }
    });
    return out;
  }

  /* ------------------------------------------- EVM wallet stablecoins */
  /* Stablecoins lying on an EVM wallet, read on-chain (balanceOf over public
     RPCs, no key): Zerion's index can lag a wallet by days, and idle stables
     are what a rebalance is made of. Valued at $1. A token marked "llama" is
     not a stable: one Zerion does not list at all (cbHYPE, unverified there),
     priced from DefiLlama. `zerion` is Zerion's chain id, so Zerion skips
     these exact tokens. */
  const WALLET_STABLES = [
    { chain: "Ethereum", zerion: "ethereum", rpc: "https://ethereum-rpc.publicnode.com", tokens: [
      ["USDC", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6], ["USDT", "0xdac17f958d2ee523a2206206994597c13d831ec7", 6],
      ["DAI", "0x6b175474e89094c44da98b954eedeac495271d0f", 18], ["USDG", "0xe343167631d89b6ffc58b88d6b7fb0228795491d", 6],
      ["PYUSD", "0x6c3ea9036406852006290770bedfcaba0e23a0e8", 6]] },
    { chain: "Arbitrum", zerion: "arbitrum", rpc: "https://arbitrum-one-rpc.publicnode.com", tokens: [
      ["USDC", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6], ["USDC.e", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", 6],
      ["USDT0", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 6], ["DAI", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", 18]] },
    { chain: "Base", zerion: "base", rpc: "https://base-rpc.publicnode.com", tokens: [
      ["USDC", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6], ["USDbC", "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", 6],
      ["USDT", "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", 6], ["DAI", "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", 18],
      ["cbHYPE", "0xb200000000000000000000451d033a5000cb479e", 18, "llama"]], llama: "base" },
    { chain: "Optimism", zerion: "optimism", rpc: "https://optimism-rpc.publicnode.com", tokens: [
      ["USDC", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6], ["USDT", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", 6],
      ["DAI", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", 18]] },
    { chain: "Avalanche", zerion: "avalanche", rpc: "https://avalanche-c-chain-rpc.publicnode.com", tokens: [
      ["USDC", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", 6], ["USDT", "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", 6]] },
    { chain: "Polygon", zerion: "polygon", rpc: "https://polygon-bor-rpc.publicnode.com", tokens: [
      ["USDC", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 6], ["USDT0", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", 6]] },
    { chain: "Celo", zerion: "celo", rpc: "https://celo-rpc.publicnode.com", tokens: [
      ["USDC", "0xceba9300f2b948710d2653dd7b07f33a8b32118c", 6], ["USDT", "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e", 6]] },
    { chain: "BNB Chain", zerion: "binance-smart-chain", rpc: "https://bsc-rpc.publicnode.com", tokens: [
      ["USDC", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", 18], ["USDT", "0x55d398326f99059ff775485246999027b3197955", 18]] },
  ];
  const WALLET_STABLE_KEYS = new Set(WALLET_STABLES.flatMap((c) => c.tokens.map(([, addr]) => `${c.zerion}:${addr}`)));

  /* eth_call for every [to, data] in batched JSON-RPC requests; returns the
     hex results in order. A reverted call fails the whole source. */
  async function evmCalls(c, calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += 40) {
      const part = calls.slice(i, i + 40);
      const res = await http(c.rpc, { body: part.map(([to, data], id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to, data }, "latest"] })) });
      for (const r of res) {
        if (r.error || !r.result) throw new SourceError(`${c.chain} RPC: ${r.error?.message || "пустой ответ"}`);
        out[i + r.id] = r.result;
      }
    }
    return out;
  }
  const word = (hex, i = 0) => BigInt("0x" + (hex.slice(2 + 64 * i, 66 + 64 * i) || "0"));
  const addrAt = (hex, i = 0) => "0x" + hex.slice(26 + 64 * i, 66 + 64 * i);
  /* an ABI string, or the bytes32 some old tokens return */
  function abiString(hex) {
    const bytes = (h) => new TextDecoder().decode(Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16))).replace(/\0/g, "");
    if (hex.length === 66) return bytes(hex.slice(2));
    const len = Number(word(hex, 1));
    return bytes(hex.slice(130, 130 + 2 * len));
  }
  const addrArg = (a) => a.slice(2).toLowerCase().padStart(64, "0");

  async function walletStables(wallet) {
    const data = "0x70a08231" + addrArg(wallet);  // balanceOf(wallet)
    const out = [];
    await pool(WALLET_STABLES, 4, async (c) => {
      const res = await evmCalls(c, c.tokens.map(([, to]) => [to, data]));
      const held = res.map((r, i) => [c.tokens[i], Number(BigInt(r)) / 10 ** c.tokens[i][2]]).filter(([, amount]) => amount > 0);
      const keys = held.filter(([t]) => t[3] === "llama").map(([t]) => `${c.llama}:${t[1]}`);
      const prices = keys.length ? (await http(`https://coins.llama.fi/prices/current/${keys.join(",")}`)).coins || {} : {};
      for (const [[symbol, addr, , priced], amount] of held) {
        const price = priced ? prices[`${c.llama}:${addr}`]?.price : 1;
        if (!price) throw new SourceError(`DefiLlama: нет цены ${symbol}`);
        if (amount * price < 1) continue;
        out.push({ id: `wallet:${wallet}:${c.zerion}:${addr}`, kind: "asset", source: "wallet", protocol: "Кошелёк", chain: c.chain,
          name: `${symbol} в кошельке`, symbols: [symbol], amount, value: amount * price });
      }
    });
    return out;
  }

  /* ------------------------------------------------------ Compound V3 */
  /* Compound V3 read on-chain from each Comet market (list: roots.json of each
     deployment in the compound-finance/comet repo): base supplied, base borrowed, collateral per
     asset. Comet prices its assets in the base feed's unit (USD in stable
     markets, ETH in the WETH ones), so HF = Σ collateral × price × liquidate
     factor / debt × base price, the protocol's own liquidation check; dollar
     values for a non-stable base come from DefiLlama. */
  const COMPOUND = [
    { chain: "Ethereum", zerion: "ethereum", llama: "ethereum", rpc: "https://ethereum-rpc.publicnode.com", comets: [
      "0xc3d688B66703497DAA19211EEdff47f25384cdc3", "0x5D409e56D886231aDAf00c8775665AD0f9897b56", "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
      "0xe85Dc543813B8c2CFEaAc371517b925a166a9293", "0xA17581A9E3356d9A858b789D68B4d866e593aE94", "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3"] },
    { chain: "Arbitrum", zerion: "arbitrum", llama: "arbitrum", rpc: "https://arbitrum-one-rpc.publicnode.com", comets: [
      "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07",
      "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486"] },
    { chain: "Base", zerion: "base", llama: "base", rpc: "https://base-rpc.publicnode.com", comets: [
      "0x784efeB622244d2348d4F2522f8860B96fbEcE89", "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", "0xb125E6687d4313864e53df431d5425969c15Eb2F",
      "0x2c776041CCFe903071AF44aa147368a9c8EEA518", "0x46e6b214b524310239732D51387075E0e70970bf"] },
    { chain: "Optimism", zerion: "optimism", llama: "optimism", rpc: "https://optimism-rpc.publicnode.com", comets: [
      "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB", "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214", "0xE36A30D249f7761327fd973001A32010b521b6Fd"] },
    { chain: "Polygon", zerion: "polygon", llama: "polygon", rpc: "https://polygon-bor-rpc.publicnode.com", comets: [
      "0xF25212E676D1F7F89Cd72fFEe66158f541246445", "0xaeB318360f27748Acb200CE616E389A6C9409a07"] },
    { chain: "Linea", zerion: "linea", llama: "linea", rpc: "https://linea-rpc.publicnode.com", comets: [
      "0x8D38A3d6B3c3B7d96D6536DA7Eef94A9d7dbC991", "0x60F2058379716A64a7A5d29219397e79bC552194"] },
    { chain: "Mantle", zerion: "mantle", llama: "mantle", rpc: "https://mantle-rpc.publicnode.com", comets: ["0x606174f62cd968d8e684c645080fa694c1D7786E"] },
    { chain: "Scroll", zerion: "scroll", llama: "scroll", rpc: "https://scroll-rpc.publicnode.com", comets: ["0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44"] },
    { chain: "Unichain", zerion: "unichain", llama: "unichain", rpc: "https://unichain-rpc.publicnode.com", comets: [
      "0x2c7118c4C88B9841FCF839074c26Ae8f035f2921", "0x6C987dDE50dB1dcDd32Cd4175778C2a291978E2a"] },
  ];
  const COMPOUND_ZERION = new Set(COMPOUND.map((c) => c.zerion));
  async function compound(wallet) {
    const user = addrArg(wallet);
    const out = [];
    await pool(COMPOUND, 4, async (c) => {
      // balanceOf, borrowBalanceOf, userBasic (its 4th word is the bitmap of collateral assets in use)
      const r1 = await evmCalls(c, c.comets.flatMap((m) => [[m, "0x70a08231" + user], [m, "0x374c49b4" + user], [m, "0xdc4abafd" + user]]));
      const active = c.comets.map((m, i) => ({ m, supply: word(r1[3 * i]), borrow: word(r1[3 * i + 1]), inUse: Number(word(r1[3 * i + 2], 3)) }))
        .filter((x) => x.supply || x.borrow || x.inUse);
      for (const x of active) {
        const idx = [...Array(16).keys()].filter((i) => x.inUse & (1 << i));
        // getAssetInfo(i), baseToken(), baseTokenPriceFeed(), decimals()
        const r2 = await evmCalls(c, [...idx.map((i) => [x.m, "0xc8c7fe6b" + i.toString(16).padStart(64, "0")]),
          [x.m, "0xc55dae63"], [x.m, "0xe7dad6bd"], [x.m, "0x313ce567"]]);
        const assets = idx.map((_, k) => ({ asset: addrAt(r2[k], 1), feed: addrAt(r2[k], 2), scale: Number(word(r2[k], 3)), lt: Number(word(r2[k], 5)) / 1e18 }));
        const n = assets.length, base = addrAt(r2[n]), baseFeed = addrAt(r2[n + 1]), baseDec = Number(word(r2[n + 2]));
        // collateralBalanceOf, getPrice and symbol() of each asset, then the base's price and symbol
        const r3 = await evmCalls(c, [...assets.flatMap((a) => [[x.m, "0x5c2549ee" + user + addrArg(a.asset)], [x.m, "0x41976e09" + addrArg(a.feed)], [a.asset, "0x95d89b41"]]),
          [x.m, "0x41976e09" + addrArg(baseFeed)], [base, "0x95d89b41"]]);
        const basePrice = Number(word(r3[3 * n])), baseSym = abiString(r3[3 * n + 1]);
        // dollars per unit of Comet's price feeds
        let usd = 1e-8;
        if (!isStable(baseSym)) {
          const key = `${c.llama}:${base}`;
          const p = (await http(`https://coins.llama.fi/prices/current/${key}`)).coins?.[key]?.price;
          if (!p) throw new SourceError(`DefiLlama: нет цены ${baseSym}`);
          usd = p / basePrice;
        }
        const label = `${baseSym} market`, id = `compound:${wallet}:${c.zerion}:${x.m.toLowerCase()}`;
        const coll = assets.map((a, k) => {
          const amount = Number(word(r3[3 * k])) / a.scale, price = Number(word(r3[3 * k + 1])) * usd;
          return { symbol: abiString(r3[3 * k + 2]), amount, price, value: amount * price, lt: a.lt, raw: amount * Number(word(r3[3 * k + 1])) * a.lt };
        }).filter((l) => l.amount > 0);
        const unit = basePrice * usd;
        if (x.supply) {
          const amount = Number(x.supply) / 10 ** baseDec;
          if (amount * unit >= 1) out.push({ id: `${id}:supply`, kind: "asset", source: "compound", protocol: "Compound V3", chain: c.chain,
            name: `${baseSym} supply`, symbols: [baseSym], amount, value: amount * unit });
        }
        const debt = Number(x.borrow) / 10 ** baseDec;
        if (debt * unit < 1) {
          for (const l of coll) if (l.value >= 1) out.push({ id: `${id}:${l.symbol}`, kind: "asset", source: "compound", protocol: "Compound V3",
            chain: c.chain, name: `${l.symbol} collateral`, symbols: [l.symbol], amount: l.amount, value: l.value });
          continue;
        }
        out.push({ id, kind: "lending", source: "compound", protocol: "Compound V3", chain: c.chain, name: label,
          collateral: coll.map(({ raw, ...l }) => l),
          debt: [{ symbol: baseSym, amount: debt, value: debt * unit }],
          hf: coll.reduce((a, l) => a + l.raw, 0) / (debt * basePrice) });
      }
    });
    return out;
  }

  /* ----------------------------------------------------------- Zerion */
  const OWN = (proto, chain) => proto === "Aave V3" || proto === "Aave V4" || proto === "Pendle" || /^Morpho/.test(proto || "") ||
    (proto === "GMX V2" && chain === "arbitrum") || (proto === "Compound V3" && COMPOUND_ZERION.has(chain));

  /* Zerion answers browsers only from localhost: requests go through this
     copy's own /zerion/ proxy, which adds the key. */
  const viaProxy = (url) => url.replace("https://api.zerion.io/", "zerion/");
  async function zerion(wallet) {
    if (!keys.zerion) throw new SourceError("нет ключа Zerion API");
    let url = `zerion/v1/wallets/${wallet}/positions/?filter%5Bpositions%5D=no_filter` +
      "&filter%5Btrash%5D=only_non_trash&currency=usd&page%5Bsize%5D=100";
    const groups = new Map();
    while (url) {
      const page = await http(url, { attempts: 4 });
      for (const p of page.data) {
        const a = p.attributes;
        const chain = p.relationships.chain.data.id;
        const proto = a.protocol;
        const value = Number(a.value || 0);
        const fi = a.fungible_info;
        const sym = fi.symbol;
        if (value < 0.5 || OWN(proto, chain)) continue;
        // Fluid vault NFTs ("Fluid Lending (#123)") on chains the Fluid source reads
        if (proto === "Fluid" && FLUID_ZERION.has(chain) && /\(#\d+\)/.test(a.name || "")) continue;
        // Aave aTokens on the wallet: already counted by the Aave source
        if (a.position_type === "wallet" && (/^a[A-Z][a-z]{2}[A-Z]/.test(sym) || (fi.name || "").includes("Aave"))) continue;
        // stablecoins read on-chain by the wallet source
        const here = fi.implementations?.find((x) => x.chain_id === chain);
        if (a.position_type === "wallet" && WALLET_STABLE_KEYS.has(`${chain}:${(here?.address || "").toLowerCase()}`)) continue;
        // Pendle PT / YT / LP tokens on the wallet: counted by the Pendle source
        if (a.position_type === "wallet" && /^(PT|YT)-|^PENDLE-LPT$/.test(sym)) continue;
        const gk = a.position_type === "wallet" ? "wallet" : `${chain}:${proto}:${a.name}`;
        if (!groups.has(gk)) groups.set(gk, { chain, protocol: proto || "Wallet", name: a.name, deposits: [], loans: [] });
        const leg = { symbol: sym, amount: Number(a.quantity.float), value, chain, price: a.price ? Number(a.price) : null };
        groups.get(gk)[a.position_type === "loan" ? "loans" : "deposits"].push(leg);
      }
      url = page.links?.next && viaProxy(page.links.next);
    }
    const out = [];
    for (const [gk, g] of groups) {
      const chain = g.chain[0].toUpperCase() + g.chain.slice(1);
      const value = g.deposits.reduce((a, d) => a + d.value, 0);
      if (gk === "wallet") {
        out.push({ id: `zerion:${wallet}:wallet`, kind: "asset", source: "zerion", protocol: "Wallet", chain: "EVM",
          name: "Кошелёк EVM", symbols: [...new Set(g.deposits.map((d) => d.symbol))].sort(), amount: null, value });
        continue;
      }
      const id = `zerion:${wallet}:${gk}`;
      if (g.loans.length) {
        // LT is unknown from Zerion: HF stays null and the UI flags it.
        out.push({ id, kind: "lending", source: "zerion", protocol: g.protocol, chain, name: g.name, hf: null,
          collateral: g.deposits.map((d) => ({ ...d, lt: null })),
          debt: g.loans.map(({ symbol, amount, value: v }) => ({ symbol, amount, value: v })) });
      } else {
        const syms = g.deposits.map((d) => d.symbol);
        out.push({ id, kind: "asset", source: "zerion", protocol: g.protocol, chain, name: g.name, symbols: syms,
          amount: new Set(syms).size === 1 ? g.deposits.reduce((a, d) => a + d.amount, 0) : null, value });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ zones */
  /* The CGS rules:
       Growth     BTC / ETH / SOL (or derivatives) as collateral, stables as debt
       Yield      GMX pools of BTC/USD and ETH/USD
       Stability  stablecoin loops, stables supplied to a lending protocol or Morpho vault, stable GMX pools, Pendle PT/LP of a stable
       Вне CGS    everything else (wallets, other protocols, other GMX pools, …) */
  const MAJOR = new Set(["BTC", "ETH", "SOL"]);
  const LENDING_SOURCES = new Set(["aave", "aave4", "kamino", "morpho", "fluid", "compound"]);
  function autoZone(p) {
    if (p.kind === "lending") {
      const coll = p.collateral.map((c) => c.symbol), debt = p.debt.map((d) => d.symbol);
      if (!coll.length) return "excluded";
      const stableDebt = debt.every(isStable);  // also true with no debt
      if (debt.length && stableDebt && coll.some((s) => MAJOR.has(assetClass(s))) && coll.every((s) => isStable(s) || MAJOR.has(assetClass(s)))) return "growth";
      if (stableDebt && coll.every(isStable)) return "stability";
      return "excluded";
    }
    const syms = p.symbols || [];
    if (!syms.length) return "excluded";
    // GMX pools here and on Solana; a Uniswap pool of BTC or ETH against a stable earns the same way
    if (p.source === "gmx" || p.source === "gmtrade" || (p.source === "zerion" && /^Uniswap/.test(p.protocol))) {
      if (syms.every(isStable)) return "stability";
      const cls = syms.filter((s) => !isStable(s)).map(assetClass);
      return cls.every((c) => c === "BTC" || c === "ETH") ? "yield" : "excluded";
    }
    // Fluid lending (fTokens) has no source of its own: Zerion lists it as "Fluid Yield: … Pool"
    if ((LENDING_SOURCES.has(p.source) || (p.source === "zerion" && p.protocol === "Fluid")) && syms.every(isStable)) return "stability";
    // a PT (or LP) of a stable is a fixed-rate stable deposit; a YT is a yield bet
    if (p.source === "pendle") return p.stable && p.leg !== "yt" ? "stability" : "excluded";
    return "excluded";
  }

  /* ------------------------------------------------------- scheduling */
  const SOURCES = {
    aave: { label: "Aave V3 API", type: "evm", fetch: aaveV3 },
    aave4: { label: "Aave V4 API", type: "evm", fetch: aaveV4 },
    kamino: { label: "Kamino API", type: "solana", fetch: kamino },
    gmx: { label: "GMX + Arbitrum RPC", type: "evm", fetch: gmx },
    pendle: { label: "Pendle API", type: "evm", fetch: pendle },
    morpho: { label: "Morpho API", type: "evm", fetch: morpho },
    fluid: { label: "Fluid API", type: "evm", fetch: fluid },
    compound: { label: "Compound V3 (RPC)", type: "evm", fetch: compound },
    gmtrade: { label: "GMTrade (индексатор + RPC)", type: "solana", fetch: gmtrade },
    wallet: { label: "Стейблы и cbHYPE в кошельке EVM (RPC)", type: "evm", fetch: walletStables },
    solana: { label: "Jupiter (кошелёк Solana)", type: "solana", fetch: solanaWallet },
    // Zerion only covers the leftovers, and only once the person has entered a key.
    zerion: { label: "Zerion", type: "evm", fetch: zerion, enabled: () => Boolean(keys.zerion) },
  };
  const HISTORY_EVERY = 3600;
  const tasks = () => wallets.flatMap((w) => Object.keys(SOURCES)
    .filter((s) => SOURCES[s].type === w.type && (SOURCES[s].enabled?.() ?? true))
    .map((s) => ({ key: `${s}:${w.address}`, source: s, wallet: w })));
  const running = new Set();
  /* No polling: sources are fetched when the page opens, on ⟳, and for a new
     wallet or key. Anything last fetched before forceAt is due again. */
  let forceAt = 0;

  function due(t) {
    const c = cache[t.key];
    return !c || ((c.okAt || 0) < forceAt && (c.errorAt || 0) < forceAt);
  }

  async function run(t) {
    running.add(t.key);
    changed();
    try {
      const positions = await SOURCES[t.source].fetch(t.wallet.address);
      cache[t.key] = { positions, okAt: now(), error: null, errorAt: null };
    } catch (e) {
      const msg = e instanceof SourceError ? e.message : `${e.name}: ${e.message}`;
      console.warn(`[cgs] ${t.key} failed:`, e);
      cache[t.key] = { ...(cache[t.key] || { positions: null, okAt: null }), error: msg, errorAt: now() };
    } finally {
      running.delete(t.key);
    }
    // a wallet removed meanwhile must not come back through the cache
    if (!tasks().some((x) => x.key === t.key)) delete cache[t.key];
    save(KEY.cache, cache);
    maybeSnapshot();
    changed();
  }

  function tick() {
    for (const t of tasks()) if (!running.has(t.key) && due(t)) run(t);
  }

  /* ------------------------------------------------------------ build */
  const walletName = (w, same) => (same > 1 ? ` · ${w.label || shortAddr(w.address)}` : "");
  const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  const positionValue = (p) => (p.kind === "lending"
    ? p.collateral.reduce((a, c) => a + c.value, 0) - p.debt.reduce((a, d) => a + d.value, 0) : p.value);

  function build() {
    const positions = [], status = [];
    const count = { evm: wallets.filter((w) => w.type === "evm").length, solana: wallets.filter((w) => w.type === "solana").length };
    const ts = tasks();
    for (const [name, src] of Object.entries(SOURCES)) {
      const mine = ts.filter((t) => t.source === name);
      if (!mine.length) continue;
      const states = mine.map((t) => cache[t.key] || {});
      const errors = states.filter((s) => s.error);
      status.push({
        name, label: src.label,
        okAt: Math.min(...states.map((s) => s.okAt || 0)) || null,
        error: errors.length ? errors.map((s) => s.error).join("; ") : null,
        errorAt: errors.length ? Math.max(...errors.map((s) => s.errorAt)) : null,
        loading: states.some((s) => !s.positions && !s.error),
      });
      for (const t of mine) {
        const s = cache[t.key];
        for (const p of s?.positions || []) {
          const auto = autoZone(p), own = config.zones[p.id];
          positions.push({
            ...p, wallet: t.wallet.address,
            name: p.protocol === "Wallet" ? p.name + walletName(t.wallet, count[t.wallet.type]) : p.name,
            defaultZone: auto, zone: own || auto, pinned: Boolean(own), stale: Boolean(s.error), updatedAt: s.okAt,
          });
        }
      }
    }
    for (const m of manual) {
      const base = { id: `manual:${m.id}`, source: "manual", protocol: "Вручную", chain: "—", name: m.name || "Новая позиция",
        zone: m.zone, defaultZone: m.zone, note: m.note || "", stale: false };
      const value = Number(m.value) || 0;
      // with a debt it is a loan like any other: LTV, HF and the common HF count it
      if (m.debt > 0) {
        const lt = m.lt > 0 ? m.lt / 100 : null;
        positions.push({ ...base, kind: "lending",
          collateral: [{ symbol: base.name, amount: m.qty ?? null, price: m.price ?? (m.qty ? value / m.qty : null), value, lt }],
          debt: [{ symbol: "USD", amount: m.debt, value: m.debt }], hf: lt ? (value * lt) / m.debt : null });
      } else positions.push({ ...base, kind: "manual", value });
    }
    return { now: now(), config: { ...config, wallets }, manual, positions, summary: summarize(positions), sources: status };
  }

  /* The sheet's CGS block: zone totals, common HF, S/G and Y/L. */
  function summarize(positions) {
    let growth = 0, debt = 0, weighted = 0, yld = 0, stab = 0, unassigned = 0, ltMissing = false;
    const prices = {};
    for (const p of positions) {
      if (p.kind === "lending") {
        for (const c of p.collateral) {
          const cls = assetClass(c.symbol);
          if (cls && c.price) prices[cls] ??= c.price;
        }
      }
      if (p.zone === "growth") {
        if (p.kind === "lending") {
          for (const c of p.collateral) {
            growth += c.value;
            if (c.lt == null) ltMissing = true;
            else weighted += c.value * c.lt;
          }
          debt += p.debt.reduce((a, d) => a + d.value, 0);
        } else growth += p.value;  // unborrowed collateral: counts for S/G, adds no borrowing power
      } else if (p.zone === "yield") yld += positionValue(p);
      else if (p.zone === "stability") stab += positionValue(p);
      else if (p.zone === "unassigned") unassigned += positionValue(p);
    }
    const t = config.targets;
    const share = t.stabilityShare / 100;
    const sgTarget = share / (1 - share);
    const sg = growth ? stab / growth : null;
    return {
      growth, debt, yield: yld, stability: stab, unassigned, weightedCollateral: weighted, ltMissing,
      total: growth - debt + yld + stab + unassigned,
      hf: debt ? weighted / debt : null, ltv: growth ? debt / growth : null,
      sg, sgTarget, sgOfTarget: sg != null ? sg / sgTarget : null,
      stabilityShare: stab + growth ? stab / (stab + growth) : null,
      yl: debt ? yld / debt : null, ylTarget: t.ylTarget / 100, prices,
    };
  }

  /* Hourly snapshot, only when every source answered (a partial total would
     draw a fake dip). Shared by all open tabs through localStorage. */
  function maybeSnapshot() {
    const ts = tasks();
    if (!ts.length || !ts.every((t) => cache[t.key]?.positions && !cache[t.key].error)) return;
    history = load(KEY.history, []);
    if (now() - (history.at(-1)?.t || 0) < HISTORY_EVERY) return;
    const s = build().summary;
    const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4), r2 = (x) => Math.round(x * 100) / 100;
    history.push({ t: Math.floor(now()), total: r2(s.total), hf: r4(s.hf), sg: r4(s.sg), yl: r4(s.yl),
      growth: r2(s.growth), debt: r2(s.debt), yield: r2(s.yield), stability: r2(s.stability) });
    save(KEY.history, history);
  }

  /* ---------------------------------------------------------- wallets */
  const EVM_RE = /^0x[0-9a-fA-F]{40}$/, SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const walletType = (a) => (EVM_RE.test(a) ? "evm" : SOL_RE.test(a) ? "solana" : null);
  const sameAddr = (a, b) => (a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);

  function addWallet({ address, label = "", via = "" }) {
    address = String(address).trim();
    const type = walletType(address);
    if (!type) throw new Error("Не похоже ни на EVM (0x…), ни на Solana адрес");
    if (wallets.some((w) => sameAddr(w.address, address))) return false;
    wallets = [...wallets, { id: Math.random().toString(36).slice(2, 10), type, address, label: label.slice(0, 40), via, addedAt: Math.floor(now()) }];
    save(KEY.wallets, wallets);
    tick();
    changed();
    return true;
  }
  function removeWallet(id) {
    const w = wallets.find((x) => x.id === id);
    if (!w) return;
    wallets = wallets.filter((x) => x.id !== id);
    for (const k of Object.keys(cache)) if (k.endsWith(`:${w.address}`)) delete cache[k];
    save(KEY.wallets, wallets);
    save(KEY.cache, cache);
    changed();
  }
  function setWalletLabel(id, label) {
    wallets = wallets.map((w) => (w.id === id ? { ...w, label: String(label).slice(0, 40) } : w));
    save(KEY.wallets, wallets);
    changed();
  }

  /* ------------------------------------------------- the old HTTP API */
  const ZONE_SET = new Set(["growth", "yield", "stability", "excluded", "unassigned"]);
  async function api(path, opts = {}) {
    await ready;
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === "GET" && path === "/api/portfolio") return build();
    if (method === "GET" && path === "/api/history") return history;
    if (method === "POST" && path === "/api/refresh") {
      forceAt = now();
      tick();
      return { ok: true };
    }
    if (method === "PUT" && path === "/api/manual") {
      if (!Array.isArray(body)) throw new Error("expected a list");
      manual = body.map((m) => {
        const value = Number(m.value || 0);
        if (!Number.isFinite(value)) throw new Error(`bad value for ${m.name}`);
        // optional loan fields (Growth): amount of collateral, its price, debt in $, liquidation LTV in %
        const opt = (x) => (x === "" || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
        const [qty, price, debt, lt] = [opt(m.qty), opt(m.price), opt(m.debt), opt(m.lt)];
        return { id: String(m.id || Math.random().toString(36).slice(2, 10)), name: String(m.name || "").slice(0, 80),
          zone: ZONE_SET.has(m.zone) ? m.zone : "stability", value: qty > 0 && price > 0 ? qty * price : value,
          note: String(m.note || "").slice(0, 200), qty, price, debt, lt };
      });
      save(KEY.manual, manual);
      return build();
    }
    if (method === "PUT" && path === "/api/config") {
      if (body.zone) {
        // "auto", or picking what the rules would pick anyway, drops the override
        const { id, zone } = body.zone;
        const m = manual.find((x) => `manual:${x.id}` === id);
        const p = build().positions.find((x) => x.id === id);
        if (m) {
          if (zone === "unassigned" || !ZONE_SET.has(zone)) throw new Error("bad zone");
          m.zone = zone;
          save(KEY.manual, manual);
        } else if (zone === "auto" || zone === p?.defaultZone) delete config.zones[id];
        else if (ZONE_SET.has(zone)) config.zones[id] = zone;
        else throw new Error("bad zone");
      }
      for (const k of ["usd", "pct"]) {
        if (!body.format || !(k in body.format)) continue;
        const v = body.format[k];
        config.format[k] = v === null || v === "" || v === "auto" ? null : Math.max(0, Math.min(2, Math.round(Number(v)) || 0));
      }
      for (const section of ["targets", "crash"]) {
        for (const [k, v] of Object.entries(body[section] || {})) if (k in config[section]) config[section][k] = Number(v);
      }
      save(KEY.config, config);
      return build();
    }
    throw new Error(`${method} ${path}: not found`);
  }

  /* ---------------------------------------------------------- startup */
  /* First run in this browser: adopt what the old Python server kept in data/
     (if this copy has it), so switching over loses no settings or history. */
  const RULES = 2;
  async function migrate() {
    try {
      if (localStorage.getItem(KEY.config) !== null) return pinPreviousZones();
    } catch { return; }  // storage blocked: run in memory only
    try {
      const r = await fetch("api/seed");
      if (r.ok) {
        const seed = await r.json();
        const c = seed.config || {};
        config = withDefaults({ targets: c.targets, crash: c.crash, zones: c.zones });
        const old = c.wallets || {};
        for (const [type, address] of Object.entries(old)) {
          if (!address || walletType(address) !== type) continue;
          wallets.push({ id: Math.random().toString(36).slice(2, 10), type, address, label: "", via: "перенесён", addedAt: Math.floor(now()) });
        }
        if (Array.isArray(seed.manual)) manual = seed.manual;
        if (Array.isArray(seed.history)) history = seed.history;
        save(KEY.wallets, wallets);
        save(KEY.manual, manual);
        save(KEY.history, history);
      }
    } catch { /* plain static hosting: start empty */ }
    config.rules = RULES;
    save(KEY.config, config);
  }

  /* The zone rules changed (RULES 1 -> 2): positions this browser already
     shows keep the zone they had, as the person's own choice, so nothing moves
     under them. Only positions added from now on follow the new rules.
     Cached positions still carry the old rules' defaultZone. */
  function pinPreviousZones() {
    if ((config.rules || 1) >= RULES) return;
    for (const c of Object.values(cache)) {
      for (const p of c.positions || []) {
        const before = config.zones[p.id] || p.defaultZone;
        if (!before || before === "unassigned" || before === autoZone(p)) delete config.zones[p.id];
        else config.zones[p.id] = before;
      }
    }
    // Aave V4 now has its own source; Zerion's cached copy would count it twice
    for (const k of Object.keys(cache)) if (k.startsWith("zerion:")) delete cache[k];
    save(KEY.cache, cache);
    config.rules = RULES;
    save(KEY.config, config);
  }

  /* One setup for everyone who opens this copy (keys.json): whether its
     Zerion proxy has a key, and the WalletConnect project ID. Keys an earlier
     version kept per browser are dropped. */
  const keys = { zerion: false, walletconnect: "" };
  async function loadKeys() {
    if (config.keys) {
      delete config.keys;
      save(KEY.config, config);
    }
    try {
      const r = await fetch("keys.json");
      if (r.ok) Object.assign(keys, await r.json());
    } catch { /* plain static hosting: no keys, Zerion and WalletConnect stay off */ }
  }

  /* Everything the person set up, as one file for another browser or site
     (the cache is left out: positions are fetched again). */
  const backup = () => ({ cgs: 1, wallets, manual, config, history });
  function restore(b) {
    if (b?.cgs !== 1 || !Array.isArray(b.wallets) || !Array.isArray(b.manual)) throw new Error("это не копия CGS");
    save(KEY.wallets, b.wallets);
    save(KEY.manual, b.manual);
    save(KEY.config, withDefaults(b.config));
    save(KEY.history, Array.isArray(b.history) ? b.history : []);
    localStorage.removeItem(KEY.cache);
  }

  const ready = migrate().then(loadKeys).then(() => {
    forceAt = now();
    tick();
  });

  return {
    api, ready, build,
    wallets: () => wallets, addWallet, removeWallet, setWalletLabel, walletType,
    keys: () => ({ ...keys }), backup, restore,
    isRunning: () => running.size > 0,
  };
})();
