/* Audit log: every admin change with filters, before/after diff drawer and CSV export. Spec 09 §8. */
(function () {
  const AREAS = ["Roles", "Users", "Groups", "Fields", "Screens", "Workflows", "Branding", "Domain", "Mail", "Notifications", "Teams", "Organisation"];
  const ACTIONS = ["Created", "Changed", "Deleted", "Published", "Added", "Removed", "Revoked", "Exported"];
  const OMAR = ["94.200.18.41", "Chrome 130 · Windows 11"], MARIAM = ["86.98.40.112", "Safari 18 · macOS"], RAHUL = ["185.93.4.17", "Edge 130 · Windows 11"], SYS = ["—", "RecruitmentOS (scheduled job)"];
  const E = (id, at, who, area, action, summary, net, diff, extra = {}) => ({ id, at, who, area, action, summary, ip: net[0], device: net[1], diff, outcome: "Success", req: "req_" + (0x5a3f00 + id * 7919).toString(16), ...extra });
  const ENTRIES = [
    E(31, "2026-11-10T11:02", "Omar Alshair", "Mail", "Changed", "Changed reply-to address for outgoing mail", OMAR, [" Sender name: RecruitmentOS · Al Noor Holding", " Sender address: no-reply@recruitmentos.ae", "-Reply-to: (none)", "+Reply-to: talent@example.test"]),
    E(30, "2026-11-10T10:31", "Omar Alshair", "Roles", "Published", "Published role “Recruiter, no CV upload” (version 2)", OMAR, [" Role: Recruiter, no CV upload", " Membership ceiling: Recruiter", "-Version: 1", "+Version: 2", " Candidates: View, Create, Edit, Move stage", "-CV file: View, Upload", "+CV file: View", "-Export: allowed", "+Export: not allowed", " Record scope: All records"], { impact: "1 person in Talent Acquisition" }),
    E(29, "2026-11-10T10:12", "Omar Alshair", "Notifications", "Changed", "Turned off email for “Application moved stage”", OMAR, [" Event: Application moved stage", " In-app: on", "-Email: on", "+Email: off", " Daily digest: on"]),
    E(28, "2026-11-10T09:58", "Mariam Al Suwaidi", "Organisation", "Created", "Added unit “Platform Engineering” under Engineering", MARIAM, ["+Unit: Platform Engineering", "+Level: Department", "+Parent: Engineering", "+Head: (vacant)"]),
    E(27, "2026-11-10T09:20", "Mariam Al Suwaidi", "Workflows", "Changed", "Saved a draft of workflow “Engineering hiring”: added stage Technical test", MARIAM, [" Applied → Screening → Interview", "+Interview → Technical test", "+Technical test → Assessment", "-Interview → Assessment", " Assessment → Offer → Hired"]),
    E(26, "2026-11-10T08:47", "Omar Alshair", "Groups", "Added", "Added Khalid Al Mansoori to offer-approvers", OMAR, [" Group: offer-approvers (approval group)", " Members: Mariam Al Suwaidi", "+Members: Khalid Al Mansoori"]),
    E(25, "2026-11-10T03:00", "System", "Users", "Revoked", "API token “Calendar bridge” of Khalid Al Mansoori expired and was switched off", SYS, [" Token: Calendar bridge (tk-24)", "-Status: Active", "+Status: Expired", " Expired on: 8 Nov 2026"]),
    E(24, "2026-11-09T16:40", "Omar Alshair", "Branding", "Changed", "Changed brand colour to #4338CA", OMAR, ["-Accent colour: #2563EB", "+Accent colour: #4338CA", "-Focus ring: #60A5FA", "+Focus ring: #8277EE", " Logo: alnoor-logo.svg (unchanged)"]),
    E(23, "2026-11-09T15:12", "Rahul Menon", "Teams", "Changed", "Changed the CV storage limit of Graduate Hiring to 2 GB", RAHUL, [" Team: Graduate Hiring", "-CV storage limit: 1 GB", "+CV storage limit: 2 GB"]),
    E(22, "2026-11-09T11:30", "Omar Alshair", "Fields", "Created", "Added field “Notice period” to Candidate", OMAR, ["+Field: Notice period", "+Type: Number (days)", "+Applies to: Candidate", "+Teams: all teams", "+Screens: none yet"]),
    E(21, "2026-11-09T11:05", "Omar Alshair", "Screens", "Changed", "Moved “Salary expectation” to the Offer tab on the Candidate screen", OMAR, [" Screen: Candidate details", "-Tab Profile: Name, Email, Phone, Salary expectation, Source", "+Tab Profile: Name, Email, Phone, Source", "-Tab Offer: Offer salary, Start date", "+Tab Offer: Salary expectation, Offer salary, Start date"]),
    E(20, "2026-11-08T14:20", "Mariam Al Suwaidi", "Workflows", "Published", "Published workflow “Executive search” (version 3)", MARIAM, ["-Version: 2", "+Version: 3", "+Rule: Offer above AED 40,000 a month needs offer-approvers", " Used by: Executive Search"], { impact: "Executive Search · 12 open applications moved to the new version" }),
    E(19, "2026-11-08T10:05", "Omar Alshair", "Domain", "Changed", "Started changing the app address to app.recruitmentos.ae (waiting for DNS)", OMAR, [" Current: recruitmentos-preview.vercel.app", "+New: app.recruitmentos.ae", "+Status: waiting for DNS records", "+Sign-in callback: https://app.recruitmentos.ae/api/auth/callback/google"]),
    E(18, "2026-11-07T17:30", "Omar Alshair", "Notifications", "Published", "Published email template “Offer needs approval” (v3)", OMAR, [" Template: Offer needs approval", "-Subject: Offer approval needed", "+Subject: Approve offer for {{candidate.name}}?", "+Body: Salary: {{offer.salary}}", "+Body: Start date: {{offer.startDate}}"]),
    E(17, "2026-11-07T09:12", "Omar Alshair", "Users", "Created", "Invited Aisha Rahman to Graduate Hiring as Viewer", OMAR, ["+User: Aisha Rahman (aisha.rahman@example.test)", "+Team: Graduate Hiring", "+Team role: Viewer", "+Status: Invited"]),
    E(16, "2026-11-06T13:00", "Omar Alshair", "Mail", "Changed", "Connected Resend and set recruitmentos.ae as the sending domain", OMAR, ["-Provider: (environment variable)", "+Provider: Resend", "+API key: •••••••• (hidden)", "+Sending domain: recruitmentos.ae"]),
    E(15, "2026-11-05T12:44", "Omar Alshair", "Roles", "Changed", "Changed record scope of “Hiring manager” to My unit and below", OMAR, [" Role: Hiring manager", "-Record scope: Assigned to me", "+Record scope: My unit and below"], { impact: "1 person · Khalid Al Mansoori now sees 2 more vacancies" }),
    E(14, "2026-11-04T16:10", "Mariam Al Suwaidi", "Roles", "Changed", "Tried to remove Export from built-in role Owner (blocked)", MARIAM, [" Role: Owner (built-in, locked)", "-Export: allowed", "+Export: not allowed"], { outcome: "Blocked: built-in Owner role cannot be changed" }),
    E(13, "2026-11-03T10:20", "Omar Alshair", "Users", "Exported", "Exported the users list (8 rows, CSV)", OMAR, ["+Export: users.csv", "+Rows: 8", "+Columns: name, email, status, teams, two-step sign-in"]),
    E(12, "2026-10-20T15:45", "Omar Alshair", "Users", "Changed", "Suspended Daniel Okafor after he left every team", OMAR, [" User: Daniel Okafor", "-Status: Active", "+Status: Suspended", "-Teams: Talent Acquisition (Viewer · Interviewer)", "+Teams: none"]),
    E(11, "2026-10-14T09:30", "Rahul Menon", "Teams", "Removed", "Removed Layla Hassan from Graduate Hiring", RAHUL, [" Team: Graduate Hiring", "-Member: Layla Hassan (Viewer)"]),
  ];
  const TODAY = "2026-11-10";
  const S = { f: { who: "Anyone", area: "All areas", action: "All actions", from: "2026-10-11", to: TODAY, range: "Last 30 days", q: "" }, appliedQ: "" };
  const esc = Admin.ui.esc;

  const fmtWhen = (at) => {
    const [d, t] = at.split("T");
    if (d === TODAY) return `Today ${t}`;
    if (d === "2026-11-09") return `Yesterday ${t}`;
    const dt = new Date(d + "T00:00:00Z");
    return `${dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} ${t}`;
  };
  const toUtc = (at) => { const [d, t] = at.split("T"); const [h, m] = t.split(":").map(Number); const dt = new Date(Date.UTC(...d.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), h - 4, m)); return dt.toISOString().replace("T", " ").slice(0, 16) + " UTC"; };
  const areaTone = (a) => ({ Roles: "info", Users: "info", Groups: "info", Mail: "warn", Domain: "warn", Branding: "", Notifications: "warn" }[a] || "");

  function filtered() {
    const f = S.f, q = f.q.trim().toLowerCase();
    return ENTRIES.filter((e) => {
      const d = e.at.slice(0, 10);
      return (f.who === "Anyone" || e.who === f.who) && (f.area === "All areas" || e.area === f.area) && (f.action === "All actions" || e.action === f.action) &&
        (!f.from || d >= f.from) && (!f.to || d <= f.to) && (!q || (e.summary + " " + e.who + " " + e.area + " " + e.diff.join(" ")).toLowerCase().includes(q));
    });
  }
  function rowsHtml() {
    const list = filtered();
    if (!list.length) return `<div class="card state">${Admin.icon("search")}<h2>No changes match</h2><p class="muted">Try a wider date range or clear the filters.</p>${Admin.ui.btn("Clear filters", { attrs: `onclick="AuditPage.clear()"` })}</div>`;
    return `<div class="table-wrap"><table class="t"><thead><tr><th style="width:120px">Time</th><th>Who</th><th>Area</th><th>Change</th><th>From</th></tr></thead><tbody>${list.map((e) => `
      <tr class="au-row" tabindex="0" onclick="AuditPage.open(${e.id})" onkeydown="if(event.key==='Enter')AuditPage.open(${e.id})">
        <td class="small" title="${esc(toUtc(e.at))}"><bdi>${esc(fmtWhen(e.at))}</bdi></td>
        <td><div class="row" style="flex-wrap:nowrap">${e.who === "System" ? `<span class="au-sys">${Admin.icon("settings", 'width="14" height="14"')}</span>` : Admin.ui.avatar(e.who)}<span>${esc(e.who)}</span></div></td>
        <td>${Admin.ui.badge(e.area, areaTone(e.area))}</td>
        <td><span class="small muted">${esc(e.action)}</span> · ${esc(e.summary)}${e.outcome !== "Success" ? ` ${Admin.ui.badge("Blocked", "bad")}` : ""}</td>
        <td class="small"><span class="au-mono">${esc(e.ip)}</span><div class="muted">${esc(e.device)}</div></td></tr>`).join("")}</tbody></table></div>
      <p class="small muted">Showing ${list.length} of ${ENTRIES.length} changes. Times are Dubai time (UTC+4); hover a time for UTC.</p>`;
  }

  const STYLE = `<style>
    .au-row{cursor:pointer}
    .au-sys{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--surface-subtle);border:1px solid var(--border);color:var(--muted)}
    .au-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;direction:ltr;unicode-bidi:embed}
    .au-diff{direction:ltr;text-align:left;border:1px solid var(--border);border-radius:8px;overflow:hidden;font-family:ui-monospace,Consolas,monospace;font-size:12px}
    .au-diff div{display:grid;grid-template-columns:22px 1fr;padding:3px 8px;border-bottom:1px solid var(--border)}
    .au-diff div:last-child{border-bottom:0}
    .au-diff div b{font-weight:700;color:var(--muted)}
    .au-diff .del{background:var(--danger-bg);color:var(--text)} .au-diff .del b{color:var(--danger)}
    .au-diff .add{background:var(--success-bg);color:var(--text)} .au-diff .add b{color:var(--success)}
    .au-kv{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:0} .au-kv dt{color:var(--muted)} .au-kv dd{margin:0}
    .au-legend{display:flex;gap:12px;font-size:12px;color:var(--muted);margin:6px 0}
    .au-legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-inline-end:4px;vertical-align:-1px}
    .au-legend .r::before{background:var(--danger-bg);border:1px solid var(--danger)} .au-legend .g::before{background:var(--success-bg);border:1px solid var(--success)}
    .au-filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
    .au-filters .field{margin:0}
    @media (max-width:1100px){.au-filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>`;

  function csv(list) {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    return ["time_dubai,time_utc,who,area,action,change,outcome,ip,device,request_id", ...list.map((e) => [e.at.replace("T", " "), toUtc(e.at), e.who, e.area, e.action, e.summary, e.outcome, e.ip, e.device, e.req].map(q).join(","))].join("\r\n");
  }

  window.AuditPage = {
    open(id) {
      const e = ENTRIES.find((x) => x.id === id);
      const diff = e.diff.map((l) => {
        const k = l[0], txt = l.slice(1);
        return k === "-" ? `<div class="del"><b aria-label="Removed">−</b><span>${esc(txt)}</span></div>` : k === "+" ? `<div class="add"><b aria-label="Added">+</b><span>${esc(txt)}</span></div>` : `<div><b></b><span>${esc(txt)}</span></div>`;
      }).join("");
      Admin.drawer(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(e.area)} · ${esc(e.action)}</h2>${Admin.ui.btn("Close", { kind: "ghost", attrs: `onclick="Admin.close()"` })}</div>
        <p style="margin:6px 0 12px">${esc(e.summary)}</p>
        ${e.outcome !== "Success" ? `<div class="callout bad" style="margin-bottom:12px">${esc(e.outcome)}. Nothing was changed.</div>` : ""}
        ${e.impact ? `<div class="callout small" style="margin-bottom:12px">Impact at the time: ${esc(e.impact)}</div>` : ""}
        <dl class="au-kv">
          <dt>When</dt><dd><bdi>${esc(fmtWhen(e.at))} Dubai time</bdi><div class="small muted"><bdi>${esc(toUtc(e.at))}</bdi></div></dd>
          <dt>Who</dt><dd>${esc(e.who)}${e.who === "System" ? "" : ` <a class="small" href="#/users" onclick="Admin.close()">open user</a>`}</dd>
          <dt>From</dt><dd><span class="au-mono">${esc(e.ip)}</span> · ${esc(e.device)}</dd>
          <dt>Outcome</dt><dd>${e.outcome === "Success" ? Admin.ui.badge("Success", "ok") : Admin.ui.badge("Blocked", "bad")}</dd>
          <dt>Reference</dt><dd><span class="au-mono">${esc(e.req)}</span> · entry #${e.id}</dd></dl>
        <h3 style="margin-top:16px">What changed</h3>
        <div class="au-legend"><span class="r">Removed (before)</span><span class="g">Added (after)</span><span>Unmarked lines did not change</span></div>
        <div class="au-diff">${diff}</div>
        <p class="small muted">Secrets such as passwords and API keys are never shown. This entry cannot be edited or deleted.</p>
        <div class="row">${Admin.ui.btn("Show all changes by " + (e.who === "System" ? "System" : e.who.split(" ")[0]), { attrs: `onclick="AuditPage.byWho('${esc(e.who)}')"` })}${Admin.ui.btn("Copy reference", { kind: "ghost", attrs: `onclick="Admin.toast('Copied ${e.req}')"` })}</div>`);
    },
    byWho(w) { Admin.close(); S.f.who = w; Admin.rerender(); },
    clear() { S.f = { who: "Anyone", area: "All areas", action: "All actions", from: "", to: "", range: "All time", q: "" }; S.appliedQ = "__cleared"; Admin.navigate("audit"); Admin.rerender(); },
    exportCsv() {
      const list = filtered();
      try {
        const url = URL.createObjectURL(new Blob(["\ufeff" + csv(list)], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a"); a.href = url; a.download = `audit-log-${TODAY}.csv`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) { /* download blocked: the toast still explains */ }
      Admin.toast(`Exported ${list.length} entries to CSV. The export itself is recorded in the audit log.`);
    },
  };

  Admin.register({
    id: "audit",
    group: "System",
    title: "Audit log",
    icon: "log",
    spec: ["AUD-001", "AUD-002", "AUD-003", "AUD-006", "AUD-007"],
    changes: "New. Today admin changes are not recorded in one place; every change to roles, users, fields, workflows, branding, mail and teams is now listed with who, when, from where and a before/after view.",
    render(ctx) {
      const { ui } = ctx;
      const qa = ctx.query.get("area");
      if (qa && qa !== S.appliedQ && AREAS.includes(qa)) { S.f.area = qa; S.appliedQ = qa; }
      const head = ui.pageHeader("Audit log", "Every change made in the Admin portal: who, when, from where, and exactly what changed.",
        ui.btn("Export CSV", { ic: "log", attrs: `onclick="AuditPage.exportCsv()"` }));
      if (ctx.state !== "normal") return STYLE + head + ui.stateBlock(ctx.state, { emptyTitle: "No changes recorded yet", emptyText: "When you or another admin changes roles, users, fields, workflows or settings, it shows up here.", emptyAction: ui.btn("Go to Admin home", { kind: "primary", attrs: `onclick="Admin.navigate('home')"` }) });
      const f = S.f;
      const people = ["Anyone", ...new Set(ENTRIES.map((e) => e.who))];
      const filters = `<div class="card" style="margin-bottom:12px">
        <div class="au-filters">
          ${ui.field("Search", `<input class="input" id="au-q" placeholder="e.g. offer-approvers, #4338CA" value="${esc(f.q)}">`)}
          ${ui.field("Who", ui.select(people, f.who, `id="au-who"`))}
          ${ui.field("Area", ui.select(["All areas", ...AREAS], f.area, `id="au-area"`))}
          ${ui.field("Action", ui.select(["All actions", ...ACTIONS], f.action, `id="au-action"`))}
          ${ui.field("Date range", ui.select(["Last 24 hours", "Last 7 days", "Last 30 days", "Last 90 days", "All time", "Custom"], f.range, `id="au-range"`))}
          ${ui.field("From", `<input class="input" type="date" id="au-from" value="${f.from}">`)}
          ${ui.field("To", `<input class="input" type="date" id="au-to" value="${f.to}">`)}
          <div class="field" style="align-self:end">${ui.btn("Clear filters", { kind: "ghost", attrs: `onclick="AuditPage.clear()"` })}</div>
        </div></div>`;
      return STYLE + head + filters + `<div id="au-rows">${rowsHtml()}</div>
        <div class="callout small" style="margin-top:12px">${Admin.icon("shield", 'width="14" height="14" style="vertical-align:-2px"')} Entries are kept for <b>3 years</b>, then removed by the nightly retention job (which is itself recorded). Nobody can edit or delete an entry. Integrity check passed today at 03:00 (Dubai time).</div>`;
    },
    mount(root) {
      const box = root.querySelector("#au-rows");
      if (!box) return;
      const refresh = () => (box.innerHTML = rowsHtml());
      const bind = (id, key, ev = "change") => { const el = root.querySelector(id); el.addEventListener(ev, () => { S.f[key] = el.value; if (key === "from" || key === "to") { S.f.range = "Custom"; root.querySelector("#au-range").value = "Custom"; } refresh(); }); };
      bind("#au-q", "q", "input"); bind("#au-who", "who"); bind("#au-area", "area"); bind("#au-action", "action"); bind("#au-from", "from"); bind("#au-to", "to");
      root.querySelector("#au-range").addEventListener("change", (e) => {
        const v = e.target.value; S.f.range = v;
        const days = { "Last 24 hours": 1, "Last 7 days": 7, "Last 30 days": 30, "Last 90 days": 90 }[v];
        if (v === "All time") { S.f.from = ""; S.f.to = ""; }
        else if (days) { const d = new Date(Date.UTC(2026, 10, 10 - days)); S.f.from = d.toISOString().slice(0, 10); S.f.to = TODAY; }
        root.querySelector("#au-from").value = S.f.from; root.querySelector("#au-to").value = S.f.to; refresh();
      });
    },
  });
})();
