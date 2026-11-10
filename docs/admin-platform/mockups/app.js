/* Admin portal mockup shell. Pages register themselves with Admin.register({...}). No build step, no network. */
(function () {
  const pages = [];
  const GROUP_ORDER = ["Overview", "People & access", "Configuration", "Look & feel", "Communication", "Integrations", "System"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Minimal inline icons (Lucide-style strokes). Use Admin.icon(name).
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/><path d="M9 21v-7h6v7"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-4-5.5"/>',
    group: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="M12 10v3M7.5 15.5 10 13M16.5 15.5 14 13"/>',
    team: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 10h8M8 14h5"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7M12 17h.01"/>',
    org: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M5 16v-4h14v4"/>',
    field: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h6"/>',
    screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    workflow: '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.5 6h9M6 8l5 8M18 8l-5 8"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 21a3 3 0 0 1 0-6h2a3 3 0 0 0 0-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    log: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>',
    inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.9.1 7 7 0 0 1-1.6.9 1.7 1.7 0 0 0-1 1.5V23h-4v-.3a1.7 1.7 0 0 0-1-1.5 7 7 0 0 1-1.6-.9 1.7 1.7 0 0 0-1.9-.1l-.2.1-2-3.4.1-.1a1.7 1.7 0 0 0 .3-1.8 7 7 0 0 1 0-1.8"/>',
  };
  const icon = (name, extra = "") =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name] || ICONS.info}</svg>`;

  const settings = {
    theme: localStorage.getItem("mock.theme") || "light",
    dir: "ltr", // right-to-left and Arabic removed from the design (owner, 10 Nov 2026)
    state: "normal",
  };

  // ---------- shared UI helpers ----------
  const ui = {
    esc,
    icon,
    pageHeader(title, desc = "", actions = "", crumbs = "") {
      return `${crumbs ? `<div class="crumbs">${crumbs}</div>` : ""}
      <div class="page-head"><div class="grow"><h1>${esc(title)}</h1>${desc ? `<p>${desc}</p>` : ""}</div>
      ${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
    },
    badge(text, tone = "") { return `<span class="badge ${tone}">${esc(text)}</span>`; },
    btn(label, { kind = "", attrs = "", ic = "" } = {}) { return `<button class="btn ${kind}" ${attrs}>${ic ? icon(ic, 'width="14" height="14"') : ""}${esc(label)}</button>`; },
    table(cols, rows, { empty = "Nothing here yet." } = {}) {
      if (!rows.length) return `<div class="card state">${icon("inbox")}<p>${esc(empty)}</p></div>`;
      return `<div class="table-wrap"><table class="t"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    },
    tabs(id, list, active) {
      return `<div class="tabs" role="tablist" data-tabs="${esc(id)}">${list
        .map((t) => `<button class="tab ${t.id === active ? "active" : ""}" role="tab" aria-selected="${t.id === active}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`)
        .join("")}</div>`;
    },
    // Standard loading / empty / error block. Pages call this when ctx.state !== "normal".
    stateBlock(state, { emptyTitle = "Nothing here yet", emptyText = "", emptyAction = "", errorText = "We could not load this page." } = {}) {
      if (state === "loading")
        return `<div class="stack" aria-busy="true"><div class="skeleton" style="height:28px;width:40%"></div>
        <div class="grid g3">${'<div class="skeleton" style="height:90px"></div>'.repeat(3)}</div>
        ${'<div class="skeleton" style="height:36px"></div>'.repeat(6)}</div>`;
      if (state === "empty")
        return `<div class="card state">${icon("inbox")}<h2>${esc(emptyTitle)}</h2><p class="muted">${emptyText}</p>${emptyAction}</div>`;
      if (state === "error")
        return `<div class="card state">${icon("alert")}<h2>Something went wrong</h2><p class="muted">${esc(errorText)} Try again, or check System health.</p>
        <div class="row" style="justify-content:center"><button class="btn primary" onclick="Admin.rerender()">Try again</button></div>
        <p class="small muted">Reference: req_7f3a91c2</p></div>`;
      return "";
    },
    field(label, control, hint = "") { return `<div class="field"><label>${esc(label)}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`; },
    input(value = "", attrs = "") { return `<input class="input" value="${esc(value)}" ${attrs}>`; },
    select(options, selected, attrs = "") {
      return `<select class="input" ${attrs}>${options.map((o) => `<option ${o === selected ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    },
    check(label, checked = false, attrs = "") { return `<label class="check"><input type="checkbox" ${checked ? "checked" : ""} ${attrs}> ${esc(label)}</label>`; },
    kpi(label, value, sub = "") { return `<div class="card"><div class="kpi-label">${esc(label)}</div><div class="kpi">${value}</div>${sub ? `<div class="small muted">${sub}</div>` : ""}</div>`; },
    bar(pct) { return `<div class="bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`; },
    avatar(name) {
      const i = String(name).split(/\s+/).map((p) => p[0]).slice(0, 2).join("");
      return `<span style="display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--primary-soft);color:var(--primary-text);font-size:11px;font-weight:700">${esc(i)}</span>`;
    },
  };

  // ---------- overlays ----------
  function closeOverlays() { document.querySelectorAll(".overlay,.drawer,.modal").forEach((n) => n.remove()); }
  function openDrawer(html) { closeOverlays(); document.body.insertAdjacentHTML("beforeend", `<div class="overlay" onclick="Admin.close()"></div><aside class="drawer" role="dialog" aria-modal="true">${html}</aside>`); }
  function openModal(html) { closeOverlays(); document.body.insertAdjacentHTML("beforeend", `<div class="overlay" onclick="Admin.close()"></div><div class="modal" role="dialog" aria-modal="true">${html}</div>`); }
  function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

  // ---------- routing ----------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, query = ""] = h.split("?");
    const parts = path.split("/").filter(Boolean);
    return { id: parts[0] || "home", params: parts.slice(1), query: new URLSearchParams(query) };
  }
  function navigate(path) { location.hash = "#/" + path.replace(/^#?\/?/, ""); }

  function sidebar(activeId) {
    const groups = GROUP_ORDER.map((g) => ({ g, items: pages.filter((p) => p.group === g && !p.hidden) })).filter((x) => x.items.length);
    return groups
      .map(({ g, items }) => `<div class="nav-group"><div class="nav-group-title">${esc(g)}</div>${items
        .map((p) => `<a class="nav-item ${p.id === activeId ? "active" : ""}" href="#/${p.id}">${icon(p.icon || "info")}<span>${esc(p.title)}</span></a>`)
        .join("")}</div>`)
      .join("") + `<div class="nav-group"><div class="nav-group-title">Mockup</div><a class="nav-item ${activeId === "index" ? "active" : ""}" href="#/index">${icon("list")}<span>Screen index</span></a></div>`;
  }

  function topbar() {
    return `<div class="brand"><div class="brand-logo">R</div><span>RecruitmentOS</span><span class="badge info">Admin</span></div>
      <div class="search" onclick="Admin.palette()" role="button" tabindex="0" aria-label="Search admin">${icon("search", 'width="16" height="16"')}<span>Search admin pages, users, fields…</span><kbd>Ctrl K</kbd></div>
      <div class="spacer"></div>
      <div class="toggles">
        <span class="mock-badge">MOCKUP · sample data</span>
        <select class="input" style="width:auto" aria-label="Page state" onchange="Admin.setState(this.value)">
          ${["normal", "loading", "empty", "error"].map((s) => `<option value="${s}" ${settings.state === s ? "selected" : ""}>State: ${s}</option>`).join("")}
        </select>
        <button class="btn sm" onclick="Admin.toggleTheme()">${settings.theme === "dark" ? "Light" : "Dark"}</button>
        ${ui.avatar("Omar Alshair")}
      </div>`;
  }

  function indexPage() {
    const rows = pages.filter((p) => !p.hidden).map((p) => [
      `<a href="#/${p.id}">${esc(p.title)}</a>`, esc(p.group), (p.spec || []).map((s) => `<code>${esc(s)}</code>`).join(" "), p.changes || "", ui.badge(p.status || "Pending review", "warn"),
    ]);
    return ui.pageHeader("Screen index", "Every mockup screen, the spec IDs it covers and what changes from today's app. Use the toolbar to switch light/dark and the loading, empty and error states.") +
      ui.table(["Screen", "Area", "Spec IDs", "What changes from today", "Status"], rows);
  }

  function render() {
    closeOverlays();
    const { id, params, query } = parseHash();
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dir = settings.dir;
    document.documentElement.lang = "en";
    document.querySelector(".topbar").innerHTML = topbar();
    document.querySelector(".sidebar").innerHTML = sidebar(id);
    const main = document.querySelector(".main");
    const page = pages.find((p) => p.id === id);
    const ctx = { params, query, state: settings.state, navigate, ui, data: window.MockData, dir: settings.dir };
    if (id === "index") main.innerHTML = indexPage();
    else if (!page) main.innerHTML = ui.pageHeader("Page not found") + `<p>No mockup screen called <code>${esc(id)}</code>. <a href="#/index">Open the screen index</a>.</p>`;
    else {
      try {
        main.innerHTML = page.render(ctx);
        if (page.mount) page.mount(main, ctx);
      } catch (e) {
        console.error(e);
        main.innerHTML = `<div class="callout bad"><b>Mockup error on ${esc(page.id)}:</b> ${esc(e.message)}</div>`;
      }
    }
    // generic tab handling: buttons with data-tab inside [data-tabs] update ?tab= in the hash
    main.querySelectorAll("[data-tabs] [data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        const q = new URLSearchParams(query); q.set("tab", b.dataset.tab);
        location.hash = "#/" + [id, ...params].join("/") + "?" + q.toString();
      }));
    main.scrollTop = 0;
    document.title = (page ? page.title : "Admin") + " · RecruitmentOS admin (mockup)";
  }

  function palette() {
    const items = pages.filter((p) => !p.hidden).map((p) => ({ label: p.title, sub: p.group, href: "#/" + p.id }))
      .concat((window.MockData?.users || []).map((u) => ({ label: u.name, sub: "User · " + u.email, href: "#/users/" + u.id })));
    openModal(`<input class="input" id="pal-q" placeholder="Search admin pages and users" autofocus><div id="pal-r" class="stack" style="margin-top:8px"></div>`);
    const q = document.getElementById("pal-q"), r = document.getElementById("pal-r");
    const draw = () => {
      const s = q.value.toLowerCase();
      r.innerHTML = items.filter((i) => (i.label + i.sub).toLowerCase().includes(s)).slice(0, 12)
        .map((i) => `<a class="palette-item" href="${i.href}" onclick="Admin.close()"><b>${esc(i.label)}</b><span class="muted small">${esc(i.sub)}</span></a>`).join("") || `<p class="muted">No match.</p>`;
    };
    q.addEventListener("input", draw); draw(); q.focus();
  }

  window.Admin = {
    register(page) { if (!page.id || !page.render) throw new Error("page needs id and render"); pages.push(page); },
    pages, ui, icon, navigate, toast, drawer: openDrawer, modal: openModal, close: closeOverlays, palette,
    rerender: render,
    setState(s) { settings.state = s; render(); },
    toggleTheme() { settings.theme = settings.theme === "dark" ? "light" : "dark"; localStorage.setItem("mock.theme", settings.theme); render(); },
    start() {
      window.addEventListener("hashchange", render);
      document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette(); }
        if (e.key === "Escape") closeOverlays();
      });
      render();
    },
  };
})();
