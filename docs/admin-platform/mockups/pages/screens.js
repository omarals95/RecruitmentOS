/* Screens & forms: screen list, screen schemes (record kind × operation → screen), screen designer with drag and drop + live preview.
   Routes: #/screens?tab=screens|schemes , #/screens/<id>. Field registry comes from window.FieldsMock (pages/fields.js). */
(function () {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fm = () => window.FieldsMock || { fields: [], SCREENS: {}, TEAMS: ["Talent Acquisition", "Executive Search", "Graduate Hiring"] };
  const sec = (name, ...f) => ({ name, fields: f.map((x) => (typeof x === "string" ? { id: x, mode: "Optional" } : { id: x[0], mode: x[1] })) });
  const R = (id) => [id, "Required"], RO = (id) => [id, "Read only"];
  const screens = [
    { id: "scr-cand-create", name: "Candidate create", kind: "Candidate", op: "Create", version: 4, tabs: [
      { name: "Details", sections: [sec("Basics", R("sys_full_name"), R("sys_email"), "sys_phone"), sec("Work and eligibility", "cf_10031", "cf_10034", "cf_10036")] },
      { name: "Documents", sections: [sec("Links")] }] },
    { id: "scr-cand-edit", name: "Candidate edit", kind: "Candidate", op: "Edit", version: 6, tabs: [
      { name: "Details", sections: [sec("Basics", R("sys_full_name"), R("sys_email"), "sys_phone", "cf_10045"), sec("Work and eligibility", "cf_10031", "cf_10034", "cf_10033", "cf_10035", "cf_10036")] }] },
    { id: "scr-cand-view", name: "Candidate view", kind: "Candidate", op: "View", version: 3, tabs: [
      { name: "Summary", sections: [sec("Basics", RO("sys_full_name"), RO("sys_email"), RO("sys_phone")), sec("Background", RO("cf_10033"), RO("cf_10035"), RO("cf_10036"))] }] },
    { id: "scr-grad-create", name: "Graduate candidate create", kind: "Candidate", op: "Create", version: 2, tabs: [
      { name: "Details", sections: [sec("Basics", R("sys_full_name"), R("sys_email")), sec("Education", R("cf_10043"))] }] },
    { id: "scr-vac-create", name: "Vacancy create", kind: "Vacancy", op: "Create", version: 5, tabs: [
      { name: "Role", sections: [sec("About the role", R("sys_vac_title"), R("sys_unit"), R("sys_hm"), "cf_10046")] },
      { name: "Budget", sections: [sec("Approval", R("cf_10037"), "cf_10044", "cf_10038")] }] },
    { id: "scr-vac-edit", name: "Vacancy edit", kind: "Vacancy", op: "Edit", version: 3, tabs: [
      { name: "Role", sections: [sec("About the role", R("sys_vac_title"), R("sys_unit"), R("sys_hm"), "cf_10046", "cf_10038")] }] },
    { id: "scr-app-view", name: "Application view", kind: "Application", op: "View", version: 2, tabs: [
      { name: "Application", sections: [sec("Progress", RO("sys_stage"), "cf_10040")] }] },
    { id: "scr-int-edit", name: "Interview feedback", kind: "Interview", op: "Edit", version: 2, tabs: [
      { name: "Interview", sections: [sec("When and who", R("sys_int_date"), "cf_10039")] }] },
    { id: "scr-off-create", name: "Offer create", kind: "Offer", op: "Create", version: 3, tabs: [
      { name: "Offer", sections: [sec("Terms", R("sys_offer_amount"), R("sys_start"), "cf_10041")] }] },
    { id: "scr-onb-edit", name: "Onboarding checklist", kind: "Onboarding", op: "Edit", version: 1, tabs: [
      { name: "Before day one", sections: [sec("Personal", "cf_10034", R("cf_10042"), RO("sys_start"))] }] },
  ];
  screens.forEach((s) => { s.published = clone(s.tabs); s.draft = false; s.updated = "4 Nov 2026 · Omar Alshair"; });

  const KINDS = [["Candidate", "Standard"], ["Candidate", "Graduate"], ["Vacancy", "Standard"], ["Application", "Standard"], ["Interview", "Standard"], ["Offer", "Standard"], ["Onboarding", "Standard"]];
  const schemes = [
    { id: "default", name: "Default screen scheme", teams: ["Talent Acquisition", "Graduate Hiring"], map: {
      "Candidate|Standard": ["scr-cand-create", "scr-cand-edit", "scr-cand-view"], "Candidate|Graduate": ["scr-grad-create", "scr-cand-edit", "scr-cand-view"],
      "Vacancy|Standard": ["scr-vac-create", "scr-vac-edit", ""], "Application|Standard": ["", "", "scr-app-view"], "Interview|Standard": ["", "scr-int-edit", ""],
      "Offer|Standard": ["scr-off-create", "", ""], "Onboarding|Standard": ["", "scr-onb-edit", ""] } },
    { id: "es", name: "Executive Search screens", teams: ["Executive Search"], map: {
      "Candidate|Standard": ["scr-cand-create", "scr-cand-edit", "scr-cand-view"], "Candidate|Graduate": ["", "", ""],
      "Vacancy|Standard": ["scr-vac-create", "scr-vac-edit", ""], "Application|Standard": ["", "", "scr-app-view"], "Interview|Standard": ["", "scr-int-edit", ""],
      "Offer|Standard": ["scr-off-create", "", ""], "Onboarding|Standard": ["", "scr-onb-edit", ""] } },
  ];
  const usedBy = (id) => {
    const out = [];
    schemes.forEach((s) => Object.entries(s.map).forEach(([k, v]) => v.forEach((x, i) => { if (x === id) out.push({ scheme: s, kind: k.replace("|", " · "), op: ["Create", "Edit", "View"][i] }); })));
    return out;
  };
  const teamsUsing = (id) => [...new Set(usedBy(id).flatMap((u) => u.scheme.teams))];
  const UI = { active: {}, team: "Talent Acquisition", q: "", all: false, drag: null };

  const CSS = `<style>
    .sd { display:grid; grid-template-columns:240px minmax(0,1fr) 330px; gap:14px; align-items:start; }
    @media (max-width:1200px) { .sd { grid-template-columns:220px minmax(0,1fr); } .sd-prev { grid-column:1 / -1; } }
    .sd-pal-list { max-height:560px; overflow:auto; margin-top:8px; }
    .sd-pi { display:flex; align-items:center; gap:6px; padding:6px 8px; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; background:var(--surface); cursor:grab; font-size:13px; }
    .sd-pi.on { opacity:.5; cursor:default; }
    .sd-pi .nm { flex:1; min-width:0; } .sd-pi .nm small { display:block; color:var(--muted); font-size:11px; }
    .sd-tabs { display:flex; gap:4px; flex-wrap:wrap; border-bottom:1px solid var(--border); margin-bottom:10px; }
    .sd-tab { padding:6px 10px; border:1px solid transparent; border-bottom:0; border-radius:8px 8px 0 0; background:none; cursor:pointer; color:var(--muted); }
    .sd-tab.on { border-color:var(--border); background:var(--surface-subtle); color:var(--primary-text); font-weight:700; }
    .sd-tab.over { outline:2px dashed var(--primary); }
    .sd-sec { border:1px solid var(--border); border-radius:10px; padding:10px; margin-bottom:10px; background:var(--surface-subtle); }
    .sd-sec-h { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
    .sd-sec-h input { font-weight:700; background:transparent; border:1px solid transparent; border-radius:6px; padding:3px 6px; flex:1; }
    .sd-sec-h input:hover, .sd-sec-h input:focus { border-color:var(--border-strong); background:var(--surface); }
    .sd-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid var(--border); border-radius:8px; background:var(--surface); margin-bottom:6px; cursor:grab; }
    .sd-row.dragging, .sd-pi.dragging { opacity:.4; }
    .sd-row.over { box-shadow:0 -3px 0 var(--primary); }
    .sd-row .grip { color:var(--muted); letter-spacing:-2px; user-select:none; }
    .sd-row .nm { flex:1; min-width:0; } .sd-row .nm small { display:block; color:var(--muted); font-size:11px; }
    .sd-zone { border:2px dashed var(--border-strong); border-radius:8px; padding:8px; text-align:center; font-size:12px; color:var(--muted); }
    .sd-zone.over { border-color:var(--primary); background:var(--primary-soft); color:var(--primary-text); }
    .sd-seg { display:inline-flex; border:1px solid var(--border-strong); border-radius:8px; overflow:hidden; flex:none; }
    .sd-seg label { padding:2px 7px; font-size:11px; cursor:pointer; border-inline-start:1px solid var(--border); white-space:nowrap; }
    .sd-seg label:first-child { border-inline-start:0; }
    .sd-seg input { position:absolute; opacity:0; pointer-events:none; }
    .sd-seg label:has(input:checked) { background:var(--primary-soft); color:var(--primary-text); font-weight:700; }
    .sd-seg label:has(input:focus-visible) { outline:2px solid var(--focus); }
    .sd-ib { border:0; background:none; cursor:pointer; color:var(--muted); padding:2px 4px; border-radius:4px; }
    .sd-ib:hover { background:var(--surface-subtle); color:var(--text); }
    .sd-prev .pf { margin-bottom:10px; } .sd-prev .pf label { display:block; font-size:12px; font-weight:700; margin-bottom:3px; }
    .sd-prev .pf .req { color:var(--danger); } .sd-prev h4 { margin:12px 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
    .sd-frame { border:1px solid var(--border); border-radius:10px; padding:12px; background:var(--bg); }
  </style>`;

  const fieldOf = (id) => fm().fields.find((f) => f.id === id) || { id, name: id, type: "Text", kinds: [], contexts: [], missing: true };
  const onScreen = (s) => new Set(s.tabs.flatMap((t) => t.sections.flatMap((x) => x.fields.map((f) => f.id))));
  const hasContext = (f, team, kind) => f.system || f.contexts.some((c) => c.kinds.includes(kind) && (c.teams === "All teams" || c.teams.includes(team)));
  const ctxFor = (f, team) => f.contexts.find((c) => c.teams !== "All teams" && c.teams.includes(team)) || f.contexts.find((c) => c.teams === "All teams");

  function diff(s) {
    const flat = (tabs) => { const m = {}; tabs.forEach((t) => t.sections.forEach((x) => x.fields.forEach((f) => (m[f.id] = { mode: f.mode, where: `${t.name} › ${x.name}` })))); return m; };
    const a = flat(s.published), b = flat(s.tabs), out = [];
    Object.keys(b).forEach((k) => { const n = fieldOf(k).name; if (!a[k]) out.push(`+ ${n} (${b[k].mode}) on ${b[k].where}`); else { if (a[k].mode !== b[k].mode) out.push(`${n}: ${a[k].mode} → ${b[k].mode}`); if (a[k].where !== b[k].where) out.push(`${n} moved to ${b[k].where}`); } });
    Object.keys(a).forEach((k) => { if (!b[k]) out.push(`− ${fieldOf(k).name}`); });
    const tn = (tabs) => tabs.map((t) => t.name + ":" + t.sections.map((x) => x.name).join(",")).join("|");
    if (tn(s.published) !== tn(s.tabs) && !out.length) out.push("Tabs or sections renamed or reordered");
    return out;
  }
  function problems(s) {
    const on = onScreen(s), out = [];
    if (s.op === "Create") fm().fields.filter((f) => f.system && f.kinds.includes(s.kind) && ["sys_full_name", "sys_email", "sys_vac_title", "sys_unit", "sys_offer_amount"].includes(f.id) && !on.has(f.id))
      .forEach((f) => out.push(`${f.name} is always required for ${s.kind.toLowerCase()} records but is not on this create screen. People could not save.`));
    if (s.op === "View") s.tabs.forEach((t) => t.sections.forEach((x) => x.fields.forEach((f) => { if (f.mode === "Required") out.push(`${fieldOf(f.id).name} is Required on a view screen. Nothing is entered here, so use Read only.`); })));
    return out;
  }

  // ---------- list ----------
  function listView(ctx) {
    const { ui } = ctx;
    const tab = ctx.query.get("tab") || "screens";
    const tabs = ui.tabs("scr", [{ id: "screens", label: `Screens (${screens.length})` }, { id: "schemes", label: "Screen schemes" }], tab);
    if (tab === "schemes") {
      const sid = ctx.query.get("scheme") || "default", sc = schemes.find((x) => x.id === sid) || schemes[0];
      const opt = (sel) => [`<option value="" ${!sel ? "selected" : ""}>Default (same as Edit)</option>`].concat(screens.map((s) => `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>${ui.esc(s.name)}</option>`)).join("");
      return tabs + `<div class="toolbar"><label for="sch-sel"><b>Scheme</b></label><select class="input" id="sch-sel">${schemes.map((x) => `<option value="${x.id}" ${x.id === sc.id ? "selected" : ""}>${ui.esc(x.name)}</option>`).join("")}</select>
        <span class="muted small">Used by ${sc.teams.map((t) => ui.badge(t, "info")).join(" ")}</span></div>
        <p class="muted small" style="margin-top:0">For each record kind and type, choose the screen people see when they create, edit or view a record. Empty operations fall back to the Edit screen.</p>
        <div class="table-wrap"><table class="t"><thead><tr><th>Record kind · type</th><th>Create</th><th>Edit</th><th>View</th></tr></thead><tbody>
        ${KINDS.map(([k, ty]) => { const key = k + "|" + ty, v = sc.map[key]; return `<tr><td><b>${k}</b> <span class="muted">· ${ty}</span></td>${[0, 1, 2].map((i) => `<td><select class="input" data-map="${key}|${i}" aria-label="${k} ${ty} ${["Create", "Edit", "View"][i]}">${opt(v[i])}</select></td>`).join("")}</tr>`; }).join("")}
        </tbody></table></div>
        <div class="row" style="margin-top:12px">${ui.btn("Save scheme", { kind: "primary", attrs: `data-savescheme="${sc.id}"` })}${ui.btn("Copy scheme", { attrs: "data-copyscheme" })}</div>`;
    }
    return tabs + ui.table(["Screen", "Record kind", "Operation", "Tabs · fields", "Used by", "Status", ""], screens.map((s) => {
      const u = usedBy(s.id), teams = teamsUsing(s.id);
      return [`<a href="#/screens/${s.id}"><b>${ui.esc(s.name)}</b></a><div class="small muted"><code>${s.id}</code> · ${ui.esc(s.updated)}</div>`, ui.esc(s.kind), ui.esc(s.op),
        `${s.tabs.length} · ${onScreen(s).size}`,
        u.length ? `<span class="small">${u.length} mapping${u.length === 1 ? "" : "s"} · ${teams.length} team${teams.length === 1 ? "" : "s"}</span>` : ui.badge("Not used", "warn"),
        (s.version ? ui.badge(`Published v${s.version}`, "ok") : "") + (s.draft ? " " + ui.badge(s.version ? "Draft" : "Draft, never published", "warn") : ""),
        `<div class="row" style="flex-wrap:nowrap">${ui.btn("Design", { kind: "sm", attrs: `data-design="${s.id}"` })}${ui.btn("Copy", { kind: "sm", attrs: `data-copy="${s.id}"` })}</div>`];
    }));
  }

  // ---------- designer ----------
  function palette(s) {
    const { ui } = Admin;
    const on = onScreen(s), q = UI.q.toLowerCase();
    const list = fm().fields.filter((f) => (UI.all || f.kinds.includes(s.kind)) && (!q || (f.name + " " + f.id + " " + f.type).toLowerCase().includes(q)));
    return list.length ? list.map((f) => `<div class="sd-pi ${on.has(f.id) ? "on" : ""}" ${on.has(f.id) ? "" : `draggable="true" data-drag="pal|${f.id}"`} title="${ui.esc(f.name)} · ${f.id}">
        <span class="nm">${ui.esc(f.name)}<small>${ui.esc(f.type)} · ${f.id}</small></span>
        ${on.has(f.id) ? `<span class="small muted">On screen</span>` : `<button class="sd-ib" data-add="${f.id}" aria-label="Add ${ui.esc(f.name)}" title="Add to the first section of this tab">＋</button>`}</div>`).join("")
      : `<p class="muted small">No field matches. <a href="#/fields">Create a field</a>.</p>`;
  }
  function canvas(s) {
    const { ui } = Admin;
    const ti = Math.min(UI.active[s.id] || 0, s.tabs.length - 1), t = s.tabs[ti];
    return `<div class="sd-tabs" role="tablist">${s.tabs.map((x, i) => `<button class="sd-tab ${i === ti ? "on" : ""}" role="tab" aria-selected="${i === ti}" data-tabi="${i}" data-droptab="${i}">${ui.esc(x.name)} <span class="small muted">${x.sections.reduce((n, y) => n + y.fields.length, 0)}</span></button>`).join("")}
        <button class="sd-tab" data-addtab title="Add tab">＋ Tab</button></div>
      <div class="row" style="margin-bottom:8px"><label class="small muted" for="sd-tabname">Tab name</label><input class="input" id="sd-tabname" value="${ui.esc(t.name)}" style="width:200px">
        ${s.tabs.length > 1 ? ui.btn("Remove tab", { kind: "sm", attrs: "data-rmtab" }) : ""}</div>
      ${t.sections.map((x, si) => `<div class="sd-sec"><div class="sd-sec-h"><input value="${ui.esc(x.name)}" data-secname="${si}" aria-label="Section name">
          ${!x.fields.length ? `<button class="sd-ib" data-rmsec="${si}" aria-label="Remove empty section">Remove</button>` : `<span class="small muted">${x.fields.length} field${x.fields.length === 1 ? "" : "s"}</span>`}</div>
        ${x.fields.map((f, fi) => { const d = fieldOf(f.id); return `<div class="sd-row" draggable="true" data-drag="cv|${si}|${fi}" data-drop="${si}|${fi}">
          <span class="grip" aria-hidden="true">⋮⋮</span><span class="nm">${ui.esc(d.name)}${d.sensitive ? ` ${ui.badge("Sensitive", "warn")}` : ""}<small>${ui.esc(d.type)} · ${d.id}</small></span>
          <span class="sd-seg" role="radiogroup" aria-label="${ui.esc(d.name)} rule">${["Required", "Optional", "Read only"].map((m) => `<label><input type="radio" name="m-${si}-${fi}" data-mode="${si}|${fi}" value="${m}" ${f.mode === m ? "checked" : ""}>${m}</label>`).join("")}</span>
          <button class="sd-ib" data-mv="${si}|${fi}|-1" aria-label="Move ${ui.esc(d.name)} up" ${fi === 0 ? "disabled" : ""}>↑</button><button class="sd-ib" data-mv="${si}|${fi}|1" aria-label="Move ${ui.esc(d.name)} down" ${fi === x.fields.length - 1 ? "disabled" : ""}>↓</button>
          <button class="sd-ib" data-rm="${si}|${fi}" aria-label="Remove ${ui.esc(d.name)}">✕</button></div>`; }).join("")}
        <div class="sd-zone" data-drop="${si}|${x.fields.length}">Drop a field here</div></div>`).join("")}
      ${ui.btn("Add section", { kind: "sm", attrs: "data-addsec" })}`;
  }
  function preview(s) {
    const { ui } = Admin;
    const team = UI.team, ti = Math.min(UI.active[s.id] || 0, s.tabs.length - 1), skipped = [];
    const ctl = (f, m) => {
      const dis = m === "Read only" ? "disabled" : "", c = ctxFor(f, team), o = c ? c.options.filter((x) => !x.disabled) : [];
      const sample = { "Full name": "Fatima Al Zaabi", Email: "fatima.alzaabi@example.test", Phone: "+971 50 123 4567", Title: "Senior Software Engineer", Unit: "Platform Engineering", "Hiring manager": "Khalid Al Mansoori", "Start date": "2027-01-04", "Interview date": "2026-11-12" }[f.name] || "";
      if (f.type === "Long text") return `<textarea class="input" rows="2" ${dis}>${ui.esc(m === "Read only" ? sample || "—" : "")}</textarea>`;
      if (f.type === "Checkbox") return `<label class="check"><input type="checkbox" ${dis}> Yes</label>`;
      if (f.type === "Single select" || f.type === "Multi select") return `<select class="input" ${f.type === "Multi select" ? 'multiple size="3"' : ""} ${dis}>${f.type === "Single select" ? "<option>Choose…</option>" : ""}${o.map((x) => `<option ${c && c.def === x.label ? "selected" : ""}>${ui.esc(x.label)}</option>`).join("")}</select>`;
      if (f.type === "Date") return `<input class="input" type="date" value="${m === "Read only" ? sample : ""}" ${dis}>`;
      if (f.type === "Money (AED)") return `<div class="row" style="flex-wrap:nowrap"><span class="small muted">AED</span><input class="input" inputmode="decimal" placeholder="0.00" ${dis}></div>`;
      if (f.type === "Number") return `<input class="input" type="number" ${dis}>`;
      return `<input class="input" ${f.type === "Email" ? 'type="email" dir="ltr"' : f.type === "URL" ? 'type="url" dir="ltr" placeholder="https://"' : f.type === "Phone" ? 'type="tel" dir="ltr" placeholder="+971"' : ""} value="${m === "Read only" ? ui.esc(sample || "—") : ""}" ${dis}>`;
    };
    const tab = s.tabs[ti];
    const body = tab.sections.map((x) => {
      const items = x.fields.map((r) => { const f = fieldOf(r.id); if (!hasContext(f, team, s.kind)) { skipped.push(f.name); return ""; }
        return `<div class="pf"><label>${ui.esc(f.name)}${r.mode === "Required" ? ' <span class="req">*</span>' : ""}${r.mode === "Read only" ? ' <span class="small muted">(read only)</span>' : ""}</label>${ctl(f, r.mode)}${f.desc ? `<div class="small muted">${ui.esc(f.desc)}</div>` : ""}</div>`; }).join("");
      return items ? `<h4>${ui.esc(x.name)}</h4>${items}` : "";
    }).join("") || `<p class="muted small">This tab has no fields for ${ui.esc(team)} yet.</p>`;
    return `<h2>Live preview</h2><div class="row" style="margin-bottom:8px"><label class="small muted" for="sd-team">As team</label><select class="input" id="sd-team" style="width:auto">${fm().TEAMS.map((t) => `<option ${t === team ? "selected" : ""}>${ui.esc(t)}</option>`).join("")}</select></div>
      <div class="sd-frame"><b>${s.op === "Create" ? "New " + s.kind.toLowerCase() : s.op === "Edit" ? "Edit " + s.kind.toLowerCase() : s.kind}</b>
        <div class="tabs" style="margin:8px 0">${s.tabs.map((x, i) => `<span class="tab ${i === ti ? "active" : ""}">${ui.esc(x.name)}</span>`).join("")}</div>
        <form onsubmit="return false">${body}${s.op !== "View" ? `<div class="row" style="margin-top:8px"><button class="btn primary" type="button">${s.op === "Create" ? "Create" : "Save"}</button><button class="btn" type="button">Cancel</button></div>` : ""}</form></div>
      ${skipped.length ? `<p class="small muted" style="margin-top:8px">Not shown for ${ui.esc(team)}: ${skipped.map(ui.esc).join(", ")} (no field context for this team). <a href="#/fields">Fix in Custom fields</a></p>` : ""}
      <p class="small muted">Fields a person's role hides are also removed when the form is shown.</p>`;
  }
  function designer(s) {
    const { ui } = Admin;
    const p = problems(s), ch = diff(s);
    return `${p.length ? `<div class="callout bad" style="margin-bottom:12px">${p.map(ui.esc).join("<br>")}</div>` : ""}
      ${ch.length ? `<div class="callout warn" style="margin-bottom:12px"><b>Unpublished changes (${ch.length}).</b> People keep seeing version ${s.version} until you publish.</div>` : ""}
      <div class="sd">
        <div class="card"><h2>Fields</h2><input class="input" type="search" id="sd-q" placeholder="Search fields" value="${ui.esc(UI.q)}" aria-label="Search fields">
          <label class="check small" style="margin-top:6px"><input type="checkbox" id="sd-all" ${UI.all ? "checked" : ""}> Show other record kinds</label>
          <div class="sd-pal-list" id="sd-pal">${palette(s)}</div><p class="small muted">Drag a field onto the form, or use ＋.</p></div>
        <div class="card" id="sd-canvas">${canvas(s)}</div>
        <div class="card sd-prev" id="sd-prev">${preview(s)}</div>
      </div>`;
  }

  function publishModal(s, done) {
    const { ui } = Admin;
    const ch = diff(s), u = usedBy(s.id), teams = teamsUsing(s.id), p = problems(s);
    const req = ch.filter((c) => /→ Required|\(Required\)/.test(c)).length;
    Admin.modal(`<h2>Publish “${ui.esc(s.name)}” as version ${s.version + 1}?</h2>
      <ul><li>Used by <b>${u.length} mapping${u.length === 1 ? "" : "s"}</b> in ${[...new Set(u.map((x) => x.scheme.name))].map(ui.esc).join(", ") || "no scheme"}</li>
      <li>Changes the ${s.op.toLowerCase()} form for <b>${teams.length} team${teams.length === 1 ? "" : "s"}</b>${teams.length ? ` (${teams.map(ui.esc).join(", ")})` : ""}</li>
      ${req ? `<li><b>${req}</b> newly required field${req === 1 ? "" : "s"}: existing records keep saving, the next edit asks for ${req === 1 ? "it" : "them"}</li>` : ""}</ul>
      <h3>Changes</h3>${ch.length ? `<ul class="list-plain">${ch.map((c) => `<li><code>${ui.esc(c)}</code></li>`).join("")}</ul>` : (s.version ? `<p class="muted">No changes since version ${s.version}.</p>` : `<p class="muted">First publish. Map it in a screen scheme so teams see it.</p>`)}
      ${p.length ? `<div class="callout bad" style="margin-top:10px">Fix ${p.length} problem${p.length === 1 ? "" : "s"} before publishing.</div>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:14px">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Publish", { kind: "primary", attrs: `id="sp-go" ${(!ch.length && s.version) || p.length ? "disabled" : ""}` })}</div>`);
    const go = document.getElementById("sp-go");
    go.addEventListener("click", () => { s.version++; s.published = clone(s.tabs); s.draft = false; s.updated = "Just now · Omar Alshair"; Admin.close(); Admin.toast(`Published “${s.name}” version ${s.version} (mockup)`); done(); });
  }

  Admin.register({
    id: "screens", group: "Configuration", title: "Screens & forms", icon: "screen",
    spec: ["SCR-001", "SCR-002", "SCR-003", "SCR-005", "SCR-010", "SCR-011", "FLD-032"],
    changes: "New. Company-wide screens with tabs and sections, a drag-and-drop designer with live preview per team, and screen schemes that map record kind × operation to a screen.",
    render(ctx) {
      const { ui } = ctx;
      const id = ctx.params[0];
      if (id) {
        const s = screens.find((x) => x.id === id);
        const crumbs = `<a href="#/screens">Screens & forms</a> / ${ui.esc(s ? s.name : id)}`;
        if (ctx.state !== "normal") return ui.pageHeader(s ? s.name : "Screen", "", "", crumbs) + ui.stateBlock(ctx.state, { emptyTitle: "This screen has no fields", emptyText: "Drag fields from the list on the left to start building the form." });
        if (!s) return ui.pageHeader("Screen not found", "", "", crumbs) + `<div class="card state">${ui.icon("alert")}<p>No screen with ID <code>${ui.esc(id)}</code>.</p><a href="#/screens">Back to screens</a></div>`;
        const teams = teamsUsing(s.id);
        return CSS + `<div id="sd-page">${ui.pageHeader(s.name, `${ui.esc(s.kind)} · ${ui.esc(s.op)} · ${s.version ? ui.badge("Published v" + s.version, "ok") : ui.badge("Draft, never published", "warn")} · used by ${teams.length} team${teams.length === 1 ? "" : "s"}`,
          ui.btn("Discard changes", { attrs: "data-discard" }) + ui.btn("Save draft", { attrs: "data-savedraft" }) + ui.btn("Publish", { kind: "primary", attrs: "data-publish" }), crumbs)}
          <div id="sd-root">${designer(s)}</div></div>`;
      }
      const head = ui.pageHeader("Screens & forms", "The forms people use to create, edit and view records. Designed once for the company; screen schemes decide which team sees which screen.",
        ui.btn("Custom fields", { ic: "field", attrs: `onclick="Admin.navigate('fields')"` }) + ui.btn("Create screen", { kind: "primary", ic: "screen", attrs: "data-create" }));
      if (ctx.state !== "normal") return `<div id="scr-page">${head}${ui.stateBlock(ctx.state, { emptyTitle: "No screens yet", emptyText: "Records use the built-in forms until you create a screen.", emptyAction: ui.btn("Create screen", { kind: "primary", attrs: "data-create" }) })}</div>`;
      return CSS + `<div id="scr-page">${head}${listView(ctx)}</div>`;
    },
    mount(root, ctx) {
      const list = root.querySelector("#scr-page");
      if (list) {
        list.addEventListener("click", (e) => {
          const t = e.target.closest("button"); if (!t) return;
          const d = t.dataset, { ui } = Admin;
          if (d.design) Admin.navigate("screens/" + d.design);
          else if (d.copy || d.create !== undefined) {
            const src = screens.find((x) => x.id === d.copy);
            Admin.modal(`<h2>${src ? "Copy screen" : "Create screen"}</h2>${ui.field("Name", ui.input(src ? src.name + " (copy)" : "", 'id="ns-name"'))}
              ${ui.field("Record kind", ui.select(window.MockData.recordKinds, src ? src.kind : "Candidate", 'id="ns-kind"'))}${ui.field("Operation", ui.select(["Create", "Edit", "View"], src ? src.op : "Create", 'id="ns-op"'))}
              <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn(src ? "Copy" : "Create", { kind: "primary", attrs: 'id="ns-go"' })}</div>`);
            document.getElementById("ns-go").onclick = () => {
              const name = document.getElementById("ns-name").value.trim(); if (!name) return;
              const id = "scr-" + Date.now().toString(36), tabs = src ? clone(src.tabs) : [{ name: "Details", sections: [sec("Main")] }];
              screens.push({ id, name, kind: document.getElementById("ns-kind").value, op: document.getElementById("ns-op").value, version: 0, tabs, published: clone(tabs), draft: true, updated: "Just now · Omar Alshair" });
              Admin.close(); Admin.toast(`Screen “${name}” created (mockup). Not used by any scheme yet.`); Admin.navigate("screens/" + id);
            };
          } else if (d.savescheme) {
            const sc = schemes.find((x) => x.id === d.savescheme);
            Admin.modal(`<h2>Save “${ui.esc(sc.name)}”?</h2><ul><li>Changes forms for <b>${sc.teams.length} team${sc.teams.length === 1 ? "" : "s"}</b>: ${sc.teams.map(ui.esc).join(", ")}</li><li>Existing records are not changed. Only the forms people see.</li></ul>
              <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Save", { kind: "primary", attrs: 'id="ss-go"' })}</div>`);
            document.getElementById("ss-go").onclick = () => { Admin.close(); Admin.toast("Screen scheme saved (mockup)"); };
          } else if (d.copyscheme !== undefined) Admin.toast("Scheme copied as a draft (mockup)");
        });
        list.addEventListener("change", (e) => {
          const t = e.target;
          if (t.id === "sch-sel") { const q = new URLSearchParams(ctx.query); q.set("scheme", t.value); Admin.navigate("screens?" + q); }
          if (t.dataset.map) { const [k, ty, i] = t.dataset.map.split("|"), sc = schemes.find((x) => x.id === (ctx.query.get("scheme") || "default")) || schemes[0]; sc.map[k + "|" + ty][+i] = t.value; }
        });
        return;
      }
      const page = root.querySelector("#sd-page"); if (!page) return;
      const s = screens.find((x) => x.id === ctx.params[0]);
      const box = page.querySelector("#sd-root");
      const tab = () => s.tabs[Math.min(UI.active[s.id] || 0, s.tabs.length - 1)];
      const changed = () => { s.draft = true; draw(); };
      const draw = () => {
        const focusId = document.activeElement && document.activeElement.id;
        box.innerHTML = designer(s);
        if (focusId === "sd-q") { const q = box.querySelector("#sd-q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      };
      const take = (si, fi) => tab().sections[si].fields.splice(fi, 1)[0];
      const put = (si, fi, item) => tab().sections[si].fields.splice(fi, 0, item);

      page.addEventListener("click", (e) => {
        const t = e.target.closest("button"); if (!t) return;
        const d = t.dataset;
        if (d.publish !== undefined) publishModal(s, () => Admin.rerender());
        else if (d.savedraft !== undefined) { s.draft = true; Admin.toast("Draft saved (mockup). People still see the published version."); }
        else if (d.discard !== undefined) { s.tabs = clone(s.published); s.draft = false; Admin.toast("Changes discarded"); draw(); }
        else if (d.tabi) { UI.active[s.id] = +d.tabi; draw(); }
        else if (d.addtab !== undefined) { s.tabs.push({ name: "New tab", sections: [sec("Main")] }); UI.active[s.id] = s.tabs.length - 1; changed(); box.querySelector("#sd-tabname").select(); }
        else if (d.rmtab !== undefined) {
          const t0 = tab(), n = t0.sections.reduce((a, x) => a + x.fields.length, 0);
          const go = () => { s.tabs.splice(s.tabs.indexOf(t0), 1); UI.active[s.id] = 0; changed(); };
          if (!n) return go();
          const { ui } = Admin;
          Admin.modal(`<h2>Remove tab “${ui.esc(t0.name)}”?</h2><p>Its <b>${n} field${n === 1 ? "" : "s"}</b> come off this screen. The fields and their values are kept.</p>
            <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Remove tab", { kind: "danger", attrs: 'id="rt-go"' })}</div>`);
          document.getElementById("rt-go").onclick = () => { Admin.close(); go(); };
        } else if (d.addsec !== undefined) { tab().sections.push(sec("New section")); changed(); }
        else if (d.rmsec) { tab().sections.splice(+d.rmsec, 1); changed(); }
        else if (d.add) { put(0, tab().sections[0].fields.length, { id: d.add, mode: "Optional" }); Admin.toast(`${fieldOf(d.add).name} added to ${tab().sections[0].name}`); changed(); }
        else if (d.rm) { const [si, fi] = d.rm.split("|").map(Number); take(si, fi); changed(); }
        else if (d.mv) { const [si, fi, dir] = d.mv.split("|").map(Number); const it = take(si, fi); put(si, fi + dir, it); changed(); }
      });
      page.addEventListener("change", (e) => {
        const t = e.target, d = t.dataset;
        if (d.mode) { const [si, fi] = d.mode.split("|").map(Number); tab().sections[si].fields[fi].mode = t.value; changed(); }
        else if (t.id === "sd-team") { UI.team = t.value; draw(); }
        else if (t.id === "sd-all") { UI.all = t.checked; draw(); }
        else if (t.id === "sd-tabname") { tab().name = t.value.trim() || tab().name; changed(); }
        else if (d.secname) { tab().sections[+d.secname].name = t.value.trim() || "Section"; changed(); }
      });
      page.addEventListener("input", (e) => {
        if (e.target.id === "sd-q") { UI.q = e.target.value; box.querySelector("#sd-pal").innerHTML = palette(s); }
      });
      // HTML5 drag and drop: palette → canvas, and reorder within / between sections and tabs.
      page.addEventListener("dragstart", (e) => {
        const src = e.target.closest && e.target.closest("[data-drag]"); if (!src) return;
        UI.drag = src.dataset.drag; e.dataTransfer.setData("text/plain", UI.drag); e.dataTransfer.effectAllowed = "copyMove";
        src.classList.add("dragging");
      });
      page.addEventListener("dragend", () => { page.querySelectorAll(".dragging,.over").forEach((n) => n.classList.remove("dragging", "over")); UI.drag = null; });
      page.addEventListener("dragover", (e) => {
        const tgt = e.target.closest("[data-drop],[data-droptab]"); if (!tgt || !UI.drag) return;
        e.preventDefault(); e.dataTransfer.dropEffect = UI.drag.startsWith("pal") ? "copy" : "move";
        page.querySelectorAll(".over").forEach((n) => n !== tgt && n.classList.remove("over")); tgt.classList.add("over");
      });
      page.addEventListener("dragleave", (e) => { const tgt = e.target.closest && e.target.closest("[data-drop],[data-droptab]"); if (tgt && !tgt.contains(e.relatedTarget)) tgt.classList.remove("over"); });
      page.addEventListener("drop", (e) => {
        const tgt = e.target.closest("[data-drop],[data-droptab]"); if (!tgt) return;
        e.preventDefault();
        const src = (e.dataTransfer.getData("text/plain") || UI.drag || "").split("|");
        let item;
        if (src[0] === "pal") { if (onScreen(s).has(src[1])) return; item = { id: src[1], mode: "Optional" }; }
        else if (src[0] === "cv") item = take(+src[1], +src[2]);
        else return;
        if (tgt.dataset.droptab !== undefined) {
          UI.active[s.id] = +tgt.dataset.droptab; const t0 = tab(); t0.sections[0].fields.push(item);
          Admin.toast(`${fieldOf(item.id).name} moved to tab ${t0.name}`);
        } else {
          let [si, fi] = tgt.dataset.drop.split("|").map(Number);
          if (src[0] === "cv" && +src[1] === si && +src[2] < fi) fi--;
          put(si, fi, item);
        }
        UI.drag = null; changed();
      });
    },
  });
})();
