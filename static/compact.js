"use strict";
/* One-screen view: KPI strip, the three zones as dense tables, signal /
   deposit planner on the right. Manual rows are edited inline.
   Shared formatting and CGS maths live in core.js. */

let data = null;
let histRows = [];
let histMetric = "total";
const openDust = new Set();
const DUST = 100;

async function load() {
  try {
    data = await api("/api/portfolio");
    render();
  } catch {
    $("#upd").textContent = "Сервер недоступен";
    $("#upd").className = "upd err";
  }
}
async function loadHistory() {
  try {
    histRows = await api("/api/history");
    if (data) renderStrip();
    if ($("#history").open) renderChart();
  } catch { /* keep the last render */ }
}

/* Don't rebuild a table under the cursor while a manual value is being typed. */
const editing = () => document.activeElement?.classList.contains("ed");

function render() {
  if (!data) return;
  Object.assign(FMT, data.config.format);
  $("#wallets").innerHTML = Wallets.chips(data.config.wallets) +
    `<button class="add-w" data-wallets title="Добавить или удалить кошельки, ключи API">+ ${data.config.wallets.length ? "Кошелёк" : "Добавить кошелёк"}</button>`;
  renderUpdated();
  renderStrip();
  $("#notices").innerHTML = notices(data).map(([c, m]) => `<div class="notice ${c}">${ICONS[c === "crit" ? "crit" : "warn"]}<span>${esc(m)}</span></div>`).join("");
  if (!editing()) renderTables();
  renderSignal();
  renderRebalance();
  renderPlanner();
  renderSources();
}

function renderUpdated() {
  if (!data) return;
  const src = data.sources;
  const errors = src.filter((s) => s.error), loading = src.filter((s) => s.loading);
  const last = Math.max(0, ...src.map((s) => s.okAt || 0));
  $("#upd").className = errors.length ? "upd err" : "upd";
  $("#upd").textContent = loading.length ? `Загрузка ${src.length - loading.length}/${src.length}…`
    : `Обновлено ${ago(last)}${errors.length ? ` · ошибок: ${errors.length}` : ""}`;
}

/* ---------------------------------------------------------- KPI strip */
function spark() {
  const pts = histRows.filter((h) => h.t >= Date.now() / 1000 - 7 * 86400 && ok(h.total));
  if (pts.length < 2) return "";
  const W = 120, H = 40, ys = pts.map((p) => p.total), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 3 - ((p.total - y0) / (y1 - y0 || 1)) * (H - 8)).toFixed(1)}`).join("");
  const c = pts.at(-1).total >= pts[0].total ? "var(--ok)" : "var(--crit)";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}L${W},${H}L0,${H}Z" fill="${c}" opacity="0.1"/><path d="${d}" fill="none" stroke="${c}" stroke-width="1.5" vector-effect="non-scaling-stroke" opacity="0.7"/></svg>`;
}
/* A ratio tile led by its % of target: within ±10% of the target is on track.
   The bar runs 0–150% with a tick at 100%. */
