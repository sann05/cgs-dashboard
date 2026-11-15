"use strict";
/* Formatting, CGS maths and the API shim, used by compact.js. */

/* ------------------------------------------------------------ formatting */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const NF = {};
const nf = (d) => (NF[d] ??= new Intl.NumberFormat("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ok = (x) => x != null && Number.isFinite(x);
/* Decimals picked in Параметры (null = automatic); compact.js sets them on render. */
const FMT = { usd: null, pct: null };
const usd = (v, d) => {
  if (!ok(v)) return "—";
  const digits = FMT.usd ?? d ?? (Math.abs(v) < 1000 ? 2 : 0);
  return (v < 0 ? "−" : "") + "$" + nf(digits).format(Math.abs(v));
};
const usdK = (v) => {
  if (!ok(v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${nf(2).format(a / 1e6)}M`;
  if (a >= 1e3) return `${s}$${nf(1).format(a / 1e3)}k`;
  return `${s}$${nf(0).format(a)}`;
};
// LTV-like ratios pass fixed = true and keep their own decimals
const pct = (x, d = 1, fixed = false) => (ok(x) ? nf(fixed ? d : FMT.pct ?? d).format(x * 100) + "%" : "—");
const num = (x, d = 2) => (ok(x) ? nf(d).format(x) : "—");
const amt = (x) => {
  if (!ok(x)) return "";
  const a = Math.abs(x);
  return nf(a >= 1000 ? 0 : a >= 100 ? 2 : a >= 1 ? 4 : 6).format(x);
};
const ago = (ts) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  return `${Math.floor(s / 3600)} ч назад`;
};
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
/* "2 500 + 707,5" -> 3207.5; the sheet kept running sums in cells, so allow + and - */
const parseMoney = (str) => {
  const s = String(str).replace(/[\s $%]/g, "").replace(/,/g, ".").replace(/[−–]/g, "-");
  if (!/^[-+]?\d*\.?\d+([-+]\d*\.?\d+)*$/.test(s)) return NaN;
  return s.match(/[-+]?\d*\.?\d+/g).reduce((a, b) => a + Number(b), 0);
};

/* --------------------------------------------------------------- domain */
const ZONES = ["growth", "yield", "stability", "excluded", "unassigned"];
const ZONE_NAME = { growth: "Growth", yield: "Yield", stability: "Stability", excluded: "Вне CGS", unassigned: "Без зоны" };
const assetClass = (sym) => {
  const s = sym.toUpperCase();
  if (s.includes("BTC")) return "BTC";
  if (s === "ETH" || s === "WETH" || s.endsWith("ETH")) return "ETH";
  if (s === "SOL" || s.endsWith("SOL")) return "SOL";
  return null;
};
const collValue = (p) => p.collateral.reduce((a, c) => a + c.value, 0);
const debtValue = (p) => p.debt.reduce((a, d) => a + d.value, 0);
const posValue = (p) => (p.kind === "lending" ? collValue(p) - debtValue(p) : p.value);
const hfState = (hf, t) => (!ok(hf) ? "" : hf < t.hfLow ? "crit" : hf > t.hfHigh ? "warn" : "ok");

const ICONS = {
  ok: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  crit: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/></svg>',
};
const statusPill = (state, label) => `<span class="status ${state}">${ICONS[state] || ""}${esc(label)}</span>`;

/* token / chain avatars: glyph + brand-ish colour, no remote images */
const TOKEN = [
  [/^PT-|^LP /, "PT", "#13c2a3"], [/^YT-/, "YT", "#13c2a3"], [/BTC/i, "₿", "#F7931A"], [/^(W?ETH|.*ETH)$/i, "Ξ", "#627EEA"], [/SOL$/i, "◎", "linear-gradient(135deg,#9945FF,#14F195)"],
  [/^JLP$/i, "JLP", "linear-gradient(135deg,#1e2a3a,#c7f284)"], [/^syrup/i, "SY", "#ff6a3d"],
  [/^USDC/i, "$", "#2775CA"], [/^USD|DAI|PYUSD|GHO/i, "$", "#1f9e78"], [/^AAVE/i, "A", "#9a63c9"],
];
const CHAIN = { Base: ["B", "#0052FF"], Arbitrum: ["A", "#28A0F0"], Celo: ["C", "#35d07f"], Solana: ["S", "#9945FF"], Ethereum: ["E", "#627EEA"], Avalanche: ["A", "#E84142"] };
function avatar(p) {
  let glyph = "•", bg = "#33405a";
  const sym = p.kind === "lending" ? p.collateral[0]?.symbol || "" : (p.symbols || [])[0] || "";
  if (p.source === "gmx") [glyph, bg] = p.name.startsWith("GLV") ? ["GLV", "#4a5bff"] : ["GM", "#2d42fc"];
  else if (p.protocol === "Wallet") [glyph, bg] = ["W", "#33405a"];
  else if (p.source === "manual") {
    const n = p.name.toLowerCase();
    [glyph, bg] = n.includes("ton") ? ["TON", "#0098EA"] : n.includes("poker") || n.includes("покер") ? ["♠", "#b83a4b"]
      : n.includes("loan") || n.includes("займ") ? ["%", "#7c5cf0"] : ["✎", "#33405a"];
  } else {
    for (const [re, g, c] of TOKEN) if (re.test(sym)) { [glyph, bg] = [g, c]; break; }
    if (glyph === "•" && sym) glyph = sym.slice(0, 3).toUpperCase();
  }
  const ch = CHAIN[p.chain];
  const sub = ch ? `<i class="sub-av" style="background:${ch[1]}">${ch[0]}</i>` : "";
  const fs = glyph.length > 2 ? "10px" : glyph.length > 1 ? "11px" : "16px";
  return `<span class="avatar" style="background:${bg};font-size:${fs}">${esc(glyph)}${sub}</span>`;
}

/* The views talk to the in-browser data engine (data.js) as if it were a server. */
const api = (path, opts) => CGS.api(path, opts);

const short = (a) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/* The CGS trigger: act only when the common HF leaves [hfLow, hfHigh].
   Below: Stability stables are converted into collateral. Above: borrow more
   into Stability. Amounts bring the common HF back to hfTarget. */
const sgText = (S, G) => pct(S / G);

/* Bring the common HF to hfTarget. Below it: sell from Stability and Yield and
   buy collateral — first from the zone further above its target (S/G % of target
   vs Y/L % of target, measured after the purchase), then from both so that the
   two end at the same % of target. Above it: borrow into Stability (the user's
   rule, unchanged). */
function rebalance(s, t) {
  if (!ok(s.hf)) return null;
  const D = s.debt, CL = s.weightedCollateral, G = s.growth, S = Math.max(0, s.stability), Y = Math.max(0, s.yield);
  const avgLt = CL / G, r = s.sgTarget, yt = s.ylTarget;
  const of = (st, y, g, d) => ({ sgOf: st / g / r, ylOf: y / d / yt });
  if (s.hf < t.hfTarget) {
    const need = (t.hfTarget * D - CL) / avgLt;
    const X = Math.min(need, S + Y);
    const A = (G + X) * r, B = D * yt;
    const k = (S + Y - X) / (A + B);
    let fromS = S - k * A, fromY = Y - k * B;
    if (fromS < 0) [fromS, fromY] = [0, X];
    if (fromY < 0) [fromS, fromY] = [X, 0];
    return {
      dir: "take", need, total: X, fromS, fromY, short: need - X,
      hf: (CL + X * avgLt) / D, sg: (S - fromS) / (G + X), yl: (Y - fromY) / D,
      ...of(S - fromS, Y - fromY, G + X, D), before: of(S, Y, G, D),
    };
  }
  const borrow = CL / t.hfTarget - D;
  return {
    dir: "borrow", need: borrow, total: borrow, fromS: -borrow, fromY: 0, short: 0,
    hf: t.hfTarget, sg: (S + borrow) / G, yl: Y / (D + borrow),
    ...of(S + borrow, Y, G, D + borrow), before: of(S, Y, G, D),
  };
}

function signal(s, t) {
  if (!ok(s.hf)) return { state: "ok", label: "Нет займа", title: "В Growth Zone нет долга", lines: [] };
  const D = s.debt, CL = s.weightedCollateral, G = s.growth, S = s.stability;
  if (s.hf < t.hfLow) {
    const rb = rebalance(s, t);
    return {
      state: "crit", label: "Нужно действие", title: `HF ${num(s.hf)} ниже ${num(t.hfLow)} — Stable/Yield → залог`,
      note: rb.short > 0.5
        ? `В Stability и Yield только ${usd(rb.total, 0)}: HF поднимется до ${num(rb.hf)}, не до ${num(t.hfTarget)}`
        : `Купить залог на деньги из Stability и Yield, HF → ${num(t.hfTarget)}`,
      lines: [["Из Stability в залог", usd(rb.fromS, 0)], ["Из Yield в залог", usd(rb.fromY, 0)]],
    };
  }
  if (s.hf > t.hfHigh) {
    const borrow = CL / t.hfTarget - D;
    return {
      state: "warn", label: "Нужно действие", title: `HF ${num(s.hf)} выше ${num(t.hfHigh)} — долг → Stable`,
      note: `Занять стейблы и положить в Stability Zone, HF → ${num(t.hfTarget)}`,
      lines: [["Занять в Stability", usd(borrow, 0)], ["S/G · Y/L после", `${sgText(S + borrow, G)} · ${pct(s.yield / (D + borrow), 0)}`]],
    };
  }
  const down = 1 - (t.hfLow * D) / CL, up = (t.hfHigh * D) / CL - 1;
  return {
    state: "ok", label: "В коридоре", title: "Действий не требуется",
    note: "При пополнении — выровнять S/G и Y/L",
    lines: [
      [`Залог −${pct(down, 0)} → HF ${num(t.hfLow, 1)}`, "Stable → залог"],
      [`Залог +${pct(up, 0)} → HF ${num(t.hfHigh, 1)}`, "долг → Stable"],
    ],
  };
}

function lendingTitle(p) {
  const c = [...new Set(p.collateral.map((x) => x.symbol))].join(" + ");
  const d = [...new Set(p.debt.map((x) => x.symbol))].join(" + ");
  return d ? `${c} → ${d}` : c;
}
function liquidation(p) {
  if (p.collateral.length !== 1) return null;
  const c = p.collateral[0];
  if (!ok(c.amount) || !ok(c.price) || !c.lt || !assetClass(c.symbol)) return null;
  const price = debtValue(p) / (c.amount * c.lt);
  return { price, drop: 1 - price / c.price };
}

/* ----------------------------------------------------- deposit planner */
function plan(X, s, t) {
  const r = s.sgTarget, G = s.growth, S = s.stability, Y = s.yield, D = s.debt;
  const yNeed = Math.max(0, D * (t.ylTarget / 100) - Y);
  const sNeed = S < r * G ? r * G - S : 0;
  const gNeed = S > r * G ? S / r - G : 0;
  const need = yNeed + sNeed + gNeed;
  let y, g, st;
  if (X <= need) {
    const k = need ? X / need : 0;
    [y, g, st] = [yNeed * k, gNeed * k, sNeed * k];
  } else {
    const rest = X - need;
    [y, g, st] = [yNeed, gNeed + rest / (1 + r), sNeed + (rest * r) / (1 + r)];
  }
  const avgLt = G ? s.weightedCollateral / G : 0;
  return {
    y, g, st, yNeed, sNeed, gNeed,
    hf: D ? (s.weightedCollateral + g * avgLt) / D : null,
    sg: (S + st) / (G + g), share: (S + st) / (S + st + G + g),
    yl: D ? (Y + y) / D : null,
  };
}

/* ------------------------------------------------------------- history */
const METRICS = {
  total: { fmt: (v) => usdK(v), full: (v) => usd(v, 0) },
  hf: { fmt: (v) => num(v), full: (v) => num(v) },
  sg: { fmt: (v) => pct(v, 0), full: (v) => pct(v) },
  yl: { fmt: (v) => pct(v, 0), full: (v) => pct(v) },
};

/* Warnings shown above the positions: per-position HF, failing sources,
   positions without a zone, unknown liquidation thresholds. */
function notices(data) {
  const t = data.config.targets;
  const out = [];
  for (const p of data.positions) {
    if (p.zone === "growth" && p.kind === "lending" && ok(p.hf) && p.hf < t.hfLow) {
      out.push(["crit", `${p.protocol} ${p.name}: HF ${num(p.hf)} ниже ${num(t.hfLow)}. Ликвидация считается по каждой позиции отдельно — общий HF её не защищает.`]);
    }
  }
  for (const s of data.sources) {
    if (s.error) {
      out.push(["warn", `${s.label}: ошибка с ${clock(s.errorAt)} (${s.error}). ${s.okAt ? `Показаны данные на ${clock(s.okAt)}.` : "Данных пока нет — итоги неполные."}`]);
    }
  }
  const un = data.positions.filter((p) => p.zone === "unassigned");
  if (un.length) out.push(["warn", `Новые позиции без зоны: ${un.map((p) => `${p.protocol} ${p.name}`).join(", ")}. Они входят в Total Value, но не в S/G и Y/L — выберите зону ниже.`]);
  if (data.summary.ltMissing) out.push(["warn", "У части залога Growth Zone неизвестен порог ликвидации (данные Zerion или ручная позиция без Liq LTV) — общий HF занижен."]);
  return out;
}

/* Crash test: collateral falls by drops[class]; the Stability Zone repays debt. */
function crashTest(positions, s, drops) {
  let CLa = 0, Ga = 0;
  const rows = positions.filter((p) => p.zone === "growth" && p.kind === "lending").map((p) => {
    let cl = 0;
    for (const c of p.collateral) {
      const d = drops[assetClass(c.symbol)] ?? drops.BTC ?? 0;
      cl += c.value * (1 - d) * (c.lt || 0);
      Ga += c.value * (1 - d);
    }
    CLa += cl;
    return { p, liq: liquidation(p), hfAfter: debtValue(p) ? cl / debtValue(p) : null, price: p.collateral[0]?.price };
  });
  const D = s.debt, S = Math.max(0, s.stability);
  const left = Math.max(0, D - S);
  const hfWith = left > 0 ? CLa / left : Infinity;
  return { rows, Ga, S, left, hfNo: D ? CLa / D : null, hfWith, pass: hfWith >= 1 };
}

/* Line chart of one history metric, with a crosshair tooltip (#tooltip). The
   area/line colour comes from CSS (--chart-line), so each view themes it. */
function drawChart(box, histRows, histMetric, data) {
  const pts = histRows.filter((h) => ok(h[histMetric])).map((h) => ({ t: h.t, v: h[histMetric] }));
  if (pts.length < 2) {
    box.innerHTML = `<div class="empty-msg">История копится: снимок делается раз в час, пока работает сервер.<br>${histRows.length ? `Первый снимок — ${new Date(histRows[0].t * 1000).toLocaleString("ru-RU")}` : ""}</div>`;
    return;
  }
  const t = data?.config.targets;
  const W = box.clientWidth, H = box.clientHeight, m = { l: 56, r: 12, t: 10, b: 26 };
  const xs = pts.map((p) => p.t), ys = pts.map((p) => p.v);
  let refs = [];
  if (t && histMetric === "hf") refs = [t.hfLow, t.hfHigh];
  if (histMetric === "sg" && data) refs = [data.summary.sgTarget];
  if (histMetric === "yl" && data) refs = [data.summary.ylTarget];
  let y0 = Math.min(...ys, ...refs), y1 = Math.max(...ys, ...refs);
  const pad = (y1 - y0) * 0.12 || Math.abs(y1) * 0.05 || 1;
  y0 -= pad; y1 += pad;
  const x0 = xs[0], x1 = xs.at(-1);
  const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const ticks = Array.from({ length: 4 }, (_, i) => y0 + ((y1 - y0) * (i + 0.5)) / 4);
  const days = (x1 - x0) / 86400;
  const xfmt = (v) => new Date(v * 1000).toLocaleString("ru-RU", days > 2 ? { day: "numeric", month: "short" } : { hour: "2-digit", minute: "2-digit" });
  const seen = new Set();
  const xt = Array.from({ length: 5 }, (_, i) => x0 + ((x1 - x0) * i) / 4).filter((v) => !seen.has(xfmt(v)) && seen.add(xfmt(v)));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const band = histMetric === "hf" && t ? `<rect class="band" x="${m.l}" width="${W - m.l - m.r}" y="${Y(t.hfHigh)}" height="${Y(t.hfLow) - Y(t.hfHigh)}"/>` : "";
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="История: ${esc(histMetric)}">
    <defs><linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--chart-line)" stop-opacity="0.22"/><stop offset="1" style="stop-color:var(--chart-line)" stop-opacity="0"/></linearGradient></defs>
    ${band}
    <g class="grid">${ticks.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("")}</g>
    <g class="axis">${ticks.map((v) => `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${esc(METRICS[histMetric].fmt(v))}</text>`).join("")}
      ${xt.map((v, i) => `<text x="${X(v)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === xt.length - 1 ? "end" : "middle"}">${esc(xfmt(v))}</text>`).join("")}</g>
    ${refs.map((r) => `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${Y(r)}" y2="${Y(r)}"/>`).join("")}
    <path class="area" d="${path}L${X(x1)},${H - m.b}L${X(x0)},${H - m.b}Z"/>
    <path class="line" d="${path}"/>
    <line class="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <circle class="pt" r="4.5" visibility="hidden"/>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" class="hit"/>
  </svg>`;
  const svg = box.querySelector("svg"), cross = svg.querySelector(".cross"), dot = svg.querySelector(".pt"), tip = $("#tooltip");
  const hit = svg.querySelector(".hit");
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const tv = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const p = pts.reduce((a, b) => (Math.abs(b.t - tv) < Math.abs(a.t - tv) ? b : a));
    cross.setAttribute("x1", X(p.t)); cross.setAttribute("x2", X(p.t)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(p.t)); dot.setAttribute("cy", Y(p.v)); dot.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(METRICS[histMetric].full(p.v))}</b><span>${esc(new Date(p.t * 1000).toLocaleString("ru-RU"))}</span>`;
    tip.style.left = `${Math.min(window.innerWidth - 180, e.clientX + 14)}px`;
    tip.style.top = `${e.clientY - 50}px`;
  });
  hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
}
