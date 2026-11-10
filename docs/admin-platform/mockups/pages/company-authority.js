/* Company authority: who runs the Admin portal (company owners and admins with areas, plus plan and pay access). */
(function () {
  const esc = (s) => Admin.ui.esc(s);
  const AREAS = ["Record fields", "Workflows", "Boards", "Organisation", "Templates", "Branding", "Communication", "System"];
  const AREA_PAGES = {
    "Record fields": "Custom fields, Screens", Workflows: "Workflows, approval groups", Boards: "Task board templates", Organisation: "Organisation, Users, Groups, Teams (members)",
    Templates: "Record and email templates", Branding: "Look & feel, Domain", Communication: "Notifications, Outgoing mail", System: "Health & monitoring, Integrations, Audit log",
  };
  const LEVELS = ["No authority", "Company admin", "Company owner"];
  const PLAN = ["No plan or pay access", "Recruitment plan figures", "Salary brackets (compensation)", "Plan figures and salary brackets"];
  const S = { viewAs: "owner" };

  // Page-local sample data (fictional), keyed to shared users
  const HOLDERS = [
    { uid: "u-101", level: "Company owner", areas: AREAS.slice(), plan: "Plan figures and salary brackets", since: "2 March 2026", by: "Workspace set-up" },
    { uid: "u-102", level: "Company admin", areas: ["Organisation", "Workflows"], plan: "Recruitment plan figures", since: "14 May 2026", by: "Omar Alshair" },
  ];
  const SUSPENDED = [{ uid: "u-107", level: "Company admin", areas: ["Boards", "Templates"], plan: "No plan or pay access", when: "21 days ago", why: "Left every team, so authority was paused" }];
  const CHANGES = [
    ["Today 09:40", "Omar Alshair", "Mariam Al Suwaidi", "Added area <b>Workflows</b>"],
    ["Yesterday 17:05", "Omar Alshair", "Mariam Al Suwaidi", "Plan &amp; pay access: none → <b>Recruitment plan figures</b>"],
    ["6 November 2026", "Omar Alshair", "Rahul Menon", "Removed <b>Company admin</b> (Boards)"],
    ["5 November 2026", "System", "Daniel Okafor", "Authority paused: left every team"],
  ];

  function confirmBox({ title, intro = "", impact = [], warn = "", ok = "Confirm", danger = false, onOk, okToast = "Saved (mockup)" }) {
    Admin.modal(`<h2>${esc(title)}</h2>${intro ? `<p>${intro}</p>` : ""}
      ${impact.length ? `<div class="callout warn" style="margin:8px 0"><b>Impact</b><ul style="margin:4px 0 0;padding-inline-start:18px">${impact.map((i) => `<li>${i}</li>`).join("")}</ul></div>` : ""}
      ${warn ? `<div class="callout bad" style="margin:8px 0">${warn}</div>` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-x="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-x="ok">${esc(ok)}</button></div>`);
    const m = document.querySelector(".modal");
    m.querySelector("[data-x=cancel]").onclick = () => Admin.close();
    m.querySelector("[data-x=ok]").onclick = () => { Admin.close(); if (onOk) onOk(); if (okToast) Admin.toast(okToast); };
    return m;
  }

  function grantModal(data, uid) {
    const ui = Admin.ui;
    const holder = HOLDERS.find((h) => h.uid === uid);
    const people = data.users.filter((u) => u.status === "Active");
    const owners = HOLDERS.filter((h) => h.level === "Company owner");
    const cur = holder || { level: "Company admin", areas: [], plan: "No plan or pay access" };
    Admin.modal(`<h2>${holder ? "Change company authority" : "Grant company authority"}</h2>
      <p class="small muted" style="margin-top:0">Company authority runs the Admin portal. It is separate from team roles: a team role never gives company authority, and company authority does not add anyone to a team.</p>
      ${ui.field("Person", `<select class="input" id="ca-p" ${holder ? "disabled" : ""}>${people.map((u) => `<option value="${u.id}" ${u.id === uid ? "selected" : ""}>${esc(u.name)} · ${esc(u.email)}</option>`).join("")}</select>`)}
      <div class="field"><label>Level</label><div class="stack" style="margin-top:2px">${LEVELS.map((l) => `<label class="check" style="display:flex"><input type="radio" name="ca-l" value="${l}" ${l === cur.level ? "checked" : ""}> <b>${l}</b> <span class="small muted">${l === "Company owner" ? "· every area, grants authority, creates and archives teams" : l === "Company admin" ? "· only the areas ticked below" : "· no Admin portal access"}</span></label>`).join("")}</div></div>
      <div class="field"><label>Areas</label><div class="grid g2" style="gap:6px" id="ca-areas">${AREAS.map((a) => `<label class="check" title="${esc(AREA_PAGES[a])}"><input type="checkbox" value="${a}" ${cur.areas.includes(a) ? "checked" : ""}> ${a}</label>`).join("")}</div>
        <div class="hint" id="ca-area-hint"></div></div>
      ${ui.field("Plan & pay access", ui.select(PLAN, cur.plan, 'id="ca-plan"'), "Confidential figures: recruitment plan budgets and job-grade salary brackets. Given per person, separate from areas.")}
      <div class="callout warn small" id="ca-2fa" hidden></div>
      <div class="callout bad small" id="ca-last" hidden>The last company owner cannot be removed. Make someone else a company owner first.</div>
      <div class="callout small" id="ca-sum" style="margin-top:8px"></div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" onclick="Admin.close()">Cancel</button><button class="btn primary" id="ca-ok">${holder ? "Save changes" : "Grant authority"}</button></div>`);
    const $ = (s) => document.querySelector(".modal " + s);
    const sync = () => {
      const lvl = $("input[name=ca-l]:checked").value, p = data.users.find((u) => u.id === $("#ca-p").value);
      $("#ca-areas").querySelectorAll("input").forEach((c) => { c.disabled = lvl !== "Company admin"; if (lvl === "Company owner") c.checked = true; if (lvl === "No authority") c.checked = false; });
      const areas = [...$("#ca-areas").querySelectorAll("input:checked")].map((c) => c.value);
      $("#ca-area-hint").textContent = lvl === "Company admin" ? (areas.length ? "Opens: " + areas.map((a) => AREA_PAGES[a]).join(" · ") : "Tick at least one area.") : lvl === "Company owner" ? "Company owners hold every area." : "";
      const last = holder && holder.level === "Company owner" && lvl !== "Company owner" && owners.length === 1;
      $("#ca-last").hidden = !last;
      $("#ca-2fa").hidden = !(p && !p.twoStep && lvl !== "No authority");
      $("#ca-2fa").textContent = p ? `${p.name} has not set up two-step sign-in. Company authority needs it: they will be asked to set it up before opening the Admin portal.` : "";
      $("#ca-sum").innerHTML = `<b>Summary:</b> ${esc(p ? p.name : "")} → ${esc(lvl)}${lvl === "Company admin" ? ` (${esc(areas.join(", ") || "no areas")})` : ""} · ${esc($("#ca-plan").value)} · recorded in the audit log`;
      $("#ca-ok").disabled = last || (lvl === "Company admin" && !areas.length);
    };
    document.querySelectorAll(".modal input, .modal select").forEach((el) => el.addEventListener("change", sync));
    $("#ca-ok").onclick = () => { Admin.close(); Admin.toast((holder ? "Authority changed" : "Authority granted") + " (mockup)"); };
    sync();
  }

  function render(ctx) {
    const { ui, data } = ctx;
    const owner = S.viewAs === "owner";
    const user = (id) => data.users.find((u) => u.id === id);
    const viewAs = `<label class="row small">Preview as <select class="input" data-viewas style="width:auto"><option value="owner" ${owner ? "selected" : ""}>Company owner (you)</option><option value="admin" ${owner ? "" : "selected"}>Company admin</option></select></label>`;
    const head = ui.pageHeader("Company authority", "Company owners and company admins run the Admin portal. A team role never gives company authority.",
      viewAs + ui.btn("Grant authority", { kind: "primary", ic: "shield", attrs: `data-act="grant" ${owner ? "" : 'disabled title="Only company owners can grant authority"'}` }));
    if (ctx.state !== "normal") return `<div data-page="authority">${head}${ui.stateBlock(ctx.state, { emptyTitle: "No company admins yet", emptyText: "You are the only company owner. Grant company admin to share the work, area by area.", emptyAction: ui.btn("Grant authority", { kind: "primary", attrs: `data-act="grant"` }), errorText: "We could not load company authority." })}</div>`;
    const owners = HOLDERS.filter((h) => h.level === "Company owner");
    const rows = HOLDERS.map((h) => {
      const u = user(h.uid);
      const last = h.level === "Company owner" && owners.length === 1;
      return [
        `<div class="row" style="flex-wrap:nowrap">${ui.avatar(u.name)}<div><a href="#/users/${u.id}?tab=authority"><b>${esc(u.name)}</b></a><div class="small muted">${esc(u.title)}</div></div></div>`,
        ui.badge(h.level, h.level === "Company owner" ? "info" : ""),
        h.level === "Company owner" ? `<span class="small">Every area</span>` : `<div class="row">${h.areas.map((a) => ui.badge(a, "")).join("")}</div>`,
        `<span class="small">${esc(h.plan)}</span>`,
        u.twoStep ? ui.badge("On", "ok") : ui.badge("Off", "warn"),
        `<span class="small">${esc(h.since)}<br><span class="muted">${esc(h.by)}</span></span>`,
        `<div class="row" style="flex-wrap:nowrap">${ui.btn("Change", { kind: "sm", attrs: `data-change="${h.uid}" ${owner ? "" : "disabled"}` })}${ui.btn("Remove", { kind: "sm danger", attrs: `data-remove="${h.uid}" ${owner && !last ? "" : "disabled"} title="${last ? "The last company owner cannot be removed" : owner ? "" : "Only company owners can remove authority"}"` })}</div>`,
      ];
    });
    const susp = SUSPENDED.map((s) => { const u = user(s.uid); return [`<div class="row" style="flex-wrap:nowrap">${ui.avatar(u.name)}<div><a href="#/users/${u.id}">${esc(u.name)}</a><div class="small muted">${ui.badge(u.status, "bad")}</div></div></div>`, `${esc(s.level)}<div class="small muted">${esc(s.areas.join(", "))}</div>`, `<span class="small">${esc(s.why)}<br><span class="muted">${esc(s.when)}</span></span>`, ui.btn("Restore authority", { kind: "sm", attrs: `data-restore="${s.uid}" ${owner ? "" : "disabled"}` })]; });
    return `<div data-page="authority">${head}
      ${owner ? "" : `<div class="callout warn" style="margin-bottom:12px">Read only. Only company owners can grant, change or remove company authority.</div>`}
      <div class="grid g4" style="margin-bottom:16px">${ui.kpi("Company owners", owners.length, "at least one is always required")}${ui.kpi("Company admins", HOLDERS.length - owners.length)}${ui.kpi("Paused", SUSPENDED.length, "suspended people")}${ui.kpi("Changes, last 7 days", CHANGES.length)}</div>
      <div class="callout" style="margin-bottom:12px">${ui.icon("shield", 'width="14" height="14" style="vertical-align:-2px"')} <b>Rule:</b> The last company owner cannot be removed. Make someone else a company owner first.</div>
      <h2>Company owners and admins</h2>
      ${ui.table(["Person", "Level", "Areas", "Plan & pay access", "Two-step", "Since", ""], rows)}
      <div class="split" style="margin-top:16px"><div class="stack">
        <div class="card"><h2>Suspended people</h2><p class="small muted" style="margin-top:0">Authority is paused, not deleted, when someone is suspended or leaves every team.</p>
          ${ui.table(["Person", "Had", "Why", ""], susp, { empty: "Nobody's authority is paused." })}</div>
        <div class="card"><h2>Recent access changes <span class="small muted">· last 7 days</span></h2>
          ${ui.table(["When", "By", "Person", "Change"], CHANGES.map((c) => [`<span style="white-space:nowrap">${esc(c[0])}</span>`, esc(c[1]), esc(c[2]), c[3]]))}
          <p class="small" style="margin:8px 0 0"><a href="#/audit?filter=authority">Open in audit log</a></p></div></div>
        <div class="card"><h2>What each area opens</h2><p class="small muted" style="margin-top:0">The Admin portal only shows pages for the areas someone holds.</p>
          <ul class="list-plain small">${AREAS.map((a) => `<li><b>${a}</b><div class="muted">${esc(AREA_PAGES[a])}</div></li>`).join("")}
          <li><b>Company owners only</b><div class="muted">Company authority, create and archive teams, configured roles on members</div></li></ul></div></div></div>`;
  }

  function mount(root, ctx) {
    const page = root.querySelector("[data-page=authority]");
    if (!page) return;
    const { data } = ctx;
    const va = page.querySelector("[data-viewas]"); if (va) va.onchange = () => { S.viewAs = va.value; Admin.rerender(); };
    page.querySelectorAll("[data-act=grant]").forEach((b) => (b.onclick = () => grantModal(data)));
    page.querySelectorAll("[data-change]").forEach((b) => (b.onclick = () => grantModal(data, b.dataset.change)));
    page.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => {
      const h = HOLDERS.find((x) => x.uid === b.dataset.remove), u = data.users.find((x) => x.id === h.uid);
      confirmBox({ title: `Remove company authority from ${u.name}?`, intro: `${esc(h.level)}${h.level === "Company admin" ? ` (${esc(h.areas.join(", "))})` : ""} → <b>No authority</b>`,
        impact: [`Loses Admin portal pages: ${esc(h.areas.map((a) => AREA_PAGES[a]).join(" · "))}`, `Plan & pay access: ${esc(h.plan)} → none`, `Team roles unchanged: ${esc(u.teams.map((t) => t[0] + " (" + t[1] + ")").join(", ") || "none")}`, "Their open Admin portal sessions end at their next click"],
        ok: "Remove authority", danger: true, okToast: "Authority removed (mockup)" });
    }));
    page.querySelectorAll("[data-restore]").forEach((b) => (b.onclick = () => {
      const s = SUSPENDED.find((x) => x.uid === b.dataset.restore), u = data.users.find((x) => x.id === s.uid);
      confirmBox({ title: `Restore authority for ${u.name}?`, intro: `Restores <b>${esc(s.level)}</b> (${esc(s.areas.join(", "))}).`,
        impact: ["Opens: " + esc(s.areas.map((a) => AREA_PAGES[a]).join(" · ")), u.status === "Suspended" ? "The account is suspended: it is restored too, so they can sign in again" : "Account already active", u.teams.length ? "" : "They are in no team, so they will not see any records until added to one"].filter(Boolean),
        ok: "Restore authority", okToast: "Authority restored (mockup)" });
    }));
  }

  Admin.register({
    id: "company-authority",
    group: "People & access",
    title: "Company authority",
    icon: "shield",
    spec: ["PRM-010", "PRM-011", "PRM-013", "PRM-063", "IAM-034"],
    changes: "Company owners and admins in one Admin portal page: grant, change and remove authority area by area, plan and pay access, paused authority for suspended people and a last-owner safeguard.",
    render,
    mount,
  });
})();