function ofTarget(name, v, detail) {
  if (!ok(v)) return `<div class="kpi"><span>${name} · от цели</span><b>—</b></div>`;
  const st = Math.abs(v - 1) <= 0.1 ? "ok" : "warn";
  return `<div class="kpi of"><span>${name} · от цели</span><b class="${st}">${pct(v, 0)}<small>${detail}</small></b>
    <div class="mbar"><i class="fill ${st}" style="width:${(Math.min(v, 1.5) / 1.5) * 100}%"></i><i class="tick" style="left:${100 / 1.5}%"></i></div></div>`;
}
function renderStrip() {
  const s = data.summary, t = data.config.targets;
  const ref = [...histRows].reverse().find((h) => h.t <= Date.now() / 1000 - 20 * 3600);
  const delta = ref ? (s.total - ref.total) / ref.total : null;
  const st = hfState(s.hf, t);
  const lo = 1.0, hi = 2.6, x = (v) => `${((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100}%`;
  const sig = signal(s, t);
  $("#strip").innerHTML = `
    <div class="kpi total"><span>Total Value</span><b>${usd(s.total, 0)}</b>
      <em>${ok(delta) ? `<span class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${pct(delta, 2)}</span> за ${Math.round((Date.now() / 1000 - ref.t) / 3600)} ч` : "история копится"}</em>${spark()}</div>
    <div class="kpi"><span>Common HF</span><b class="${st}">${num(s.hf)}<small>коридор ${num(t.hfLow, 1)}–${num(t.hfHigh, 1)}</small></b>
      <div class="mbar"><i class="band" style="left:${x(t.hfLow)};width:calc(${x(t.hfHigh)} - ${x(t.hfLow)})"></i>${ok(s.hf) ? `<b style="left:${x(s.hf)}"></b>` : ""}</div></div>
    ${ofTarget("S/G", s.sgOfTarget, `${pct(s.sg)} / ${pct(s.sgTarget)}`)}
    ${ofTarget("Y/L", ok(s.yl) ? s.yl / s.ylTarget : null, `${usdK(s.yield)} / ${usdK(s.debt)}`)}
    <div class="kpi"><span>Залог / Долг</span><b>${usdK(s.growth)}<small>/ ${usdK(s.debt)}</small></b><em>LTV ${pct(s.ltv, 1, true)}</em></div>
    <div class="kpi sig ${sig.state}"><span class="sig-ico">${ICONS[sig.state]}</span>
      <div><strong>${esc(sig.title)}</strong><em>${esc(sig.lines.map(([k, v]) => `${k}: ${v}`).join(" · "))}</em></div></div>`;
}

/* -------------------------------------------------------------- tables */
const ZONE_OPTS = { growth: "Growth", yield: "Yield", stability: "Stab.", excluded: "Вне CGS" };
function zoneSelect(p) {
  const opts = Object.entries(ZONE_OPTS).map(([z, n]) => `<option value="${z}" ${p.zone === z ? "selected" : ""}>${n}</option>`);
  if (p.zone === "unassigned") opts.unshift(`<option value="unassigned" selected>Зона…</option>`);
  // a zone picked by hand (not by the rules) is marked and can go back to auto
  if (p.pinned) opts.push(`<option value="auto">↺ Авто: ${ZONE_OPTS[p.defaultZone] || p.defaultZone}</option>`);
  return `<select class="zs${p.pinned ? " pinned" : ""}" data-id="${esc(p.id)}" aria-label="Зона"
    title="${p.source === "manual" ? "Ручная позиция" : p.pinned ? `Выбрано вручную; по правилам — ${ZONE_NAME[p.defaultZone]}` : "Выбрано по правилам CGS"}">${opts.join("")}</select>`;
}
const stale = (p) => (p.stale ? `<span class="stale" title="Источник не ответил — данные на ${clock(p.updatedAt)}">●</span>` : "");
/* A manual row's editable cells, in whichever table it sits: name, $ value,
   zone (+ delete), and for Growth the loan fields. A field not filled in yet
   is empty (placeholder only), so typing never mixes with a shown "0,00". */
const money = (v) => (v < 0 ? "−" : "") + "$" + nf(FMT.usd ?? 2).format(Math.abs(v));
const plain = (v) => String(v).replace(".", ",");
function manualCells(p) {
  const m = data.manual.find((x) => `manual:${x.id}` === p.id);
  const input = (f, val, label, ph, cls = "v") =>
    `<input class="ed ${cls}" data-f="${f}" value="${esc(val)}" placeholder="${ph}" inputmode="decimal" aria-label="${label}">`;
  return {
    name: `<div class="nm">${avatar(p)}<input class="ed" data-f="name" value="${esc(m.name)}" placeholder="Новая позиция" title="${esc(m.note || "Ручная позиция")}" aria-label="Название"></div>`,
    value: `<input class="ed v" data-f="value" value="${m.value ? esc(money(m.value)) : ""}" placeholder="$0" inputmode="decimal" aria-label="Сумма, $" title="Можно выражение: 2500 + 707">`,
    qty: input("qty", ok(m.qty) ? plain(m.qty) : "", "Количество залога", "кол-во", "v s"),
    price: input("price", ok(m.price) ? money(m.price) : "", "Цена залога, $", "$", "v s"),
    debt: input("debt", ok(m.debt) ? money(m.debt) : "", "Долг, $", "$0"),
    lt: input("lt", ok(m.lt) ? `${plain(m.lt)}%` : "", "Liq LTV, %", "%", "v xs"),
    zone: `<select class="zs" data-f="zone" aria-label="Зона">${Object.entries(ZONE_OPTS).map(([k, n]) => `<option value="${k}" ${m.zone === k ? "selected" : ""}>${n}</option>`).join("")}</select>
      <button class="x" data-del="${esc(m.id)}" title="Удалить" aria-label="Удалить">✕</button>`,
  };
}
/* Short names for the narrow tables: "dHEDGE Yield: USDC Pool" -> "dHEDGE USDC",
   "GM BTC/USD [WBTC.b-USDC]" -> "GM BTC/USD", "Aave V4 Lending" -> "Aave V4 USDG". */
