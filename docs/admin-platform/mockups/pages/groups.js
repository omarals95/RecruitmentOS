/* Groups: list, detail with nested members tree, approval-group settings, where used, delete with impact. */
(function () {
  const esc = (s) => Admin.ui.esc(s);
  const SYSTEM = ["system-administrators"];
  // Page-local sample data (fictional)
  const WHERE = {
    "system-administrators": { roles: [], approvals: [], notifications: [["Admin alerts", "Health check failed, mail delivery failing"]], fields: [], other: ["Company authority: holders get Company owner rights in the Admin portal"] },
    "hr-leadership": { roles: [["Admin", "Executive Search", "Team role granted to the group"]], approvals: [["Standard hiring", "Vacancy approval", "Any one member"]], notifications: [["Weekly hiring digest", "Every Monday 08:00"]], fields: [["Offer salary", "Can edit · all teams"]] },
    recruiters: { roles: [["Recruiter", "Talent Acquisition", "Team role granted to the group"], ["Recruiter", "Graduate Hiring", "Team role granted to the group"]], approvals: [], notifications: [["New application received", "Instant email + in-app"]], fields: [["Salary expectation", "Can edit · Talent Acquisition, Graduate Hiring"]] },
    "hiring-managers": { roles: [["Hiring manager", "Talent Acquisition", "Configured role · My unit and below"]], approvals: [], notifications: [["Interview feedback due", "Daily 09:00"]], fields: [] },
    interviewers: { roles: [["Interviewer", "Talent Acquisition", "Configured role · Assigned to me"]], approvals: [], notifications: [["Interview scheduled", "Instant email + calendar invite"]], fields: [["Interview scorecard", "Can edit · assigned interviews"]] },
    "offer-approvers": { roles: [], approvals: [["Standard hiring", "Offer approval (above AED 40,000 / month)", "All members"], ["Engineering hiring", "Offer approval", "Any one member"]], notifications: [["Offer awaiting approval", "Instant email + in-app"]], fields: [["Offer salary", "Read only · during approval"]] },
  };
  const APPROVAL = {
    "offer-approvers": { rule: "all", n: 2, delegate: true, noSelf: true, fallback: "hr-leadership", open: 3, avg: "6 h", workflows: 2 },
  };
  const S = { approvalOn: {} };

  function directUsers(data, g) { return data.users.filter((u) => u.groups.includes(g.name)); }
  function effective(data, g, seen = new Set()) {
    if (seen.has(g.name)) return [];
    seen.add(g.name);
    const out = directUsers(data, g).map((u) => ({ u, via: "" }));
    g.nested.forEach((n) => { const ng = data.groups.find((x) => x.name === n); if (ng) effective(data, ng, seen).forEach((m) => out.push({ u: m.u, via: m.via || n })); });
    const uniq = new Map(); out.forEach((m) => { if (!uniq.has(m.u.id) || !m.via) uniq.set(m.u.id, m); });
    return [...uniq.values()];
  }
  function ancestors(data, name, acc = new Set()) {
    data.groups.filter((p) => p.nested.includes(name)).forEach((p) => { if (!acc.has(p.name)) { acc.add(p.name); ancestors(data, p.name, acc); } });
    return acc;
  }
  const usedCount = (g) => { const w = WHERE[g.name] || {}; return (w.roles || []).length + (w.approvals || []).length + (w.notifications || []).length + (w.fields || []).length; };
  const isApproval = (g) => (g.name in S.approvalOn ? S.approvalOn[g.name] : !!g.approval);

  function confirmBox({ title, intro = "", impact = [], extra = "", ok = "Confirm", danger = false, onOk, okToast = "Saved (mockup)" }) {
    Admin.modal(`<h2>${esc(title)}</h2>${intro ? `<p>${intro}</p>` : ""}
      ${impact.length ? `<div class="callout warn" style="margin:8px 0"><b>Impact</b><ul style="margin:4px 0 0;padding-inline-start:18px">${impact.map((i) => `<li>${i}</li>`).join("")}</ul></div>` : ""}${extra}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-x="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-x="ok">${esc(ok)}</button></div>`);
    const m = document.querySelector(".modal");
    m.querySelector("[data-x=cancel]").onclick = () => Admin.close();
    m.querySelector("[data-x=ok]").onclick = () => { Admin.close(); if (onOk) onOk(); if (okToast) Admin.toast(okToast); };
    return m;
  }

  function createModal(data) {
    const ui = Admin.ui;
    Admin.modal(`<h2>Create group</h2>
      ${ui.field("Name", `<input class="input" id="g-name" placeholder="e.g. finance-approvers">`, "Lower case with hyphens. Names must be unique; renaming later is safe because everything refers to the group, not its name.")}
      <div id="g-name-err" class="small" style="color:var(--danger);margin:-8px 0 8px" hidden></div>
      ${ui.field("Description", ui.input("", 'placeholder="Who is in it and what it is for"'))}
      <div class="field"><label>Include other groups (nested)</label><div class="row">${data.groups.map((g) => ui.check(g.name)).join("")}</div><div class="hint">Members of a nested group count as members of this group.</div></div>
      ${ui.check("Use as an approval group (shows in workflow approval steps)", false)}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" id="g-create">Create group</button></div>`);
    document.getElementById("g-create").onclick = () => {
      const v = document.getElementById("g-name").value.trim(), err = document.getElementById("g-name-err");
      const msg = !v ? "Enter a name." : data.groups.some((g) => g.name.toLowerCase() === v.toLowerCase()) ? "A group with this name already exists." : "";
      err.textContent = msg; err.hidden = !msg;
      if (!msg) { Admin.close(); Admin.toast(`Group ${v} created (mockup)`); }
    };
  }

  // ---------- List ----------
  function renderList(ctx) {
    const { ui, data } = ctx;
    const head = ui.pageHeader("Groups", "Groups control access. Give roles, approval steps, notification rules and field rules to a group instead of to each person. Groups can contain other groups.",
      ui.btn("Export CSV", { ic: "log", attrs: `onclick="Admin.toast('groups.csv exported (mockup)')"` }) + ui.btn("Create group", { kind: "primary", ic: "group", attrs: `data-act="create"` }));
    if (ctx.state !== "normal") return `<div data-page="groups-list">${head}${ui.stateBlock(ctx.state, { emptyTitle: "No groups yet", emptyText: "Create a group such as <b>recruiters</b> or <b>offer-approvers</b>, then grant roles or approval steps to it.", emptyAction: ui.btn("Create group", { kind: "primary", attrs: `data-act="create"` }), errorText: "We could not load groups." })}</div>`;
    const rows = data.groups.map((g) => {
      const d = directUsers(data, g).length, eff = effective(data, g).length, used = usedCount(g);
      return `<tr data-row data-text="${esc((g.name + " " + g.desc).toLowerCase())}" data-appr="${isApproval(g) ? 1 : 0}">
        <td><a href="#/groups/${g.id}"><b>${esc(g.name)}</b></a> ${SYSTEM.includes(g.name) ? ui.badge("System", "") : ""}</td>
        <td>${esc(g.desc)}</td>
        <td style="white-space:nowrap"><b>${eff}</b> <span class="small muted">${d} direct${g.nested.length ? ` · via ${g.nested.map(esc).join(", ")}` : ""}</span></td>
        <td>${isApproval(g) ? ui.badge("Approval group", "info") : `<span class="muted small">No</span>`}</td>
        <td>${ui.badge(g.source || "Local", "")}</td>
        <td>${used ? `<a href="#/groups/${g.id}?tab=where">${used} ${used === 1 ? "place" : "places"}</a>` : `<span class="muted small">Not used</span>`}</td>
        <td class="small" style="white-space:nowrap">${g.id === "g-off" ? "Yesterday · Mariam Al Suwaidi" : "2 Nov 2026 · Omar Alshair"}</td></tr>`;
    }).join("");
    return `<div data-page="groups-list">${head}
      <div class="callout" style="margin-bottom:12px"><b>Groups or teams?</b> Groups control <i>access</i> across the company. Teams organise <i>work</i> and keep their records apart. Both can be given roles.</div>
      <div class="toolbar"><input class="input" id="g-q" type="search" placeholder="Search groups" aria-label="Search groups">
        ${ui.check("Approval groups only", false, 'id="g-appr"')}<span class="small muted" id="g-count" style="margin-inline-start:auto"></span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Description</th><th>Members (incl. nested)</th><th>Approval group</th><th>Source</th><th>Used by</th><th>Last modified</th></tr></thead>
      <tbody>${rows}<tr id="g-none" hidden><td colspan="7"><div class="state" style="padding:24px">${ui.icon("search")}<p>No groups match.</p></div></td></tr></tbody></table></div></div>`;
  }
  function mountList(root, ctx) {
    const page = root.querySelector("[data-page=groups-list]");
    if (!page) return;
    page.querySelectorAll("[data-act=create]").forEach((b) => (b.onclick = () => createModal(ctx.data)));
    const q = page.querySelector("#g-q"); if (!q) return;
    const appr = page.querySelector("#g-appr"), rows = [...page.querySelectorAll("tr[data-row]")];
    const apply = () => { let n = 0; rows.forEach((r) => { const s = (!q.value || r.dataset.text.includes(q.value.toLowerCase())) && (!appr.checked || r.dataset.appr === "1"); r.hidden = !s; if (s) n++; }); page.querySelector("#g-none").hidden = n > 0; page.querySelector("#g-count").textContent = `Showing ${n} of ${rows.length}`; };
    q.addEventListener("input", apply); appr.addEventListener("change", apply);
    if (ctx.query.get("filter") === "approval") appr.checked = true;
    apply();
  }

  // ---------- Detail ----------
  function memberTree(data, g, depth = 0, via = "") {
    const ui = Admin.ui;
    const users = directUsers(data, g).map((u) => `<li class="gm-row">${ui.avatar(u.name)}<a href="#/users/${u.id}">${esc(u.name)}</a><span class="small muted">${esc(u.email)}</span>
        <span class="gm-end">${depth === 0 ? ui.badge("Direct", "info") + ui.btn("Remove", { kind: "sm", attrs: `data-rmuser="${u.id}"` }) : ui.badge("Inherited via " + via, "")}</span></li>`).join("");
    const nested = g.nested.map((n) => {
      const ng = data.groups.find((x) => x.name === n); if (!ng) return "";
      return `<li><details open class="gm-node"><summary class="gm-row">${ui.icon("group", 'width="16" height="16"')}<a href="#/groups/${ng.id}"><b>${esc(ng.name)}</b></a><span class="small muted">${effective(data, ng).length} members · nested group</span>
          <span class="gm-end">${depth === 0 ? ui.badge("Direct", "info") + ui.btn("Remove", { kind: "sm", attrs: `data-rmgroup="${esc(n)}"` }) : ui.badge("Inherited via " + via, "")}</span></summary>
          <ul class="gm-tree">${memberTree(data, ng, depth + 1, via || n)}</ul></details></li>`;
    }).join("");
    return users + nested || (depth ? `<li class="small muted gm-row">No members</li>` : "");
  }

  function tabMembers(ctx, g) {
    const { ui, data } = ctx;
    const eff = effective(data, g), direct = directUsers(data, g);
    return `<style>
      .gm-tree{list-style:none;margin:0;padding-inline-start:0}
      .gm-tree .gm-tree{padding-inline-start:22px;border-inline-start:2px solid var(--border);margin-inline-start:8px}
      .gm-row{display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border);flex-wrap:wrap}
      .gm-end{margin-inline-start:auto;display:flex;gap:6px;align-items:center}
      .gm-node>summary{cursor:pointer;list-style-position:inside}
    </style>
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><div><h2 style="margin:0">Members</h2><p class="small muted" style="margin:2px 0 0">${direct.length} direct people · ${g.nested.length} nested ${g.nested.length === 1 ? "group" : "groups"} · <b>${eff.length}</b> people in total</p></div>
      <div class="row">${ui.btn("Add people or group", { kind: "primary", attrs: `data-act="add"` })}${ui.btn("Paste a list", { attrs: `data-act="paste"` })}</div></div>
    <div class="card"><ul class="gm-tree">${memberTree(data, g) || `<li class="muted">No members yet. Add people, or nest another group.</li>`}</ul></div>
    <p class="small muted">Inherited members come from nested groups. To remove one, remove them from the nested group or remove the nested group.</p>`;
  }

  function tabMemberOf(ctx, g) {
    const { ui, data } = ctx;
    const parents = data.groups.filter((p) => p.nested.includes(g.name));
    return `<h2>Member of</h2><p class="small muted" style="margin-top:0">Everyone in ${esc(g.name)} also counts as a member of these groups.</p>` +
      ui.table(["Group", "Description"], parents.map((p) => [`<a href="#/groups/${p.id}">${esc(p.name)}</a>`, esc(p.desc)]), { empty: "Not nested in any other group." });
  }

  function tabApproval(ctx, g) {
    const { ui, data } = ctx;
    const on = isApproval(g);
    const a = APPROVAL[g.name] || { rule: "any", n: 1, delegate: false, noSelf: true, fallback: "None", open: 0, avg: "–", workflows: 0 };
    const m = effective(data, g).length;
    const w = WHERE[g.name] || { approvals: [] };
    const radio = (v, label, extra = "") => `<label class="check" style="display:flex;margin-bottom:6px"><input type="radio" name="ap-rule" value="${v}" ${a.rule === v ? "checked" : ""}> ${label}${extra}</label>`;
    return `<div data-appr-tab><div class="card" style="margin-bottom:16px"><label class="check"><input type="checkbox" data-appron ${on ? "checked" : ""}> <b>Use as an approval group</b></label>
      <p class="small muted" style="margin:4px 0 0">Only approval groups appear when picking approvers in a workflow approval step. This stops large access groups being used by mistake.</p></div>
      <fieldset data-apfs ${on ? "" : "disabled"} style="border:0;padding:0;margin:0;${on ? "" : "opacity:.55"}">
      ${on ? `<div class="grid g3" style="margin-bottom:16px">${ui.kpi("Open approvals", a.open)}${ui.kpi("Average decision time", a.avg)}${ui.kpi("Workflows using it", w.approvals.length)}</div>` : ""}
      <div class="split"><div class="card"><h2>Default decision rule</h2><p class="small muted" style="margin-top:0">Used by approval steps unless a step sets its own rule.</p>
        ${radio("any", "Any one member approves")}${radio("all", `All members approve <span class="small muted">(${m} people today)</span>`)}
        ${radio("count", "A number of members approve:", ` <input class="input" type="number" min="1" max="${m}" value="${a.n}" data-n style="width:70px;margin-inline-start:6px"> <span class="small muted">of ${m}</span>`)}
        <div id="ap-n-err" class="small" style="color:var(--danger)" hidden>Must be between 1 and ${m}.</div>
        <hr style="border:0;border-top:1px solid var(--border);margin:12px 0">
        ${ui.check("Approvers can hand a decision to another member", a.delegate)}<br>
        ${ui.check("The person who asked cannot approve their own request", a.noSelf)}
        ${ui.field("When an approver is out of office, ask", ui.select(["None"].concat(data.groups.filter((x) => x.name !== g.name).map((x) => x.name)), a.fallback), "")}
        <div class="row" style="justify-content:flex-end">${ui.btn("Save settings", { kind: "primary", attrs: `data-act="saveap"` })}</div></div>
      <div class="card"><h2>Used by approval steps</h2>${w.approvals.length ? `<ul class="list-plain">${w.approvals.map((x) => `<li><a href="#/workflows">${esc(x[0])}</a> · ${esc(x[1])}<div class="small muted">Step rule: ${esc(x[2])}</div></li>`).join("")}</ul>` : `<p class="muted small">No approval step uses this group yet.</p>`}</div></div></fieldset></div>`;
  }

  function tabWhere(ctx, g) {
    const { ui } = ctx;
    const w = WHERE[g.name] || { roles: [], approvals: [], notifications: [], fields: [] };
    const sec = (title, cols, rows, link) => `<div class="card" style="margin-bottom:12px"><div class="row" style="justify-content:space-between"><h2>${title} <span class="badge">${rows.length}</span></h2>${link ? `<a class="small" href="#/${link}">Open</a>` : ""}</div>${rows.length ? ui.table(cols, rows) : `<p class="muted small" style="margin:0">Not used here.</p>`}</div>`;
    return `<p class="muted small" style="margin-top:0">Everything that refers to <b>${esc(g.name)}</b>. Check this before deleting or changing members.</p>
      ${sec("Role grants", ["Role", "Team", "How"], w.roles.map((r) => r.map(esc)), "roles")}
      ${sec("Workflow approval steps", ["Workflow", "Step", "Rule"], w.approvals.map((r) => r.map(esc)), "workflows")}
      ${sec("Notification rules", ["Rule", "When"], w.notifications.map((r) => r.map(esc)), "notifications")}
      ${sec("Field context", ["Field", "Rule"], w.fields.map((r) => r.map(esc)), "fields")}
      ${(w.other || []).map((o) => `<div class="callout">${esc(o)}</div>`).join("")}`;
  }

  function tabAudit(ctx, g) {
    return ctx.ui.table(["When", "Who", "Change"], [
      ["Yesterday 15:20", "Mariam Al Suwaidi", `Changed default decision rule of <b>${esc(g.name)}</b>`],
      ["2 November 2026", "Omar Alshair", "Added Khalid Al Mansoori"],
      ["12 February 2026", "Omar Alshair", "Created group"],
    ]) + `<p class="small"><a href="#/audit?group=${g.id}">Open in audit log</a></p>`;
  }

  function renderDetail(ctx) {
    const { ui, data } = ctx;
    const g = data.groups.find((x) => x.id === ctx.params[0]);
    const crumbs = `<a href="#/groups">Groups</a> / ${g ? esc(g.name) : "Unknown"}`;
    if (!g) return ui.pageHeader("Group not found", "", "", crumbs) + `<div class="card state">${ui.icon("search")}<p>No group with ID <code>${esc(ctx.params[0])}</code>.</p><a class="btn" href="#/groups">Back to groups</a></div>`;
    const sys = SYSTEM.includes(g.name);
    const actions = ui.btn("Rename", { attrs: `data-act="rename"` }) + ui.btn("Delete group", { kind: "danger", attrs: `data-act="delete" ${sys ? 'disabled title="System groups can be renamed but not deleted"' : ""}` });
    const head = ui.pageHeader(g.name, `${esc(g.desc)} · ${ui.badge(g.source || "Local", "")} ${isApproval(g) ? ui.badge("Approval group", "info") : ""} ${sys ? ui.badge("System group", "warn") : ""}`, actions, crumbs);
    if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No members yet", emptyText: "Add people, or nest another group inside this one.", errorText: "We could not load this group." });
    const tabs = [{ id: "members", label: "Members" }, { id: "memberof", label: "Member of" }, { id: "approval", label: "Approval settings" }, { id: "where", label: "Where used" }, { id: "audit", label: "Audit" }];
    const tab = tabs.some((t) => t.id === ctx.query.get("tab")) ? ctx.query.get("tab") : "members";
    const body = { members: tabMembers, memberof: tabMemberOf, approval: tabApproval, where: tabWhere, audit: tabAudit }[tab](ctx, g);
    return `<div data-page="group-detail">${head}${sys ? `<div class="callout warn" style="margin-bottom:12px">System group: it can be renamed but not deleted.</div>` : ""}${ui.tabs("group", tabs, tab)}${body}</div>`;
  }

  function mountDetail(root, ctx) {
    const page = root.querySelector("[data-page=group-detail]");
    if (!page) return;
    const { ui, data } = ctx;
    const g = data.groups.find((x) => x.id === ctx.params[0]);
    const on = (sel, fn) => page.querySelectorAll(sel).forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); fn(el); }));
    const w = WHERE[g.name] || { roles: [], approvals: [], notifications: [], fields: [] };
    on("[data-act=rename]", () => { Admin.modal(`<h2>Rename group</h2>${ui.field("Name", ui.input(g.name, 'id="g-rn"'), `Safe: roles, approval steps and rules refer to the group itself, so ${usedCount(g)} uses update automatically.`)}<div class="row" style="justify-content:flex-end"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" onclick="Admin.close();Admin.toast('Renamed (mockup)')">Rename</button></div>`); });
    on("[data-act=delete]", (b) => {
      if (b.disabled) return;
      const eff = effective(data, g).length;
      const repl = ["Remove the grant"].concat(data.groups.filter((x) => x.name !== g.name).map((x) => "Replace with " + x.name));
      const lines = [].concat(w.roles.map((r) => `Role grant: ${r[0]} in ${r[1]}`), w.approvals.map((r) => `Approval step: ${r[0]} · ${r[1]}`), w.notifications.map((r) => `Notification rule: ${r[0]}`), w.fields.map((r) => `Field context: ${r[0]}`));
      const m = confirmBox({ title: `Delete ${g.name}?`,
        impact: [`Used by ${w.roles.length} role grants · ${w.approvals.length} approval steps · ${w.notifications.length} notification rules · ${w.fields.length} field contexts`, `${eff} people may lose access they get only through this group`, ...data.groups.filter((p) => p.nested.includes(g.name)).map((p) => `Removed from parent group <b>${esc(p.name)}</b>`), "People stay; only the group is deleted"],
        extra: lines.length ? `<div class="field" style="margin-top:10px"><label>Choose what happens to each use</label>${lines.map((l) => `<div class="row" style="justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)"><span class="small">${esc(l)}</span><select class="input" style="width:auto">${repl.map((r) => `<option>${esc(r)}</option>`).join("")}</select></div>`).join("")}</div>` : "",
        ok: "Delete group", danger: true, onOk: () => Admin.navigate("groups"), okToast: "Group deleted (mockup)" });
      if (w.approvals.length) m.querySelector(".callout").insertAdjacentHTML("afterend", `<div class="callout bad small" style="margin-bottom:8px">Approval steps need an approver. Pick a replacement approval group or the steps will be blocked.</div>`);
    });
    on("[data-rmuser]", (b) => { const u = data.users.find((x) => x.id === b.dataset.rmuser); confirmBox({ title: `Remove ${u.name} from ${g.name}?`, impact: [`Loses what ${esc(g.name)} grants (${usedCount(g)} uses)`, ...data.groups.filter((p) => ancestors(data, g.name).has(p.name)).map((p) => `Also stops inheriting <b>${esc(p.name)}</b>`)], ok: "Remove", danger: true, onOk: () => b.closest("li").remove(), okToast: "Removed (mockup)" }); });
    on("[data-rmgroup]", (b) => { const ng = data.groups.find((x) => x.name === b.dataset.rmgroup); confirmBox({ title: `Remove nested group ${ng.name}?`, impact: [`${effective(data, ng).length} people stop inheriting ${esc(g.name)}`, `${esc(ng.name)} itself is not changed`], ok: "Remove", danger: true, onOk: () => b.closest("li").remove(), okToast: "Removed (mockup)" }); });
    on("[data-act=add]", () => {
      const anc = ancestors(data, g.name);
      const options = data.groups.filter((x) => x.name !== g.name && !g.nested.includes(x.name));
      Admin.modal(`<h2>Add to ${esc(g.name)}</h2>
        ${ui.field("Add", `<select class="input" id="ga-type"><option value="person">A person</option><option value="group">A group (nested)</option></select>`)}
        <div id="ga-person">${ui.field("Person", `<select class="input">${data.users.filter((u) => !u.groups.includes(g.name)).map((u) => `<option>${esc(u.name)} · ${esc(u.email)}</option>`).join("")}</select>`)}</div>
        <div id="ga-group" hidden>${ui.field("Group", `<select class="input" id="ga-g">${options.map((x) => `<option value="${esc(x.name)}">${esc(x.name)} (${effective(data, x).length} people)</option>`).join("")}</select>`, "Members of the nested group count as members here.")}
          <div id="ga-loop" class="callout bad small" hidden></div></div>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" id="ga-ok">Add</button></div>`);
      const t = document.getElementById("ga-type"), sg = document.getElementById("ga-g"), loop = document.getElementById("ga-loop"), ok = document.getElementById("ga-ok");
      const check = () => { const bad = t.value === "group" && anc.has(sg.value); loop.hidden = !bad; loop.textContent = bad ? `Would make a loop: ${sg.value} already contains ${g.name}.` : ""; ok.disabled = bad; };
      t.onchange = () => { document.getElementById("ga-person").hidden = t.value !== "person"; document.getElementById("ga-group").hidden = t.value !== "group"; check(); };
      sg.onchange = check;
      ok.onclick = () => { Admin.close(); Admin.toast("Added (mockup)"); };
    });
    on("[data-act=paste]", () => Admin.modal(`<h2>Add people from a list</h2>${ui.field("Emails", `<textarea class="input" rows="5" placeholder="one email per line"></textarea>`, "We check every address first and show who was not found.")}<div class="row" style="justify-content:flex-end"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" onclick="Admin.close();Admin.toast('Checked: 0 to add (mockup)')">Check and add</button></div>`));
    // Approval settings
    const ap = page.querySelector("[data-appron]");
    if (ap) {
      ap.onchange = () => {
        const next = ap.checked; ap.checked = !next;
        if (!next && w.approvals.length) {
          confirmBox({ title: `Stop using ${g.name} as an approval group?`, impact: w.approvals.map((x) => `Approval step <b>${esc(x[0])} · ${esc(x[1])}</b> loses its approvers`), ok: "Stop using", danger: true, onOk: () => { S.approvalOn[g.name] = false; Admin.rerender(); } });
        } else { S.approvalOn[g.name] = next; Admin.rerender(); Admin.toast(next ? "Now available in approval steps (mockup)" : "No longer an approval group (mockup)"); }
      };
      const n = page.querySelector("[data-n]");
      on("[data-act=saveap]", () => {
        const max = +n.max, v = +n.value, isCount = page.querySelector("input[name=ap-rule]:checked").value === "count";
        const bad = isCount && (v < 1 || v > max);
        page.querySelector("#ap-n-err").hidden = !bad;
        if (!bad) Admin.toast("Approval settings saved (mockup)");
      });
    }
  }

  Admin.register({
    id: "groups",
    group: "People & access",
    title: "Groups",
    icon: "group",
    spec: ["IAM-040", "IAM-041", "IAM-042", "IAM-043", "IAM-045", "IAM-054", "IAM-060", "IAM-061", "IAM-062"],
    changes: "New. Today access is given person by person; groups (with nesting and approval groups) let you grant roles, approval steps and rules once.",
    render(ctx) { return ctx.params[0] ? renderDetail(ctx) : renderList(ctx); },
    mount(root, ctx) { return ctx.params[0] ? mountDetail(root, ctx) : mountList(root, ctx); },
  });
})();
