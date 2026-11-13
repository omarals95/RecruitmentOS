/* Permission matrix: read-only overview of roles × actions, role comparison and CSV export. Reads window.AccessMock (pages/roles.js). */
(function () {
  const CSS = `<style>
    .pm-matrix th, .pm-matrix td { text-align:center; vertical-align:middle; }
    .pm-matrix th:first-child, .pm-matrix td:first-child { text-align:start; font-weight:700; white-space:nowrap; }
    .pm-matrix th { min-width:92px; }
    .pm-c { display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:700; border-radius:999px; padding:1px 8px; white-space:nowrap; }
    .pm-allowed { background:var(--success-bg); color:var(--success); }
    .pm-denied { color:var(--muted); font-weight:400; }
    .pm-ceiling { background:var(--warning-bg); color:var(--warning); }
    .pm-fixed { background:var(--surface-subtle); color:var(--muted); border:1px dashed var(--border-strong); }
    .pm-na { color:var(--muted); font-weight:400; opacity:.6; }
    .pm-diff td { background:var(--warning-bg) !important; }
    .pm-diff td:first-child { box-shadow: inset 4px 0 0 var(--warning); }
    [dir="rtl"] .pm-diff td:first-child { box-shadow: inset -4px 0 0 var(--warning); }
  </style>`;
  const LABEL = { allowed: "✓ Allowed", denied: "Not granted", ceiling: "Ceiling", fixed: "Fixed rule", na: "n/a" };
  const chip = (c, title = "") => `<span class="pm-c pm-${c}" ${title ? `title="${Admin.ui.esc(title)}"` : ""}>${LABEL[c]}</span>`;

  function csv(M) {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [["Record kind", "Action", ...M.roles.map((r) => r.name)].map(q).join(",")];
    M.RESOURCES.forEach((res) => M.ACTIONS.forEach((a) => lines.push([res, a, ...M.roles.map((r) => LABEL[M.cell(r, res, a)].replace("✓ ", ""))].map(q).join(","))));
    lines.push(["Record scope", "Vacancies", ...M.roles.map((r) => r.scope.vacancies)].map(q).join(","));
    return lines.join("\r\n");
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function compareRows(M, A, B) {
    const rows = [];
    M.RESOURCES.forEach((res) => M.ACTIONS.forEach((a) => {
      const x = M.cell(A, res, a), y = M.cell(B, res, a);
      if (x === "na" && y === "na") return;
      rows.push({ k: res, a, x: chip(x), y: chip(y), diff: (x === "allowed") !== (y === "allowed") });
    }));
    [["candidates", "Candidates"], ["vacancies", "Vacancies and below"], ["tasks", "Team tasks"]].forEach(([k, l]) =>
      rows.push({ k: "Record scope", a: l, x: A.scope[k], y: B.scope[k], diff: A.scope[k] !== B.scope[k] }));
    const fk = [...new Set([...Object.keys(A.fields), ...Object.keys(B.fields)])].sort();
    fk.forEach((f) => { const x = A.fields[f] || "Default", y = B.fields[f] || "Default"; rows.push({ k: "Field rule", a: f.replace(".", " · "), x, y, diff: x !== y }); });
    M.PAGES.forEach((p) => { const x = A.pages.includes(p), y = B.pages.includes(p); rows.push({ k: "Page", a: p, x: x ? "Shown" : "Hidden", y: y ? "Shown" : "Hidden", diff: x !== y }); });
    return rows;
  }

  Admin.register({
    id: "permissions", group: "People & access", title: "Permission matrix", icon: "shield",
    spec: ["PRM-025", "PRM-032", "PRM-034", "PRM-062"],
    changes: "New. One read-only view of every role's actions per record kind, a side-by-side role comparison and CSV export for access reviews.",
    render(ctx) {
      const { ui } = ctx;
      const M = window.AccessMock;
      const head = ui.pageHeader("Permission matrix", "Which role can do what, per record kind. A read-only overview: change access in the role editor.",
        ui.btn("Export CSV", { ic: "log", attrs: "data-csv" }) + ui.btn("Open roles", { kind: "primary", ic: "key", attrs: `onclick="Admin.navigate('roles')"` }));
      if (!M) return head + ui.stateBlock("error", { errorText: "The roles model did not load." });
      if (ctx.state !== "normal") return `<div id="pm-page">${head}${ui.stateBlock(ctx.state, { emptyTitle: "No roles to compare", emptyText: "Create a company role to see it here.", emptyAction: ui.btn("Create role", { kind: "primary", attrs: `onclick="Admin.navigate('roles')"` }) })}</div>`;
      const res = M.RESOURCES.includes(ctx.query.get("res")) ? ctx.query.get("res") : "Candidates";
      const byId = (id, d) => M.roles.find((r) => r.id === id) || M.roles.find((r) => r.id === d);
      const A = byId(ctx.query.get("a"), "r-rec"), B = byId(ctx.query.get("b"), "r-nocv");
      const only = ctx.query.get("diff") !== "0";
      const matrix = `<div class="table-wrap"><table class="t pm-matrix"><thead><tr><th>${ui.esc(res)}</th>${M.roles.map((r) =>
        `<th><a href="#/roles/${r.id}?tab=actions">${ui.esc(r.name)}</a><div class="small muted" style="font-weight:400">${ui.esc(r.membership)} · ${r.holders.length} holder${r.holders.length === 1 ? "" : "s"}</div></th>`).join("")}</tr></thead>
        <tbody>${M.ACTIONS.map((a) => `<tr><td>${a}</td>${M.roles.map((r) => {
          const c = M.cell(r, res, a), ref = M.refusal(r.membership, res, a);
          return `<td>${chip(c, ref && ref.kind !== "na" ? ref.msg : "")}</td>`;
        }).join("")}</tr>`).join("")}
        <tr><td>Record scope</td>${M.roles.map((r) => `<td class="small">${ui.esc(res === "Candidates" ? r.scope.candidates : res === "Team tasks" ? r.scope.tasks : res === "Directory" || res === "Job roles" ? "All records" : r.scope.vacancies)}</td>`).join("")}</tr>
        </tbody></table></div>`;
      const rows = compareRows(M, A, B);
      const diffs = rows.filter((r) => r.diff).length;
      const shown = only ? rows.filter((r) => r.diff) : rows;
      const roleOpts = (sel, id) => `<select class="input" id="${id}" style="width:auto">${M.roles.map((r) => `<option value="${r.id}" ${r.id === sel.id ? "selected" : ""}>${ui.esc(r.name)}</option>`).join("")}</select>`;
      return CSS + `<div id="pm-page">${head}
        <div class="callout" style="margin-bottom:14px">${ui.icon("info", 'width="14" height="14"')} <b>Read only.</b> To change a role, open it in the <a href="#/roles">role editor</a>, save a draft and publish. There is no explicit deny: a role can do what is granted, within its membership ceiling. Private notes, shortlists and private saved views can never be granted.</div>
        <div class="card" style="margin-bottom:16px">
          <div class="toolbar"><label for="pm-res"><b>Record kind</b></label>${ui.select(M.RESOURCES, res, 'id="pm-res"')}
            <span class="spacer" style="flex:1"></span>
            <span class="row small">${chip("allowed")} ${chip("denied")} ${chip("ceiling")} ${chip("fixed")} ${chip("na")}</span></div>
          ${matrix}
          <p class="small muted" style="margin:10px 0 0"><b>Ceiling</b>: the role's membership (Viewer, Recruiter) can never hold this action. <b>Fixed rule</b>: no team role can hold it, for example directory changes need company authority. Hover a cell for the reason.</p>
        </div>
        <div class="card" id="pm-compare">
          <h2>Compare two roles</h2>
          <div class="toolbar">${roleOpts(A, "pm-a")}<span class="muted">and</span>${roleOpts(B, "pm-b")}
            ${ui.btn("Swap", { kind: "sm", attrs: "data-swap" })}
            <label class="check" style="margin-inline-start:auto"><input type="checkbox" id="pm-only" ${only ? "checked" : ""}> Differences only</label></div>
          <p class="muted small" style="margin-top:0">${diffs ? `<b>${diffs} difference${diffs === 1 ? "" : "s"}</b> across actions, record scope, field rules and pages. Highlighted rows differ.` : "These roles grant exactly the same access."}</p>
          ${ui.table(["Area", "Item", A.name, B.name], shown.map((r) => [ui.esc(r.k), ui.esc(r.a), r.x.startsWith("<") ? r.x : ui.esc(r.x), r.y.startsWith("<") ? r.y : ui.esc(r.y)]), { empty: "No differences." })}
        </div></div>`;
    },
    mount(root, ctx) {
      const page = root.querySelector("#pm-page"); if (!page) return;
      const M = window.AccessMock;
      // highlight differing rows (ui.table has no row classes)
      if (M && ctx.state === "normal") {
        const A = ctx.query.get("a"), B = ctx.query.get("b");
        const byId = (id, d) => M.roles.find((r) => r.id === id) || M.roles.find((r) => r.id === d);
        const rows = compareRows(M, byId(A, "r-rec"), byId(B, "r-nocv"));
        const only = ctx.query.get("diff") !== "0";
        const shown = only ? rows.filter((r) => r.diff) : rows;
        const trs = page.querySelectorAll("#pm-compare tbody tr");
        shown.forEach((r, i) => { if (r.diff && trs[i]) trs[i].classList.add("pm-diff"); });
      }
      const setQ = (k, v) => { const q = new URLSearchParams(ctx.query); q.set(k, v); Admin.navigate("permissions?" + q); };
      page.addEventListener("change", (e) => {
        if (e.target.id === "pm-res") setQ("res", e.target.value);
        if (e.target.id === "pm-a") setQ("a", e.target.value);
        if (e.target.id === "pm-b") setQ("b", e.target.value);
        if (e.target.id === "pm-only") setQ("diff", e.target.checked ? "1" : "0");
      });
      page.addEventListener("click", (e) => {
        if (e.target.closest("[data-csv]")) {
          if (!M) return;
          download("recruitmentos-permission-matrix.csv", csv(M));
          Admin.toast(`Exported ${M.roles.length} roles × ${M.RESOURCES.length * M.ACTIONS.length} actions (mockup CSV)`);
        }
        if (e.target.closest("[data-swap]")) {
          const q = new URLSearchParams(ctx.query);
          q.set("a", page.querySelector("#pm-b").value); q.set("b", page.querySelector("#pm-a").value);
          Admin.navigate("permissions?" + q);
        }
      });
    },
  });
})();
