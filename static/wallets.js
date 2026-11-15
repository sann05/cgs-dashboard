"use strict";
/* Watched wallets: a dialog to add (by address or by connecting MetaMask,
   Rabby, Phantom or WalletConnect), rename and remove them. Connecting only reads the address — nothing is signed or
   sent, and the WalletConnect session is closed right after.
   Any view opens it with an element carrying data-wallets. */

const Wallets = (() => {
  const WC_PROVIDER = "https://esm.sh/@walletconnect/universal-provider@2.25.0?bundle";
  const QR_LIB = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
  const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

  /* EIP-6963: every installed EVM wallet announces itself */
  const injected = new Map();  // rdns -> {info, provider}
  window.addEventListener("eip6963:announceProvider", (e) => {
    injected.set(e.detail.info.rdns, e.detail);
    if (dlg?.open) renderConnect();
  });
  const discover = () => window.dispatchEvent(new Event("eip6963:requestProvider"));
  discover();

  const KNOWN = [
    { id: "metamask", name: "MetaMask", rdns: ["io.metamask", "io.metamask.flask"], legacy: "isMetaMask", url: "https://metamask.io/download/" },
    { id: "rabby", name: "Rabby", rdns: ["io.rabby"], legacy: "isRabby", url: "https://rabby.io/" },
    { id: "phantom", name: "Phantom", solana: true, url: "https://phantom.com/download" },
  ];
  const evmProvider = (w) => {
    for (const r of w.rdns) if (injected.has(r)) return injected.get(r).provider;
    const eth = window.ethereum;
    return eth?.[w.legacy] && !(w.id === "metamask" && eth.isRabby) ? eth : null;
  };
  const phantomSolana = () => window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);

  /* ----------------------------------------------------------- dialog */
  let dlg = null;
  let busy = "";  // label of the connection in progress
  let wcCancel = null;

  function ensure() {
    if (dlg) return;
    document.head.insertAdjacentHTML("beforeend", `<style>
      #wallets-dlg { width: min(580px, calc(100vw - 32px)); }
      #wallets-dlg .wd-h { display: flex; align-items: center; gap: 10px; }
      #wallets-dlg .wd-h form { margin-left: auto; }
      #wallets-dlg .wd-x { border: 0; background: none; color: var(--text-3); font-size: 15px; padding: 2px 6px; cursor: pointer; }
      #wallets-dlg .wd-x:hover { color: var(--crit, var(--down, #f63d3d)); }
      #wallets-dlg .wd-note { color: var(--text-3); font-size: 12px; margin: 4px 0 14px; }
      #wallets-dlg h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); margin: 16px 0 8px; }
      #wallets-dlg .wd-list { display: grid; gap: 6px; }
      #wallets-dlg .wd-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: 10px;
        padding: 7px 10px; border-radius: 6px; background: var(--chip, var(--surface-2)); font-size: 13px; }
      #wallets-dlg .wd-type { font: 700 10px var(--font); padding: 2px 6px; border-radius: 4px; color: #fff; }
      #wallets-dlg .wd-type.evm { background: #627EEA; } #wallets-dlg .wd-type.solana { background: #9945FF; }
      #wallets-dlg .wd-name { border: 1px solid transparent; background: none; color: var(--text); font: 600 13px var(--font); padding: 2px 4px; border-radius: 4px; min-width: 0; width: 100%; }
      #wallets-dlg .wd-name:hover, #wallets-dlg .wd-name:focus { border-color: var(--line, var(--border)); outline: none; }
      #wallets-dlg .wd-addr { font: 500 12px var(--font-num, var(--font)); color: var(--text-2); border: 0; background: none; cursor: pointer; padding: 0; }
      #wallets-dlg .wd-addr:hover { color: var(--text); }
      #wallets-dlg .wd-via { color: var(--text-3); font-size: 11px; }
      #wallets-dlg .wd-empty { color: var(--text-3); font-size: 13px; padding: 8px 2px; }
      #wallets-dlg .wd-btns { display: flex; flex-wrap: wrap; gap: 8px; }
      #wallets-dlg .wd-btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line, var(--border)); background: none; color: var(--text);
        border-radius: 8px; padding: 7px 12px; font: 700 13px var(--font); cursor: pointer; }
      #wallets-dlg .wd-btn:hover { border-color: var(--accent, var(--orange)); }
      #wallets-dlg .wd-btn img, #wallets-dlg .wd-btn .wd-ico { width: 18px; height: 18px; border-radius: 4px; }
      #wallets-dlg .wd-btn .wd-ico { display: grid; place-items: center; color: #fff; font-size: 10px; }
      #wallets-dlg .wd-btn small { color: var(--text-3); font-weight: 400; }
      #wallets-dlg .wd-btn[disabled] { opacity: .5; cursor: progress; }
      #wallets-dlg .wd-add { display: flex; gap: 8px; margin-top: 10px; }
      #wallets-dlg input.wd-in { border: 1px solid var(--line, var(--border)); background: var(--input, transparent); color: var(--text); border-radius: 6px;
        padding: 7px 9px; font: 500 13px var(--font-num, var(--font)); outline: none; min-width: 0; }
      #wallets-dlg input.wd-in:focus { border-color: var(--accent, var(--orange)); }
      #wallets-dlg .wd-add .wd-in:first-child { flex: 1; }
      #wallets-dlg .wd-add .wd-in.lbl { width: 120px; }
      #wallets-dlg .wd-go { border: 0; border-radius: 6px; padding: 0 14px; font: 700 13px var(--font); cursor: pointer;
        background: var(--accent, var(--orange)); color: var(--accent-ink, #fff); }
      #wallets-dlg .wd-msg { min-height: 18px; font-size: 12px; margin-top: 8px; color: var(--text-2); }
      #wallets-dlg .wd-msg.err { color: var(--crit, var(--down, #f63d3d)); }
      #wallets-dlg .wd-qr { display: grid; justify-items: center; gap: 8px; margin-top: 10px; }
      #wallets-dlg .wd-qr svg { background: #fff; border-radius: 8px; width: 220px; height: 220px; }
      #wallets-dlg .wd-qr button { border: 0; background: none; color: var(--link, var(--blue, var(--accent))); font-size: 12px; cursor: pointer; }
      #wallets-dlg a { color: var(--link, var(--blue, var(--accent))); }
      @media (max-width: 560px) { #wallets-dlg .wd-row { grid-template-columns: auto minmax(0,1fr) auto; } #wallets-dlg .wd-via { display: none; } }
    </style>`);
    document.body.insertAdjacentHTML("beforeend", `<dialog id="wallets-dlg">
      <div class="wd-h"><h2>Кошельки</h2><form method="dialog"><button class="wd-x" aria-label="Закрыть">✕</button></form></div>
      <p class="wd-note">Страница только читает адреса: ничего не подписывается и не отправляется. Данные загружаются прямо из этого браузера и хранятся только в нём.</p>
      <div class="wd-list" id="wd-list"></div>
      <h3>Добавить</h3>
      <div class="wd-btns" id="wd-connect"></div>
      <div class="wd-qr" id="wd-qr" hidden></div>
      <form class="wd-add" id="wd-add">
        <input class="wd-in" name="address" placeholder="Адрес EVM (0x…) или Solana" autocomplete="off" spellcheck="false" aria-label="Адрес">
        <input class="wd-in lbl" name="label" placeholder="Название" autocomplete="off" aria-label="Название">
        <button class="wd-go">Добавить</button>
      </form>
      <div class="wd-msg" id="wd-msg" role="status"></div>
    </dialog>`);
    dlg = $("#wallets-dlg");

    dlg.addEventListener("close", () => { wcCancel?.(); hideQr(); });
    $("#wd-add").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = e.target;
      add([{ address: f.elements.address.value, label: f.elements.label.value, via: "по адресу" }]) && f.reset();
    });
    dlg.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        const w = CGS.wallets().find((x) => x.id === del.dataset.del);
        if (w && confirm(`Перестать следить за ${w.label || w.address}?`)) { CGS.removeWallet(w.id); renderList(); }
        return;
      }
      const cp = e.target.closest("[data-copy]");
      if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); msg("Адрес скопирован"); } catch { /* clipboard blocked */ } return; }
      const c = e.target.closest("[data-connect]");
      if (c && !busy) connect(c.dataset.connect);
    });
    dlg.addEventListener("change", (e) => {
      if (e.target.matches(".wd-name")) CGS.setWalletLabel(e.target.dataset.id, e.target.value.trim());
    });
  }

  const msg = (text, err = false) => {
    const m = $("#wd-msg");
    m.textContent = text;
    m.className = `wd-msg${err ? " err" : ""}`;
  };

  function renderList() {
    const ws = CGS.wallets();
    $("#wd-list").innerHTML = ws.length ? ws.map((w) => `<div class="wd-row">
        <span class="wd-type ${w.type}">${w.type === "evm" ? "EVM" : "SOL"}</span>
        <input class="wd-name" data-id="${esc(w.id)}" value="${esc(w.label)}" placeholder="Без названия" aria-label="Название кошелька">
        <button class="wd-addr" data-copy="${esc(w.address)}" title="Скопировать ${esc(w.address)}">${esc(short(w.address))}</button>
        <span class="wd-via">${esc(w.via || "")}</span>
        <button class="wd-x" data-del="${esc(w.id)}" title="Удалить" aria-label="Удалить кошелёк">✕</button></div>`).join("")
      : `<div class="wd-empty">Пока нет кошельков. Подключите кошелёк или вставьте адрес ниже.</div>`;
  }

  function renderConnect() {
    const ico = (src, text, bg) => (src ? `<img src="${esc(src)}" alt="">` : `<span class="wd-ico" style="background:${bg}">${text}</span>`);
    const btns = KNOWN.map((w) => {
      const there = w.solana ? phantomSolana() : evmProvider(w);
      const info = w.rdns && w.rdns.map((r) => injected.get(r)).find(Boolean)?.info;
      const icon = info?.icon || (w.id === "phantom" ? [...injected.values()].find((d) => d.info.rdns === "app.phantom")?.info.icon : null);
      return `<button class="wd-btn" data-connect="${w.id}" ${busy ? "disabled" : ""}>${ico(icon, w.name[0], "#33405a")}${w.name}${w.solana ? " <small>Solana</small>" : ""}${there ? "" : " <small>установить</small>"}</button>`;
    });
    /* any other EVM wallet that announced itself (Phantom EVM, Coinbase, …) */
    const knownRdns = new Set(KNOWN.flatMap((w) => w.rdns || []));
    for (const [rdns, d] of injected) {
      if (!knownRdns.has(rdns)) btns.push(`<button class="wd-btn" data-connect="6963:${esc(rdns)}" ${busy ? "disabled" : ""}>${ico(d.info.icon, "?", "#33405a")}${esc(d.info.name)} <small>EVM</small></button>`);
    }
    // WalletConnect needs a Project ID (WALLETCONNECT_PROJECT_ID in the server's .env)
    if (CGS.keys().walletconnect) btns.push(`<button class="wd-btn" data-connect="walletconnect" ${busy ? "disabled" : ""}>${ico(null, "WC", "#3b99fc")}WalletConnect</button>`);
    $("#wd-connect").innerHTML = btns.join("");
  }

  function add(list) {
    let added = 0, dup = 0;
    try {
      for (const w of list) (CGS.addWallet(w) ? added++ : dup++);
    } catch (e) {
      msg(e.message, true);
      return false;
    }
    renderList();
    msg(added ? `Добавлено: ${added}${dup ? `, уже были: ${dup}` : ""}. Позиции загрузятся в течение минуты.` : "Этот кошелёк уже в списке");
    return true;
  }

  /* ---------------------------------------------------------- connect */
  async function connect(id) {
    const w = KNOWN.find((x) => x.id === id);
    busy = id;
    renderConnect();
    try {
      if (id === "walletconnect") return await walletConnect();
      if (w?.solana) {
        const p = phantomSolana();
        if (!p) return install(w);
        msg("Подтвердите подключение в Phantom…");
        const r = await p.connect();
        return add([{ address: r.publicKey.toString(), via: "Phantom" }]);
      }
      const provider = w ? evmProvider(w) : injected.get(id.slice(5))?.provider;
      if (!provider) return install(w);
      const name = w?.name || injected.get(id.slice(5))?.info.name || "Кошелёк";
      msg(`Подтвердите подключение в ${name}…`);
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      add(accounts.map((a) => ({ address: a, via: name })));
    } catch (e) {
      msg(e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || "") ? "Подключение отклонено" : `Не удалось подключить: ${e?.message || e}`, true);
    } finally {
      busy = "";
      renderConnect();
    }
  }

  function install(w) {
    msg(`${w.name} не найден в этом браузере — откроется страница установки`, true);
    window.open(w.url, "_blank", "noopener");
  }

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src, crossOrigin: "anonymous", onload: resolve, onerror: () => reject(new Error(`не загрузился ${new URL(src).host}`)) });
    document.head.append(s);
  });

  function hideQr() {
    const q = $("#wd-qr");
    if (q) { q.hidden = true; q.innerHTML = ""; }
  }

  /* One WalletConnect session asking for both EVM and Solana accounts; we
     take the addresses and disconnect at once. */
  async function walletConnect() {
    const projectId = CGS.keys().walletconnect;
    if (!projectId) return msg("WalletConnect не настроен: нет Project ID", true);
    msg("Загрузка WalletConnect…");
    const [mod] = await Promise.all([import(WC_PROVIDER), window.qrcode ? null : loadScript(QR_LIB)]);
    const UniversalProvider = mod.UniversalProvider || mod.default;
    /* closing the dialog cancels; a bad Project ID makes the relay retry
       forever without ever producing a QR, so give up after 20 s */
    let shown = false, provider = null, watch = 0;
    const stop = new Promise((_, reject) => {
      wcCancel = () => reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      watch = setInterval(() => dlg.open || wcCancel?.(), 500);  // the close event is not always delivered
      setTimeout(() => shown || reject(new Error("WalletConnect не отвечает — проверьте Project ID")), 20000);
    });
    stop.catch(() => { /* handled where awaited */ });
    try {
      provider = await Promise.race([UniversalProvider.init({
        projectId,
        metadata: { name: "CGS Portfolio", description: "Watch-only portfolio monitor", url: location.origin, icons: [] },
      }), stop]);
      await connectWith(provider, stop, () => { shown = true; });
    } catch (e) {
      if (!e.cancelled) throw e;
      msg("");
    } finally {
      clearInterval(watch);
      wcCancel = null;
      hideQr();
      Promise.resolve().then(() => provider?.disconnect()).catch(() => { /* no session */ });
      Promise.resolve().then(() => provider?.client?.core?.relayer?.transportClose?.()).catch(() => { /* already closed */ });
    }
  }

  async function connectWith(provider, stop, onShown) {
    provider.on("display_uri", (uri) => {
      onShown();
      const qr = window.qrcode(0, "M");
      qr.addData(uri);
      qr.make();
      const box = $("#wd-qr");
      box.innerHTML = `${qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true })}<button type="button" id="wd-copy-uri">Скопировать ссылку для кошелька</button>`;
      box.hidden = false;
      $("#wd-copy-uri").onclick = () => navigator.clipboard.writeText(uri).then(() => msg("Ссылка скопирована"));
      msg("Отсканируйте QR-код кошельком с поддержкой WalletConnect");
    });
    const session = await Promise.race([provider.connect({
      optionalNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: ["accountsChanged", "chainChanged"] },
        solana: { chains: [SOLANA_MAINNET], methods: ["solana_signMessage"], events: [] },
      },
    }), stop]);
    if (!session) return;
    const via = `WalletConnect · ${session.peer?.metadata?.name || "кошелёк"}`;
    const addresses = [...new Set(Object.values(session.namespaces).flatMap((n) => n.accounts).map((a) => a.split(":").slice(2).join(":")))];
    add(addresses.map((address) => ({ address, via })));
  }

  function open() {
    ensure();
    discover();
    renderList();
    renderConnect();
    msg(CGS.wallets().length ? "" : "Добавьте хотя бы один кошелёк, чтобы увидеть позиции");
    if (!dlg.open) dlg.showModal();
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-wallets]")) open();
    const x = e.target.closest("[data-unwatch]");
    const w = x && CGS.wallets().find((v) => v.id === x.dataset.unwatch);
    // zones picked for its positions stay saved, so adding it back restores them
    if (w && confirm(`Перестать следить за ${w.label || w.address}?`)) CGS.removeWallet(w.id);
  });
  window.addEventListener("cgs:update", () => { if (dlg?.open && !dlg.contains(document.activeElement)) renderList(); });

  /* header chips: one per wallet (click copies, ✕ stops watching it) */
  const chips = (ws, cls = "") => ws.map((w) => `<span class="${cls}">${w.type === "evm" ? "EVM" : "SOL"} <button data-copy="${esc(w.address)}" title="Скопировать ${esc(w.address)}">${esc(w.label || short(w.address))}</button><button class="w-x" data-unwatch="${esc(w.id)}" title="Удалить кошелёк" aria-label="Удалить кошелёк">✕</button></span>`).join("");

  return { open, chips };
})();
