/* Custom fields: central field registry (#/fields), field detail (#/fields/<id>?tab=general|contexts|screens|delete), create wizard.
   Exposes window.FieldsMock (fields + screen names) for pages/screens.js. */
(function () {
  const TYPES = ["Text", "Long text", "Number", "Money (AED)", "Date", "Single select", "Multi select", "User", "Unit", "Checkbox", "URL", "Email", "Phone"];
  const TYPE_HINT = {
    Text: "One line, up to 255 characters", "Long text": "Paragraphs, plain or rich text", Number: "Whole or decimal, optional unit", "Money (AED)": "Amount in dirhams, two decimals",
    Date: "A calendar date", "Single select": "Pick one option", "Multi select": "Pick several options", User: "A person in the company", Unit: "A unit from the org chart",
    Checkbox: "Yes or no", URL: "A web address", Email: "An email address", Phone: "A phone number with country code",
  };
  const CHOICE = new Set(["Single select", "Multi select"]);
  const TEAMS = ["Talent Acquisition", "Executive Search", "Graduate Hiring"];
  const SCREENS = {
    "scr-cand-create": "Candidate create", "scr-cand-edit": "Candidate edit", "scr-cand-view": "Candidate view", "scr-grad-create": "Graduate candidate create",
    "scr-vac-create": "Vacancy create", "scr-vac-edit": "Vacancy edit", "scr-app-view": "Application view", "scr-int-edit": "Interview feedback",
    "scr-off-create": "Offer create", "scr-onb-edit": "Onboarding checklist",
  };
  const ctxAll = (kinds, extra = {}) => [{ name: "Default context", kinds, teams: "All teams", def: "", options: [], ...extra }];
  const opts = (...l) => l.map((label) => ({ label, disabled: false, used: Math.floor(label.length * 1.7) % 23 }));
  const F = (id, name, type, kinds, o) => ({ id, name, type, kinds, system: id.startsWith("sys_"), sensitive: false, desc: "", screens: [], records: 0, updated: "1 Sep 2026", contexts: ctxAll(kinds), ...o });
  const fields = [
    F("sys_full_name", "Full name", "Text", ["Candidate"], { desc: "The candidate's name as it appears on their CV.", screens: ["scr-cand-create", "scr-cand-edit", "scr-cand-view", "scr-grad-create"], records: 103 }),
    F("sys_email", "Email", "Email", ["Candidate"], { desc: "Main contact email.", screens: ["scr-cand-create", "scr-cand-edit", "scr-cand-view", "scr-grad-create"], records: 101 }),
    F("sys_phone", "Phone", "Phone", ["Candidate"], { sensitive: true, screens: ["scr-cand-create", "scr-cand-edit", "scr-cand-view"], records: 88 }),
    F("sys_stage", "Stage", "Single select", ["Application"], { desc: "Where the application is in the pipeline. Set by the workflow.", screens: ["scr-app-view"], records: 142,
      contexts: ctxAll(["Application"], { options: opts("Applied", "Screening", "Interview", "Assessment", "Offer", "Hired", "Rejected"), def: "Applied" }) }),
    F("sys_vac_title", "Title", "Text", ["Vacancy"], { screens: ["scr-vac-create", "scr-vac-edit"], records: 16 }),
    F("sys_unit", "Unit", "Unit", ["Vacancy"], { desc: "The org unit that owns the vacancy. Record scope follows it.", screens: ["scr-vac-create", "scr-vac-edit"], records: 16 }),
    F("sys_hm", "Hiring manager", "User", ["Vacancy"], { screens: ["scr-vac-create", "scr-vac-edit"], records: 15 }),
    F("sys_offer_amount", "Offer amount", "Money (AED)", ["Offer"], { sensitive: true, desc: "Monthly basic salary offered.", screens: ["scr-off-create"], records: 9 }),
    F("sys_start", "Start date", "Date", ["Offer", "Onboarding"], { screens: ["scr-off-create", "scr-onb-edit"], records: 11 }),
    F("sys_int_date", "Interview date", "Date", ["Interview"], { screens: ["scr-int-edit"], records: 37 }),
    F("cf_10031", "Expected salary", "Money (AED)", ["Candidate"], { sensitive: true, desc: "What the candidate asked for, per month.", screens: ["scr-cand-create", "scr-cand-edit"], records: 61, updated: "2 Nov 2026" }),
    F("cf_10032", "Notice period", "Number", ["Candidate"], { desc: "In days.", screens: [], records: 0, updated: "28 Oct 2026" }),
    F("cf_10033", "Nationality", "Single select", ["Candidate"], { sensitive: true, screens: ["scr-cand-edit", "scr-cand-view"], records: 77,
      contexts: ctxAll(["Candidate"], { options: opts("Emirati", "Indian", "Pakistani", "Egyptian", "Jordanian", "Filipino", "British", "Other") }) }),
    F("cf_10034", "Visa status", "Single select", ["Candidate", "Onboarding"], { screens: ["scr-cand-create", "scr-cand-edit", "scr-onb-edit"], records: 69, updated: "6 Nov 2026",
      contexts: [
        { name: "Default context", kinds: ["Candidate", "Onboarding"], teams: "All teams", def: "Needs sponsorship", options: opts("UAE national", "Residence visa (employer)", "Residence visa (family)", "Golden visa", "Visit visa", "Needs sponsorship") },
        { name: "Executive Search", kinds: ["Candidate"], teams: ["Executive Search"], def: "", options: opts("UAE national", "Golden visa", "Residence visa", "Relocating from abroad") },
      ] }),
    F("cf_10035", "Languages", "Multi select", ["Candidate"], { screens: ["scr-cand-edit", "scr-cand-view"], records: 54, contexts: ctxAll(["Candidate"], { options: opts("Arabic", "English", "Hindi", "Urdu", "French", "Tagalog") }) }),
    F("cf_10036", "LinkedIn profile", "URL", ["Candidate"], { screens: ["scr-cand-create", "scr-cand-edit", "scr-cand-view"], records: 58 }),
    F("cf_10037", "Budget code", "Text", ["Vacancy"], { screens: ["scr-vac-create"], records: 14 }),
    F("cf_10038", "Security clearance required", "Checkbox", ["Vacancy"], { screens: ["scr-vac-create", "scr-vac-edit"], records: 16 }),
    F("cf_10039", "Interview panel", "User", ["Interview"], { screens: ["scr-int-edit"], records: 31 }),
    F("cf_10040", "Reason for rejection", "Single select", ["Application"], { screens: ["scr-app-view"], records: 40, contexts: ctxAll(["Application"], { options: opts("Skills gap", "Salary expectations", "Withdrew", "Failed assessment", "Position filled", "No right to work") }) }),
    F("cf_10041", "Relocation support", "Checkbox", ["Offer"], { screens: ["scr-off-create"], records: 9 }),
    F("cf_10042", "Emergency contact phone", "Phone", ["Onboarding"], { sensitive: true, screens: ["scr-onb-edit"], records: 6 }),
    F("cf_10043", "Graduation date", "Date", ["Candidate"], { screens: ["scr-grad-create"], records: 44, contexts: [{ name: "Graduate Hiring", kinds: ["Candidate"], teams: ["Graduate Hiring"], def: "", options: [] }] }),
    F("cf_10044", "Cost centre", "Unit", ["Vacancy"], { screens: ["scr-vac-create"], records: 12 }),
    F("cf_10045", "Alternate email", "Email", ["Candidate"], { screens: ["scr-cand-edit"], records: 7 }),
    F("cf_10046", "Hiring rationale", "Long text", ["Vacancy"], { desc: "Why the role is needed now.", screens: ["scr-vac-create", "scr-vac-edit"], records: 13 }),
  ];
  window.FieldsMock = { fields, TYPES, SCREENS, TEAMS };

  const CSS = `<style>
    .fd-types { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
    .fd-type { text-align:start; padding:10px; border:1px solid var(--border); border-radius:10px; background:var(--surface); cursor:pointer; }
    .fd-type:hover { border-color:var(--border-strong); }
    .fd-type.on { border-color:var(--primary); background:var(--primary-soft); }
    .fd-type b { display:block; } .fd-type span { font-size:12px; color:var(--muted); }
    .fd-opt { display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; background:var(--surface); }
    .fd-opt.off .lbl { text-decoration:line-through; color:var(--muted); }
    .fd-opt .lbl { flex:1; }
    .fd-ctx { margin-bottom:14px; } .fd-ctx .btn { white-space:nowrap; }
    .fd-steps { display:flex; gap:6px; margin-bottom:14px; font-size:12px; }
    .fd-steps span { padding:3px 10px; border-radius:999px; background:var(--surface-subtle); color:var(--muted); border:1px solid var(--border); }
    .fd-steps span.on { background:var(--primary-soft); color:var(--primary-text); border-color:transparent; font-weight:700; }
  </style>`;
  const sens = (f, ui) => (f.sensitive ? ui.badge("Sensitive", "warn") : "");

  function listView(ctx) {
    const { ui, data } = ctx;
    const q = ctx.query;
    const term = (q.get("q") || "").toLowerCase(), kind = q.get("kind") || "All record kinds", type = q.get("type") || "All types", show = q.get("show") || "all";
    const rows = fields.filter((f) => (!term || (f.name + " " + f.id).toLowerCase().includes(term)) && (kind === "All record kinds" || f.kinds.includes(kind)) && (type === "All types" || f.type === type)
      && (show === "all" || (show === "custom" && !f.system) || (show === "system" && f.system) || (show === "unused" && !f.screens.length) || (show === "sensitive" && f.sensitive)));
    const unused = fields.filter((f) => !f.screens.length);
    return `${unused.length ? `<div class="callout warn" style="margin-bottom:12px">${unused.length} field${unused.length === 1 ? " is" : "s are"} not used on any screen: ${unused.map((f) => `<a href="#/fields/${f.id}">${ui.esc(f.name)}</a>`).join(", ")}. Add it to a screen or delete it.</div>` : ""}
      <div class="toolbar"><input class="input" type="search" id="fl-q" placeholder="Search by name or ID" value="${ui.esc(q.get("q") || "")}" aria-label="Search fields">
      ${ui.select(["All record kinds"].concat(data.recordKinds), kind, 'id="fl-kind" aria-label="Record kind"')}
      ${ui.select(["All types"].concat(TYPES), type, 'id="fl-type" aria-label="Type"')}
      <div class="row">${[["all", "All"], ["custom", "Custom"], ["system", "System"], ["unused", "Not on a screen"], ["sensitive", "Sensitive"]].map(([k, l]) => `<button class="btn sm ${show === k ? "primary" : ""}" data-show="${k}">${l}</button>`).join("")}</div>
      <span class="small muted" style="margin-inline-start:auto">${rows.length} of ${fields.length} fields</span></div>
      ${ui.table(["Field", "Type", "Record kinds", "Contexts", "Used on", "Records with value", ""], rows.map((f) => [
        `<a href="#/fields/${f.id}"><b>${ui.esc(f.name)}</b></a> ${sens(f, ui)}<div class="small muted"><code>${f.id}</code> · ${f.system ? "System field" : "Custom field"}</div>`,
        ui.esc(f.type), `<span class="small">${f.kinds.map(ui.esc).join(", ")}</span>`,
        `${f.contexts.length}${f.contexts.some((c) => c.teams === "All teams") ? ' <span class="small muted">· all teams</span>' : ' <span class="small muted">· some teams</span>'}`,
        f.screens.length ? `${f.screens.length} screen${f.screens.length === 1 ? "" : "s"}` : ui.badge("No screen", "warn"),
        f.records.toLocaleString("en-GB"),
        ui.btn("Open", { kind: "sm", attrs: `data-open="${f.id}"` }),
      ]), { empty: "No fields match. Clear the filters or create a field." })}`;
  }

  function detailView(ctx, f) {
    const { ui, data } = ctx;
    const tab = ctx.query.get("tab") || "general";
    const tabs = ui.tabs("field", [{ id: "general", label: "General" }, { id: "contexts", label: `Contexts & options (${f.contexts.length})` }, { id: "screens", label: `Used on screens (${f.screens.length})` }, { id: "delete", label: "Where used & delete" }], tab);
    let body = "";
    if (tab === "general") {
      body = `<div class="split"><div class="card">
        ${ui.field("Name", ui.input(f.name, `id="fd-name" ${f.system ? "disabled" : ""}`), f.system ? "System fields keep their name. You can change the help text." : "Names need not be unique, so admin pickers always show the ID too.")}
        ${ui.field("Description (help text on forms)", `<textarea class="input" rows="2" id="fd-desc">${ui.esc(f.desc)}</textarea>`)}
        ${ui.field("Type", ui.select(TYPES, f.type, "disabled"), "The type cannot change after creation. Use <a href='#' data-migrate>Move values to a new field</a> instead.")}
        <label class="check"><input type="checkbox" id="fd-sens" ${f.sensitive ? "checked" : ""}> Sensitive</label>
        <div class="hint small muted" style="margin:4px 0 12px">Sensitive values are masked in the audit log and left out of AI results and exports unless a role allows them.</div>
        ${ui.btn("Save", { kind: "primary", attrs: "data-save" })}</div>
        <div class="card"><h2>Details</h2><dl class="small"><dt class="muted">Field ID</dt><dd><code>${f.id}</code></dd><dt class="muted">Kind</dt><dd>${f.system ? "System field (built in, cannot be deleted)" : "Custom field"}</dd>
        <dt class="muted">Record kinds</dt><dd>${f.kinds.map(ui.esc).join(", ")}</dd><dt class="muted">Records with a value</dt><dd>${f.records}</dd><dt class="muted">Last changed</dt><dd>${f.updated}</dd></dl>
        <p class="small"><a href="#/roles/r-int?tab=fields">Which roles hide this field?</a></p></div></div>`;
    } else if (tab === "contexts") {
      const choice = CHOICE.has(f.type);
      body = `<p class="muted">A context decides <b>where</b> the field applies (record kinds and teams) and, for choice fields, its default and options. A team-specific context overrides the default one. Contexts may not overlap.</p>
        ${f.contexts.map((c, ci) => `<div class="card fd-ctx"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${ui.esc(c.name)}</h2>
          <div class="row">${c.teams === "All teams" ? ui.badge("All teams", "info") : c.teams.map((t) => ui.badge(t, "")).join(" ")}${ci > 0 ? ui.btn("Remove context", { kind: "sm danger", attrs: `data-rmctx="${ci}"` }) : ""}</div></div>
          <div class="grid g2" style="margin-top:12px"><div>
            ${ui.field("Record kinds", `<div class="row">${data.recordKinds.map((k) => ui.check(k, c.kinds.includes(k), `data-ctxkind="${ci}|${k}" ${f.system ? "disabled" : ""}`)).join("")}</div>`)}
            ${ui.field("Teams", `<div class="row">${ui.check("All teams", c.teams === "All teams", `data-ctxall="${ci}"`)}${TEAMS.map((t) => ui.check(t, c.teams === "All teams" || c.teams.includes(t), `data-ctxteam="${ci}|${t}" ${c.teams === "All teams" ? "disabled" : ""}`)).join("")}</div>`)}
            ${ui.field("Default value", choice ? ui.select(["No default"].concat(c.options.filter((o) => !o.disabled).map((o) => o.label)), c.def || "No default", `data-ctxdef="${ci}"`) : ui.input(c.def, `data-ctxdef="${ci}" placeholder="No default"`))}
          </div><div>${choice ? `<label style="font-weight:700;font-size:13px">Options</label><p class="small muted" style="margin:2px 0 8px">Disabled options are hidden from new choices and kept on existing records.</p>
            ${c.options.map((o, oi) => `<div class="fd-opt ${o.disabled ? "off" : ""}"><span class="lbl">${ui.esc(o.label)}</span><span class="small muted">${o.used} records</span>
              ${o.disabled ? ui.badge("Disabled", "") : ""}
              ${ui.btn("↑", { kind: "sm", attrs: `data-up="${ci}|${oi}" aria-label="Move ${ui.esc(o.label)} up" ${oi === 0 ? "disabled" : ""}` })}${ui.btn("↓", { kind: "sm", attrs: `data-down="${ci}|${oi}" aria-label="Move ${ui.esc(o.label)} down" ${oi === c.options.length - 1 ? "disabled" : ""}` })}
              ${ui.btn(o.disabled ? "Enable" : "Disable", { kind: "sm", attrs: `data-toggle="${ci}|${oi}"` })}</div>`).join("")}
            <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input class="input" placeholder="New option" data-newopt="${ci}" aria-label="New option">${ui.btn("Add", { kind: "sm", attrs: `data-addopt="${ci}"` })}${ui.btn("Sort A–Z", { kind: "sm", attrs: `data-sort="${ci}"` })}</div>`
            : `<div class="callout">This field type has no options. Only the scope and default value apply.</div>`}</div></div></div>`).join("")}
        <div class="row">${ui.btn("Add context", { attrs: "data-addctx" })}${ui.btn("Save contexts", { kind: "primary", attrs: "data-save" })}</div>`;
    } else if (tab === "screens") {
      body = f.screens.length ? `${ui.table(["Screen", "Record kind", ""], f.screens.map((s) => [`<a href="#/screens/${s}"><b>${ui.esc(SCREENS[s])}</b></a>`, ui.esc(SCREENS[s].split(" ")[0]), ui.btn("Open in designer", { kind: "sm", attrs: `onclick="Admin.navigate('screens/${s}')"` })]))}
          <p class="small muted">A field shows on a form only when it is on the screen <b>and</b> a context covers that team and record kind <b>and</b> the person's role does not hide it.</p>`
        : `<div class="card state">${ui.icon("screen")}<h2>Not on any screen</h2><p class="muted">Nobody can see or fill in this field yet.</p><a class="btn primary" href="#/screens/scr-cand-edit">Add it to Candidate edit</a></div>`;
    } else {
      const wf = f.id === "sys_stage" ? 3 : f.type === "Single select" ? 1 : 0, views = f.records > 40 ? 2 : 0;
      body = `<div class="split"><div class="card"><h2>Where used</h2><ul class="list-plain">
          <li class="row" style="justify-content:space-between"><span>Contexts</span><b>${f.contexts.length}</b></li>
          <li class="row" style="justify-content:space-between"><span>Screens</span><b>${f.screens.length}</b></li>
          <li class="row" style="justify-content:space-between"><span>Workflow rules and conditions</span><b>${wf}</b></li>
          <li class="row" style="justify-content:space-between"><span>Shared saved views and filters</span><b>${views}</b></li>
          <li class="row" style="justify-content:space-between"><span>Role field rules</span><b>${f.sensitive ? 2 : 0}</b></li>
          <li class="row" style="justify-content:space-between"><span>Records with a value</span><b>${f.records}</b></li></ul></div>
        <div class="card"><h2>Delete field</h2>${f.system
          ? `<p class="muted">System fields are built in and cannot be deleted. You can remove it from screens or hide it with a role field rule.</p>${ui.btn("Delete field", { kind: "danger", attrs: 'disabled title="System fields cannot be deleted"' })}`
          : `<p class="muted">Deleting moves the field to the bin for 30 days. After that its values are removed for good.</p>${ui.btn("Delete field…", { kind: "danger", attrs: "data-delete" })}`}</div></div>`;
    }
    return ui.pageHeader(f.name, `<code>${f.id}</code> · ${ui.esc(f.type)} · ${f.system ? "System field" : "Custom field"} ${sens(f, ui)}`, "", `<a href="#/fields">Custom fields</a> / ${ui.esc(f.name)}`) + tabs + body;
  }

  // ---- create wizard ----
  function wizard(w) {
    const { ui } = Admin;
    w = w || { step: 1, type: "", name: "", desc: "", sensitive: false, kinds: ["Candidate"], teams: "All teams", options: "" };
    const steps = `<div class="fd-steps">${["1 Type", "2 Name", "3 Context"].map((s, i) => `<span class="${i + 1 === w.step ? "on" : ""}">${s}</span>`).join("")}</div>`;
    let body = "";
    if (w.step === 1) body = `<div class="fd-types">${TYPES.map((t) => `<button class="fd-type ${w.type === t ? "on" : ""}" data-type="${t}"><b>${t}</b><span>${TYPE_HINT[t]}</span></button>`).join("")}</div>`;
    else if (w.step === 2) body = `${ui.field("Name", ui.input(w.name, 'id="wz-name" placeholder="For example: Driving licence"'))}${ui.field("Description", `<textarea class="input" rows="2" id="wz-desc" placeholder="Help text shown under the field">${ui.esc(w.desc)}</textarea>`)}
      ${ui.check("Sensitive (masked in audit log, left out of AI results)", w.sensitive, 'id="wz-sens"')}<div id="wz-dup" class="small" style="color:var(--warning);margin-top:6px"></div>`;
    else body = `${ui.field("Record kinds", `<div class="row">${(window.MockData.recordKinds).map((k) => ui.check(k, w.kinds.includes(k), `data-wzkind="${k}"`)).join("")}</div>`)}
      ${ui.field("Teams", ui.select(["All teams"].concat(TEAMS), w.teams, 'id="wz-teams"'))}
      ${CHOICE.has(w.type) ? ui.field("Options (one per line)", `<textarea class="input" rows="4" id="wz-opts">${ui.esc(w.options)}</textarea>`) : ""}
      <div class="callout small">You can add it to screens straight after.</div>`;
    Admin.modal(`<h2>Create field${w.type ? `: ${ui.esc(w.type)}` : ""}</h2>${steps}${body}<div id="wz-err" class="small" style="color:var(--danger);min-height:18px;margin-top:6px"></div>
      <div class="row" style="justify-content:space-between">${w.step > 1 ? ui.btn("Back", { attrs: 'id="wz-back"' }) : ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn(w.step === 3 ? "Create field" : "Next", { kind: "primary", attrs: 'id="wz-next"' })}</div>`);
    const m = document.querySelector(".modal");
    const keep = () => {
      if (w.step === 2) { w.name = m.querySelector("#wz-name").value.trim(); w.desc = m.querySelector("#wz-desc").value; w.sensitive = m.querySelector("#wz-sens").checked; }
      if (w.step === 3) { w.kinds = [...m.querySelectorAll("[data-wzkind]:checked")].map((c) => c.dataset.wzkind); w.teams = m.querySelector("#wz-teams").value; const o = m.querySelector("#wz-opts"); if (o) w.options = o.value; }
    };
    m.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => { w.type = b.dataset.type; w.step = 2; wizard(w); }));
    const nm = m.querySelector("#wz-name");
    if (nm) { nm.focus(); nm.addEventListener("input", () => { const d = fields.find((f) => f.name.toLowerCase() === nm.value.trim().toLowerCase()); m.querySelector("#wz-dup").textContent = d ? `A field called “${d.name}” already exists (${d.id}). You can still continue.` : ""; }); }
    const back = m.querySelector("#wz-back"); if (back) back.addEventListener("click", () => { keep(); w.step--; wizard(w); });
    m.querySelector("#wz-next").addEventListener("click", () => {
      keep();
      const err = (t) => (m.querySelector("#wz-err").textContent = t);
      if (w.step === 1 && !w.type) return err("Choose a type.");
      if (w.step === 2 && !w.name) return err("Give the field a name.");
      if (w.step === 3) {
        if (!w.kinds.length) return err("Choose at least one record kind.");
        const id = "cf_" + (10047 + fields.filter((f) => !f.system).length);
        fields.push(F(id, w.name, w.type, w.kinds, { desc: w.desc, sensitive: w.sensitive, updated: "Just now",
          contexts: [{ name: "Default context", kinds: w.kinds, teams: w.teams === "All teams" ? "All teams" : [w.teams], def: "", options: opts(...w.options.split(/\n/).map((s) => s.trim()).filter(Boolean)) }] }));
        Admin.close(); Admin.toast(`Field “${w.name}” created (mockup). Add it to a screen next.`); Admin.navigate(`fields/${id}?tab=screens`); return;
      }
      w.step++; wizard(w);
    });
  }

  Admin.register({
    id: "fields", group: "Configuration", title: "Custom fields", icon: "field",
    spec: ["FLD-010", "FLD-011", "FLD-013", "FLD-015", "FLD-016", "FLD-020", "FLD-021", "FLD-022"],
    changes: "New central registry: every system and custom field across record kinds, with contexts per team, options, screen usage and a delete impact check.",
    render(ctx) {
      const { ui } = ctx;
      const id = ctx.params[0];
      if (id) {
        const f = fields.find((x) => x.id === id);
        if (ctx.state !== "normal") return ui.pageHeader("Field", "", "", `<a href="#/fields">Custom fields</a>`) + ui.stateBlock(ctx.state, { emptyTitle: "No contexts yet", emptyText: "Add a context so the field applies somewhere." });
        if (!f) return ui.pageHeader("Field not found", "", "", `<a href="#/fields">Custom fields</a>`) + `<div class="card state">${ui.icon("alert")}<p>No field with ID <code>${ui.esc(id)}</code>. It may be in the bin.</p><a href="#/fields">Back to fields</a></div>`;
        return CSS + `<div id="fd-page">${detailView(ctx, f)}</div>`;
      }
      const head = ui.pageHeader("Custom fields", "Every field on every record kind, defined once for the company. Teams get the fields whose context includes them.",
        ui.btn("Screens & forms", { ic: "screen", attrs: `onclick="Admin.navigate('screens')"` }) + ui.btn("Create field", { kind: "primary", ic: "field", attrs: "data-create" }));
      if (ctx.state !== "normal") return `<div id="fd-page">${head}${ui.stateBlock(ctx.state, { emptyTitle: "No custom fields yet", emptyText: "System fields are always there. Create a custom field to capture something extra, such as visa status.", emptyAction: ui.btn("Create field", { kind: "primary", attrs: "data-create" }) })}</div>`;
      return CSS + `<div id="fd-page">${head}${listView(ctx)}</div>`;
    },
    mount(root, ctx) {
      const page = root.querySelector("#fd-page"); if (!page) return;
      const f = fields.find((x) => x.id === ctx.params[0]);
      const setQ = (k, v) => { const q = new URLSearchParams(ctx.query); v ? q.set(k, v) : q.delete(k); Admin.navigate("fields?" + q); };
      const fq = page.querySelector("#fl-q");
      if (fq) {
        let tmr; fq.addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(() => setQ("q", fq.value), 350); });
        if (ctx.query.get("q")) { fq.focus(); fq.setSelectionRange(fq.value.length, fq.value.length); }
      }
      page.addEventListener("change", (e) => {
        const t = e.target, d = t.dataset;
        if (t.id === "fl-kind") setQ("kind", t.value === "All record kinds" ? "" : t.value);
        if (t.id === "fl-type") setQ("type", t.value === "All types" ? "" : t.value);
        if (!f) return;
        if (d.ctxkind) { const [ci, k] = d.ctxkind.split("|"); const c = f.contexts[ci]; c.kinds = t.checked ? [...c.kinds, k] : c.kinds.filter((x) => x !== k); }
        if (d.ctxall) { const c = f.contexts[d.ctxall]; c.teams = t.checked ? "All teams" : TEAMS.slice(); Admin.rerender(); }
        if (d.ctxteam) { const [ci, tm] = d.ctxteam.split("|"); const c = f.contexts[ci]; c.teams = t.checked ? [...c.teams, tm] : c.teams.filter((x) => x !== tm); }
        if (d.ctxdef) f.contexts[d.ctxdef].def = t.value === "No default" ? "" : t.value;
        if (t.id === "fd-sens") f.sensitive = t.checked;
      });
      page.addEventListener("click", (e) => {
        const t = e.target.closest("button,a"); if (!t) return;
        const d = t.dataset;
        if (d.create !== undefined) wizard();
        else if (d.open) Admin.navigate("fields/" + d.open);
        else if (d.show) setQ("show", d.show === "all" ? "" : d.show);
        else if (!f) return;
        else if (d.migrate !== undefined) { e.preventDefault(); Admin.toast("Move values to a new field: opens a guided copy (mockup)"); }
        else if (d.save !== undefined) {
          const n = page.querySelector("#fd-name"), ds = page.querySelector("#fd-desc");
          if (n && !f.system && n.value.trim()) f.name = n.value.trim();
          if (ds) f.desc = ds.value;
          Admin.toast("Saved (mockup)"); Admin.rerender();
        } else if (d.up || d.down) {
          const [ci, oi] = (d.up || d.down).split("|").map(Number), o = f.contexts[ci].options, j = d.up ? oi - 1 : oi + 1;
          [o[oi], o[j]] = [o[j], o[oi]]; Admin.rerender();
        } else if (d.toggle) { const [ci, oi] = d.toggle.split("|").map(Number); const o = f.contexts[ci].options[oi]; o.disabled = !o.disabled; Admin.toast(o.disabled ? `“${o.label}” disabled. ${o.used} records keep it.` : `“${o.label}” enabled`); Admin.rerender(); }
        else if (d.addopt) {
          const inp = page.querySelector(`[data-newopt="${d.addopt}"]`), v = inp.value.trim(), o = f.contexts[d.addopt].options;
          if (!v) return inp.focus();
          if (o.some((x) => x.label.toLowerCase() === v.toLowerCase())) return Admin.toast("That option already exists in this context");
          o.push({ label: v, disabled: false, used: 0 }); Admin.rerender();
        } else if (d.sort) { f.contexts[d.sort].options.sort((a, b) => a.label.localeCompare(b.label, "en-GB")); Admin.rerender(); }
        else if (d.rmctx) { f.contexts.splice(+d.rmctx, 1); Admin.toast("Context removed (mockup)"); Admin.rerender(); }
        else if (d.addctx !== undefined) {
          const free = TEAMS.filter((tm) => !f.contexts.some((c) => c.teams !== "All teams" && c.teams.includes(tm)));
          if (!free.length) return Admin.toast("Every team already has its own context");
          f.contexts.push({ name: free[0], kinds: f.kinds.slice(), teams: [free[0]], def: "", options: CHOICE.has(f.type) ? f.contexts[0].options.map((o) => ({ ...o, used: 0 })) : [] });
          Admin.toast(`Context for ${free[0]} added. It overrides the default context for that team.`); Admin.rerender();
        } else if (d.delete !== undefined) {
          const { ui } = Admin;
          Admin.modal(`<h2>Delete “${ui.esc(f.name)}”?</h2><div class="callout warn"><ul style="margin:0;padding-inline-start:18px">
            <li>Used by <b>${f.contexts.length} context${f.contexts.length === 1 ? "" : "s"}</b> and <b>${f.screens.length} screen${f.screens.length === 1 ? "" : "s"}</b>${f.screens.length ? ` (${f.screens.map((s) => ui.esc(SCREENS[s])).join(", ")})` : ""}</li>
            <li><b>${f.records}</b> records have a value</li><li>Goes to the bin for 30 days, then values are removed for good</li></ul></div>
            ${ui.field(`Type the field name to confirm`, ui.input("", 'id="del-name" autocomplete="off"'))}
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Delete field", { kind: "danger", attrs: 'id="del-go" disabled' })}</div>`);
          const inp = document.getElementById("del-name"), go = document.getElementById("del-go");
          inp.addEventListener("input", () => (go.disabled = inp.value.trim() !== f.name));
          go.addEventListener("click", () => { fields.splice(fields.indexOf(f), 1); Admin.close(); Admin.toast(`“${f.name}” moved to the bin (mockup)`); Admin.navigate("fields"); });
        }
      });
    },
  });
})();
