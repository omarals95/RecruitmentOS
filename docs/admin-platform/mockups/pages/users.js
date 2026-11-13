/* Users: list with filters, bulk actions and invite; user detail with tabs. */
(function () {
  const RANK = { Owner: 4, Admin: 3, Recruiter: 2, Viewer: 1 };
  const TEAM_ROLES = ["Owner", "Admin", "Recruiter", "Viewer"];
  const AREAS = ["Record fields", "Workflows", "Boards", "Organisation", "Templates", "Branding", "Communication", "System"];
  const LEVELS = ["No authority", "Company admin", "Company owner"];
  const PLAN = ["No plan or pay access", "Recruitment plan figures", "Salary brackets (compensation)", "Plan figures and salary brackets"];
  const S = { viewAs: "owner" };

  // Page-local sample data (fictional)
  const AUTH = {
    "u-101": { level: "Company owner", areas: AREAS.slice(), plan: "Plan figures and salary brackets", since: "2 March 2026", by: "Set up the workspace" },
    "u-102": { level: "Company admin", areas: ["Organisation", "Workflows"], plan: "Recruitment plan figures", since: "14 May 2026", by: "Omar Alshair" },
    "u-107": { level: "Company admin", areas: ["Boards", "Templates"], plan: "No plan or pay access", since: "3 January 2026", by: "Omar Alshair", paused: true },
  };
  const SESSIONS = {
    "u-101": [["Windows · Edge", "Dubai, AE", "Now", true], ["iPhone · Safari", "Dubai, AE", "Today 07:58", false], ["macOS · Chrome", "Abu Dhabi, AE", "2 days ago", false]],
    "u-102": [["macOS · Safari", "Dubai, AE", "Today 09:15", false]],
    "u-103": [["Windows · Chrome", "Sharjah, AE", "Yesterday", false], ["Android · Chrome", "Sharjah, AE", "Yesterday", false]],
    "u-104": [["Windows · Edge", "Dubai, AE", "Today 08:02", false]],
    "u-105": [["macOS · Chrome", "Dubai, AE", "3 days ago", false]],
    "u-108": [["iPad · Safari", "Dubai, AE", "Today 11:20", false]],
  };
  const DEVICES = {
    "u-101": [["Office laptop (Edge)", "Added 2 March 2026", "Today"], ["iPhone 15", "Added 9 April 2026", "Today"]],
    "u-102": [["MacBook Air", "Added 14 May 2026", "Today"]],
    "u-104": [["HR desk PC", "Added 1 June 2026", "Today"]],
    "u-107": [["Engineering laptop", "Added 3 January 2026", "21 days ago"]],
  };
  const PAGES_BY_ROLE = {
    Owner: "Dashboard, Candidates, Pipeline, Vacancies, Interviews, Offers, Onboarding, Tasks, Team settings",
    Admin: "Dashboard, Candidates, Pipeline, Vacancies, Interviews, Offers, Onboarding, Tasks, Team settings",
    Recruiter: "Dashboard, Candidates, Pipeline, Vacancies, Interviews, Offers, Tasks",
    Viewer: "Dashboard, Candidates, Pipeline, Vacancies",
  };
  const ACTIONS_BY_ROLE = {
    Owner: "Everything, including members and team settings",
    Admin: "View, Create, Edit, Move stage, Archive, Export, Import, Approve, Comment, Share view; manage members",
    Recruiter: "View, Create, Edit, Move stage, Export, Comment, Share view",
    Viewer: "View, Comment",
  };
  const CONF_NOTES = {
    "Recruiter, no CV upload": "Cannot upload or replace CV files",
    "Hiring manager": "Approve on vacancies and offers in their unit",
    Interviewer: "Only interviews and candidates assigned to them; feedback only",
  };

  const esc = (s) => Admin.ui.esc(s);
  const parseTeam = ([team, r]) => { const [role, conf] = String(r).split(" · "); return { team, role, conf: conf || "" }; };
  const authOf = (u) => AUTH[u.id] || { level: "No authority", areas: [], plan: "No plan or pay access" };
  const statusTone = (s) => (s === "Active" ? "ok" : s === "Invited" ? "info" : "bad");
  const confOptions = (data, role) => ["None"].concat(data.roles.filter((r) => r.kind !== "Built-in" && RANK[r.membership] <= RANK[role]).map((r) => r.name));

  function inheritedGroups(data, u) {
    const out = []; const seen = new Set(u.groups);
    let frontier = u.groups.slice();
    while (frontier.length) {
      const next = [];
      frontier.forEach((g) => data.groups.filter((p) => p.nested.includes(g) && !seen.has(p.name)).forEach((p) => { seen.add(p.name); out.push({ name: p.name, via: g }); next.push(p.name); }));
      frontier = next;
    }
    return out;
  }

  function confirmBox({ title, intro = "", impact = [], warn = "", ok = "Confirm", danger = false, onOk, okToast = "Saved (mockup)" }) {
    Admin.modal(`<h2>${esc(title)}</h2>${intro ? `<p>${intro}</p>` : ""}
      ${impact.length ? `<div class="callout warn" style="margin:8px 0"><b>Impact</b><ul style="margin:4px 0 0;padding-inline-start:18px">${impact.map((i) => `<li>${i}</li>`).join("")}</ul></div>` : ""}
      ${warn ? `<div class="callout bad" style="margin:8px 0">${warn}</div>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-x="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-x="ok">${esc(ok)}</button></div>`);
    const m = document.querySelector(".modal");
    m.querySelector("[data-x=cancel]").onclick = () => Admin.close();
    m.querySelector("[data-x=ok]").onclick = () => { Admin.close(); if (onOk) onOk(); if (okToast) Admin.toast(okToast); };
  }

  // ---------- Invite ----------
  function inviteModal(data) {
    const teamRow = () => `<div class="row inv-team" style="margin-bottom:6px;flex-wrap:nowrap">
      <select class="input" aria-label="Team">${data.teams.map((t) => `<option>${esc(t.name)}</option>`).join("")}</select>
      <select class="input inv-role" aria-label="Team role">${TEAM_ROLES.map((r) => `<option ${r === "Recruiter" ? "selected" : ""}>${r}</option>`).join("")}</select>
      <select class="input inv-conf" aria-label="Configured role">${confOptions(data, "Recruiter").map((o) => `<option>${esc(o)}</option>`).join("")}</select>
      <button class="btn ghost sm" data-x="rm" aria-label="Remove team">✕</button></div>`;
    Admin.modal(`<h2>Invite user</h2><p class="muted small" style="margin-top:0">They get an email link that expires after 72 hours. Everyone must join at least one team.</p>
      ${Admin.ui.field("Email addresses", `<textarea class="input" id="inv-email" rows="2" placeholder="name@example.test, another@example.test"></textarea>`, "Separate several addresses with commas.")}
      <div id="inv-email-err" class="small" style="color:var(--danger);margin:-8px 0 8px" hidden>Enter at least one valid email address.</div>
      <div class="field"><label>Teams, team role and configured role</label><div id="inv-teams">${teamRow()}</div>
        <div><button class="btn sm" data-x="add">+ Add another team</button></div>
        <div class="hint">A configured role narrows the team role (for example Hiring manager = my unit and below). A team role never gives company authority.</div></div>
      <div class="field"><label>Groups</label><div class="row">${data.groups.map((g) => Admin.ui.check(g.name, false, `data-g="${esc(g.name)}"`)).join("")}</div></div>
      ${Admin.ui.field("Personal message (optional)", `<input class="input" placeholder="Welcome to the hiring workspace">`)}
      <div class="row" style="justify-content:flex-end"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="send">Send invite</button></div>`);
    const m = document.querySelector(".modal");
    const wireRow = (row) => {
      row.querySelector("[data-x=rm]").onclick = () => { if (m.querySelectorAll(".inv-team").length > 1) row.remove(); else Admin.toast("Everyone must join at least one team"); };
      const role = row.querySelector(".inv-role"), conf = row.querySelector(".inv-conf");
      role.onchange = () => { conf.innerHTML = confOptions(data, role.value).map((o) => `<option>${esc(o)}</option>`).join(""); };
    };
    m.querySelectorAll(".inv-team").forEach(wireRow);
    m.querySelector("[data-x=add]").onclick = () => { m.querySelector("#inv-teams").insertAdjacentHTML("beforeend", teamRow()); wireRow(m.querySelector("#inv-teams").lastElementChild); };
    m.querySelector("[data-x=cancel]").onclick = () => Admin.close();
    m.querySelector("[data-x=send]").onclick = () => {
      const emails = m.querySelector("#inv-email").value.split(/[,\s]+/).filter(Boolean);
      const okEmails = emails.length && emails.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      m.querySelector("#inv-email-err").hidden = !!okEmails;
      if (!okEmails) return;
      Admin.close(); Admin.toast(`Invite sent to ${emails.length === 1 ? emails[0] : emails.length + " people"} (mockup)`);
    };
  }

  // ---------- List ----------
  function renderList(ctx) {
    const { ui, data } = ctx;
    const head = ui.pageHeader("Users", "Everyone who can sign in to the company workspace, their teams, groups and two-step sign-in.",
      ui.btn("Export CSV", { ic: "log", attrs: `data-act="export"` }) + ui.btn("Invite user", { kind: "primary", ic: "users", attrs: `data-act="invite"` }));
    if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No users yet", emptyText: "Invite your first colleague. They join a team with a team role, and can be added to groups.", emptyAction: ui.btn("Invite user", { kind: "primary", attrs: `onclick="Admin.navigate('users?invite=1')"` }), errorText: "We could not load the user list." });
    const counts = { Active: 0, Invited: 0, Suspended: 0 };
    data.users.forEach((u) => counts[u.status]++);
    const noTwo = data.users.filter((u) => u.status === "Active" && !u.twoStep).length;
    const rows = data.users.map((u) => {
      const teams = u.teams.map(parseTeam);
      const allGroups = u.groups.concat(inheritedGroups(data, u).map((g) => g.name));
      const auth = authOf(u);
      return `<tr data-row data-text="${esc((u.name + " " + u.email + " " + u.title).toLowerCase())}" data-status="${u.status}" data-two="${u.twoStep ? "on" : "off"}" data-teams="|${esc(teams.map((t) => t.team).join("|"))}|" data-groups="|${esc(allGroups.join("|"))}|">
        <td><input type="checkbox" data-sel="${u.id}" aria-label="Select ${esc(u.name)}"></td>
        <td><div class="row" style="flex-wrap:nowrap">${ui.avatar(u.name)}<div><a href="#/users/${u.id}"><b>${esc(u.name)}</b></a><div class="small muted">${esc(u.email)}</div></div></div></td>
        <td>${ui.badge(u.status, statusTone(u.status))}</td>
        <td>${u.twoStep ? ui.badge("On", "ok") : ui.badge("Off", "warn")}</td>
        <td>${teams.length ? teams.map((t) => `<div class="small">${esc(t.team)} · <span class="muted">${esc(t.role)}${t.conf ? " · " + esc(t.conf) : ""}</span></div>`).join("") : `<span class="muted small">No team</span>`}</td>
        <td style="white-space:nowrap">${u.groups.length}${allGroups.length > u.groups.length ? ` <span class="small muted">+${allGroups.length - u.groups.length} inherited</span>` : ""}</td>
        <td>${auth.level === "No authority" ? `<span class="muted small">None</span>` : auth.paused ? ui.badge(auth.level + " (paused)", "") : ui.badge(auth.level, "info")}</td>
        <td class="small" style="white-space:nowrap">${esc(u.lastSeen)}</td>
        <td><a class="btn sm" href="#/users/${u.id}">Open</a></td></tr>`;
    }).join("");
    const opt = (list, label) => `<option value="">${label}</option>` + list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    return `<div data-page="users-list">${head}
      ${noTwo ? `<div class="callout warn" style="margin-bottom:12px">${noTwo} active users have not set up two-step sign-in. <a href="#/users?filter=no-2fa">Show them</a></div>` : ""}
      <div class="grid g4" style="margin-bottom:16px">${ui.kpi("Active", counts.Active, "can sign in")}${ui.kpi("Invited", counts.Invited, "invite expires after 72 hours")}${ui.kpi("Suspended", counts.Suspended, "keep their history, cannot sign in")}${ui.kpi("Two-step off", noTwo, "active users only")}</div>
      <div class="toolbar">
        <input class="input" id="u-q" type="search" placeholder="Search name, email or job title" aria-label="Search users" style="min-width:260px">
        <select class="input" id="u-status" aria-label="Status">${opt(["Active", "Invited", "Suspended"], "Any status")}</select>
        <select class="input" id="u-two" aria-label="Two-step sign-in"><option value="">Two-step: any</option><option value="on">Two-step: on</option><option value="off">Two-step: off</option></select>
        <select class="input" id="u-team" aria-label="Team">${opt(data.teams.map((t) => t.name), "Any team")}</select>
        <select class="input" id="u-group" aria-label="Group">${opt(data.groups.map((g) => g.name), "Any group (incl. nested)")}</select>
        <button class="btn ghost sm" data-act="clear">Clear filters</button>
        <span class="small muted" id="u-count" style="margin-inline-start:auto"></span>
      </div>
      <div class="callout" id="u-bulk" hidden style="margin-bottom:12px"><div class="row"><b id="u-bulk-n"></b>
        ${["Add to group", "Add to team", "Resend invite", "Reset two-step", "Suspend", "Restore", "Export selected"].map((a) => ui.btn(a, { kind: "sm" + (a === "Suspend" ? " danger" : ""), attrs: `data-bulk="${a}"` })).join("")}
        <button class="btn ghost sm" data-act="unselect">Clear selection</button></div></div>
      <div class="table-wrap"><table class="t"><thead><tr><th><input type="checkbox" id="u-all" aria-label="Select all shown"></th><th>Name</th><th>Status</th><th>Two-step</th><th>Teams · team role · configured role</th><th>Groups</th><th>Company authority</th><th>Last active</th><th></th></tr></thead>
      <tbody>${rows}<tr id="u-none" hidden><td colspan="9"><div class="state" style="padding:24px">${ui.icon("search")}<p>No users match these filters.</p><button class="btn sm" data-act="clear">Clear filters</button></div></td></tr></tbody></table></div></div>`;
  }

  function mountList(root, ctx) {
    const page = root.querySelector("[data-page=users-list]");
    if (!page) { root.querySelectorAll("[data-act=invite]").forEach((b) => (b.onclick = () => inviteModal(ctx.data))); return; }
    const data = ctx.data;
    const $ = (s) => page.querySelector(s);
    const rows = [...page.querySelectorAll("tr[data-row]")];
    const sel = new Set();
    const apply = () => {
      const q = $("#u-q").value.trim().toLowerCase(), st = $("#u-status").value, two = $("#u-two").value, tm = $("#u-team").value, gr = $("#u-group").value;
      let n = 0;
      rows.forEach((r) => {
        const show = (!q || r.dataset.text.includes(q)) && (!st || r.dataset.status === st) && (!two || r.dataset.two === two) && (!tm || r.dataset.teams.includes("|" + tm + "|")) && (!gr || r.dataset.groups.includes("|" + gr + "|"));
        r.hidden = !show; if (show) n++;
      });
      $("#u-none").hidden = n > 0;
      $("#u-count").textContent = `Showing ${n} of ${rows.length}`;
    };
    const syncBulk = () => { $("#u-bulk").hidden = !sel.size; $("#u-bulk-n").textContent = `${sel.size} selected`; };
    ["#u-q", "#u-status", "#u-two", "#u-team", "#u-group"].forEach((s) => $(s).addEventListener("input", apply));
    if (ctx.query.get("filter") === "no-2fa") { $("#u-two").value = "off"; $("#u-status").value = "Active"; }
    page.querySelectorAll("[data-act=clear]").forEach((b) => (b.onclick = () => { ["#u-q", "#u-status", "#u-two", "#u-team", "#u-group"].forEach((s) => ($(s).value = "")); apply(); }));
    page.querySelectorAll("[data-sel]").forEach((c) => (c.onchange = () => { c.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); syncBulk(); }));
    $("#u-all").onchange = (e) => { rows.filter((r) => !r.hidden).forEach((r) => { const c = r.querySelector("[data-sel]"); c.checked = e.target.checked; c.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); }); syncBulk(); };
    page.querySelector("[data-act=unselect]").onclick = () => { sel.clear(); page.querySelectorAll("[data-sel]").forEach((c) => (c.checked = false)); $("#u-all").checked = false; syncBulk(); };
    page.querySelector("[data-act=invite]").onclick = () => inviteModal(data);
    page.querySelector("[data-act=export]").onclick = () => Admin.toast("users.csv exported with the current filters (mockup)");
    page.querySelectorAll("[data-bulk]").forEach((b) => (b.onclick = () => {
      const users = data.users.filter((u) => sel.has(u.id));
      const names = users.map((u) => esc(u.name)).join(", ");
      const a = b.dataset.bulk;
      if (a === "Export selected") return Admin.toast(`${users.length} users exported (mockup)`);
      if (a === "Suspend") {
        const owners = users.filter((u) => authOf(u).level === "Company owner");
        const target = users.filter((u) => u.status !== "Suspended" && authOf(u).level !== "Company owner");
        return confirmBox({ title: `Suspend ${target.length} ${target.length === 1 ? "person" : "people"}?`, intro: target.map((u) => esc(u.name)).join(", ") || "Nobody in the selection can be suspended.",
          impact: [`${target.reduce((n, u) => n + u.teams.length, 0)} team memberships stop working`, `${target.filter((u) => authOf(u).level !== "No authority").length} lose company authority until restored`, "Their records, comments and history stay as they are", "They are signed out everywhere"],
          warn: owners.length ? `${owners.map((u) => esc(u.name)).join(", ")} skipped: the last company owner cannot be suspended.` : "", ok: "Suspend", danger: true, okToast: "Suspended (mockup)" });
      }
      if (a === "Add to group" || a === "Add to team") {
        const isGroup = a === "Add to group";
        Admin.modal(`<h2>${a}</h2><p class="muted">${names}</p>
          ${isGroup ? ui.field("Group", ui.select(data.groups.map((g) => g.name), "recruiters")) : ui.field("Team", ui.select(data.teams.map((t) => t.name), data.teams[0].name)) + ui.field("Team role", ui.select(TEAM_ROLES, "Recruiter"), "People already in the team keep their current role.")}
          <div class="callout" style="margin-bottom:12px">${users.length} people · ${isGroup ? "they gain whatever this group grants (roles, approval steps, notifications)" : "they can see this team's records from now on"}</div>
          <div class="row" style="justify-content:flex-end"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" onclick="Admin.close();Admin.toast('Added (mockup)')">Add ${users.length}</button></div>`);
        return;
      }
      const map = {
        "Resend invite": [users.filter((u) => u.status === "Invited"), "Resend invite", "A new 72-hour link is emailed; the old link stops working", "Invites resent (mockup)"],
        "Reset two-step": [users.filter((u) => u.twoStep), "Reset two-step sign-in", "They must set up two-step sign-in again at next sign-in", "Two-step reset (mockup)"],
        Restore: [users.filter((u) => u.status === "Suspended"), "Restore", "They can sign in again. Team memberships and authority are not restored automatically", "Restored (mockup)"],
      }[a];
      confirmBox({ title: `${map[1]} for ${map[0].length} ${map[0].length === 1 ? "person" : "people"}?`, intro: map[0].map((u) => esc(u.name)).join(", ") || "Nobody in the selection applies.", impact: [map[2]], ok: map[1], okToast: map[3] });
    }));
    apply(); syncBulk();
    if (ctx.query.get("invite") === "1") inviteModal(data);
  }

  // ---------- Detail ----------
  function tabProfile(ctx, u) {
    const { ui, data } = ctx;
    return `<div class="split"><div class="card"><h2>Profile</h2>
      <div class="grid g2">${ui.field("Display name", ui.input(u.name))}${ui.field("Email", ui.input(u.email), u.status === "Invited" ? "Not verified yet" : "Verified")}
      ${ui.field("Job title", ui.input(u.title))}${ui.field("Unit", ui.select(data.units.map((x) => x.name), u.unit), "Used by “My unit and below” record scope")}
      ${ui.field("Language", ui.select(["English", "العربية"], "English"))}${ui.field("Time zone", ui.select(["Asia/Dubai (GST, UTC+4)", "Europe/London", "Asia/Kolkata"], "Asia/Dubai (GST, UTC+4)"))}</div>
      <div class="row" style="justify-content:flex-end">${ui.btn("Save profile", { kind: "primary", attrs: `onclick="Admin.toast('Saved (mockup)')"` })}</div></div>
      <div class="card"><h2>Details</h2><ul class="list-plain small">
        <li class="row" style="justify-content:space-between"><span class="muted">User ID</span><code>${u.id}</code></li>
        <li class="row" style="justify-content:space-between"><span class="muted">Account type</span><span>Person</span></li>
        <li class="row" style="justify-content:space-between"><span class="muted">Source</span><span>Local</span></li>
        <li class="row" style="justify-content:space-between"><span class="muted">Last active</span><span>${esc(u.lastSeen)}</span></li>
        <li class="row" style="justify-content:space-between"><span class="muted">Created</span><span>12 February 2026 by Omar Alshair</span></li></ul></div></div>`;
  }

  function tabTeams(ctx, u) {
    const { ui, data } = ctx;
    const teams = u.teams.map(parseTeam);
    const rows = teams.map((t, i) => [
      `<a href="#/teams/${(data.teams.find((x) => x.name === t.team) || {}).id || ""}">${esc(t.team)}</a>`,
      `<select class="input" data-trole="${i}" aria-label="Team role in ${esc(t.team)}" style="width:auto">${TEAM_ROLES.map((r) => `<option ${r === t.role ? "selected" : ""}>${r}</option>`).join("")}</select>`,
      `<select class="input" data-crole="${i}" aria-label="Configured role in ${esc(t.team)}" style="width:auto">${confOptions(data, t.role).map((r) => `<option ${r === (t.conf || "None") ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>`,
      esc((data.roles.find((r) => r.name === t.conf) || { scope: "All records" }).scope),
      ui.btn("Remove", { kind: "sm danger", attrs: `data-rmteam="${i}"` }),
    ]);
    return `<div data-teams-tab><div class="callout" style="margin-bottom:12px">Each team keeps its records apart. The <b>team role</b> sets the most someone can do in that team; a <b>configured role</b> narrows it. A team role never gives company authority.</div>
      <div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Teams &amp; roles</h2>${ui.btn("Add to teams", { kind: "primary", attrs: `data-act="addteams"` })}</div>
      ${ui.table(["Team", "Team role", "Configured role", "Record scope", ""], rows, { empty: "Not in any team. People with no team cannot see any records." })}</div>`;
  }

  function tabGroups(ctx, u) {
    const { ui, data } = ctx;
    const inh = inheritedGroups(data, u);
    const gid = (n) => (data.groups.find((g) => g.name === n) || {}).id;
    const direct = u.groups.map((g) => [`<a href="#/groups/${gid(g)}">${esc(g)}</a>`, ui.badge("Direct", "info"), esc((data.groups.find((x) => x.name === g) || {}).desc || ""), ui.btn("Remove", { kind: "sm", attrs: `data-rmgroup="${esc(g)}"` })]);
    const inherited = inh.map((g) => [`<a href="#/groups/${gid(g.name)}">${esc(g.name)}</a>`, ui.badge("Inherited", ""), `Because <b>${esc(g.via)}</b> is nested in <b>${esc(g.name)}</b>`, `<span class="small muted">Remove from ${esc(g.via)} instead</span>`]);
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Groups</h2>${ui.btn("Add to group", { kind: "primary", attrs: `data-act="addgroup"` })}</div>
      <p class="muted small" style="margin-top:0">Groups control access: roles, approval steps, notification rules and field rules can be given to a group. Membership of a nested group counts as membership of its parent.</p>
      ${ui.table(["Group", "Membership", "Why", ""], direct.concat(inherited), { empty: "Not in any group." })}`;
  }

  function tabAuthority(ctx, u) {
    const { ui, data } = ctx;
    const a = authOf(u);
    const canEdit = S.viewAs === "owner";
    const owners = data.users.filter((x) => authOf(x).level === "Company owner");
    const lastOwner = a.level === "Company owner" && owners.length === 1;
    return `<div data-auth-tab><div class="row" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Company authority</h2>
      <label class="row small">Preview as ${`<select class="input" data-viewas style="width:auto"><option value="owner" ${canEdit ? "selected" : ""}>Company owner (you)</option><option value="admin" ${!canEdit ? "selected" : ""}>Company admin</option></select>`}</label></div>
      ${canEdit ? "" : `<div class="callout warn" style="margin-bottom:12px">Read only. Only company owners can change company authority.</div>`}
      ${a.paused ? `<div class="callout bad" style="margin-bottom:12px">Paused: this person is suspended. Restore their authority from <a href="#/company-authority">Company authority</a> after restoring the account.</div>` : ""}
      <div class="split"><div class="card"><fieldset ${canEdit ? "" : "disabled"} style="border:0;padding:0;margin:0">
        ${ui.field("Level", `<select class="input" data-level>${LEVELS.map((l) => `<option ${l === a.level ? "selected" : ""}>${l}</option>`).join("")}</select>`, "Company owners hold every area. Company admins hold only the areas ticked below.")}
        <div class="field"><label>Areas</label><div class="grid g2" style="gap:6px">${AREAS.map((ar) => ui.check(ar, a.areas.includes(ar), `data-area="${ar}" ${a.level !== "Company admin" ? "disabled" : ""}`)).join("")}</div></div>
        ${ui.field("Plan & pay access", ui.select(PLAN, a.plan, "data-plan"), "Confidential figures: recruitment plan budgets and job-grade salary brackets. Given per person, separate from areas.")}
        ${lastOwner ? `<div class="callout bad small" data-lastowner hidden style="margin-bottom:10px">The last company owner cannot be removed. Make someone else a company owner first.</div>` : ""}
        <div class="row" style="justify-content:flex-end">${ui.btn("Save authority", { kind: "primary", attrs: `data-act="saveauth"` })}</div></fieldset></div>
        <div class="card"><h2>What this opens</h2><p class="small muted" style="margin-top:0">The Admin portal only shows the pages someone holds an area for.</p>
          <ul class="list-plain small">${a.level === "No authority" ? `<li>No Admin portal access. Team roles never give company authority.</li>` : (a.level === "Company owner" ? ["Every Admin portal page", "Company authority (grant and remove)", "Create and archive teams"] : a.areas.map((x) => x + " pages")).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          ${a.since ? `<p class="small muted">Since ${esc(a.since)} · ${esc(a.by)}</p>` : ""}<p><a href="#/company-authority">Open Company authority</a></p></div></div></div>`;
  }

  function tabAccess(ctx, u) {
    const { ui, data } = ctx;
    const a = authOf(u);
    const teams = u.teams.map(parseTeam);
    const rows = teams.map((t) => {
      const conf = data.roles.find((r) => r.name === t.conf);
      return [`<b>${esc(t.team)}</b>`, `${esc(t.role)}${t.conf ? ` → <b>${esc(t.conf)}</b>` : ""}<div class="small muted">Source: direct team membership</div>`, esc(conf ? conf.scope : "All records"), `<span class="small">${esc(PAGES_BY_ROLE[t.role])}</span>`, `<span class="small">${esc(ACTIONS_BY_ROLE[t.role])}${t.conf && CONF_NOTES[t.conf] ? `<br><span class="muted">Narrowed: ${esc(CONF_NOTES[t.conf])}</span>` : ""}</span>`];
    });
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">Effective access</h2>
      <a class="btn primary" href="#/permission-helper?user=${u.id}">${ui.icon("help", 'width="14" height="14"')}Check a specific action in the permission helper</a></div>
      ${u.status === "Suspended" ? `<div class="callout bad" style="margin-bottom:12px">Suspended: nothing below applies until the account is restored.</div>` : ""}
      <div class="grid g3" style="margin-bottom:12px">${ui.kpi("Teams", teams.length)}${ui.kpi("Groups", u.groups.length + inheritedGroups(data, u).length, "direct and inherited")}${ui.kpi("Company authority", `<span style="font-size:18px">${esc(a.level)}</span>`, a.level === "Company admin" ? esc(a.areas.join(", ")) : "")}</div>
      ${ui.table(["Team", "Role (source)", "Record scope", "Pages", "Actions"], rows, { empty: "No team access. This person cannot see any records." })}
      <p class="small muted">Private notes, shortlists and private saved views stay private to their owner. No role can grant them.</p>`;
  }

  function tabSecurity(ctx, u) {
    const { ui } = ctx;
    const sessions = SESSIONS[u.id] || [];
    const devices = DEVICES[u.id] || [];
    return `<div class="grid g2" style="margin-bottom:16px"><div class="card"><h2>Two-step sign-in</h2>
        <p>${u.twoStep ? ui.badge("On", "ok") + " Authenticator app · 8 recovery codes left" : ui.badge("Not set up", "warn") + " Required for company admins and owners."}</p>
        <div class="row">${u.twoStep ? ui.btn("Reset two-step", { kind: "danger", attrs: `data-act="reset2"` }) : ui.btn("Send set-up reminder", { attrs: `onclick="Admin.toast('Reminder emailed (mockup)')"` })}</div></div>
      <div class="card"><h2>Sign-in</h2><p class="small muted" style="margin-top:0">Signs in with email and password through the company workspace.</p>
        <div class="row">${ui.btn("Send password reset link", { attrs: `onclick="Admin.toast('Reset link emailed, valid for 1 hour (mockup)')"` })}${ui.btn("Sign out everywhere", { kind: "danger", attrs: `data-act="signoutall"` })}</div></div></div>
      <h2>Active sessions</h2>
      ${ui.table(["Device", "Location", "Last active", ""], sessions.map((s, i) => [esc(s[0]) + (s[3] ? " " + ui.badge("This session", "info") : ""), esc(s[1]), esc(s[2]), s[3] ? "" : ui.btn("Sign out", { kind: "sm", attrs: `data-signout="${i}"` })]), { empty: "No active sessions." })}
      <h2 style="margin-top:16px">Trusted devices</h2><p class="small muted" style="margin-top:0">Trusted devices skip the two-step prompt for 30 days.</p>
      ${ui.table(["Device", "Added", "Last used", ""], devices.map((d, i) => [esc(d[0]), esc(d[1]), esc(d[2]), ui.btn("Remove", { kind: "sm", attrs: `data-rmdev="${i}"` })]), { empty: "No trusted devices." })}`;
  }

  function tabActivity(ctx, u) {
    const items = u.status === "Invited"
      ? [["9 November 2026 14:05", "Omar Alshair", "Invited to Graduate Hiring as Viewer"], ["9 November 2026 14:05", "System", "Invite email delivered"]]
      : [["Today 10:12", esc(u.name), "Signed in (two-step " + (u.twoStep ? "passed" : "not set up") + ")"], ["Yesterday 16:40", "Omar Alshair", "Added to group <b>" + esc(u.groups[0] || "recruiters") + "</b>"], ["3 November 2026", "Mariam Al Suwaidi", "Changed team role in <b>" + esc((u.teams[0] || ["Talent Acquisition"])[0]) + "</b>"], ["12 February 2026", "Omar Alshair", "Account created"]];
    return `<h2>Activity</h2>${ctx.ui.table(["When", "Who", "What"], items)}<p class="small"><a href="#/audit?user=${u.id}">Open in audit log</a></p>`;
  }

  function renderDetail(ctx) {
    const { ui, data } = ctx;
    const u = data.users.find((x) => x.id === ctx.params[0]);
    const crumbs = `<a href="#/users">Users</a> / ${u ? esc(u.name) : "Unknown"}`;
    if (!u) return ui.pageHeader("User not found", "", "", crumbs) + `<div class="card state">${ui.icon("search")}<p>No user with ID <code>${esc(ctx.params[0])}</code>.</p><a class="btn" href="#/users">Back to users</a></div>`;
    const actions = (u.status === "Invited" ? ui.btn("Resend invite", { attrs: `data-act="resend"` }) + ui.btn("Cancel invite", { kind: "danger", attrs: `data-act="cancelinv"` })
      : u.status === "Suspended" ? ui.btn("Restore", { kind: "primary", attrs: `data-act="restore"` }) : ui.btn("Suspend", { kind: "danger", attrs: `data-act="suspend"` })) + ui.btn("Erase personal data", { kind: "ghost", attrs: `data-act="erase"` });
    const head = ui.pageHeader(u.name, `${esc(u.title)} · ${esc(u.email)} · ${ui.badge(u.status, statusTone(u.status))} ${u.twoStep ? ui.badge("Two-step on", "ok") : ui.badge("Two-step off", "warn")}`, actions, crumbs);
    if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No details yet", emptyText: "This person has not signed in yet.", errorText: "We could not load this user." });
    const tabs = [{ id: "profile", label: "Profile" }, { id: "teams", label: "Teams & roles" }, { id: "groups", label: "Groups" }, { id: "authority", label: "Company authority" }, { id: "access", label: "Effective access" }, { id: "security", label: "Security" }, { id: "activity", label: "Activity" }];
    const tab = tabs.some((t) => t.id === ctx.query.get("tab")) ? ctx.query.get("tab") : "profile";
    const body = { profile: tabProfile, teams: tabTeams, groups: tabGroups, authority: tabAuthority, access: tabAccess, security: tabSecurity, activity: tabActivity }[tab](ctx, u);
    return `<div data-page="user-detail">${head}${ui.tabs("user", tabs, tab)}${body}</div>`;
  }

  function mountDetail(root, ctx) {
    const page = root.querySelector("[data-page=user-detail]");
    if (!page) return;
    const { data, ui } = ctx;
    const u = data.users.find((x) => x.id === ctx.params[0]);
    const on = (sel, fn) => page.querySelectorAll(sel).forEach((el) => el.addEventListener("click", (e) => fn(el, e)));
    const teams = u.teams.map(parseTeam);
    on("[data-act=suspend]", () => {
      const a = authOf(u);
      const last = a.level === "Company owner" && data.users.filter((x) => authOf(x).level === "Company owner").length === 1;
      confirmBox({ title: `Suspend ${u.name}?`, impact: [`Loses access to ${teams.length} ${teams.length === 1 ? "team" : "teams"}: ${teams.map((t) => esc(t.team)).join(", ") || "none"}`, `${u.groups.length} group memberships kept but grant nothing`, a.level !== "No authority" ? `Company authority (${esc(a.level)}) paused until restored` : "No company authority", "Signed out on every device; records and history stay"],
        warn: last ? "The last company owner cannot be suspended. Make someone else a company owner first." : "", ok: last ? "Cannot suspend" : "Suspend", danger: true, okToast: last ? "" : "Suspended (mockup)" });
      if (last) document.querySelector(".modal [data-x=ok]").disabled = true;
    });
    on("[data-act=restore]", () => confirmBox({ title: `Restore ${u.name}?`, impact: ["Can sign in again", "Team memberships must be added again", "Company authority can be restored on the Company authority page"], ok: "Restore", okToast: "Restored (mockup)" }));
    on("[data-act=resend]", () => Admin.toast("Invite resent, new link valid for 72 hours (mockup)"));
    on("[data-act=cancelinv]", () => confirmBox({ title: "Cancel this invite?", impact: ["The invite link stops working", "No history to keep: the account is removed"], ok: "Cancel invite", danger: true, okToast: "Invite cancelled (mockup)" }));
    on("[data-act=erase]", () => confirmBox({ title: `Erase personal data for ${u.name}?`, intro: "Under the UAE data protection law a person can ask to be erased. Their name becomes “Former user 7f3a” everywhere; records they created stay.", impact: [`${teams.length} team memberships removed`, "37 comments and 112 history entries anonymised", "An erasure report is added to the audit log"], ok: "Erase personal data", danger: true, okToast: "Erasure queued (mockup)" }));
    // Teams & roles: change with confirm
    page.querySelectorAll("[data-trole],[data-crole]").forEach((s) => {
      s.dataset.prev = s.value;
      s.addEventListener("change", () => {
        const i = +(s.dataset.trole ?? s.dataset.crole), t = teams[i], next = s.value, prev = s.dataset.prev, isTeam = s.dataset.trole !== undefined;
        s.value = prev;
        const impact = isTeam
          ? [RANK[next] > RANK[prev] ? `Gains: ${esc(ACTIONS_BY_ROLE[next])}` : `Loses: anything above ${esc(next)} (${esc(ACTIONS_BY_ROLE[next])} remain)`, t.conf && !confOptions(data, next).includes(t.conf) ? `Configured role <b>${esc(t.conf)}</b> no longer fits and is cleared` : "Configured role stays", "Takes effect on their next page load"]
          : [next === "None" ? `Full ${esc(t.role)} access in ${esc(t.team)}` : `Narrowed to <b>${esc(next)}</b>: ${esc((data.roles.find((r) => r.name === next) || {}).scope || "")}`, "Takes effect on their next page load"];
        confirmBox({ title: `Change ${isTeam ? "team role" : "configured role"} in ${t.team}?`, intro: `${esc(u.name)}: <b>${esc(prev)}</b> → <b>${esc(next)}</b>`, impact, ok: "Change role", onOk: () => { s.value = next; s.dataset.prev = next; } });
      });
    });
    on("[data-rmteam]", (b) => { const t = teams[+b.dataset.rmteam]; confirmBox({ title: `Remove ${u.name} from ${t.team}?`, impact: [`Loses access to every ${esc(t.team)} record`, "Assigned tasks and interviews stay assigned; reassign them from the team", teams.length === 1 ? "This is their only team: they will not see any records" : `Keeps ${teams.length - 1} other team${teams.length > 2 ? "s" : ""}`], ok: "Remove", danger: true, onOk: () => b.closest("tr").remove(), okToast: "Removed (mockup)" }); });
    on("[data-act=addteams]", () => Admin.modal(`<h2>Add ${esc(u.name)} to teams</h2><p class="muted small" style="margin-top:0">Pick each team and the team role they get there.</p>
      ${data.teams.map((t) => { const has = teams.find((x) => x.team === t.name); return `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">${ui.check(t.name, !!has, has ? "disabled" : "")}<select class="input" style="width:auto" ${has ? "disabled" : ""}>${TEAM_ROLES.map((r) => `<option ${r === (has ? has.role : "Viewer") ? "selected" : ""}>${r}</option>`).join("")}</select></div>`; }).join("")}
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" onclick="Admin.close();Admin.toast('Added to teams (mockup)')">Add</button></div>`));
    on("[data-rmgroup]", (b) => { const g = b.dataset.rmgroup; confirmBox({ title: `Remove ${u.name} from ${g}?`, impact: [`Loses whatever ${esc(g)} grants`, ...data.groups.filter((p) => p.nested.includes(g)).map((p) => `Also stops inheriting <b>${esc(p.name)}</b>`)], ok: "Remove", danger: true, onOk: () => b.closest("tr").remove(), okToast: "Removed (mockup)" }); });
    on("[data-act=addgroup]", () => Admin.modal(`<h2>Add ${esc(u.name)} to a group</h2>${ui.field("Group", ui.select(data.groups.filter((g) => !u.groups.includes(g.name)).map((g) => g.name), ""))}<div class="row" style="justify-content:flex-end"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" onclick="Admin.close();Admin.toast('Added to group (mockup)')">Add</button></div>`));
    // Authority
    const va = page.querySelector("[data-viewas]");
    if (va) va.onchange = () => { S.viewAs = va.value; Admin.rerender(); };
    const lvl = page.querySelector("[data-level]");
    if (lvl) {
      const sync = () => {
        page.querySelectorAll("[data-area]").forEach((c) => { c.disabled = lvl.value !== "Company admin"; if (lvl.value === "Company owner") c.checked = true; if (lvl.value === "No authority") c.checked = false; });
        const lo = page.querySelector("[data-lastowner]"); if (lo) lo.hidden = lvl.value === "Company owner";
      };
      lvl.onchange = sync;
      on("[data-act=saveauth]", () => {
        const lo = page.querySelector("[data-lastowner]");
        if (lo && !lo.hidden) return Admin.toast("The last company owner cannot be removed");
        const areas = [...page.querySelectorAll("[data-area]:checked")].map((c) => c.dataset.area);
        confirmBox({ title: `Change company authority for ${u.name}?`, intro: `${esc(authOf(u).level)} → <b>${esc(lvl.value)}</b>`, impact: [lvl.value === "Company admin" ? `Areas: ${esc(areas.join(", ") || "none")}` : lvl.value === "Company owner" ? "Every Admin portal page" : "No Admin portal access", `Plan access: ${esc(page.querySelector("[data-plan]").value)}`, "Recorded in the audit log and shown under recent access changes"], ok: "Save authority" });
      });
    }
    // Security
    on("[data-act=reset2]", () => confirmBox({ title: `Reset two-step sign-in for ${u.name}?`, impact: ["Their authenticator app and recovery codes stop working", "Trusted devices are removed", "They must set up two-step sign-in again at next sign-in"], ok: "Reset two-step", danger: true, okToast: "Two-step reset (mockup)" }));
    on("[data-act=signoutall]", () => confirmBox({ title: `Sign ${u.name} out everywhere?`, impact: [`${(SESSIONS[u.id] || []).length} active sessions end`, "Unsaved work in open tabs may be lost"], ok: "Sign out everywhere", danger: true, okToast: "Signed out everywhere (mockup)" }));
    on("[data-signout]", (b) => { b.closest("tr").remove(); Admin.toast("Session signed out (mockup)"); });
    on("[data-rmdev]", (b) => { b.closest("tr").remove(); Admin.toast("Trusted device removed; two-step will be asked next time (mockup)"); });
  }

  Admin.register({
    id: "users",
    group: "People & access",
    title: "Users",
    icon: "users",
    spec: ["IAM-001", "IAM-002", "IAM-003", "IAM-004", "IAM-005", "IAM-006", "IAM-034", "IAM-035", "IAM-041", "IAM-071", "IAM-072", "PRM-060"],
    changes: "New in the Admin portal: one list of everyone across teams with filters, bulk actions and a user page showing teams, groups, company authority, effective access and security.",
    render(ctx) { return ctx.params[0] ? renderDetail(ctx) : renderList(ctx); },
    mount(root, ctx) { return ctx.params[0] ? mountDetail(root, ctx) : mountList(root, ctx); },
  });
})();