const titleOf = (p) => {
  if (p.source === "manual") return p.name;
  if (p.kind === "lending") {
    const lt = lendingTitle(p);
    return lt.startsWith(p.name.split(" ·")[0]) ? lt : `${lt} · ${p.name}`;
  }
  if (p.source === "gmx") return p.name.replace(/\s*\[(.*)\]$/, (_, m) => (p.name.startsWith("GLV") ? ` ${[...new Set(m.split("-"))].join("/")}` : "")).replace(/^GLV\s+/, "GLV ");
  if (p.protocol === "Wallet" || !p.name.startsWith(p.protocol)) return p.name;
  const rest = p.name.slice(p.protocol.length).replace(/^\s*(Yield:|Lending)?\s*/, "").replace(/\s*(Pool|Lending)$/, "");
  return `${p.protocol} ${rest || [...new Set(p.symbols || [])].join("/")}`;
};
const subOf = (p) => (p.source === "manual" ? "" : p.kind === "lending" || p.source === "gmx" || p.name.startsWith(p.protocol)
  ? (p.chain !== "EVM" ? p.chain : "") : `${p.protocol === "Wallet" ? "" : p.protocol + " · "}${p.chain !== "EVM" ? p.chain : ""}`);

function renderTables() {
  const s = data.summary, t = data.config.targets;
  const by = Object.fromEntries(ZONES.map((z) => [z, []]));
  for (const p of data.positions) (by[p.zone] || by.unassigned).push(p);
  const size = (p) => (p.kind === "lending" ? collValue(p) : Math.abs(posValue(p)));
  for (const z of ZONES) by[z].sort((a, b) => (a.source === "manual") - (b.source === "manual") || size(b) - size(a));

  /* Growth: one line per loan, like the sheet's deposit/borrow pairs */
  const gRows = by.growth.map((p) => {
    if (p.source === "manual") {
      const c = manualCells(p), dv = p.kind === "lending" ? debtValue(p) : 0, cv = p.kind === "lending" ? collValue(p) : p.value;
      return `<tr data-m="${esc(p.id.slice(7))}"><td>${c.name}</td><td>${c.value}</td><td class="opt">${c.qty}</td><td class="opt">${c.price}</td>
        <td>${c.debt}</td><td>${dv && cv ? pct(dv / cv, 1, true) : ""}</td><td>${c.lt}</td>
        <td>${p.kind === "lending" ? `<span class="hf ${hfState(p.hf, t)}">${num(p.hf)}</span>` : ""}</td><td>${pct(cv / s.growth)}</td><td>${c.zone}</td></tr>`;
    }
    if (p.kind !== "lending") {
      return `<tr><td><div class="nm">${avatar(p)}<span class="label">${esc(p.name)}</span><span class="sub">без займа</span></div></td>
        <td>${usd(posValue(p), 0)}</td><td class="opt"></td><td class="opt"></td><td class="dim">—</td><td></td><td></td><td></td><td>${pct(posValue(p) / s.growth)}</td><td>${zoneSelect(p)}</td></tr>`;
    }
    const c = p.collateral[0], cv = collValue(p), dv = debtValue(p);
    const qty = p.collateral.length === 1 && ok(c.amount) ? `${amt(c.amount)} ${c.symbol}` : "";
    const price = ok(c?.price) ? usd(c.price, c.price < 10 ? 2 : 0) : "";
    return `<tr><td><div class="nm" title="${esc(`${lendingTitle(p)} · ${subOf(p)}${qty ? ` · ${qty} по ${price}` : ""}`)}">${avatar(p)}<span class="label">${esc(lendingTitle(p))}</span><span class="sub">${esc(subOf(p))}</span>${stale(p)}</div></td>
      <td>${usd(cv, 0)}</td>
      <td class="dim opt">${p.collateral.length === 1 && ok(c.amount) ? amt(c.amount) : ""}</td>
      <td class="dim opt">${price}</td>
      <td>${usd(dv, 0)}</td>
      <td>${pct(dv / cv, 1, true)}</td>
      <td class="dim">${c?.lt ? pct(c.lt, 0, true) : "?"}</td>
      <td><span class="hf ${hfState(p.hf, t)}">${num(p.hf)}</span></td>
      <td>${pct(cv / s.growth)}</td>
      <td>${zoneSelect(p)}</td></tr>`;
  }).join("");
  $("#growth").innerHTML = `
    <div class="box-h"><h2><i class="zi" style="background:var(--z-growth)"></i>Growth Zone</h2>
      <span class="tot"><small>залог</small>${usd(s.growth, 0)}</span></div>
    <table class="t"><thead><tr><th>Позиция</th><th>Залог</th><th class="opt">Кол-во</th><th class="opt">Цена</th><th>Долг</th><th>LTV</th><th>Liq LTV</th><th>HF</th><th>Доля</th><th>Зона</th></tr></thead>
      <tbody>${gRows || `<tr><td colspan="12" class="dim">Нет позиций</td></tr>`}</tbody>
      <tfoot><tr><td>Итого</td><td>${usd(s.growth, 0)}</td><td class="opt"></td><td class="opt"></td><td>${usd(s.debt, 0)}</td><td>${pct(s.ltv, 1, true)}</td><td></td><td><span class="hf ${hfState(s.hf, t)}">${num(s.hf)}</span></td><td></td><td></td></tr></tfoot>
    </table>`;

  $("#yield").innerHTML = flatTable("yield", "Yield Zone", by.yield, s.yield, `Y/L ${pct(s.yl, 0)}`);
  $("#stability").innerHTML = flatTable("stability", "Stability Zone", by.stability, s.stability, `S/G ${pct(s.sg)}`, true);

  const rest = [...by.unassigned, ...by.excluded];
  $("#other").innerHTML = rest.length ? `<span>${by.unassigned.length ? "Без зоны (только в Total Value):" : "Вне CGS:"}</span>` +
    rest.map((p) => `<span>${esc(titleOf(p))} <b>${usd(posValue(p), 0)}</b> ${zoneSelect(p)}${p.source === "manual"
      ? `<button class="x" data-del="${esc(p.id.slice(7))}" title="Удалить" aria-label="Удалить">✕</button>` : ""}</span>`).join("") : "";
}

