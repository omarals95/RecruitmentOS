/* Roles list + role editor (#/roles, #/roles/<id>?tab=...).
   Also exposes window.AccessMock: the shared access model read by permissions.js and permission-helper.js. */
(function () {
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- access model ----------
  const RESOURCES = ["Candidates", "Job roles", "Vacancies", "Applications", "Interviews", "Offers", "Onboarding", "Team tasks", "Directory"];
  const ACTIONS = ["View", "Create", "Edit", "Move stage", "Archive", "Export", "Erase", "Approve", "Import", "Comment", "Share view"];
  const WRITE = new Set(["Create", "Edit", "Move stage", "Archive", "Erase", "Approve", "Import"]);
  const APPLIES = {
    Candidates: ["View", "Create", "Edit", "Archive", "Export", "Erase", "Import", "Comment", "Share view"],
    "Job roles": ["View", "Create", "Edit", "Archive", "Export", "Import", "Comment", "Share view"],
    Vacancies: ["View", "Create", "Edit", "Archive", "Export", "Approve", "Import", "Comment", "Share view"],
    Applications: ["View", "Create", "Edit", "Move stage", "Archive", "Export", "Comment", "Share view"],
    Interviews: ["View", "Create", "Edit", "Archive", "Export", "Comment", "Share view"],
    Offers: ["View", "Create", "Edit", "Archive", "Export", "Approve", "Comment"],
    Onboarding: ["View", "Create", "Edit", "Archive", "Export", "Comment"],
    "Team tasks": ["View", "Create", "Edit", "Archive", "Comment"],
    Directory: ["View", "Edit", "Export", "Import"],
  };
  const MEMBERSHIPS = ["Owner", "Admin", "Recruiter", "Viewer"];
  const PAGES = ["Home", "Candidates", "Job roles", "Vacancies", "Pipeline board", "Interviews", "Offers", "Onboarding", "Team tasks", "Directory", "Analytics", "Team & access"];
  const LATER_PAGES = ["Talent pool", "Careers site"];
  const SCOPES = ["All records", "My unit and below", "Assigned to me"];
  const SCOPE_GROUPS = [
    ["candidates", "Candidates", "Candidates follow the vacancies they applied to."],
    ["vacancies", "Vacancies and everything under them", "Applications, interviews, offers, onboarding and comments inherit the vacancy's unit."],
    ["tasks", "Team tasks", "Tasks follow the record they are linked to, or their assignee."],
  ];
  const FIELD_RULES = ["Default", "Hidden", "Read only", "Can edit"];
  const FIELDS = {
    Candidate: ["Full name", "Email", "Phone", "CV file", "Expected salary", "Nationality", "Notice period", "Private notes"],
    Vacancy: ["Title", "Unit", "Hiring manager", "Budget code", "Salary band"],
    Application: ["Stage", "Source", "Reason for rejection"],
    Interview: ["Date and time", "Panel", "Scorecard"],
    Offer: ["Offer amount", "Allowances", "Start date", "Relocation support"],
    Onboarding: ["Start date", "Emergency contact phone", "Visa status"],
  };
  const FIXED_FIELDS = { "Candidate.Private notes": "Private notes are only ever visible to their author. No role can share them." };

  // Ceiling / fixed-rule refusal for one action. Returns null when the membership may hold it.
  function refusal(membership, res, act) {
    if (!APPLIES[res] || !APPLIES[res].includes(act)) return { kind: "na", msg: "Not an action for this record kind." };
    if (res === "Directory" && (act === "Edit" || act === "Import"))
      return { kind: "fixed", msg: "Directory changes need company authority (Organisation area), never a team role." };
    if (membership === "Viewer" && WRITE.has(act)) return { kind: "ceiling", msg: "Viewer membership cannot hold a write action." };
    if (membership === "Recruiter" && act === "Erase") return { kind: "ceiling", msg: "Recruiter membership cannot erase records. Erase needs Admin membership." };
    return null;
  }
  function fullGrants(membership) {
    const g = {};
    RESOURCES.forEach((r) => (g[r] = APPLIES[r].filter((a) => !refusal(membership, r, a))));
    return g;
  }
  function grants(spec) { const g = {}; RESOURCES.forEach((r) => (g[r] = (spec[r] || []).slice())); return g; }
  const allPages = (m) => PAGES.filter((p) => !(p === "Team & access" && (m === "Viewer" || m === "Recruiter")));
  const allScope = { candidates: "All records", vacancies: "All records", tasks: "All records" };

  const recruiterGrants = fullGrants("Recruiter");
  const noCv = clone(recruiterGrants); noCv.Candidates = noCv.Candidates.filter((a) => a !== "Import");

  const roles = [
    { id: "r-owner", name: "Owner", desc: "Team owner. Full access inside the team. Locked.", membership: "Owner", kind: "owner",
      holders: [["Omar Alshair", "Talent Acquisition"], ["Omar Alshair", "Executive Search"]], pages: PAGES.slice(), actions: fullGrants("Owner"), fields: {}, scope: clone(allScope),
      versions: [["Built-in", "Shipped with RecruitmentOS", "System", "Locked"]], updated: "Built-in" },
    { id: "r-admin", name: "Admin", desc: "Runs a team: members, settings and every record action.", membership: "Admin", kind: "builtin",
      holders: [["Mariam Al Suwaidi", "Executive Search"], ["Rahul Menon", "Graduate Hiring"]], pages: PAGES.slice(), actions: fullGrants("Admin"), fields: {}, scope: clone(allScope),
      versions: [["Built-in", "Shipped with RecruitmentOS", "System", "Built-in"]], updated: "Built-in" },
    { id: "r-rec", name: "Recruiter", desc: "Day-to-day hiring. No erase, no team settings.", membership: "Recruiter", kind: "builtin",
      holders: [["Rahul Menon", "Talent Acquisition"], ["Sara Haddad", "Talent Acquisition"], ["Khalid Al Mansoori", "Talent Acquisition"]], pages: allPages("Recruiter"), actions: fullGrants("Recruiter"), fields: {}, scope: clone(allScope),
      versions: [["Built-in", "Shipped with RecruitmentOS", "System", "Built-in"]], updated: "Built-in" },
    { id: "r-view", name: "Viewer", desc: "Read only, can comment.", membership: "Viewer", kind: "builtin",
      holders: [["Aisha Rahman", "Graduate Hiring"]], pages: allPages("Viewer"), actions: grants(Object.fromEntries(RESOURCES.map((r) => [r, r === "Directory" ? ["View"] : ["View", "Comment"]]))), fields: {}, scope: clone(allScope),
      versions: [["Built-in", "Shipped with RecruitmentOS", "System", "Built-in"]], updated: "Built-in" },
    { id: "r-hm", name: "Hiring manager", desc: "Sees only their unit's vacancies and everything under them. No export or erase.", membership: "Recruiter", kind: "template",
      holders: [["Khalid Al Mansoori", "Talent Acquisition"]], pages: ["Home", "Vacancies", "Pipeline board", "Interviews", "Offers", "Team tasks", "Directory"],
      actions: grants({ Candidates: ["View", "Comment"], Vacancies: ["View", "Create", "Edit", "Approve", "Comment"], Applications: ["View", "Move stage", "Comment"], Interviews: ["View", "Create", "Edit", "Comment"], Offers: ["View", "Approve", "Comment"], Onboarding: ["View"], "Team tasks": ["View", "Create", "Edit", "Comment"], Directory: ["View"] }),
      fields: { "Candidate.Expected salary": "Read only", "Candidate.Phone": "Read only" }, scope: { candidates: "My unit and below", vacancies: "My unit and below", tasks: "Assigned to me" },
      versions: [["Template", "Shipped with Release 2", "System", "Ready to use"]], updated: "Built-in template" },
    { id: "r-int", name: "Interviewer", desc: "Sees only interviews assigned to them and the candidate's basics.", membership: "Viewer", kind: "template",
      holders: [["Layla Hassan", "Talent Acquisition"]], pages: ["Home", "Interviews", "Team tasks"],
      actions: grants({ Candidates: ["View"], Applications: ["View"], Interviews: ["View", "Comment"], "Team tasks": ["View", "Comment"], Directory: ["View"] }),
      fields: { "Candidate.Expected salary": "Hidden", "Candidate.Phone": "Hidden", "Offer.Offer amount": "Hidden", "Offer.Allowances": "Hidden" }, scope: { candidates: "Assigned to me", vacancies: "Assigned to me", tasks: "Assigned to me" },
      versions: [["Template", "Shipped with Release 2", "System", "Ready to use"]], updated: "Built-in template" },
    { id: "r-nocv", name: "Recruiter, no CV upload", desc: "Recruiter who cannot upload or import CVs.", membership: "Recruiter", kind: "company", status: "published", version: 2, draftOpen: false,
      holders: [["Sara Haddad", "Talent Acquisition"]], pages: allPages("Recruiter"), actions: noCv, fields: { "Candidate.CV file": "Read only" }, scope: clone(allScope),
      versions: [["v2", "10 Nov 2026 10:31", "Omar Alshair", "Published"], ["v1", "4 Nov 2026 15:02", "Omar Alshair", "Replaced"]], updated: "Today 10:31 · Omar Alshair" },
    { id: "r-offer", name: "Offer approver", desc: "Approves offers and vacancy requests. Cannot change candidate data.", membership: "Recruiter", kind: "company", status: "published", version: 1, draftOpen: true,
      holders: [["Noura Al Ketbi", "Talent Acquisition"], ["Hessa Al Mazrouei", "Talent Acquisition"], ["Faisal Qureshi", "Graduate Hiring"]], pages: ["Home", "Candidates", "Vacancies", "Offers", "Team tasks"],
      actions: grants({ Candidates: ["View", "Comment"], Vacancies: ["View", "Comment"], Applications: ["View"], Offers: ["View", "Approve", "Comment"], "Team tasks": ["View", "Comment"], Directory: ["View"] }),
      fields: { "Candidate.Phone": "Hidden" }, scope: clone(allScope),
      versions: [["v2", "Today 10:05 (draft)", "Omar Alshair", "Draft in progress"], ["v1", "2 Nov 2026 09:40", "Omar Alshair", "Published"]], updated: "Today 10:05 · Omar Alshair" },
    { id: "r-fin", name: "Finance reviewer", desc: "Finance partners who check offers and budgets.", membership: "Viewer", kind: "company", status: "draft", version: 0, draftOpen: true,
      holders: [], pages: ["Home", "Vacancies", "Offers"],
      actions: grants({ Vacancies: ["View", "Comment"], Offers: ["View", "Comment"], Directory: ["View"] }),
      fields: { "Candidate.Phone": "Hidden", "Candidate.Email": "Hidden" }, scope: { candidates: "My unit and below", vacancies: "My unit and below", tasks: "Assigned to me" },
      versions: [["v1", "Yesterday 16:20 (draft)", "Mariam Al Suwaidi", "Draft, never published"]], updated: "Yesterday · Mariam Al Suwaidi" },
  ];
  // Published snapshots, so the publish dialog can show what changed.
  const snap = (r) => clone({ pages: r.pages, actions: r.actions, fields: r.fields, scope: r.scope, name: r.name });
  roles.forEach((r) => { r.published = r.kind === "company" && r.status === "draft" ? null : snap(r); });
  // The Offer approver draft already differs from v1.
  const offer = roles.find((r) => r.id === "r-offer"); offer.actions.Vacancies.push("Approve"); offer.fields["Offer.Allowances"] = "Read only";

  function cell(role, res, act) {
    const ref = refusal(role.membership, res, act);
    if (ref) return ref.kind;
    return (role.actions[res] || []).includes(act) ? "allowed" : "denied";
  }
  function statusBadge(r) {
    const { ui } = Admin;
    if (r.kind === "owner") return ui.badge("Locked", "");
    if (r.kind === "builtin") return ui.badge("Built-in", "info");
    if (r.kind === "template") return ui.badge("Template", "info");
    if (r.status === "draft") return ui.badge("Draft", "warn");
    return ui.badge(`Published v${r.version}`, "ok") + (r.draftOpen ? " " + ui.badge("Draft in progress", "warn") : "");
  }
  function teamsOf(r) { return [...new Set(r.holders.map((h) => h[1]))]; }
  function diff(r) {
    const p = r.published, out = [];
    if (!p) return ["First publish: the role becomes available to give to team members."];
    RESOURCES.forEach((res) => {
      const a = new Set(p.actions[res] || []), b = new Set(r.actions[res] || []);
      b.forEach((x) => { if (!a.has(x)) out.push(`+ ${res} → ${x}`); });
      a.forEach((x) => { if (!b.has(x)) out.push(`− ${res} → ${x}`); });
    });
    new Set([...Object.keys(p.fields), ...Object.keys(r.fields)]).forEach((k) => {
      const a = p.fields[k] || "Default", b = r.fields[k] || "Default";
      if (a !== b) out.push(`${k.replace(".", " · ")}: ${a} → ${b}`);
    });
    Object.keys(r.scope).forEach((k) => { if (p.scope[k] !== r.scope[k]) out.push(`Record scope (${k}): ${p.scope[k]} → ${r.scope[k]}`); });
    PAGES.concat(LATER_PAGES).forEach((pg) => {
      const a = p.pages.includes(pg), b = r.pages.includes(pg);
      if (a !== b) out.push(`${b ? "+" : "−"} Page: ${pg}`);
    });
    if (p.name !== r.name) out.push(`Renamed: ${p.name} → ${r.name}`);
    return out;
  }

  window.AccessMock = { RESOURCES, ACTIONS, WRITE, APPLIES, MEMBERSHIPS, PAGES, SCOPES, FIELDS, FIXED_FIELDS, roles, refusal, cell, statusBadge };

  // ---------- page ----------
  const CSS = `<style>
    .ro-grid td, .ro-grid th { text-align:center; padding:6px 4px; vertical-align:middle; }
    .ro-list td { vertical-align:middle; }
    .ro-grid td:first-child, .ro-grid th:first-child { text-align:start; white-space:nowrap; font-weight:700; }
    .ro-grid th { font-size:11px; }
    .ro-cell { width:28px; height:28px; border-radius:6px; display:inline-grid; place-items:center; border:1px solid var(--border); background:var(--surface); cursor:pointer; }
    .ro-cell input { margin:0; cursor:pointer; }
    .ro-cell.blocked { background:var(--surface-subtle); color:var(--muted); border-style:dashed; }
    .ro-cell.blocked svg { width:13px; height:13px; }
    .ro-cell.flash { border-color:var(--danger); background:var(--danger-bg); color:var(--danger); }
    .ro-na { color:var(--muted); }
    .ro-seg { display:inline-flex; border:1px solid var(--border-strong); border-radius:8px; overflow:hidden; }
    .ro-seg label { padding:3px 9px; font-size:12px; cursor:pointer; border-inline-start:1px solid var(--border); }
    .ro-seg label:first-child { border-inline-start:0; }
    .ro-seg input { position:absolute; opacity:0; pointer-events:none; }
    .ro-seg label:has(input:checked) { background:var(--primary-soft); color:var(--primary-text); font-weight:700; }
    .ro-seg label:has(input:disabled) { opacity:.45; cursor:not-allowed; }
    .ro-seg label:has(input:focus-visible) { outline:2px solid var(--focus); }
    .ro-pages { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px 16px; }
    .ro-meta dt { color:var(--muted); font-size:12px; } .ro-meta dd { margin:0 0 10px; }
    .ro-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--muted); align-items:center; }
  </style>`;
  const lock = () => Admin.icon("key", 'width="13" height="13"');

  function listView(ctx) {
    const { ui } = ctx;
    const tab = ctx.query.get("tab") || "all";
    const filter = { all: () => true, builtin: (r) => r.kind !== "company", company: (r) => r.kind === "company" }[tab] || (() => true);
    const rows = roles.filter(filter).map((r) => [
      `<a href="#/roles/${r.id}"><b>${ui.esc(r.name)}</b></a><div class="small muted">${ui.esc(r.desc)}</div>`,
      ui.badge(r.membership, ""),
      r.kind === "company" ? "Company role" : r.kind === "template" ? "Built-in template" : "Built-in",
      ui.esc(r.scope.vacancies),
      statusBadge(r),
      `<span style="white-space:nowrap"><b>${r.holders.length}</b> <span class="small muted">in ${teamsOf(r).length} team${teamsOf(r).length === 1 ? "" : "s"}</span></span>`,
      `<span class="small">${ui.esc(r.updated)}</span>`,
      `<div class="row" style="flex-wrap:nowrap">${ui.btn(r.kind === "company" ? "Edit" : "View", { kind: "sm", attrs: `data-open="${r.id}"` })}${r.kind === "owner" ? "" : ui.btn("Copy", { kind: "sm", attrs: `data-copy="${r.id}"` })}</div>`,
    ]);
    return `<div class="callout" style="margin-bottom:14px">Roles are designed <b>once for the company</b> and shared by every team. A role is a narrower copy of Admin, Recruiter or Viewer: it can only take access away, never add. Giving someone a role happens on <a href="#/teams">Teams → members</a>.</div>
      ${ui.tabs("roles", [{ id: "all", label: `All roles (${roles.length})` }, { id: "builtin", label: "Built-in and templates" }, { id: "company", label: `Company roles (${roles.filter((r) => r.kind === "company").length})` }], tab)}
      ${ui.table(["Role", "Based on", "Kind", "Record scope", "Status", "Holders", "Last changed", ""], rows)}
      <p class="small muted" style="margin-top:10px">Private notes, shortlists and private saved views can never be granted by any role, including Owner.</p>`;
  }

  function editorView(ctx, r) {
    const { ui } = ctx;
    const ro = r.kind !== "company";
    const tab = ctx.query.get("tab") || "general";
    const banner = r.kind === "owner"
      ? `<div class="callout warn" style="margin-bottom:12px">${lock()} <b>Owner is locked.</b> Team owners always keep full access inside their team so a team can never be left without someone in charge.</div>`
      : ro ? `<div class="callout" style="margin-bottom:12px"><b>Built-in ${r.kind === "template" ? "template" : "role"}: read only.</b> To change it, copy it to a new company role and narrow the copy. ${ui.btn("Copy to new role", { kind: "sm", attrs: `data-copy="${r.id}"` })}</div>`
      : r.draftOpen ? `<div class="callout warn" style="margin-bottom:12px"><b>You are editing a draft.</b> ${r.status === "draft" ? "This role has never been published, so nobody holds it yet." : `Members keep version ${r.version} until you publish.`}</div>` : "";
    const tabs = ui.tabs("role-editor", [
      { id: "general", label: "General" }, { id: "pages", label: "Pages" }, { id: "actions", label: "Actions" },
      { id: "fields", label: "Field rules" }, { id: "scope", label: "Record scope" }, { id: "versions", label: "Versions" },
    ], tab);
    const dis = ro ? "disabled" : "";
    let body = "";
    if (tab === "general") {
      body = `<div class="split"><div class="card">
        ${ui.field("Name", ui.input(r.name, `data-name ${dis} maxlength="60"`))}
        ${ui.field("Description", `<textarea class="input" rows="2" data-desc ${dis}>${ui.esc(r.desc)}</textarea>`)}
        ${ui.field("Based on (membership ceiling)", ui.select(MEMBERSHIPS, r.membership, "disabled"), `Fixed when the role is created. The role can never go above <b>${ui.esc(r.membership)}</b>. To change it, copy to a new role.`)}
      </div><div class="card"><h2>Who holds it</h2>${r.holders.length
        ? `<ul class="list-plain">${r.holders.map(([n, t]) => `<li class="row">${ui.avatar(n)}<span>${ui.esc(n)}</span><span class="muted small" style="margin-inline-start:auto">${ui.esc(t)}</span></li>`).join("")}</ul>`
        : `<p class="muted">Nobody yet. Publish the role, then give it to members on a team's member list.</p>`}
        <dl class="ro-meta" style="margin-top:12px"><dt>Role ID</dt><dd><code>${r.id}</code></dd><dt>Last changed</dt><dd>${ui.esc(r.updated)}</dd></dl></div></div>`;
    } else if (tab === "pages") {
      const cap = r.membership === "Viewer" || r.membership === "Recruiter";
      body = `<div class="card"><h2>Pages in the menu</h2><p class="muted small">Unticked pages disappear from the menu and their addresses return “not available”.</p>
        <div class="ro-pages">${PAGES.map((p) => {
          const blocked = cap && p === "Team & access";
          return `<label class="check" ${blocked ? `title="${r.membership} membership cannot open team settings."` : ""}><input type="checkbox" data-page="${ui.esc(p)}" ${r.pages.includes(p) ? "checked" : ""} ${ro || blocked ? "disabled" : ""}> ${ui.esc(p)}${blocked ? ` <span class="small muted">(needs Admin)</span>` : ""}</label>`;
        }).join("")}</div>
        <h3 style="margin-top:16px">Takes effect later</h3><p class="muted small">Saved now, starts working when these screens arrive.</p>
        <div class="ro-pages">${LATER_PAGES.map((p) => `<label class="check"><input type="checkbox" data-page="${p}" ${r.pages.includes(p) ? "checked" : ""} ${dis}> ${p} ${ui.badge("Later", "")}</label>`).join("")}</div></div>`;
    } else if (tab === "actions") {
      const viewerNote = r.membership === "Viewer" ? `<div class="callout warn" style="margin-bottom:10px">Based on <b>Viewer</b>: write actions are greyed out. Select one to see why.</div>` : "";
      body = `<div class="card">${viewerNote}
        <div class="ro-legend" style="margin-bottom:10px"><span><input type="checkbox" checked disabled> Granted</span><span><input type="checkbox" disabled> Not granted</span><span><span class="ro-cell blocked" style="width:20px;height:20px">${lock()}</span> Above the ceiling or a fixed rule</span><span>— Not an action for this record kind</span></div>
        <div class="table-wrap"><table class="t ro-grid"><thead><tr><th>Record kind</th>${ACTIONS.map((a) => `<th>${a}</th>`).join("")}</tr></thead><tbody>
        ${RESOURCES.map((res) => `<tr><td>${res}</td>${ACTIONS.map((a) => {
          const c = cell(r, res, a);
          if (c === "na") return `<td><span class="ro-na" aria-label="Not applicable">—</span></td>`;
          if (c === "ceiling" || c === "fixed") {
            const msg = refusal(r.membership, res, a).msg;
            return `<td><button class="ro-cell blocked" data-refuse="${ui.esc(res + " → " + a)}" data-msg="${ui.esc(msg)}" title="${ui.esc(msg)}" aria-label="${ui.esc(res + " " + a + ": " + msg)}">${lock()}</button></td>`;
          }
          return `<td><label class="ro-cell" title="${ui.esc(res + " → " + a)}"><input type="checkbox" aria-label="${ui.esc(res + " " + a)}" data-act="${ui.esc(res)}|${ui.esc(a)}" ${c === "allowed" ? "checked" : ""} ${dis}></label></td>`;
        }).join("")}</tr>`).join("")}
        </tbody></table></div>
        <div id="ro-refusal" aria-live="polite" style="margin-top:10px"></div>
        <p class="small muted" style="margin:10px 0 0">There is no explicit deny: a member can do exactly what is ticked, within the ceiling. Moving a candidate to Hired or Rejected is always done by a person, never a token or AI connection.</p></div>`;
    } else if (tab === "fields") {
      const kind = ctx.query.get("kind") || "Candidate";
      body = `<div class="card"><div class="toolbar"><label class="small muted" for="ro-kind">Record kind</label>${ui.select(Object.keys(FIELDS), kind, 'id="ro-kind" style="width:auto"')}</div>
        <p class="muted small">Hidden fields are removed everywhere: screens, API, CSV export, search, notifications and AI results. People cannot search or sort by a field they cannot see.</p>
        ${ui.table(["Field", "Rule"], FIELDS[kind].map((f) => {
          const key = kind + "." + f;
          if (FIXED_FIELDS[key]) return [ui.esc(f), `${ui.badge("Fixed rule", "")} <span class="small muted">${FIXED_FIELDS[key]}</span>`];
          const cur = r.fields[key] || "Default";
          return [`${ui.esc(f)}${cur !== "Default" ? " " + ui.badge(cur, cur === "Hidden" ? "bad" : "warn") : ""}`,
            `<div class="ro-seg" role="radiogroup" aria-label="${ui.esc(f)}">${FIELD_RULES.map((o) => {
              const blocked = o === "Can edit" && r.membership === "Viewer";
              return `<label ${blocked ? `title="Viewer membership cannot hold a write action."` : ""}><input type="radio" name="fr-${ui.esc(key)}" data-field="${ui.esc(key)}" value="${o}" ${cur === o ? "checked" : ""} ${ro || blocked ? "disabled" : ""}>${o}</label>`;
            }).join("")}</div>`];
        }))}
        <p class="small muted" style="margin:10px 0 0"><b>Default</b> follows the action grid: view if the record is visible, edit if Edit is ticked.</p></div>`;
    } else if (tab === "scope") {
      body = `<div class="card"><p class="muted" style="margin-top:0">Record scope narrows <i>which</i> records in the team this role can see. It uses the <a href="#/organisation?tab=chart">org chart</a>: each vacancy belongs to a unit, and each person has a home unit in the directory.</p>
        ${SCOPE_GROUPS.map(([k, label, hint]) => `<fieldset class="card" style="box-shadow:none;margin-bottom:10px"><legend><b>${label}</b></legend>
          <div class="row">${SCOPES.map((s) => `<label class="check" style="margin-inline-end:14px"><input type="radio" name="scope-${k}" data-scope="${k}" value="${s}" ${r.scope[k] === s ? "checked" : ""} ${dis}> ${s}</label>`).join("")}</div>
          <div class="small muted" style="margin-top:6px">${hint}</div></fieldset>`).join("")}
        <div class="callout"><b>Example.</b> Khalid Al Mansoori's home unit is Engineering. With <i>My unit and below</i> he sees vacancies in Engineering and Platform Engineering, not Finance.</div></div>`;
    } else {
      body = `<div class="card"><h2>Version history</h2>${ui.table(["Version", "When", "By", "State", ""], r.versions.map((v) => [
        `<b>${ui.esc(v[0])}</b>`, ui.esc(v[1]), ui.esc(v[2]),
        ui.badge(v[3], v[3] === "Published" ? "ok" : v[3].startsWith("Draft") ? "warn" : ""),
        r.kind === "company" && v[3] === "Replaced" ? ui.btn("Restore as draft", { kind: "sm", attrs: `data-restore="${ui.esc(v[0])}"` }) : "",
      ]))}<p class="small muted" style="margin:10px 0 0">Every version is also in the <a href="#/audit">audit log</a>.</p></div>`;
    }
    const actions = ro
      ? (r.kind === "owner" ? "" : ui.btn("Copy to new role", { kind: "primary", attrs: `data-copy="${r.id}"` }))
      : ui.btn("Copy to new role", { attrs: `data-copy="${r.id}"` }) + ui.btn("Save draft", { attrs: "data-save" }) + ui.btn("Publish", { kind: "primary", attrs: "data-publish" });
    return ui.pageHeader(r.name, `${statusBadge(r)} <span style="margin-inline-start:6px">Based on <b>${ui.esc(r.membership)}</b> · ${r.holders.length} holder${r.holders.length === 1 ? "" : "s"}</span>`, actions,
      `<a href="#/roles">Roles</a> / ${ui.esc(r.name)}`) + banner + tabs + body;
  }

  function copyModal(fromId) {
    const { ui } = Admin;
    const from = roles.find((r) => r.id === fromId);
    const bases = ["Admin", "Recruiter", "Viewer"];
    Admin.modal(`<h2>Copy to new role</h2>
      <p class="muted small">The new role starts as a draft. Nobody holds it until you publish it and give it to members.</p>
      ${ui.field("Name", ui.input(from ? `${from.name} (copy)` : "", 'id="cp-name" maxlength="60"'))}
      ${ui.field("Start from", ui.select(roles.filter((r) => r.kind !== "owner").map((r) => r.name), from && from.kind !== "owner" ? from.name : "Recruiter", 'id="cp-from"'), "Pages, actions, field rules and scope are copied from this role.")}
      ${ui.field("Based on (ceiling)", ui.select(bases, from && bases.includes(from.membership) ? from.membership : "Recruiter", 'id="cp-base"'), "Cannot be changed after create. Anything above the ceiling is dropped from the copy.")}
      <div id="cp-err" class="small" style="color:var(--danger);min-height:18px"></div>
      <div class="row" style="justify-content:flex-end">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Create draft", { kind: "primary", attrs: 'id="cp-go"' })}</div>`);
    const m = document.querySelector(".modal");
    m.querySelector("#cp-from").addEventListener("change", (e) => {
      const src = roles.find((r) => r.name === e.target.value);
      if (src && bases.includes(src.membership)) m.querySelector("#cp-base").value = src.membership;
    });
    m.querySelector("#cp-go").addEventListener("click", () => {
      const name = m.querySelector("#cp-name").value.trim();
      if (!name) { m.querySelector("#cp-err").textContent = "Give the role a name."; return; }
      if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) { m.querySelector("#cp-err").textContent = "A role with this name already exists."; return; }
      const src = roles.find((r) => r.name === m.querySelector("#cp-from").value) || roles[2];
      const base = m.querySelector("#cp-base").value;
      const acts = {}; RESOURCES.forEach((res) => (acts[res] = (src.actions[res] || []).filter((a) => !refusal(base, res, a))));
      const id = "r-new" + Date.now().toString(36);
      roles.push({ id, name, desc: `Copy of ${src.name}.`, membership: base, kind: "company", status: "draft", version: 0, draftOpen: true, holders: [],
        pages: src.pages.filter((p) => !(p === "Team & access" && base !== "Admin")), actions: acts, fields: clone(src.fields), scope: clone(src.scope),
        versions: [["v1", "Just now (draft)", "Omar Alshair", "Draft, never published"]], updated: "Just now · Omar Alshair", published: null });
      Admin.close(); Admin.toast(`Draft role “${name}” created (mockup)`); Admin.navigate("roles/" + id);
    });
  }

  function publishModal(r) {
    const { ui } = Admin;
    const changes = diff(r), teams = teamsOf(r);
    const nothing = r.published && !changes.length;
    Admin.modal(`<h2>Publish “${ui.esc(r.name)}”${r.published ? ` as version ${r.version + 1}` : ""}?</h2>
      <ul>
        <li>${r.holders.length ? `Changes access for <b>${r.holders.length} member${r.holders.length === 1 ? "" : "s"}</b> in <b>${teams.length} team${teams.length === 1 ? "" : "s"}</b> (${teams.map(ui.esc).join(", ")})` : "Nobody holds this role yet, so nobody's access changes today"}</li>
        <li>Takes effect on their next page load, in screens, API, exports, search, notifications and AI connections</li>
      </ul>
      <h3>Changes</h3>${nothing ? `<p class="muted">No changes since version ${r.version}.</p>` : `<ul class="list-plain">${changes.map((c) => `<li><code>${ui.esc(c)}</code></li>`).join("")}</ul>`}
      <div class="row" style="justify-content:flex-end;margin-top:14px">${ui.btn("Cancel", { attrs: 'onclick="Admin.close()"' })}${ui.btn("Publish", { kind: "primary", attrs: `id="pb-go" ${nothing ? "disabled" : ""}` })}</div>`);
    const go = document.getElementById("pb-go");
    if (go) go.addEventListener("click", () => {
      r.version = (r.published ? r.version : 0) + 1; r.status = "published"; r.draftOpen = false; r.published = snap(r);
      r.versions = r.versions.filter((v) => !v[3].startsWith("Draft")).map((v) => (v[3] === "Published" ? [v[0], v[1], v[2], "Replaced"] : v));
      r.versions.unshift(["v" + r.version, "Just now", "Omar Alshair", "Published"]); r.updated = "Just now · Omar Alshair";
      Admin.close(); Admin.toast(`Published “${r.name}” version ${r.version} (mockup)`); Admin.rerender();
    });
  }

  function markDraft(r) {
    if (r.kind !== "company") return;
    if (!r.draftOpen) { r.draftOpen = true; r.versions.unshift([`v${r.version + 1}`, "Just now (draft)", "Omar Alshair", "Draft in progress"]); }
    r.updated = "Just now · Omar Alshair";
  }

  Admin.register({
    id: "roles", group: "People & access", title: "Roles", icon: "key",
    spec: ["PRM-020", "PRM-022", "PRM-024", "PRM-050", "P-07"],
    changes: "Moves Roles & permissions into the Admin portal: list with holders and versions, a full role editor with inline ceiling refusals, publish impact and copy-to-new-role.",
    render(ctx) {
      const { ui } = ctx;
      const id = ctx.params[0];
      if (id) {
        const r = roles.find((x) => x.id === id);
        if (ctx.state !== "normal") return ui.pageHeader("Role", "", "", `<a href="#/roles">Roles</a>`) + ui.stateBlock(ctx.state, { emptyTitle: "This role has no settings yet", emptyText: "Start by choosing pages and actions." });
        if (!r) return ui.pageHeader("Role not found", "", "", `<a href="#/roles">Roles</a>`) + `<div class="card state">${ui.icon("alert")}<p>No role with ID <code>${ui.esc(id)}</code>. It may have been archived.</p><a href="#/roles">Back to roles</a></div>`;
        return CSS + `<div id="roles-page">${editorView(ctx, r)}</div>`;
      }
      const head = ui.pageHeader("Roles", "What each team role can see and do. Designed once for the company, given per team.",
        ui.btn("Permission matrix", { ic: "shield", attrs: `onclick="Admin.navigate('permissions')"` }) + ui.btn("Create role", { kind: "primary", ic: "key", attrs: "data-copy=''" }));
      if (ctx.state !== "normal") return `<div id="roles-page">${head}${ui.stateBlock(ctx.state, { emptyTitle: "No company roles yet", emptyText: "The built-in roles are always available. Copy one to make a narrower company role.", emptyAction: ui.btn("Create role", { kind: "primary", attrs: "data-copy=''" }) })}</div>`;
      return CSS + `<div id="roles-page">${head}${listView(ctx)}</div>`;
    },
    mount(root, ctx) {
      const page = root.querySelector("#roles-page"); if (!page) return;
      const r = roles.find((x) => x.id === ctx.params[0]);
      page.addEventListener("click", (e) => {
        const t = e.target.closest("[data-open],[data-copy],[data-refuse],[data-save],[data-publish],[data-restore]");
        if (!t) return;
        if (t.dataset.open) Admin.navigate("roles/" + t.dataset.open);
        else if (t.hasAttribute("data-copy")) copyModal(t.dataset.copy);
        else if (t.dataset.refuse) {
          page.querySelectorAll(".ro-cell.flash").forEach((n) => n.classList.remove("flash"));
          t.classList.add("flash");
          page.querySelector("#ro-refusal").innerHTML = `<div class="callout bad"><b>Refused: ${Admin.ui.esc(t.dataset.refuse)}.</b> ${Admin.ui.esc(t.dataset.msg)}</div>`;
        } else if (t.hasAttribute("data-save")) { markDraft(r); Admin.toast("Draft saved (mockup). Members keep the published version until you publish."); Admin.rerender(); }
        else if (t.hasAttribute("data-publish")) publishModal(r);
        else if (t.dataset.restore) { markDraft(r); Admin.toast(`${t.dataset.restore} copied into the draft (mockup)`); Admin.rerender(); }
      });
      page.addEventListener("change", (e) => {
        if (e.target.id !== "ro-kind" || !r) return;
        const q = new URLSearchParams(ctx.query); q.set("kind", e.target.value); Admin.navigate(`roles/${r.id}?${q}`);
      });
      if (!r || r.kind !== "company") return;
      page.addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset.act) {
          const [res, a] = t.dataset.act.split("|");
          const set = new Set(r.actions[res] || []);
          t.checked ? set.add(a) : set.delete(a);
          if (a === "View" && !t.checked) { set.clear(); page.querySelectorAll(`[data-act^="${res}|"]`).forEach((c) => (c.checked = false)); Admin.toast(`Without View, ${res} is hidden, so other ${res} actions were cleared`); }
          if (a !== "View" && t.checked && !set.has("View")) { set.add("View"); const v = page.querySelector(`[data-act="${res}|View"]`); if (v) v.checked = true; }
          r.actions[res] = ACTIONS.filter((x) => set.has(x)); markDraft(r);
        } else if (t.dataset.page) {
          r.pages = t.checked ? [...r.pages, t.dataset.page] : r.pages.filter((p) => p !== t.dataset.page); markDraft(r);
        } else if (t.dataset.field) {
          if (t.value === "Default") delete r.fields[t.dataset.field]; else r.fields[t.dataset.field] = t.value; markDraft(r);
        } else if (t.dataset.scope) { r.scope[t.dataset.scope] = t.value; markDraft(r); }
      });
      page.addEventListener("input", (e) => {
        if (e.target.hasAttribute("data-name")) { r.name = e.target.value || r.name; markDraft(r); }
        if (e.target.hasAttribute("data-desc")) { r.desc = e.target.value; markDraft(r); }
      });
    },
  });
})();
