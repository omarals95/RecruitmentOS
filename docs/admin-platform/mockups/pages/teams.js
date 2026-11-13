/* Teams: replaces today's "Team settings" / "Team & access" page. List, create, and team detail tabs. */
(function () {
  const esc = (s) => Admin.ui.esc(s);
  const RANK = { Owner: 4, Admin: 3, Recruiter: 2, Viewer: 1 };
  const TEAM_ROLES = ["Owner", "Admin", "Recruiter", "Viewer"];
  const S = { viewAs: "owner", storage: {} };

  // Page-local sample data (fictional). Extra members are people not shown in the shared user sample.
  const EXTRA = {
    "t-ta": [["Noura Al Ketbi", "Recruiter", ""], ["James Whitfield", "Recruiter", ""], ["Priya Nair", "Admin", ""], ["Yousef Al Hammadi", "Viewer", "Interviewer"]],
    "t-es": [["Hessa Al Falasi", "Recruiter", ""], ["Thomas Becker", "Viewer", ""]],
    "t-gr": [["Fatima Zahra", "Recruiter", ""], ["Arjun Pillai", "Recruiter", ""], ["Reem Al Nuaimi", "Recruiter", ""], ["Chloe Martin", "Viewer", ""]],
  };
  const META = {
    "t-ta": { desc: "Hiring for every permanent role outside the executive team.", created: "12 February 2026", apps: 41, boards: 3 },
    "t-es": { desc: "Confidential senior and board-level searches.", created: "1 April 2026", apps: 9, boards: 1 },
    "t-gr": { desc: "Graduate and internship programmes, campus events.", created: "20 May 2026", apps: 88, boards: 2 },
  };
  const ARCHIVED = [{ id: "t-ce", name: "Campus Events 2025", lead: "Rahul Menon", members: 0, candidates: 31, vacancies: 0, unit: "Human Resources", archived: "14 January 2026" }];
  const STORAGE = {
    "t-ta": { usedMb: 182, files: 214, limitOn: true, limitMb: 1024, limitFiles: 2000, rateOn: true, perMin: 20, ai: false },
    "t-es": { usedMb: 41, files: 38, limitOn: false, limitMb: 512, limitFiles: 500, rateOn: false, perMin: 10, ai: false },
    "t-gr": { usedMb: 95, files: 402, limitOn: true, limitMb: 256, limitFiles: 600, rateOn: true, perMin: 30, ai: true },
  };
  const SPEED = [
    ["Candidates list", "/candidates", 180, 420], ["Candidate profile", "/candidates/[id]", 210, 560], ["Pipeline board", "/pipeline", 260, 780],
    ["Vacancies", "/vacancies", 150, 380], ["Interviews calendar", "/interviews", 230, 640], ["CV upload", "/api/candidates/cv", 640, 1480], ["Search", "/api/search", 120, 310],
  ];
  const BOARDS = {
    "t-ta": [["Hiring tasks", ["To do", "In progress", "Waiting on candidate", "Done"], 24], ["Onboarding checklist", ["Before day one", "First week", "First month", "Complete"], 11], ["Sourcing ideas", ["Ideas", "Trying", "Works", "Dropped"], 7]],
    "t-es": [["Search tasks", ["To do", "Doing", "Client review", "Done"], 8]],
    "t-gr": [["Campus events", ["Planned", "Confirmed", "Done"], 6], ["Assessment centre", ["Prepare", "On the day", "Follow-up"], 15]],
  };

  function members(data, t) {
    const real = data.users.filter((u) => u.teams.some((x) => x[0] === t.name)).map((u) => {
      const [role, conf] = String(u.teams.find((x) => x[0] === t.name)[1]).split(" · ");
      return { id: u.id, name: u.name, email: u.email, role, conf: conf || "", status: u.status };
    });
    const extra = (EXTRA[t.id] || []).map(([name, role, conf]) => ({ id: "", name, email: name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".") + "@example.test", role, conf, status: "Active" }));
    return real.concat(extra);
  }
  const confOptions = (data, role) => ["None"].concat(data.roles.filter((r) => r.kind !== "Built-in" && RANK[r.membership] <= RANK[role]).map((r) => r.name));

  function confirmBox({ title, intro = "", impact = [], extra = "", ok = "Confirm", danger = false, onOk, okToast = "Saved (mockup)" }) {
    Admin.modal(`<h2>${esc(title)}</h2>${intro ? `<p>${intro}</p>` : ""}
      ${impact.length ? `<div class="callout warn" style="margin:8px 0"><b>Impact</b><ul style="margin:4px 0 0;padding-inline-start:18px">${impact.map((i) => `<li>${i}</li>`).join("")}</ul></div>` : ""}${extra}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-x="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-x="ok">${esc(ok)}</button></div>`);
    const m = document.querySelector(".modal");
    m.querySelector("[data-x=cancel]").onclick = () => Admin.close();
    m.querySelector("[data-x=ok]").onclick = () => { Admin.close(); if (onOk) onOk(); if (okToast) Admin.toast(okToast); };
    return m;
  }
  const viewAsSelect = () => `<label class="row small">Preview as <select class="input" data-viewas style="width:auto"><option value="owner" ${S.viewAs === "owner" ? "selected" : ""}>Company owner (you)</option><option value="admin" ${S.viewAs === "admin" ? "selected" : ""}>Company admin (Organisation)</option><option value="teamadmin" ${S.viewAs === "teamadmin" ? "selected" : ""}>Team admin, no company authority</option></select></label>`;
  const callout = `<div class="callout" style="margin-bottom:12px"><b>Team settings now live here.</b> What used to be <i>Team settings</i> and <i>Team &amp; access</i> in each team is now part of the Admin portal: members, CV storage, speed, task boards and archiving. Team owners and admins still manage their own team's members.</div>`;

  function createModal(data) {
    const ui = Admin.ui;
    Admin.modal(`<h2>Create team</h2><p class="small muted" style="margin-top:0">Each team's records are kept apart from other teams. Company roles, fields, workflows and templates are shared by every team.</p>
      ${ui.field("Team name", `<input class="input" id="t-name" placeholder="e.g. Engineering Hiring">`)}
      <div id="t-err" class="small" style="color:var(--danger);margin:-8px 0 8px" hidden></div>
      ${ui.field("Description", ui.input("", 'placeholder="What this team hires for"'))}
      <div class="grid g2">${ui.field("Team lead", ui.select(data.users.filter((u) => u.status === "Active").map((u) => u.name), "Omar Alshair"))}${ui.field("Unit", ui.select(data.units.map((u) => u.name), "Human Resources"), "Vacancies created here default to this unit")}</div>
      ${ui.field("First owner", ui.select(data.users.filter((u) => u.status === "Active").map((u) => u.name), "Omar Alshair"), "Gets the Owner team role. You can add more members afterwards.")}
      ${ui.check("Copy task boards from Talent Acquisition", true)}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" id="t-ok">Create team</button></div>`);
    document.getElementById("t-ok").onclick = () => {
      const v = document.getElementById("t-name").value.trim(), err = document.getElementById("t-err");
      const msg = !v ? "Enter a team name." : data.teams.concat(ARCHIVED).some((t) => t.name.toLowerCase() === v.toLowerCase()) ? "A team with this name already exists (including archived teams)." : "";
      err.textContent = msg; err.hidden = !msg;
      if (!msg) { Admin.close(); Admin.toast(`Team ${v} created (mockup)`); }
    };
  }

  // ---------- List ----------
  function renderList(ctx) {
    const { ui, data } = ctx;
    const owner = S.viewAs === "owner";
    const head = ui.pageHeader("Teams", "Teams organise work. Each team's candidates, vacancies and tasks are kept apart from other teams.",
      viewAsSelect() + ui.btn("Create team", { kind: "primary", ic: "team", attrs: `data-act="create" ${owner ? "" : 'disabled title="Only company owners can create teams"'}` }));
    if (ctx.state !== "normal") return `<div data-page="teams-list">${head}${ui.stateBlock(ctx.state, { emptyTitle: "No teams yet", emptyText: "Create your first team. Everyone must belong to at least one team to see records.", emptyAction: ui.btn("Create team", { kind: "primary", attrs: `data-act="create"` }), errorText: "We could not load teams." })}</div>`;
    const lead = (n) => { const u = data.users.find((x) => x.name === n); return `<div class="row" style="flex-wrap:nowrap">${ui.avatar(n)}${u ? `<a href="#/users/${u.id}">${esc(n)}</a>` : esc(n)}</div>`; };
    const rows = data.teams.map((t) => [`<a href="#/teams/${t.id}"><b>${esc(t.name)}</b></a><div class="small muted">${esc((META[t.id] || {}).desc || "")}</div>`, lead(t.lead), t.members, t.candidates, t.vacancies, esc(t.unit), `<a class="btn sm" href="#/teams/${t.id}">Open</a>`]);
    const arch = ARCHIVED.map((t) => [`<b>${esc(t.name)}</b> ${ui.badge("Archived", "")}<div class="small muted">Archived ${esc(t.archived)} · read only</div>`, lead(t.lead), t.members, t.candidates, t.vacancies, esc(t.unit), ui.btn("Restore", { kind: "sm", attrs: `data-restore="${t.id}" ${owner ? "" : "disabled"}` })]);
    return `<div data-page="teams-list">${head}${callout}
      ${owner ? "" : `<div class="callout warn" style="margin-bottom:12px">Only company owners can create, archive or restore teams.</div>`}
      <div class="grid g4" style="margin-bottom:16px">${ui.kpi("Teams", data.teams.length, "1 archived")}${ui.kpi("Members", data.teams.reduce((n, t) => n + t.members, 0), "across all teams")}${ui.kpi("Candidates", data.teams.reduce((n, t) => n + t.candidates, 0))}${ui.kpi("Open vacancies", data.teams.reduce((n, t) => n + t.vacancies, 0))}</div>
      <div class="toolbar"><input class="input" id="t-q" type="search" placeholder="Search teams" aria-label="Search teams">${ui.check("Show archived teams", false, 'id="t-arch"')}</div>
      <div id="t-active">${ui.table(["Team", "Lead", "Members", "Candidates", "Vacancies", "Unit", ""], rows)}</div>
      <div id="t-archived" hidden style="margin-top:16px"><h2>Archived</h2>${ui.table(["Team", "Lead", "Members", "Candidates", "Vacancies", "Unit", ""], arch)}</div></div>`;
  }
  function mountList(root, ctx) {
    const page = root.querySelector("[data-page=teams-list]");
    if (!page) return;
    page.querySelectorAll("[data-act=create]").forEach((b) => (b.onclick = () => createModal(ctx.data)));
    const va = page.querySelector("[data-viewas]"); if (va) va.onchange = () => { S.viewAs = va.value; Admin.rerender(); };
    const q = page.querySelector("#t-q"); if (!q) return;
    q.addEventListener("input", () => page.querySelectorAll("#t-active tbody tr").forEach((r) => (r.hidden = !r.textContent.toLowerCase().includes(q.value.toLowerCase()))));
    page.querySelector("#t-arch").onchange = (e) => (page.querySelector("#t-archived").hidden = !e.target.checked);
    page.querySelectorAll("[data-restore]").forEach((b) => (b.onclick = () => confirmBox({ title: "Restore Campus Events 2025?", impact: ["31 candidates become editable again", "No members: add at least one owner after restoring"], ok: "Restore", okToast: "Team restored (mockup)" })));
  }

  // ---------- Detail tabs ----------
  function tabOverview(ctx, t) {
    const { ui, data } = ctx;
    const m = META[t.id] || {};
    const grants = { "t-ta": [["recruiters", "Recruiter"], ["hiring-managers", "Recruiter · Hiring manager"], ["interviewers", "Viewer · Interviewer"]], "t-es": [["hr-leadership", "Admin"]], "t-gr": [["recruiters", "Recruiter"]] }[t.id] || [];
    return `<div class="grid g4" style="margin-bottom:16px">${ui.kpi("Members", t.members)}${ui.kpi("Candidates", t.candidates)}${ui.kpi("Open vacancies", t.vacancies)}${ui.kpi("Open applications", m.apps || 0)}</div>
      <div class="split"><div class="card"><h2>Details</h2>
        <div class="grid g2">${ui.field("Team name", ui.input(t.name))}${ui.field("Web address", `<input class="input" value="${esc(t.slug)}" dir="ltr">`, `recruitmentos-preview.vercel.app/t/${esc(t.slug)}`)}</div>
        ${ui.field("Description", ui.input(m.desc || ""))}
        <div class="grid g2">${ui.field("Team lead", ui.select(members(data, t).map((x) => x.name), t.lead))}${ui.field("Unit", ui.select(data.units.map((u) => u.name), t.unit), "New vacancies default to this unit")}</div>
        ${ui.field("Time zone", ui.select(["Asia/Dubai (GST, UTC+4)", "Europe/London", "Asia/Kolkata"], "Asia/Dubai (GST, UTC+4)"), "Used for interview times and task due dates")}
        ${ui.check("The team lead can add and remove members", true)}
        <div class="row" style="justify-content:flex-end">${ui.btn("Save", { kind: "primary", attrs: `onclick="Admin.toast('Saved (mockup)')"` })}</div></div>
        <div class="stack"><div class="card"><h2>Groups with a role here</h2>${grants.length ? `<ul class="list-plain small">${grants.map(([g, r]) => `<li class="row" style="justify-content:space-between"><a href="#/groups/${(data.groups.find((x) => x.name === g) || {}).id}">${esc(g)}</a><span>${esc(r)}</span></li>`).join("")}</ul>` : `<p class="muted small">None.</p>`}</div>
          <div class="card small"><b>Groups or teams?</b><p class="muted" style="margin:4px 0 0">Groups control access across the company. Teams organise work and keep records apart. Both can be given roles.</p><p class="muted">Created ${esc(m.created || "")} · ID <code>${t.id}</code></p></div></div></div>`;
  }

  function tabMembers(ctx, t) {
    const { ui, data } = ctx;
    const owner = S.viewAs === "owner";
    const list = members(data, t);
    const rows = list.map((m, i) => [
      `<div class="row" style="flex-wrap:nowrap">${ui.avatar(m.name)}<div>${m.id ? `<a href="#/users/${m.id}">${esc(m.name)}</a>` : esc(m.name)} ${m.status !== "Active" ? ui.badge(m.status, m.status === "Invited" ? "info" : "bad") : ""}<div class="small muted">${esc(m.email)}</div></div></div>`,
      `<select class="input" style="width:auto" data-trole="${i}" aria-label="Team role for ${esc(m.name)}">${TEAM_ROLES.map((r) => `<option ${r === m.role ? "selected" : ""}>${r}</option>`).join("")}</select>`,
      owner ? `<select class="input" style="width:auto" data-crole="${i}" aria-label="Configured role for ${esc(m.name)}">${confOptions(data, m.role).map((r) => `<option ${r === (m.conf || "None") ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>`
        : `<span title="Only company owners can change configured roles">🔒 ${esc(m.conf || "None")}</span>`,
      esc((data.roles.find((r) => r.name === m.conf) || { scope: "All records" }).scope),
      ui.btn("Remove", { kind: "sm danger", attrs: `data-rm="${i}"` }),
    ]);
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><div><h2 style="margin:0">Members</h2><p class="small muted" style="margin:2px 0 0">${list.length} people. The team role sets the most someone can do here; the configured role narrows it.</p></div>
      <div class="row">${viewAsSelect()}${ui.btn("Invite to team", { kind: "primary", ic: "users", attrs: `data-act="invite"` })}</div></div>
      ${owner ? "" : `<div class="callout warn" style="margin-bottom:12px">Configured roles are company-wide, so only company owners can change them. You can still change team roles and remove members.</div>`}
      <div class="toolbar"><input class="input" id="tm-q" type="search" placeholder="Search members" aria-label="Search members"><select class="input" id="tm-role" aria-label="Filter by team role"><option value="">Any team role</option>${TEAM_ROLES.map((r) => `<option>${r}</option>`).join("")}</select></div>
      ${ui.table(["Member", "Team role", "Configured role", "Record scope", ""], rows)}`;
  }

  function tabStorage(ctx, t) {
    const { ui } = ctx;
    const s = Object.assign({}, STORAGE[t.id], S.storage[t.id] || {});
    const pct = s.limitOn ? Math.round((s.usedMb / s.limitMb) * 100) : Math.round((s.usedMb / 5120) * 100);
    const fpct = Math.round((s.files / s.limitFiles) * 100);
    const toggle = (key, label, hint) => `<label class="check" style="display:flex;align-items:flex-start;gap:8px"><input type="checkbox" data-tog="${key}" ${s[key] ? "checked" : ""} style="margin-top:3px"><span><b>${label}</b><br><span class="small muted">${hint}</span></span></label>`;
    return `<div class="grid g2" style="margin-bottom:16px"><div class="card"><div class="kpi-label">Storage used</div><div class="kpi">${s.usedMb} MB</div>
        <div class="small muted" style="margin-bottom:6px">${s.limitOn ? `of ${s.limitMb.toLocaleString("en-GB")} MB team limit` : "of 5 GB company CV storage (no team limit)"} · ${pct}%</div>${ui.bar(pct)}</div>
      <div class="card"><div class="kpi-label">CV files</div><div class="kpi">${s.files}</div><div class="small muted" style="margin-bottom:6px">${s.limitOn ? `of ${s.limitFiles.toLocaleString("en-GB")} files · ${fpct}%` : "no file limit"}</div>${s.limitOn ? ui.bar(fpct) : ""}</div></div>
      ${pct >= 80 ? `<div class="callout warn" style="margin-bottom:12px">This team has used ${pct}% of its CV storage. New uploads are blocked at 100%.</div>` : ""}
      <div class="card stack" data-storage>
        ${toggle("limitOn", "Limit this team's CV storage", "Uploads are refused once the team reaches either limit.")}
        <div class="row" style="padding-inline-start:26px" ${s.limitOn ? "" : "hidden"} data-show="limitOn">${ui.field("Maximum storage (MB)", `<input class="input" type="number" min="1" value="${s.limitMb}" data-num="limitMb" style="width:140px">`)}${ui.field("Maximum number of files", `<input class="input" type="number" min="1" value="${s.limitFiles}" data-num="limitFiles" style="width:140px">`)}</div>
        ${toggle("rateOn", "Limit CV upload requests", "Stops a runaway import or script from flooding storage.")}
        <div class="row" style="padding-inline-start:26px" ${s.rateOn ? "" : "hidden"} data-show="rateOn">${ui.field("Uploads per minute, per person", `<input class="input" type="number" min="1" value="${s.perMin}" data-num="perMin" style="width:140px">`)}</div>
        ${toggle("ai", "Connected AI apps can read CV contents", "When off, connected AI apps see candidate fields but not the text inside CV files.")}
        <div class="callout warn small" data-show="ai" ${s.ai ? "" : "hidden"}>CV text is personal data. Connected AI apps listed under <a href="#/integrations">Integrations</a> will be able to read it for this team.</div>
        <div class="row" style="justify-content:flex-end">${ui.btn("Save CV storage settings", { kind: "primary", attrs: `data-act="savestorage"` })}</div></div>`;
  }

  function tabSpeed(ctx) {
    const { ui } = ctx;
    const rows = SPEED.map(([name, route, p50, p95]) => [`<b>${esc(name)}</b><div class="small muted"><code dir="ltr">${esc(route)}</code></div>`, `${p50} ms`, `${p95} ms`, `<div style="min-width:160px">${ui.bar(Math.min(100, p95 / 20))}</div>`, p95 > 1000 ? ui.badge("Slow", "warn") : p95 > 600 ? ui.badge("Watch", "") : ui.badge("Good", "ok")]);
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><div><h2 style="margin:0">Speed</h2><p class="small muted" style="margin:2px 0 0">How long pages and actions take for this team, last 7 days. p50 is a typical request; p95 is the slowest 1 in 20.</p></div>
      ${ui.select(["Last 24 hours", "Last 7 days", "Last 30 days"], "Last 7 days", 'style="width:auto" aria-label="Period"')}</div>
      ${ui.table(["Page or action", "p50", "p95", "p95 (2 s scale)", ""], rows)}
      <p class="small muted">CV upload is slowest because files are scanned and stored in Vercel Blob. Company-wide figures are on <a href="#/health">Health &amp; monitoring</a>.</p>`;
  }

  function tabBoards(ctx, t) {
    const { ui } = ctx;
    const boards = BOARDS[t.id] || [];
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><div><h2 style="margin:0">Task boards</h2><p class="small muted" style="margin:2px 0 0">Boards hold this team's tasks. Buckets are the columns tasks move through.</p></div>${ui.btn("Create board", { kind: "primary", attrs: `onclick="Admin.toast('Board created (mockup)')"` })}</div>
      ${ui.table(["Board", "Buckets", "Open tasks", ""], boards.map(([n, b, c]) => [`<b>${esc(n)}</b>`, `<div class="row">${b.map((x, i) => `${i ? `<span class="muted" aria-hidden="true">›</span>` : ""}${ui.badge(x, "")}`).join("")}</div>`, c, ui.btn("Edit buckets", { kind: "sm", attrs: `onclick="Admin.toast('Bucket editor (mockup)')"` })]), { empty: "No task boards yet." })}
      <p class="small muted">Company admins with the <b>Boards</b> area can publish board templates that every team can copy.</p>`;
  }

  function tabDanger(ctx, t) {
    const { ui } = ctx;
    const owner = S.viewAs === "owner";
    return `<div class="card" style="border-color:var(--danger)"><h2 style="color:var(--danger)">Archive this team</h2>
      <p>Archived teams become read only. Members lose access, records stay for reporting and can be restored by a company owner.</p>
      <div class="callout warn" style="margin-bottom:12px"><b>Impact</b> · ${t.members} members lose access · ${t.candidates} candidates · ${t.vacancies} open vacancies closed to new applicants · ${(BOARDS[t.id] || []).length} task boards frozen · ${(META[t.id] || {}).apps || 0} open applications paused</div>
      <div class="row">${viewAsSelect()}${ui.btn("Archive team", { kind: "danger", attrs: `data-act="archive" ${owner ? "" : 'disabled title="Only company owners can archive teams"'}` })}</div>
      ${owner ? "" : `<p class="small muted">Only company owners can archive teams.</p>`}</div>`;
  }

  function renderDetail(ctx) {
    const { ui, data } = ctx;
    const t = data.teams.find((x) => x.id === ctx.params[0]);
    const crumbs = `<a href="#/teams">Teams</a> / ${t ? esc(t.name) : "Unknown"}`;
    if (!t) return ui.pageHeader("Team not found", "", "", crumbs) + `<div class="card state">${ui.icon("search")}<p>No team with ID <code>${esc(ctx.params[0])}</code>.</p><a class="btn" href="#/teams">Back to teams</a></div>`;
    const head = ui.pageHeader(t.name, `${esc((META[t.id] || {}).desc || "")} · Lead: ${esc(t.lead)} · Unit: ${esc(t.unit)}`, ui.btn("Open team in the app", { attrs: `onclick="Admin.toast('Opens /t/${esc(t.slug)} (mockup)')"` }), crumbs);
    if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No members yet", emptyText: "Invite at least one owner to this team.", errorText: "We could not load this team." });
    const tabs = [{ id: "overview", label: "Overview" }, { id: "members", label: "Members" }, { id: "storage", label: "CV storage" }, { id: "speed", label: "Speed" }, { id: "boards", label: "Task boards" }, { id: "danger", label: "Danger zone" }];
    const tab = tabs.some((x) => x.id === ctx.query.get("tab")) ? ctx.query.get("tab") : "overview";
    const body = { overview: tabOverview, members: tabMembers, storage: tabStorage, speed: tabSpeed, boards: tabBoards, danger: tabDanger }[tab](ctx, t);
    return `<div data-page="team-detail">${head}${callout}${ui.tabs("team", tabs, tab)}${body}</div>`;
  }

  function mountDetail(root, ctx) {
    const page = root.querySelector("[data-page=team-detail]");
    if (!page) return;
    const { ui, data } = ctx;
    const t = data.teams.find((x) => x.id === ctx.params[0]);
    const list = members(data, t);
    const on = (sel, fn) => page.querySelectorAll(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
    page.querySelectorAll("[data-viewas]").forEach((va) => (va.onchange = () => { S.viewAs = va.value; Admin.rerender(); }));
    // members
    const q = page.querySelector("#tm-q"), rf = page.querySelector("#tm-role");
    if (q) {
      const rows = [...page.querySelectorAll("tbody tr")];
      const apply = () => rows.forEach((r, i) => (r.hidden = !((!q.value || r.textContent.toLowerCase().includes(q.value.toLowerCase())) && (!rf.value || list[i].role === rf.value))));
      q.addEventListener("input", apply); rf.addEventListener("change", apply);
    }
    page.querySelectorAll("[data-trole],[data-crole]").forEach((s) => {
      s.dataset.prev = s.value;
      s.addEventListener("change", () => {
        const isTeam = s.dataset.trole !== undefined, m = list[+(isTeam ? s.dataset.trole : s.dataset.crole)], next = s.value, prev = s.dataset.prev;
        s.value = prev;
        const owners = list.filter((x) => x.role === "Owner");
        if (isTeam && prev === "Owner" && owners.length === 1) {
          return confirmBox({ title: "Cannot change the only owner", intro: `${esc(m.name)} is this team's only owner. Make someone else an owner first.`, ok: "OK", okToast: "" });
        }
        const impact = isTeam
          ? [RANK[next] > RANK[prev] ? `${esc(m.name)} gains ${esc(next)} rights in ${esc(t.name)}` : `${esc(m.name)} loses anything above ${esc(next)} in ${esc(t.name)}`, m.conf && !confOptions(data, next).includes(m.conf) ? `Configured role <b>${esc(m.conf)}</b> no longer fits and is cleared` : "Configured role unchanged", "Takes effect on their next page load"]
          : [next === "None" ? `Full ${esc(m.role)} rights in ${esc(t.name)}` : `Narrowed to <b>${esc(next)}</b> (${esc((data.roles.find((r) => r.name === next) || {}).scope)})`, "Takes effect on their next page load"];
        confirmBox({ title: `Change ${isTeam ? "team role" : "configured role"}?`, intro: `${esc(m.name)}: <b>${esc(prev)}</b> → <b>${esc(next)}</b>`, impact, ok: "Change role", onOk: () => { s.value = next; s.dataset.prev = next; } });
      });
    });
    on("[data-rm]", (b) => {
      const m = list[+b.dataset.rm];
      if (m.role === "Owner" && list.filter((x) => x.role === "Owner").length === 1) return confirmBox({ title: "Cannot remove the only owner", intro: "Make someone else an owner of this team first.", ok: "OK", okToast: "" });
      confirmBox({ title: `Remove ${m.name} from ${t.name}?`, impact: [`Loses access to ${t.candidates} candidates and ${t.vacancies} vacancies in this team`, "Their tasks and interviews stay assigned; reassign them from the team", "Their private notes and shortlists in this team stay private and are kept"], ok: "Remove", danger: true, onOk: () => b.closest("tr").remove(), okToast: "Removed (mockup)" });
    });
    on("[data-act=invite]", () => {
      Admin.modal(`<h2>Invite to ${esc(t.name)}</h2>${ui.field("Email or existing user", `<input class="input" id="ti-e" list="ti-users" placeholder="name@example.test"><datalist id="ti-users">${data.users.map((u) => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join("")}</datalist>`)}
        <div id="ti-err" class="small" style="color:var(--danger);margin:-8px 0 8px" hidden>Enter a valid email address.</div>
        <div class="grid g2">${ui.field("Team role", ui.select(TEAM_ROLES, "Recruiter", 'id="ti-r"'))}${ui.field("Configured role", S.viewAs === "owner" ? `<select class="input" id="ti-c">${confOptions(data, "Recruiter").map((o) => `<option>${esc(o)}</option>`).join("")}</select>` : `<input class="input" value="None" disabled>`, S.viewAs === "owner" ? "Optional. Narrows the team role." : "Only company owners can set this.")}</div>
        <div class="row" style="justify-content:flex-end"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" id="ti-ok">Send invite</button></div>`);
      const r = document.getElementById("ti-r"), c = document.getElementById("ti-c");
      if (c) r.onchange = () => (c.innerHTML = confOptions(data, r.value).map((o) => `<option>${esc(o)}</option>`).join(""));
      document.getElementById("ti-ok").onclick = () => { const v = document.getElementById("ti-e").value.trim(); const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v); document.getElementById("ti-err").hidden = ok; if (ok) { Admin.close(); Admin.toast(`Invite sent to ${v} (mockup)`); } };
    });
    // storage
    const st = page.querySelector("[data-storage]");
    if (st) {
      st.querySelectorAll("[data-tog]").forEach((c) => (c.onchange = () => st.querySelectorAll(`[data-show=${c.dataset.tog}]`).forEach((el) => (el.hidden = !c.checked))));
      on("[data-act=savestorage]", () => {
        const v = {}; st.querySelectorAll("[data-tog]").forEach((c) => (v[c.dataset.tog] = c.checked)); st.querySelectorAll("[data-num]").forEach((n) => (v[n.dataset.num] = Math.max(1, +n.value || 1)));
        const s = STORAGE[t.id];
        const impact = [];
        if (v.limitOn && v.limitMb < s.usedMb) impact.push(`The new limit (${v.limitMb} MB) is below what is already used (${s.usedMb} MB): new uploads are blocked until files are removed`);
        if (v.ai !== s.ai) impact.push(v.ai ? "Connected AI apps will be able to read CV text for this team" : "Connected AI apps lose access to CV text for this team");
        if (v.rateOn !== s.rateOn) impact.push(v.rateOn ? `Uploads limited to ${v.perMin} per minute per person` : "No upload rate limit");
        if (!impact.length) { S.storage[t.id] = v; Admin.toast("Saved (mockup)"); return Admin.rerender(); }
        confirmBox({ title: "Save CV storage settings?", impact, ok: "Save", onOk: () => { S.storage[t.id] = v; Admin.rerender(); } });
      });
    }
    // danger
    on("[data-act=archive]", (b) => {
      if (b.disabled) return;
      const m = confirmBox({ title: `Archive ${t.name}?`, impact: [`${t.members} members lose access`, `${t.candidates} candidates and ${t.vacancies} vacancies become read only`, `${(BOARDS[t.id] || []).length} task boards frozen`, "Can be restored later by a company owner"],
        extra: `${ui.field(`Type the team name to confirm`, `<input class="input" id="ar-n" placeholder="${esc(t.name)}">`)}`, ok: "Archive team", danger: true, onOk: () => Admin.navigate("teams"), okToast: "Team archived (mockup)" });
      const okBtn = m.querySelector("[data-x=ok]"); okBtn.disabled = true;
      m.querySelector("#ar-n").addEventListener("input", (e) => (okBtn.disabled = e.target.value.trim() !== t.name));
    });
  }

  Admin.register({
    id: "teams",
    group: "People & access",
    title: "Teams",
    icon: "team",
    spec: ["IAM-050", "IAM-051", "IAM-052", "IAM-053", "IAM-054", "IAM-070", "IAM-071"],
    changes: "Replaces each team's Team settings / Team & access page: members, configured roles, CV storage limits, speed, task boards and archiving now live in the Admin portal.",
    render(ctx) { return ctx.params[0] ? renderDetail(ctx) : renderList(ctx); },
    mount(root, ctx) { return ctx.params[0] ? mountDetail(root, ctx) : mountList(root, ctx); },
  });
})();