function flatTable(z, title, list, total, ratio, canAdd = false) {
  const many = list.length > 4;
  const isDust = (p) => many && p.source !== "manual" && Math.abs(posValue(p)) < DUST;
  const dust = list.filter(isDust);
  const rows = list.map((p) => {
    if (isDust(p) && !openDust.has(z)) return "";
    const v = posValue(p);
    if (p.source === "manual") {
      const c = manualCells(p);
      return `<tr data-m="${esc(p.id.slice(7))}"><td>${c.name}</td><td>${c.value}</td><td>${total ? pct(v / total) : "—"}</td><td>${c.zone}</td></tr>`;
    }
    const extra = p.kind === "lending" ? `нетто · HF ${num(p.hf)}` : subOf(p);
    return `<tr><td><div class="nm" title="${esc(`${p.name} · ${p.protocol} · ${p.chain}`)}">${avatar(p)}<span class="label">${esc(titleOf(p))}</span><span class="sub">${esc(extra)}</span>${stale(p)}</div></td>
      <td>${usd(v, v < 1000 ? 2 : 0)}</td><td>${total ? pct(v / total) : "—"}</td><td>${zoneSelect(p)}</td></tr>`;
  }).join("");
  const dv = dust.reduce((a, p) => a + posValue(p), 0);
  const dustRow = dust.length ? `<tr class="dust"><td><button data-dust="${z}">${openDust.has(z) ? "свернуть мелкие" : `прочее · ${dust.length} мелких`}</button></td><td>${openDust.has(z) ? "" : usd(dv)}</td><td>${openDust.has(z) || !total ? "" : pct(dv / total)}</td><td></td></tr>` : "";
  return `<div class="box-h"><h2><i class="zi" style="background:var(--z-${z})"></i>${title}</h2><span class="tot"><small>${ratio}</small>${usd(total, 0)}</span></div>
    <table class="t"><thead><tr><th>Позиция</th><th>$</th><th>Доля</th><th>Зона</th></tr></thead>
      <tbody>${rows}${dustRow}</tbody>
      <tfoot><tr><td>${canAdd ? `<button class="add" id="manual-add">+ ручная позиция</button>` : "Итого"}</td><td>${usd(total, 0)}</td><td></td><td></td></tr></tfoot></table>`;
}

