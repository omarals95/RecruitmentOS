/* Organisation & hierarchy: levels, org chart (tree/list), job architecture, directory, directory settings, Excel import. Route #/organisation?tab=levels|chart|jobs|directory|settings|import */
(function () {
  const S = {
    levels: [
      { id: "lv-1", name: "Company", shown: true, archived: false },
      { id: "lv-2", name: "Division", shown: true, archived: false },
      { id: "lv-3", name: "Department", shown: true, archived: false },
      { id: "lv-4", name: "Section", shown: false, archived: false },
      { id: "lv-5", name: "Region", shown: false, archived: true },
    ],
    units: null, // filled from MockData on first render
    positions: [
      ["ou-1", "Group Chief Executive", "Hamad Al Nuaimi"], ["ou-2", "Chief of Staff", "Mariam Al Suwaidi"],
      ["ou-3", "Chief People Officer", "Shamsa Al Kaabi"], ["ou-3", "Head of Talent", "Omar Alshair"],
      ["ou-9", "Senior Recruiter", "Sara Haddad"], ["ou-9", "Graduate Programme Manager", "Rahul Menon"], ["ou-9", "Recruiter", null],
      ["ou-4", "Engineering Director", "Khalid Al Mansoori"], ["ou-5", "Head of Platform", "Arjun Pillai"], ["ou-5", "Staff Engineer", "Daniel Okafor"],
      ["ou-5", "Senior Software Engineer", null], ["ou-8", "Data Science Lead", "Hannah Whitfield"],
      ["ou-6", "Chief Financial Officer", "Bilal Siddiqui"], ["ou-6", "Finance Business Partner", "Aisha Rahman"], ["ou-10", "Payroll Officer", "Grace Mendes"],
      ["ou-7", "Marketing Director", "Noor Al Hashimi"], ["ou-7", "Brand Manager", "Layla Hassan"],
    ],
    managers: {
      "Mariam Al Suwaidi": "Hamad Al Nuaimi", "Shamsa Al Kaabi": "Hamad Al Nuaimi", "Omar Alshair": "Shamsa Al Kaabi", "Sara Haddad": "Omar Alshair", "Rahul Menon": "Omar Alshair",
      "Khalid Al Mansoori": "Hamad Al Nuaimi", "Arjun Pillai": "Khalid Al Mansoori", "Daniel Okafor": "Arjun Pillai", "Hannah Whitfield": "Khalid Al Mansoori",
      "Bilal Siddiqui": "Hamad Al Nuaimi", "Aisha Rahman": "Bilal Siddiqui", "Grace Mendes": "Bilal Siddiqui", "Noor Al Hashimi": "Hamad Al Nuaimi", "Layla Hassan": "Noor Al Hashimi", "Hamad Al Nuaimi": "",
    },
    managerFrom: "Position reports to",
    open: new Set(["ou-1", "ou-3", "ou-4"]),
    imp: { step: 1, file: "", done: false, running: false },
    chartView: "tree", treeMode: "units", zoom: 1,
    jaTab: "grades",
    grades: [
      { code: "G16", name: "Executive", min: 85000, mid: 105000, max: 125000 },
      { code: "G14", name: "Director", min: 58000, mid: 70000, max: 82000 },
      { code: "G12", name: "Senior manager", min: 42000, mid: 50000, max: 58000 },
      { code: "G10", name: "Manager / lead", min: 30000, mid: 36000, max: 42000 },
      { code: "G8", name: "Senior professional", min: 22000, mid: 26500, max: 31000 },
      { code: "G6", name: "Professional", min: 15000, mid: 18500, max: 22000 },
      { code: "G4", name: "Associate", min: 9000, mid: 11500, max: 14000 },
    ],
    families: ["Leadership", "People & HR", "Engineering", "Data", "Finance", "Marketing"],
    titles: [
      ["Group Chief Executive", "Leadership", "G16"], ["Chief of Staff", "Leadership", "G14"], ["Chief People Officer", "People & HR", "G16"],
      ["Head of Talent", "People & HR", "G12"], ["Senior Recruiter", "People & HR", "G8"], ["Recruiter", "People & HR", "G6"],
      ["Graduate Programme Manager", "People & HR", "G10"], ["Engineering Director", "Engineering", "G14"], ["Head of Platform", "Engineering", "G12"],
      ["Staff Engineer", "Engineering", "G10"], ["Senior Software Engineer", "Engineering", "G8"], ["Data Science Lead", "Data", "G10"],
      ["Chief Financial Officer", "Finance", "G16"], ["Finance Business Partner", "Finance", "G8"], ["Payroll Officer", "Finance", "G6"],
      ["Marketing Director", "Marketing", "G14"], ["Brand Manager", "Marketing", "G8"],
    ].map(([title, family, grade]) => ({ title, family, grade })),
    bracketMeta: { currency: "AED", period: "Monthly", basis: "Basic + housing + transport", effective: "1 January 2026", version: 3 },
    showPay: true,
  };
  const EXTRA_UNITS = [
    { id: "ou-8", name: "Data & AI", level: "Department", parent: "ou-4" },
    { id: "ou-9", name: "Talent Acquisition", level: "Department", parent: "ou-3" },
    { id: "ou-10", name: "Payroll", level: "Section", parent: "ou-6" },
  ];
  const CSS = `<style>
    .oc-tree, .oc-tree ul { list-style:none; margin:0; padding:0; }
    .oc-tree ul { padding-inline-start:22px; border-inline-start:1px dashed var(--border-strong); margin-inline-start:10px; }
    .oc-tree details > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:var(--surface); margin:6px 0; }
    .oc-tree details > summary::-webkit-details-marker { display:none; }
    .oc-tree summary .chev { transition:transform .15s; display:inline-block; width:12px; color:var(--muted); }
    .oc-tree details[open] > summary .chev { transform:rotate(90deg); }
    [dir="rtl"] .oc-tree summary .chev { transform:scaleX(-1); }
    [dir="rtl"] .oc-tree details[open] > summary .chev { transform:rotate(90deg); }
    .oc-pos { display:flex; gap:8px; align-items:center; padding:4px 10px; font-size:13px; }
    .oc-pos .t { color:var(--muted); min-width:220px; }
    .steps { display:flex; gap:0; margin-bottom:16px; counter-reset:st; flex-wrap:wrap; }
    .steps .st { flex:1; min-width:140px; display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:3px solid var(--border); color:var(--muted); }
    .steps .st::before { counter-increment:st; content:counter(st); width:24px; height:24px; border-radius:50%; display:grid; place-items:center; border:1px solid var(--border-strong); font-size:12px; font-weight:700; }
    .steps .st.on { color:var(--primary-text); border-color:var(--primary); font-weight:700; }
    .steps .st.done { color:var(--text); border-color:var(--success); }
    .steps .st.done::before { content:"✓"; background:var(--success-bg); color:var(--success); border-color:transparent; }
    .drop { border:2px dashed var(--border-strong); border-radius:12px; padding:36px; text-align:center; background:var(--surface-subtle); }
    .lv-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border); border-radius:10px; margin-bottom:8px; background:var(--surface); }
    .lv-row .grow { flex:1; }
    tr.err td { background:var(--danger-bg) !important; } tr.wrn td { background:var(--warning-bg) !important; }
    .ot-wrap { overflow:auto; padding:16px 8px 24px; background:var(--surface-subtle); border:1px solid var(--border); border-radius:var(--radius); }
    .ot { display:inline-block; min-width:100%; text-align:center; transform-origin:top center; }
    .ot ul { padding-top:20px; position:relative; display:flex; justify-content:center; margin:0; padding-left:0; }
    .ot li { list-style:none; position:relative; padding:20px 6px 0; display:flex; flex-direction:column; align-items:center; }
    .ot li::before, .ot li::after { content:""; position:absolute; top:0; right:50%; border-top:1.5px solid var(--border-strong); width:50%; height:20px; }
    .ot li::after { right:auto; left:50%; border-left:1.5px solid var(--border-strong); }
    .ot li:only-child::before, .ot li:only-child::after { display:none; } .ot li:only-child { padding-top:0; }
    .ot li:first-child::before, .ot li:last-child::after { border:0 none; }
    .ot li:last-child::before { border-right:1.5px solid var(--border-strong); border-radius:0 6px 0 0; }
    .ot li:first-child::after { border-radius:6px 0 0 0; }
    .ot ul ul::before { content:""; position:absolute; top:0; left:50%; border-left:1.5px solid var(--border-strong); height:20px; }
    .ot > ul { padding-top:0; }
    .ot-node { background:var(--surface); border:1px solid var(--border); border-top:3px solid var(--primary); border-radius:10px; padding:8px 10px; min-width:150px; max-width:190px; text-align:start; box-shadow:var(--shadow); cursor:pointer; }
    .ot-node:hover { border-color:var(--primary); }
    .ot-node .nm { font-weight:700; font-size:13px; } .ot-node .meta { font-size:11px; color:var(--muted); }
    .ot-node.person { border-top-color:var(--success); } .ot-node.vacant { border-top-color:var(--warning); border-style:dashed; }
    .ot-node .who { display:flex; gap:6px; align-items:center; margin-top:6px; font-size:12px; }
    .ot-toggle { font-size:11px; margin-top:4px; }
    .seg { display:inline-flex; border:1px solid var(--border-strong); border-radius:8px; overflow:hidden; }
    .seg button { border:0; background:var(--surface); padding:5px 12px; cursor:pointer; }
    .seg button.on { background:var(--primary-soft); color:var(--primary-text); font-weight:700; }
    .band { position:relative; height:10px; background:var(--surface-subtle); border:1px solid var(--border); border-radius:999px; min-width:180px; }
    .band span { position:absolute; top:-1px; bottom:-1px; background:var(--primary-soft); border:1px solid var(--primary); border-radius:999px; }
    .band i { position:absolute; top:-3px; width:2px; height:14px; background:var(--primary); }
  </style>`;

  const units = (data) => { if (!S.units) S.units = data.units.map((u) => ({ ...u })).concat(EXTRA_UNITS); return S.units; };
  const unitName = (id) => (S.units.find((u) => u.id === id) || {}).name || "";
  const employees = () => S.positions.filter((p) => p[2]).map(([uid, title, name]) => ({ name, title, unit: unitName(uid), uid, manager: S.managers[name] || "", email: name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".") + "@example.test" }));

  function levelsTab(ui) {
    const rows = S.levels.map((l, i) => {
      const n = S.units.filter((u) => u.level === l.name).length;
      return [`<b>${i + 1}</b>`, `<b>${ui.esc(l.name)}</b>`, `${n} unit${n === 1 ? "" : "s"}`, l.archived ? ui.badge("Archived", "") : ui.badge("Active", "ok"),
        `<div class="row" style="flex-wrap:nowrap">${ui.btn("Rename", { kind: "sm", attrs: `data-rename="${l.id}"` })}${l.archived ? ui.btn("Restore", { kind: "sm", attrs: `data-restore="${l.id}"` }) : ui.btn("Archive", { kind: "sm", attrs: `data-archive="${l.id}"` })}</div>`];
    });
    return `<div class="split"><div>${ui.table(["Order", "Level", "Used by", "Status", ""], rows)}</div>
      <div class="card"><h2>What levels are</h2><p class="muted">Levels name the layers of your organisation, from the company down. Every unit sits at one level. Record scope (“my unit and below”) follows the units, not the level names.</p>
      ${ui.btn("Add level", { kind: "primary", attrs: "data-addlevel" })}</div></div>`;
  }

  const gradeOf = (title) => (S.titles.find((t) => t.title === title) || {}).grade || "";
  const fmt = (n) => n.toLocaleString("en-GB");

  function chartTab(ui) {
    const children = (pid) => S.units.filter((u) => u.parent === pid);
    const switcher = `<div class="seg" role="group" aria-label="Org chart view"><button data-view="tree" class="${S.chartView === "tree" ? "on" : ""}">Org tree</button><button data-view="list" class="${S.chartView === "list" ? "on" : ""}">List</button></div>`;
    const counts = `<span class="small muted" style="margin-inline-start:auto">${S.units.length} units · ${S.positions.length} positions · ${S.positions.filter((p) => !p[2]).length} vacant</span>`;
    if (S.chartView === "tree") {
      const mode = `<div class="seg" role="group" aria-label="Tree shows"><button data-tmode="units" class="${S.treeMode === "units" ? "on" : ""}">Units</button><button data-tmode="people" class="${S.treeMode === "people" ? "on" : ""}">People (reporting lines)</button></div>`;
      let tree;
      if (S.treeMode === "units") {
        const node = (u) => {
          const pos = S.positions.filter((p) => p[0] === u.id), head = pos.find((p) => p[2]), kids = children(u.id), open = S.open.has(u.id);
          return `<li><div class="ot-node" data-tunit="${u.id}" title="Open ${ui.esc(u.name)}"><div class="nm">${ui.esc(u.name)}</div><div class="meta">${ui.esc(u.level)} · ${pos.length} position${pos.length === 1 ? "" : "s"} · ${pos.filter((p) => !p[2]).length} vacant</div>
            ${head ? `<div class="who">${ui.avatar(head[2])}<span>${ui.esc(head[2])}<br><span class="meta">${ui.esc(head[1])}${gradeOf(head[1]) ? " · " + gradeOf(head[1]) : ""}</span></span></div>` : ""}
            ${kids.length ? `<div class="ot-toggle muted">${open ? "▾ hide" : "▸ show"} ${kids.length} below</div>` : ""}</div>
            ${kids.length && open ? `<ul>${kids.map(node).join("")}</ul>` : ""}</li>`;
        };
        tree = `<ul>${S.units.filter((u) => !u.parent).map(node).join("")}</ul>`;
      } else {
        const people = S.positions.filter((p) => p[2]);
        const reports = (name) => people.filter((p) => S.managers[p[2]] === name);
        const vacantUnder = (name) => S.positions.filter((p) => !p[2] && people.some((q) => q[2] === name && q[0] === p[0]));
        const node = (p) => {
          const kids = reports(p[2]), vac = vacantUnder(p[2]);
          return `<li><div class="ot-node person"><div class="who" style="margin-top:0">${ui.avatar(p[2])}<span><span class="nm">${ui.esc(p[2])}</span><br><span class="meta">${ui.esc(p[1])}${gradeOf(p[1]) ? " · " + gradeOf(p[1]) : ""}</span></span></div><div class="meta" style="margin-top:4px">${ui.esc(unitName(p[0]))}</div></div>
            ${kids.length || vac.length ? `<ul>${kids.map(node).join("")}${vac.map((v) => `<li><div class="ot-node vacant"><div class="nm">${ui.esc(v[1])}</div><div class="meta">Vacant · ${ui.esc(unitName(v[0]))}${gradeOf(v[1]) ? " · " + gradeOf(v[1]) : ""}</div></div></li>`).join("")}</ul>` : ""}</li>`;
        };
        const top = people.filter((p) => !S.managers[p[2]]);
        tree = `<ul>${top.map(node).join("")}</ul>`;
      }
      return `<div class="toolbar">${switcher}${mode}${ui.btn("−", { kind: "sm", attrs: 'data-zoom="-1" aria-label="Zoom out"' })}${ui.btn("+", { kind: "sm", attrs: 'data-zoom="1" aria-label="Zoom in"' })}${S.treeMode === "units" ? ui.btn("Expand all", { kind: "sm", attrs: "data-expand" }) + ui.btn("Collapse all", { kind: "sm", attrs: "data-collapse" }) : ""}${ui.btn("Export image", { kind: "sm", attrs: "data-export" })}${counts}</div>
        <div class="ot-wrap"><div class="ot" style="transform:scale(${S.zoom})">${tree}</div></div>
        <p class="small muted">${S.treeMode === "units" ? "Click a unit to show or hide the units below it." : "Reporting lines come from Directory settings (“Position reports to”). Dashed boxes are vacant positions."} Grades come from <a href="#/organisation?tab=jobs">Job architecture</a>.</p>`;
    }
    const node = (u) => {
      const pos = S.positions.filter((p) => p[0] === u.id);
      const kids = children(u.id);
      const filled = pos.filter((p) => p[2]).length;
      return `<li><details ${S.open.has(u.id) ? "open" : ""} data-unit="${u.id}"><summary><span class="chev">›</span><b>${ui.esc(u.name)}</b>${ui.badge(u.level, "info")}
          <span class="small muted">${pos.length} position${pos.length === 1 ? "" : "s"} · ${filled} filled${kids.length ? ` · ${kids.length} unit${kids.length === 1 ? "" : "s"} below` : ""}</span>
          <span style="margin-inline-start:auto">${ui.btn("Add unit below", { kind: "sm ghost", attrs: `data-addunit="${u.id}"` })}</span></summary>
        ${pos.map(([, t, h]) => `<div class="oc-pos"><span class="t">${ui.esc(t)} ${gradeOf(t) ? ui.badge(gradeOf(t), "") : ""}</span>${h ? `${ui.avatar(h)} ${ui.esc(h)}` : `${ui.badge("Vacant", "warn")} <a href="#/organisation?tab=chart" class="small">Vacancy open in Talent Acquisition</a>`}</div>`).join("")}
        ${kids.length ? `<ul>${kids.map(node).join("")}</ul>` : ""}</details></li>`;
    };
    const roots = S.units.filter((u) => !u.parent);
    return `<div class="toolbar">${switcher}${ui.btn("Expand all", { kind: "sm", attrs: "data-expand" })}${ui.btn("Collapse all", { kind: "sm", attrs: "data-collapse" })}${counts}</div>
      <div class="card"><ul class="oc-tree">${roots.map(node).join("")}</ul></div>
      <p class="small muted">Vacancies belong to a unit. Everything under a vacancy (applications, interviews, offers, onboarding) inherits that unit, which is how <a href="#/roles/r-hm?tab=scope">Hiring manager</a> scope works.</p>`;
  }

  function jobsTab(ui) {
    const sub = `<div class="seg" role="group" aria-label="Job architecture section">${[["grades", "Job grades & salary brackets"], ["titles", "Job titles"], ["families", "Job families"]].map(([id, l]) => `<button data-ja="${id}" class="${S.jaTab === id ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const conf = `<div class="callout warn" style="margin-bottom:12px"><b>Confidential.</b> Salary brackets are visible only to company owners and people given <b>salary brackets</b> under <i>Plan &amp; pay access</i> in <a href="#/company-authority">Company authority</a>. Everyone else sees grades without pay. Brackets are never sent to AI apps, exports or notifications.</div>`;
    const maxAll = Math.max(...S.grades.map((g) => g.max));
    let body = "";
    if (S.jaTab === "grades") {
      const m = S.bracketMeta;
      body = conf + `<div class="toolbar"><span class="small muted">Brackets in <b>${m.currency}</b>, <b>${m.period.toLowerCase()}</b>, ${ui.esc(m.basis)} · effective ${m.effective} · version ${m.version}</span>
        <label class="check" style="margin-inline-start:auto">${`<input type="checkbox" data-showpay ${S.showPay ? "checked" : ""}>`} Show salary brackets</label>${ui.btn("Bracket settings", { kind: "sm", attrs: "data-bsettings" })}${ui.btn("Add grade", { kind: "primary sm", attrs: "data-addgrade" })}</div>` +
        ui.table(["Grade", "Name", ...(S.showPay ? ["Minimum", "Midpoint", "Maximum", "Range"] : []), "Job titles", "Positions", ""], S.grades.map((g) => {
          const titles = S.titles.filter((t) => t.grade === g.code), pos = S.positions.filter((p) => titles.some((t) => t.title === p[1]));
          return [`<b>${g.code}</b>`, ui.esc(g.name), ...(S.showPay ? [fmt(g.min), `<b>${fmt(g.mid)}</b>`, fmt(g.max),
            `<div class="band" title="${fmt(g.min)}–${fmt(g.max)} AED"><span style="left:${(g.min / maxAll) * 100}%;right:${100 - (g.max / maxAll) * 100}%"></span><i style="left:${(g.mid / maxAll) * 100}%"></i></div>`] : []),
            `${titles.length}`, `${pos.length} (${pos.filter((p) => !p[2]).length} vacant)`, ui.btn("Edit", { kind: "sm", attrs: `data-editgrade="${g.code}"` })];
        })) + `<p class="small muted">Offers outside a vacancy's grade bracket need approval from the <a href="#/groups/g-off">offer-approvers</a> group (set in the Offer approval <a href="#/workflows/offer">workflow</a>).</p>`;
    } else if (S.jaTab === "titles") {
      body = `<div class="toolbar"><input class="input" type="search" id="jt-q" placeholder="Search job titles"><select class="input" id="jt-fam"><option value="">All families</option>${S.families.map((f) => `<option>${ui.esc(f)}</option>`).join("")}</select>${ui.btn("Add job title", { kind: "primary sm", attrs: "data-addtitle" })}</div>` +
        `<div class="table-wrap"><table class="t"><thead><tr><th>Job title</th><th>Family</th><th>Grade</th>${S.showPay ? "<th>Salary bracket (AED / month)</th>" : ""}<th>Positions</th><th>Open vacancies</th><th></th></tr></thead><tbody>${S.titles.map((t) => {
          const g = S.grades.find((x) => x.code === t.grade) || {}, pos = S.positions.filter((p) => p[1] === t.title);
          return `<tr data-jt="${ui.esc((t.title + " " + t.family).toLowerCase())}" data-fam="${ui.esc(t.family)}"><td><b>${ui.esc(t.title)}</b></td><td>${ui.esc(t.family)}</td><td>${ui.badge(t.grade, "info")} <span class="small muted">${ui.esc(g.name || "")}</span></td>${S.showPay ? `<td>${fmt(g.min)} – ${fmt(g.max)}</td>` : ""}<td>${pos.length}</td><td>${pos.filter((p) => !p[2]).length}</td><td>${ui.btn("Edit", { kind: "sm", attrs: `data-edittitle="${ui.esc(t.title)}"` })}</td></tr>`;
        }).join("")}</tbody></table></div><p class="small muted">Positions and vacancies pick a job title; the grade and bracket follow from it. Changing a title's grade shows which positions, open vacancies and offers it affects first.</p>`;
    } else {
      body = ui.table(["Family", "Job titles", "Grades used", ""], S.families.map((f) => { const ts = S.titles.filter((t) => t.family === f); return [`<b>${ui.esc(f)}</b>`, `${ts.length}`, [...new Set(ts.map((t) => t.grade))].sort().join(", ") || "—", ui.btn("Rename", { kind: "sm", attrs: `data-renfam="${ui.esc(f)}"` })]; })) +
        `<div class="row" style="margin-top:12px">${ui.btn("Add family", { kind: "primary sm", attrs: "data-addfam" })}</div>`;
    }
    return `<div class="toolbar">${sub}</div>${body}`;
  }

  function directoryTab(ui, q) {
    const emps = employees();
    return `<div class="toolbar"><input class="input" id="dir-q" type="search" placeholder="Search name, position, unit or manager" value="${ui.esc(q)}" aria-label="Search directory">
      <select class="input" id="dir-unit" aria-label="Filter by unit"><option value="">All units</option>${S.units.map((u) => `<option>${ui.esc(u.name)}</option>`).join("")}</select>
      <span class="small muted" id="dir-count" style="margin-inline-start:auto">${emps.length} people</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Position</th><th>Grade</th><th>Unit</th><th>Manager</th><th>Email</th><th></th></tr></thead><tbody>
      ${emps.map((e) => `<tr data-row="${ui.esc((e.name + " " + e.title + " " + e.unit + " " + e.manager).toLowerCase())}" data-unit="${ui.esc(e.unit)}">
        <td><span class="row" style="flex-wrap:nowrap">${ui.avatar(e.name)} <b>${ui.esc(e.name)}</b></span></td><td>${ui.esc(e.title)}</td><td>${gradeOf(e.title) ? ui.badge(gradeOf(e.title), "info") : "—"}</td><td>${ui.esc(e.unit)}</td><td>${ui.esc(e.manager || "—")}</td><td class="small">${ui.esc(e.email)}</td>
        <td>${ui.btn("Edit", { kind: "sm", attrs: `data-edit="${ui.esc(e.name)}"` })}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="card state" id="dir-none" hidden>${ui.icon("search")}<p>No one matches. Try a shorter search.</p></div>
      <p class="small muted">Changing someone's home unit changes which records they can see. Only company owners can do it, and it is recorded in the audit log.</p>`;
  }

  function settingsTab(ui) {
    const act = S.levels.filter((l) => !l.archived);
    const shown = act.filter((l) => l.shown).map((l) => l.name);
    return `<div class="split"><div class="card"><h2>How the hierarchy is built</h2>
      <p class="muted small">Choose which levels appear in the org chart, unit pickers and breadcrumbs, and in what order. Hidden levels still exist; their units fold into the level above.</p>
      ${act.map((l, i) => `<div class="lv-row"><input type="checkbox" data-shown="${l.id}" ${l.shown ? "checked" : ""} ${i === 0 ? "disabled" : ""} aria-label="Show ${ui.esc(l.name)}">
        <span class="grow"><b>${ui.esc(l.name)}</b>${i === 0 ? ' <span class="small muted">(always shown)</span>' : ""}</span>
        ${ui.btn("↑", { kind: "sm", attrs: `data-up="${l.id}" aria-label="Move ${ui.esc(l.name)} up" ${i <= 1 ? "disabled" : ""}` })}
        ${ui.btn("↓", { kind: "sm", attrs: `data-down="${l.id}" aria-label="Move ${ui.esc(l.name)} down" ${i === 0 || i === act.length - 1 ? "disabled" : ""}` })}</div>`).join("")}
      <h3 style="margin-top:14px">A person's manager comes from</h3>
      ${["Position reports to", "Head of their unit"].map((o) => `<label class="check" style="margin-inline-end:16px"><input type="radio" name="mgr" data-mgr value="${o}" ${S.managerFrom === o ? "checked" : ""}> ${o}</label>`).join("")}
      <h3 style="margin-top:14px">Record scope follows</h3>
      <label class="check"><input type="radio" checked disabled> The person's home unit in this directory</label>
      <div class="row" style="margin-top:16px">${ui.btn("Save settings", { kind: "primary", attrs: "data-savesettings" })}</div></div>
      <div class="card"><h2>Preview</h2><p class="small muted">Breadcrumb for Senior Software Engineer:</p>
      <p><b>${["Al Noor Holding", "Engineering", "Platform Engineering"].filter((n, i) => shown.includes(["Company", "Division", "Department"][i])).join(" › ")}</b></p>
      <p class="small muted">Levels shown: ${shown.map(ui.esc).join(" → ")}</p></div></div>`;
  }

  const MAP = [["Employee name", "Name"], ["Work email", "Email"], ["Job title", "Job title"], ["Grade", "Grade"], ["Department", "Unit"], ["Line manager email", "Manager email"], ["Employee no.", "Employee ID"], ["Nationality", "Ignore"]];
  const PREVIEW = [
    ["", "Fatma Al Shamsi", "fatma.alshamsi@example.test", "HR Business Partner", "Human Resources", "shamsa.alkaabi@example.test", "New"],
    ["", "Vikram Nair", "vikram.nair@example.test", "Platform Engineer", "Platform Engineering", "arjun.pillai@example.test", "New"],
    ["wrn", "Daniel Okafor", "daniel.okafor@example.test", "Principal Engineer", "Data & AI", "hannah.whitfield@example.test", "Updates position and home unit (changes what he can see)"],
    ["err", "Ahmed Saleh", "ahmed.saleh@example.test", "Data Analyst", "Enginering", "khalid.almansoori@example.test", "Unit “Enginering” does not exist. Did you mean Engineering?"],
    ["err", "Priya Raman", "priya.raman@example", "Payroll Assistant", "Payroll", "grace.mendes@example.test", "Email “priya.raman@example” is not valid"],
    ["", "Tom Becker", "tom.becker@example.test", "Content Lead", "Marketing", "noor.alhashimi@example.test", "New"],
  ];
  function importTab(ui) {
    const I = S.imp, labels = ["Upload", "Map columns", "Preview", "Import"];
    const steps = `<div class="steps">${labels.map((l, i) => `<div class="st ${i + 1 === I.step && !I.done ? "on" : i + 1 < I.step || I.done ? "done" : ""}">${l}</div>`).join("")}</div>`;
    let body = "";
    if (I.step === 1) body = `<div class="drop">${ui.icon("inbox", 'width="36" height="36"')}<h2>Upload your employee list</h2><p class="muted">Excel (.xlsx) or CSV, up to 5,000 rows. One row per person.</p>
        <div class="row" style="justify-content:center"><label class="btn primary" style="cursor:pointer">Choose file<input type="file" accept=".xlsx,.csv" id="imp-file" hidden></label>${ui.btn("Use sample file", { attrs: "data-sample" })}</div>
        <p class="small" style="margin-top:12px">${I.file ? `Selected: <b>${ui.esc(I.file)}</b>` : `<a href="#/organisation?tab=import" data-template>Download the template</a>`}</p></div>`;
    else if (I.step === 2) body = `<p class="muted">We matched your columns to directory fields. Check them before the preview.</p>${ui.table(["Column in your file", "Sample value", "Directory field"], MAP.map(([c, f], i) => [
        `<b>${c}</b>`, `<span class="small muted">${ui.esc(PREVIEW[0][i + 1] || "Emirati")}</span>`,
        ui.select(["Name", "Email", "Job title", "Grade", "Position", "Unit", "Manager email", "Employee ID", "Ignore"], f, `aria-label="Field for ${c}"`)]))}
        <p class="small muted">Units are matched by name to the org chart. Managers are matched by email.</p>`;
    else if (I.step === 3) body = `<div class="grid g4" style="margin-bottom:12px">${ui.kpi("Rows", "42")}${ui.kpi("Ready", "38", "31 new · 7 updates")}${ui.kpi("Warnings", "2", "Will import")}${ui.kpi("Errors", "2", "Fix or skip")}</div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Email</th><th>Position</th><th>Unit</th><th>Manager</th><th>Result</th></tr></thead><tbody>
        ${PREVIEW.map((r) => `<tr class="${r[0]}">${r.slice(1, 6).map((c) => `<td>${ui.esc(c)}</td>`).join("")}<td>${r[0] === "err" ? ui.badge("Error", "bad") : r[0] === "wrn" ? ui.badge("Warning", "warn") : ui.badge("Ready", "ok")} <span class="small">${ui.esc(r[6])}</span></td></tr>`).join("")}
        </tbody></table></div><p class="small muted">Showing 6 of 42 rows, including every row with a problem.</p>
        <label class="check"><input type="checkbox" id="imp-skip" checked> Skip the 2 rows with errors and import the rest</label>`;
    else body = I.done
      ? `<div class="card state">${ui.icon("activity")}<h2>Import finished</h2><p class="muted">40 people imported: 31 added, 7 updated, 2 changed home unit. 2 rows skipped.</p>
          <div class="row" style="justify-content:center">${ui.btn("Open directory", { kind: "primary", attrs: "data-godir" })}${ui.btn("Import another file", { attrs: "data-again" })}${ui.btn("Download skipped rows", { attrs: "data-skipped" })}</div></div>`
      : `<div class="callout warn"><b>Before you import</b><ul style="margin:6px 0 0">
          <li>Adds <b>31</b> people and updates <b>7</b> in the directory</li>
          <li>Changes the home unit for <b>2</b> people. This changes which records they can see in <b>2 teams</b> (roles with “My unit and below”)</li>
          <li>Skips <b>2</b> rows with errors</li><li>Recorded in the audit log as one import</li></ul></div>
        <div id="imp-progress" style="margin-top:14px" ${I.running ? "" : "hidden"}>${ui.bar(0)}<p class="small muted">Importing…</p></div>`;
    const nav = I.done ? "" : `<div class="row" style="justify-content:space-between;margin-top:16px">${I.step > 1 ? ui.btn("Back", { attrs: "data-back" }) : "<span></span>"}
      ${I.step < 4 ? ui.btn("Next", { kind: "primary", attrs: `data-next ${I.step === 1 && !I.file ? "disabled" : ""}` }) : ui.btn("Import 40 people", { kind: "primary", attrs: `data-run ${I.running ? "disabled" : ""}` })}</div>`;
    return `<div class="card">${steps}${body}${nav}</div>`;
  }

  Admin.register({
    id: "organisation", group: "People & access", title: "Organisation & hierarchy", icon: "org",
    spec: ["R2a-18", "R2a-19", "IAM-004"],
    changes: "Brings levels, the org chart (tree and list), job architecture (grades, job titles, salary brackets), the employee directory, directory settings and Excel import together on one page.",
    render(ctx) {
      const { ui, data } = ctx;
      units(data);
      const tab = ctx.query.get("tab") || "levels";
      const head = ui.pageHeader("Organisation & hierarchy", "The company's structure: levels, units, positions, job grades and people. Record scope follows it.",
        ui.btn("Import from Excel", { ic: "log", attrs: `onclick="Admin.navigate('organisation?tab=import')"` }) + ui.btn("Add unit", { kind: "primary", ic: "org", attrs: "data-addunit='ou-1'" }));
      const tabs = ui.tabs("org", [{ id: "levels", label: "Levels" }, { id: "chart", label: "Org chart" }, { id: "jobs", label: "Job architecture" }, { id: "directory", label: "Directory" }, { id: "settings", label: "Directory settings" }, { id: "import", label: "Import from Excel" }], tab);
      if (ctx.state !== "normal") return head + tabs + ui.stateBlock(ctx.state, { emptyTitle: "No organisation yet", emptyText: "Add your first unit or import your employee list from Excel.", emptyAction: `<div class="row" style="justify-content:center">${ui.btn("Import from Excel", { kind: "primary", attrs: `onclick="Admin.navigate('organisation?tab=import')"` })}</div>` });
      const body = { levels: () => levelsTab(ui), chart: () => chartTab(ui), jobs: () => jobsTab(ui), directory: () => directoryTab(ui, ctx.query.get("q") || ""), settings: () => settingsTab(ui), import: () => importTab(ui) }[tab] || (() => levelsTab(ui));
      return CSS + `<div id="org-page">${head}${tabs}${body()}</div>`;
    },
    mount(root, ctx) {
      const page = root.querySelector("#org-page"); if (!page) return;
      const { ui } = ctx;
      const find = (id) => S.levels.find((l) => l.id === id);
      const filterDir = () => {
        const q = (page.querySelector("#dir-q").value || "").toLowerCase().trim(), u = page.querySelector("#dir-unit").value;
        let n = 0;
        page.querySelectorAll("tr[data-row]").forEach((tr) => { const ok = tr.dataset.row.includes(q) && (!u || tr.dataset.unit === u); tr.hidden = !ok; if (ok) n++; });
        page.querySelector("#dir-count").textContent = `${n} ${n === 1 ? "person" : "people"}`;
        page.querySelector("#dir-none").hidden = n > 0;
        page.querySelector(".table-wrap").hidden = n === 0;
      };
      if (page.querySelector("#dir-q")) { page.querySelector("#dir-q").addEventListener("input", filterDir); page.querySelector("#dir-unit").addEventListener("change", filterDir); if (ctx.query.get("q")) filterDir(); }
      page.querySelectorAll("details[data-unit]").forEach((d) => d.addEventListener("toggle", () => (d.open ? S.open.add(d.dataset.unit) : S.open.delete(d.dataset.unit))));
      function filterJt() { const q = (page.querySelector("#jt-q")?.value || "").toLowerCase(), f = page.querySelector("#jt-fam")?.value || ""; page.querySelectorAll("tr[data-jt]").forEach((tr) => (tr.hidden = !(tr.dataset.jt.includes(q) && (!f || tr.dataset.fam === f)))); }
      const fileIn = page.querySelector("#imp-file");
      if (fileIn) fileIn.addEventListener("change", () => { if (fileIn.files[0]) { S.imp.file = fileIn.files[0].name; Admin.rerender(); } });

      page.addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset.shown) { find(t.dataset.shown).shown = t.checked; Admin.rerender(); }
        if (t.hasAttribute("data-mgr")) S.managerFrom = t.value;
        if (t.hasAttribute("data-showpay")) { S.showPay = t.checked; Admin.rerender(); }
        if (t.id === "jt-fam") filterJt();
      });
      page.querySelector("#jt-q")?.addEventListener("input", () => filterJt());
      page.addEventListener("click", (e) => {
        const node = e.target.closest("[data-tunit]"); if (node) { const id = node.dataset.tunit; S.open.has(id) ? S.open.delete(id) : S.open.add(id); Admin.rerender(); return; }
        const t = e.target.closest("button,a,[data-addunit]"); if (!t) return;
        const d = t.dataset;
        if (d.addlevel !== undefined) {
          Admin.modal(`<h2>Add level</h2>${ui.field("Name", ui.input("", 'id="lv-name" placeholder="For example: Section"'), "Added at the bottom. Change the order in Directory settings.")}<div id="lv-err" class="small" style="color:var(--danger)"></div>
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Add level", { kind: "primary", attrs: 'id="lv-go"' })}</div>`);
          document.getElementById("lv-go").onclick = () => {
            const v = document.getElementById("lv-name").value.trim();
            if (!v) return (document.getElementById("lv-err").textContent = "Enter a name.");
            if (S.levels.some((l) => l.name.toLowerCase() === v.toLowerCase())) return (document.getElementById("lv-err").textContent = "That level already exists.");
            S.levels.push({ id: "lv-" + Date.now(), name: v, shown: true, archived: false }); Admin.close(); Admin.toast(`Level “${v}” added (mockup)`); Admin.rerender();
          };
        } else if (d.rename) {
          const l = find(d.rename);
          Admin.modal(`<h2>Rename level</h2>${ui.field("Name", ui.input(l.name, 'id="lv-name"'), `${S.units.filter((u) => u.level === l.name).length} units will show the new name.`)}
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Rename", { kind: "primary", attrs: 'id="lv-go"' })}</div>`);
          document.getElementById("lv-go").onclick = () => {
            const v = document.getElementById("lv-name").value.trim(); if (!v) return;
            S.units.forEach((u) => { if (u.level === l.name) u.level = v; }); l.name = v; Admin.close(); Admin.toast("Level renamed (mockup)"); Admin.rerender();
          };
        } else if (d.archive) {
          const l = find(d.archive), used = S.units.filter((u) => u.level === l.name);
          Admin.modal(used.length
            ? `<h2>Archive “${ui.esc(l.name)}”?</h2><div class="callout warn">Used by <b>${used.length} unit${used.length === 1 ? "" : "s"}</b>: ${used.map((u) => ui.esc(u.name)).join(", ")}. Move them to another level first, or they keep the archived level name.</div>
               <div class="row" style="justify-content:flex-end;margin-top:12px">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Archive anyway", { kind: "danger", attrs: 'id="lv-go"' })}</div>`
            : `<h2>Archive “${ui.esc(l.name)}”?</h2><p>No units use this level. You can restore it later.</p><div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Archive", { kind: "danger", attrs: 'id="lv-go"' })}</div>`);
          document.getElementById("lv-go").onclick = () => { l.archived = true; Admin.close(); Admin.toast(`Level “${l.name}” archived (mockup)`); Admin.rerender(); };
        } else if (d.restore) { find(d.restore).archived = false; Admin.toast("Level restored (mockup)"); Admin.rerender(); }
        else if (d.addunit) {
          e.preventDefault();
          const parent = S.units.find((u) => u.id === d.addunit);
          Admin.modal(`<h2>Add unit</h2>${ui.field("Name", ui.input("", 'id="un-name" placeholder="For example: Cloud Operations"'))}
            ${ui.field("Under", `<select class="input" id="un-parent">${S.units.map((u) => `<option value="${u.id}" ${u.id === parent.id ? "selected" : ""}>${ui.esc(u.name)}</option>`).join("")}</select>`)}
            ${ui.field("Level", ui.select(S.levels.filter((l) => !l.archived).map((l) => l.name), "Department", 'id="un-level"'))}
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Add unit", { kind: "primary", attrs: 'id="un-go"' })}</div>`);
          document.getElementById("un-go").onclick = () => {
            const v = document.getElementById("un-name").value.trim(); if (!v) return;
            const id = "ou-" + Date.now(), p = document.getElementById("un-parent").value;
            S.units.push({ id, name: v, level: document.getElementById("un-level").value, parent: p }); S.open.add(p);
            Admin.close(); Admin.toast(`Unit “${v}” added (mockup)`); Admin.navigate("organisation?tab=chart"); Admin.rerender();
          };
        } else if (d.expand !== undefined) { S.units.forEach((u) => S.open.add(u.id)); if (S.chartView === "tree") Admin.rerender(); else page.querySelectorAll("details[data-unit]").forEach((x) => (x.open = true)); }
        else if (d.collapse !== undefined) { S.open.clear(); S.open.add("ou-1"); if (S.chartView === "tree") Admin.rerender(); else page.querySelectorAll("details[data-unit]").forEach((x) => (x.open = false)); }
        else if (d.edit) {
          const emp = employees().find((x) => x.name === d.edit);
          Admin.drawer(`<h2>${ui.esc(emp.name)}</h2><p class="muted small">${ui.esc(emp.email)}</p>
            ${ui.field("Position", ui.input(emp.title))}
            ${ui.field("Home unit", `<select class="input" id="emp-unit">${S.units.map((u) => `<option ${u.name === emp.unit ? "selected" : ""}>${ui.esc(u.name)}</option>`).join("")}</select>`, "Changing this changes which records they can see. Company owners only; audited.")}
            ${ui.field("Manager", ui.select(["—"].concat(employees().map((x) => x.name).filter((n) => n !== emp.name)), emp.manager || "—"))}
            <div id="emp-impact"></div>
            <div class="row" style="margin-top:12px">${ui.btn("Save", { kind: "primary", attrs: 'id="emp-go"' })}${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}</div>`);
          document.getElementById("emp-unit").onchange = (ev) => {
            document.getElementById("emp-impact").innerHTML = ev.target.value !== emp.unit
              ? `<div class="callout warn"><b>Access changes.</b> ${ui.esc(emp.name)} will see records in <b>${ui.esc(ev.target.value)}</b> and below instead of ${ui.esc(emp.unit)}, wherever their role uses “My unit and below”.</div>` : "";
          };
          document.getElementById("emp-go").onclick = () => { Admin.close(); Admin.toast("Saved (mockup). Recorded in the audit log."); };
        } else if (d.up || d.down) {
          const act = S.levels.filter((l) => !l.archived), id = d.up || d.down, i = act.findIndex((l) => l.id === id), j = d.up ? i - 1 : i + 1;
          const a = S.levels.indexOf(act[i]), b = S.levels.indexOf(act[j]);
          [S.levels[a], S.levels[b]] = [S.levels[b], S.levels[a]]; Admin.rerender();
        } else if (d.savesettings !== undefined) Admin.toast("Directory settings saved (mockup)");
        else if (d.sample !== undefined) { S.imp.file = "al-noor-directory-nov-2026.xlsx"; Admin.rerender(); }
        else if (d.template !== undefined) { e.preventDefault(); Admin.toast("Template downloaded (mockup)"); }
        else if (d.next !== undefined) { S.imp.step++; Admin.rerender(); }
        else if (d.back !== undefined) { S.imp.step--; Admin.rerender(); }
        else if (d.run !== undefined) {
          S.imp.running = true; t.disabled = true;
          const prog = page.querySelector("#imp-progress"); prog.hidden = false;
          let p = 0; const bar = prog.querySelector(".bar > span");
          const iv = setInterval(() => { p += 20; bar.style.width = p + "%"; if (p >= 100) { clearInterval(iv); S.imp.running = false; S.imp.done = true; Admin.toast("Import finished (mockup)"); Admin.rerender(); } }, 250);
        } else if (d.again !== undefined) { S.imp = { step: 1, file: "", done: false, running: false }; Admin.rerender(); }
        else if (d.godir !== undefined) { S.imp = { step: 1, file: "", done: false, running: false }; Admin.navigate("organisation?tab=directory"); }
        else if (d.skipped !== undefined) Admin.toast("Skipped rows downloaded (mockup)");
        else if (d.view) { S.chartView = d.view; Admin.rerender(); }
        else if (d.tmode) { S.treeMode = d.tmode; Admin.rerender(); }
        else if (d.zoom) { S.zoom = Math.min(1.4, Math.max(0.5, +(S.zoom + 0.15 * +d.zoom).toFixed(2))); page.querySelector(".ot").style.transform = `scale(${S.zoom})`; }
        else if (d.export !== undefined) Admin.toast("Org tree exported as PNG (mockup)");
        else if (d.ja) { S.jaTab = d.ja; Admin.rerender(); }
        else if (d.addgrade !== undefined || d.editgrade) {
          const g = S.grades.find((x) => x.code === d.editgrade) || { code: "", name: "", min: "", mid: "", max: "" };
          const uses = S.titles.filter((t) => t.grade === g.code);
          Admin.modal(`<h2>${d.editgrade ? "Edit grade " + ui.esc(g.code) : "Add grade"}</h2>
            <div class="grid g2">${ui.field("Grade code", ui.input(g.code, 'id="gr-code" placeholder="G9"'))}${ui.field("Name", ui.input(g.name, 'id="gr-name" placeholder="Senior professional"'))}</div>
            <div class="grid g3">${ui.field("Minimum (AED / month)", ui.input(g.min, 'id="gr-min" type="number" min="0" step="500"'))}${ui.field("Midpoint", ui.input(g.mid, 'id="gr-mid" type="number" min="0" step="500"'))}${ui.field("Maximum", ui.input(g.max, 'id="gr-max" type="number" min="0" step="500"'))}</div>
            <div id="gr-err" class="small" style="color:var(--danger)"></div>
            ${uses.length ? `<div class="callout warn">Used by <b>${uses.length} job titles</b> and their positions. Changing the bracket creates bracket version ${S.bracketMeta.version + 1}; open offers keep the bracket they were made under.</div>` : ""}
            <div class="row" style="justify-content:flex-end;margin-top:12px">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Save grade", { kind: "primary", attrs: 'id="gr-go"' })}</div>`);
          document.getElementById("gr-go").onclick = () => {
            const v = (id) => document.getElementById(id).value.trim(), mn = +v("gr-min"), md = +v("gr-mid"), mx = +v("gr-max");
            if (!v("gr-code") || !v("gr-name")) return (document.getElementById("gr-err").textContent = "Enter a grade code and a name.");
            if (!(mn > 0 && mn <= md && md <= mx)) return (document.getElementById("gr-err").textContent = "Minimum must be at most the midpoint, and the midpoint at most the maximum.");
            Object.assign(g, { code: v("gr-code"), name: v("gr-name"), min: mn, mid: md, max: mx }); if (!d.editgrade) S.grades.push(g); else S.bracketMeta.version++;
            S.grades.sort((a, b) => b.mid - a.mid); Admin.close(); Admin.toast("Grade saved (mockup). Recorded in the audit log."); Admin.rerender();
          };
        } else if (d.bsettings !== undefined) {
          const m = S.bracketMeta;
          Admin.modal(`<h2>Salary bracket settings</h2>${ui.field("Currency", ui.select(["AED", "USD", "SAR"], m.currency))}${ui.field("Pay period", ui.select(["Monthly", "Annual"], m.period))}${ui.field("What the bracket covers", ui.select(["Basic + housing + transport", "Basic salary only", "Total cash"], m.basis))}${ui.field("Effective from", ui.input("2026-01-01", 'type="date"'))}
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Save", { kind: "primary", attrs: 'onclick="Admin.close();Admin.toast(\'Bracket settings saved (mockup)\')"' })}</div>`);
        } else if (d.addtitle !== undefined || d.edittitle) {
          const t = S.titles.find((x) => x.title === d.edittitle) || { title: "", family: S.families[0], grade: "G6" };
          const pos = S.positions.filter((p) => p[1] === t.title);
          Admin.modal(`<h2>${d.edittitle ? "Edit job title" : "Add job title"}</h2>${ui.field("Job title", ui.input(t.title, 'id="jt-name"'))}
            <div class="grid g2">${ui.field("Job family", ui.select(S.families, t.family, 'id="jt-family"'))}${ui.field("Grade", `<select class="input" id="jt-grade">${S.grades.map((g) => `<option value="${g.code}" ${g.code === t.grade ? "selected" : ""}>${g.code} · ${ui.esc(g.name)}</option>`).join("")}</select>`)}</div>
            <div id="jt-impact">${pos.length ? `<p class="small muted">Used by ${pos.length} position${pos.length === 1 ? "" : "s"} (${pos.filter((p) => !p[2]).length} vacant).</p>` : ""}</div>
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Save job title", { kind: "primary", attrs: 'id="jt-go"' })}</div>`);
          document.getElementById("jt-grade").onchange = (ev) => { if (d.edittitle && ev.target.value !== t.grade) document.getElementById("jt-impact").innerHTML = `<div class="callout warn">Moves <b>${pos.length} position${pos.length === 1 ? "" : "s"}</b> and <b>${pos.filter((p) => !p[2]).length} open vacanc${pos.filter((p) => !p[2]).length === 1 ? "y" : "ies"}</b> from ${t.grade} to ${ev.target.value}. Existing offers are not changed.</div>`; };
          document.getElementById("jt-go").onclick = () => { const n = document.getElementById("jt-name").value.trim(); if (!n) return; Object.assign(t, { title: n, family: document.getElementById("jt-family").value, grade: document.getElementById("jt-grade").value }); if (!d.edittitle) S.titles.push(t); Admin.close(); Admin.toast("Job title saved (mockup)"); Admin.rerender(); };
        } else if (d.addfam !== undefined || d.renfam) {
          Admin.modal(`<h2>${d.renfam ? "Rename family" : "Add job family"}</h2>${ui.field("Name", ui.input(d.renfam || "", 'id="jf-name"'))}<div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Save", { kind: "primary", attrs: 'id="jf-go"' })}</div>`);
          document.getElementById("jf-go").onclick = () => { const n = document.getElementById("jf-name").value.trim(); if (!n) return; if (d.renfam) { S.families[S.families.indexOf(d.renfam)] = n; S.titles.forEach((t) => { if (t.family === d.renfam) t.family = n; }); } else S.families.push(n); Admin.close(); Admin.rerender(); };
        }
      });
    },
  });
})();