/* ------------------------------------------------------- right column */
function renderSignal() {
  const s = data.summary, t = data.config.targets;
  const sig = signal(s, t);
  /* the amounts live in the "К HF" box below and the corridor distances in the strip */
  $("#signal").innerHTML = `<div class="box-h"><h2>Сигнал CGS</h2><span class="badge ${sig.state}">${ICONS[sig.state]}${esc(sig.label)}</span></div>
    <p class="sig-title">${esc(sig.title)}</p>
    ${sig.note && sig.state !== "ok" ? `<p class="sig-note">${esc(sig.note)}</p>` : ""}`;
}

/* a row of small label-over-value cells */
const cells = (list) => `<div class="after${list.length === 2 ? " two" : ""}">${list.map(([z, k, v, was]) =>
  `<div><span>${z ? `<i class="dot ${z}"></i>` : ""}${k}</span><b>${v}</b>${was ? `<em>${was}</em>` : ""}</div>`).join("")}</div>`;

function renderRebalance() {
  const s = data.summary, t = data.config.targets;
  const rb = rebalance(s, t);
  const head = `<div class="box-h"><h2>К HF ${num(t.hfTarget)}</h2>`;
  if (!rb || Math.abs(s.hf - t.hfTarget) < 0.005) {
    $("#rebalance").innerHTML = `${head}<span class="muted">${rb ? "HF уже на цели" : "нет займа"}</span></div>`;
    return;
  }
  const moves = rb.dir === "take"
    ? [["stability", "Из Stability → залог", usd(rb.fromS, 0)], ["yield", "Из Yield → залог", usd(rb.fromY, 0)]]
    : [["stability", "Занять → в Stability", usd(rb.total, 0)], ["", "Долг после", usd(s.debt + rb.total, 0)]];
  $("#rebalance").innerHTML = `${head}<span class="muted">${rb.dir === "take" ? "сначала из зоны выше цели" : "долг → Stable"}</span>
      <span class="tot">${usd(rb.total, 0)}</span></div>
    ${rb.short > 0.5 ? `<p class="sig-note">Не хватает ${usd(rb.short, 0)}: HF поднимется только до ${num(rb.hf)}</p>` : ""}
    ${cells(moves)}
    ${cells([["", "HF", num(rb.hf), num(s.hf)], ["", "S/G от цели", pct(rb.sgOf, 0), pct(rb.before.sgOf, 0)], ["", "Y/L от цели", pct(rb.ylOf, 0), pct(rb.before.ylOf, 0)]])}`;
}

function renderPlanner() {
  const out = $("#planner-out");
  const X = parseMoney($("#deposit").value);
  const s = data.summary, t = data.config.targets;
  if (!ok(X) || X <= 0) {
    const yNeed = Math.max(0, s.debt * (t.ylTarget / 100) - s.yield);
    const sNeed = s.stability < s.sgTarget * s.growth ? s.sgTarget * s.growth - s.stability : 0;
    const gNeed = s.stability > s.sgTarget * s.growth ? s.stability / s.sgTarget - s.growth : 0;
    out.innerHTML = cells([["yield", `в Yield до Y/L ${pct(t.ylTarget / 100, 0)}`, usd(yNeed, 0)],
      [sNeed ? "stability" : "growth", `в ${sNeed ? "Stability" : "Growth"} до S/G ${pct(s.sgTarget)}`, usd(sNeed || gNeed, 0)]]);
    return;
  }
  const p = plan(X, s, t);
  /* one row, like the empty state, so typing doesn't change the box height */
  out.innerHTML = cells([["yield", "в Yield", usd(p.y, 0), `Y/L ${pct(p.yl, 0)}`], ["growth", "в Growth", usd(p.g, 0), `HF ${num(p.hf)}`],
    ["stability", "в Stability", usd(p.st, 0), `S/G ${pct(p.sg)}`]]);
}

/* Folded to one line: counts and the last update; the list opens on click,
   and by itself when a source starts failing. */
let srcErrors = 0;
function renderSources() {
  const src = data.sources;
  const ok = src.filter((s) => !s.error && !s.loading).length, err = src.filter((s) => s.error).length, load = src.filter((s) => s.loading).length;
  const last = Math.max(0, ...src.map((s) => s.okAt || 0));
  $("#srcsum").innerHTML = `Источники: <span class="src"><i></i>${ok} ок</span>` +
    (err ? ` · <span class="src err"><i></i>${err} ${err === 1 ? "ошибка" : err < 5 ? "ошибки" : "ошибок"}</span>` : "") +
    (load ? ` · <span class="src load"><i></i>${load} загрузка</span>` : "") + ` · обновлено ${last ? ago(last) : "—"}`;
  if (err > srcErrors) $("#sources").open = true;
  srcErrors = err;
  $("#srclist").innerHTML = src.map((s) => {
    const cls = s.loading ? "load" : s.error ? "err" : "";
    const name = { aave: "Aave V3", aave4: "Aave V4", kamino: "Kamino", gmx: "GMX", morpho: "Morpho", fluid: "Fluid", compound: "Compound", gmtrade: "GMTrade", pendle: "Pendle", wallet: "Кошелёк EVM", solana: "Solana", zerion: "Zerion" }[s.name] || s.label;
    return `<span class="src ${cls}" title="${esc(`${s.label}: ${s.error ? `ошибка — ${s.error}` : `обновлено ${clock(s.okAt)}; ⟳ — обновить`}`)}"><i></i>${esc(name)} · ${s.loading ? "загрузка" : ago(s.okAt)}</span>`;
  }).join("");
}
function renderChart() {
  drawChart($("#chart"), histRows, histMetric, data);
}

/* ----------------------------------------------------- manual editing */
async function saveManual(list) {
  try {
    data = await api("/api/manual", { method: "PUT", body: JSON.stringify(list) });
    render();
  } catch {
    $("#upd").textContent = "Не удалось сохранить ручную позицию";
    $("#upd").className = "upd err";
  }
}
document.addEventListener("change", (e) => {
  const row = e.target.closest("tr[data-m]");
  if (!row || !e.target.dataset.f) return;
  const list = structuredClone(data.manual);
  const m = list.find((x) => x.id === row.dataset.m);
  const f = e.target.dataset.f;
  if (f === "name" || f === "zone") m[f] = e.target.value;
  else {
    // empty clears a field (the value back to 0)
    const v = e.target.value.trim() === "" ? null : parseMoney(e.target.value);
    e.target.classList.toggle("bad", v !== null && !ok(v));
    if (v !== null && !ok(v)) return;
    if (f === "value") {
      m.value = v ?? 0;
      if (m.qty > 0 && m.price > 0) m.price = m.value / m.qty;  // keep Залог = Кол-во × Цена
    } else m[f] = v;
  }
  e.target.blur();
  saveManual(list);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("ed")) e.target.blur();
  if (e.key === "Escape" && e.target.classList.contains("ed")) { e.target.blur(); renderTables(); }
});
document.addEventListener("focusout", (e) => {
  if (e.target.classList?.contains("ed")) setTimeout(() => { if (!editing() && data) renderTables(); }, 0);
});

/* ------------------------------------------------------------ wiring */
document.addEventListener("click", async (e) => {
  const cp = e.target.closest("[data-copy]");
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); cp.style.color = "var(--ok)"; setTimeout(() => (cp.style.color = ""), 900); } catch { /* clipboard blocked */ } return; }
  const dust = e.target.closest("[data-dust]");
  if (dust) { const z = dust.dataset.dust; openDust.has(z) ? openDust.delete(z) : openDust.add(z); renderTables(); return; }
  const del = e.target.closest("[data-del]");
  if (del) {
    const m = data.manual.find((x) => x.id === del.dataset.del);
    if (m && confirm(`Удалить «${m.name}»?`)) saveManual(data.manual.filter((x) => x.id !== m.id));
    return;
  }
  if (e.target.closest("#manual-add")) {
    const id = Math.random().toString(36).slice(2, 10);
    await saveManual([...data.manual, { id, name: "", zone: "stability", value: 0, note: "" }]);
    const input = $(`tr[data-m="${id}"] .ed`);
    if (input) { input.focus(); input.select(); }
  }
});
document.addEventListener("change", async (e) => {
  const sel = e.target.closest("select.zs[data-id]");
  if (!sel) return;
  sel.disabled = true;
  try {
    data = await api("/api/config", { method: "PUT", body: JSON.stringify({ zone: { id: sel.dataset.id, zone: sel.value } }) });
    render();
  } catch { sel.disabled = false; }
});
$("#deposit").addEventListener("input", renderPlanner);
$("#deposit-quick").addEventListener("click", (e) => {
  const v = e.target.dataset.v;
  if (!v) return;
  const cur = parseMoney($("#deposit").value);
  $("#deposit").value = nf(0).format((ok(cur) ? cur : 0) + Number(v));
  renderPlanner();
});
$("#refresh").addEventListener("click", async () => {
  const b = $("#refresh");
  b.classList.add("spin");
  try { await api("/api/refresh", { method: "POST" }); } catch { /* shown in the status line */ }
  setTimeout(load, 2500);
  setTimeout(() => { load(); b.classList.remove("spin"); }, 7000);
});
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("cgs-theme", next); } catch { /* private mode */ }
});
$("#open-history").addEventListener("click", () => { $("#history").showModal(); renderChart(); });
$("#hist-metric").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  histMetric = b.dataset.m;
  $$("#hist-metric button").forEach((x) => x.classList.toggle("active", x === b));
  renderChart();
});
$("#open-settings").addEventListener("click", () => {
  if (!data) return;
  const f = $("#settings-form");
  for (const [k, v] of Object.entries(data.config.targets)) if (f.elements[k]) f.elements[k].value = v;
  f.elements.usdDigits.value = data.config.format.usd ?? "";
  f.elements.pctDigits.value = data.config.format.pct ?? "";
  $("#settings").showModal();
});
$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "save") return;
  const f = $("#settings-form");
  // "1,3" works; an empty field, or a Stability share of 0 / 100 % (S/G would divide by zero), keeps the old value
  const targets = Object.fromEntries(["hfLow", "hfHigh", "hfTarget", "stabilityShare", "ylTarget"]
    .map((k) => [k, parseMoney(f.elements[k].value)])
    .filter(([k, v]) => v > 0 && (k !== "stabilityShare" || v < 100)));
  const format = { usd: f.elements.usdDigits.value, pct: f.elements.pctDigits.value };
  data = await api("/api/config", { method: "PUT", body: JSON.stringify({ targets, format }) });
  render();
});

$("#backup-save").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(CGS.backup())], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `cgs-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
});
$("#backup-load").addEventListener("click", () => $("#backup-file").click());
$("#backup-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !confirm("Заменить кошельки, ручные позиции, зоны и историю в этом браузере данными из файла?")) return;
  try {
    CGS.restore(JSON.parse(await file.text()));
    location.reload();
  } catch (err) { alert(`Не удалось загрузить: ${err.message}`); }
});

load().then(() => {
  loadHistory();
  if (!data.config.wallets.length && !data.manual.length) Wallets.open();  // first run in this browser
});
/* the data engine finished a source (here or in another tab) */
let pending = 0;
window.addEventListener("cgs:update", () => { clearTimeout(pending); pending = setTimeout(() => { load(); loadHistory(); }, 150); });
setInterval(() => { renderUpdated(); if (data) renderSources(); }, 1000);
