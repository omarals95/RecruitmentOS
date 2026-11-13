/* API & AI connections: every API token in the company, connected AI apps, company switches. Spec 03 IAM-008, 11 API-007. */
(function () {
  const S = {
    tokens: [
      { id: "tk-31", name: "Careers site sync", owner: "Omar Alshair", team: "Talent Acquisition", scopes: ["Read vacancies", "Create candidates"], created: "2 Jun 2026", expires: "2 Dec 2026", days: 22, lastUsed: "Today 11:38", ip: "94.200.18.41", uses7: 2140, status: "Active" },
      { id: "tk-30", name: "Power BI hiring report", owner: "Mariam Al Suwaidi", team: "Executive Search", scopes: ["Read applications", "Read vacancies"], created: "15 Aug 2026", expires: "13 Feb 2027", days: 95, lastUsed: "Today 06:00", ip: "20.74.8.112", uses7: 7, status: "Active" },
      { id: "tk-29", name: "Assessment results import", owner: "Rahul Menon", team: "Graduate Hiring", scopes: ["Read candidates", "Edit applications", "Add notes"], created: "1 Sep 2026", expires: "19 Nov 2026", days: 9, lastUsed: "Yesterday 16:02", ip: "185.93.4.17", uses7: 64, status: "Active" },
      { id: "tk-27", name: "Laptop script", owner: "Sara Haddad", team: "Talent Acquisition", scopes: ["Read candidates", "Read CVs"], created: "20 Oct 2026", expires: "19 Jan 2027", days: 70, lastUsed: "4 Nov 2026", ip: "86.98.211.5", uses7: 0, status: "Active" },
      { id: "tk-24", name: "Calendar bridge", owner: "Khalid Al Mansoori", team: "Talent Acquisition", scopes: ["Read interviews", "Edit interviews"], created: "10 Jul 2026", expires: "8 Nov 2026", days: -2, lastUsed: "7 Nov 2026", ip: "94.200.18.41", uses7: 31, status: "Expired" },
      { id: "tk-19", name: "Old HRIS export", owner: "Daniel Okafor", team: "—", scopes: ["Read candidates", "Export"], created: "3 Mar 2026", expires: "1 Sep 2026", days: -70, lastUsed: "28 Aug 2026", ip: "5.195.77.20", uses7: 0, status: "Revoked" },
    ],
    policy: { maxExpiry: "180 days", who: "Team admins and above", scopesRequired: true, ipList: "" },
    tFilter: { q: "", team: "All teams", status: "All" },
    company: { allowAi: true, allowCv: true, allowWrite: false, defaultLimit: 500 },
    ai: [
      { id: "ai-1", app: "Claude", user: "Sara Haddad", team: "Talent Acquisition", scopes: ["Read candidates", "Read vacancies", "Search"], write: ["Add notes"], cv: true, limit: 500, used: 212, lastUsed: "Today 10:14", since: "12 Sep 2026" },
      { id: "ai-2", app: "ChatGPT", user: "Rahul Menon", team: "Graduate Hiring", scopes: ["Read candidates", "Read applications", "Search"], write: ["Move stage"], cv: false, limit: 300, used: 288, lastUsed: "Today 09:47", since: "30 Sep 2026" },
      { id: "ai-3", app: "Claude", user: "Mariam Al Suwaidi", team: "Executive Search", scopes: ["Read vacancies", "Read offers", "Search"], write: [], cv: true, limit: 200, used: 18, lastUsed: "Yesterday 18:30", since: "2 Oct 2026" },
      { id: "ai-4", app: "Microsoft Copilot", user: "Khalid Al Mansoori", team: "Talent Acquisition", scopes: ["Read interviews", "Read applications"], write: ["Add interview feedback"], cv: false, limit: 100, used: 0, lastUsed: "6 days ago", since: "21 Oct 2026" },
      { id: "ai-5", app: "ChatGPT", user: "Omar Alshair", team: "Talent Acquisition", scopes: ["Read candidates", "Read vacancies", "Read applications", "Search"], write: ["Add notes", "Create tasks"], cv: true, limit: 500, used: 41, lastUsed: "Today 08:05", since: "5 Aug 2026" },
    ],
  };
  const esc = Admin.ui.esc;
  const N = (s) => `<bdi dir="ltr">${s}</bdi>`;
  const tokTone = (t) => (t.status === "Revoked" ? "" : t.status === "Expired" ? "bad" : t.days <= 14 ? "warn" : "ok");
  const tokLabel = (t) => (t.status === "Active" && t.days <= 14 ? `Expires in ${t.days} days` : t.status);
  const sw = (on, attrs = "", dis = false) => `<label class="ig-sw"><input type="checkbox" ${on ? "checked" : ""} ${dis ? "disabled" : ""} ${attrs}><span></span></label>`;
  const STYLE = `<style>
    .ig-sw{position:relative;display:inline-block;width:34px;height:20px;vertical-align:middle;flex:none}
    .ig-sw input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
    .ig-sw span{position:absolute;inset:0;border-radius:999px;background:var(--border-strong);transition:background .15s;pointer-events:none}
    .ig-sw span::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:14px;height:14px;border-radius:50%;background:var(--surface);transition:inset-inline-start .15s}
    .ig-sw input:checked+span{background:var(--primary)}
    .ig-sw input:checked+span::after{inset-inline-start:17px}
    .ig-sw input:disabled+span{opacity:.45}
    .ig-sw input:focus-visible+span{outline:2px solid var(--focus);outline-offset:2px}
    td .btn{white-space:nowrap}
    .ig-scope{display:inline-block;font-size:11px;border:1px solid var(--border);border-radius:6px;padding:0 6px;margin:1px 3px 1px 0;background:var(--surface-subtle);white-space:nowrap}
    .ig-scope.w{border-color:var(--warning);color:var(--warning);background:var(--warning-bg)}
    .ig-scope.off{text-decoration:line-through;opacity:.6}
    .ig-line{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
    .ig-line:last-child{border-bottom:0}
    .ig-app{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--primary-soft);color:var(--primary-text);font-weight:700;font-size:12px;flex:none}
    .ig-kv{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;margin:0}
    .ig-kv dt{color:var(--muted)} .ig-kv dd{margin:0}
    tr.ig-dim td{opacity:.6}
  </style>`;

  // ---------- API tokens ----------
  function tokenRows() {
    const f = S.tFilter, q = f.q.toLowerCase();
    const list = S.tokens.filter((t) => (f.team === "All teams" || t.team === f.team) && (f.status === "All" || (f.status === "Expiring soon" ? t.status === "Active" && t.days <= 14 : t.status === f.status)) && (!q || (t.name + t.owner).toLowerCase().includes(q)));
    if (!list.length) return `<div class="card state">${Admin.icon("key")}<h2>No tokens match</h2><p class="muted">Try another team or status.</p></div>`;
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Token</th><th>Owner</th><th>Scopes</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>${list.map((t) => `
      <tr class="${t.status === "Revoked" ? "ig-dim" : ""}">
        <td><a href="javascript:void 0" onclick="IntPage.token('${t.id}')"><b>${esc(t.name)}</b></a><div class="small muted"><bdi>${t.id} · ${t.uses7.toLocaleString("en-GB")} calls in 7 days</bdi></div></td>
        <td><div class="row" style="flex-wrap:nowrap">${Admin.ui.avatar(t.owner)}<div>${esc(t.owner)}<div class="small muted">${esc(t.team)}</div></div></div></td>
        <td>${t.scopes.map((s) => `<span class="ig-scope">${esc(s)}</span>`).join("")}</td>
        <td class="small" style="white-space:nowrap"><bdi>${esc(t.expires)}</bdi><div>${Admin.ui.badge(tokLabel(t), tokTone(t))}</div><div class="muted">Created <bdi>${esc(t.created)}</bdi></div></td>
        <td class="small"><bdi>${esc(t.lastUsed)}</bdi><div class="muted">${N(esc(t.ip))}</div></td>
        <td>${t.status === "Active" ? Admin.ui.btn("Revoke", { kind: "sm danger", attrs: `onclick="IntPage.revokeToken('${t.id}')"` }) : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function tokensTab() {
    const f = S.tFilter, p = S.policy;
    return `<div class="split" style="grid-template-columns:minmax(0,1fr) 320px"><div>
        <div class="toolbar">
          <input class="input" id="ig-q" placeholder="Search token or owner" value="${esc(f.q)}" aria-label="Search tokens">
          ${Admin.ui.select(["All teams", ...window.MockData.teams.map((t) => t.name)], f.team, `id="ig-team" aria-label="Team"`)}
          ${Admin.ui.select(["All", "Active", "Expiring soon", "Expired", "Revoked"], f.status, `id="ig-status" aria-label="Status"`).replace(/>All</, ">All statuses<")}
        </div>
        <div id="ig-tokens">${tokenRows()}</div>
        <p class="small muted">Tokens are stored scrambled; nobody (including admins) can see a token after it is created. People create their own tokens in their profile. Every use is logged with time and IP address.</p>
      </div>
      <div class="card"><h2>Token rules</h2>
        ${Admin.ui.field("Longest allowed expiry", Admin.ui.select(["30 days", "90 days", "180 days", "1 year"], p.maxExpiry, `onchange="IntPage.policy('maxExpiry',this.value)"`), "Tokens without an expiry date are not allowed.")}
        ${Admin.ui.field("Who can create tokens", Admin.ui.select(["Everyone", "Team admins and above", "Company admins only", "Nobody (turn off API access)"], p.who, `onchange="IntPage.policy('who',this.value)"`))}
        ${Admin.ui.check("Every token must choose scopes", p.scopesRequired)}<br><br>
        ${Admin.ui.field("Only allow these IP addresses (optional)", `<textarea class="input" rows="3" placeholder="One address or range per line, e.g. 94.200.18.0/24">${esc(p.ipList)}</textarea>`, "Leave empty to allow any address.")}
        ${Admin.ui.field("Requests per token", `<div class="row">${Admin.ui.input("600", `style="width:90px" inputmode="numeric"`)}<span class="small muted">a minute, then the API answers “try again later”</span></div>`)}
        <div class="callout small" style="margin-bottom:12px">2 tokens expire in the next 30 days. Owners get an email 7 days before.</div>
        ${Admin.ui.btn("Save rules", { kind: "primary", attrs: `onclick="IntPage.savePolicy()"` })}
      </div></div>`;
  }

  // ---------- AI connections ----------
  function aiTab() {
    const c = S.company;
    const line = (label, desc, key, warn = "") => `<div class="ig-line"><div><b>${label}</b><div class="small muted">${desc}</div>${warn}</div>${sw(c[key], `aria-label="${esc(label)}" onchange="IntPage.company('${key}',this)"`, key !== "allowAi" && !c.allowAi)}</div>`;
    const rows = S.ai.map((a) => {
      const pct = Math.round((a.used / a.limit) * 100);
      return `<tr class="${!c.allowAi ? "ig-dim" : ""}">
        <td><div class="row" style="flex-wrap:nowrap"><span class="ig-app">${esc(a.app.slice(0, 2))}</span><div><a href="javascript:void 0" onclick="IntPage.conn('${a.id}')"><b>${esc(a.app)}</b></a><div class="small muted">Connected ${esc(a.since)}</div></div></div></td>
        <td><div class="row" style="flex-wrap:nowrap">${Admin.ui.avatar(a.user)}<div>${esc(a.user)}<div class="small muted">${esc(a.team)}</div></div></div></td>
        <td>${a.scopes.map((s) => `<span class="ig-scope">${esc(s)}</span>`).join("")}${a.write.map((s) => `<span class="ig-scope w ${c.allowWrite ? "" : "off"}" title="${c.allowWrite ? "Write tool" : "Write tools are turned off for the company"}">${esc(s)}</span>`).join("")}</td>
        <td style="text-align:center">${sw(a.cv && c.allowCv, `aria-label="${esc(a.user)}: ${esc(a.app)} may read CV text" onchange="IntPage.cv('${a.id}',this.checked)"`, !c.allowCv || !c.allowAi)}</td>
        <td style="min-width:150px"><div class="small"><bdi>${a.used} of <b>${a.limit}</b> today</bdi></div>${Admin.ui.bar(pct)}${pct >= 90 ? `<div class="small" style="color:var(--warning)">Near the limit</div>` : ""}</td>
        <td class="small"><bdi>${esc(a.lastUsed)}</bdi></td>
        <td><div class="row" style="flex-wrap:nowrap">${Admin.ui.btn("Edit", { kind: "sm", attrs: `onclick="IntPage.conn('${a.id}')"` })}${Admin.ui.btn("Revoke", { kind: "sm danger", attrs: `onclick="IntPage.revokeAi('${a.id}')"` })}</div></td></tr>`;
    }).join("");
    return `<div class="split" style="grid-template-columns:minmax(0,1fr) 380px">
      <div>
        ${!c.allowAi ? `<div class="callout bad" style="margin-bottom:12px">AI connections are turned off. Existing connections are paused and nobody can connect a new one.</div>` : ""}
        ${S.ai.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>App</th><th>Connected by</th><th>What it can do</th><th style="text-align:center">CV text</th><th>Requests</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="card state">${Admin.icon("bot")}<h2>No AI apps connected</h2><p class="muted">When people connect Claude, ChatGPT or another AI app to RecruitmentOS, they appear here.</p></div>`}
        <p class="small muted">An AI app only ever sees what the person who connected it can see, in their teams. Private notes and shortlists are never shared. Every request is logged.</p>
      </div>
      <div class="card"><h2>Company switches</h2>
        ${line("Allow AI connections", "People can connect AI apps such as Claude or ChatGPT to their account.", "allowAi")}
        ${line("Allow reading CV text", "AI apps can read the text of uploaded CVs. Turn off to share profile fields only.", "allowCv")}
        ${line("Allow write tools", "AI apps can add notes, move stages, create tasks and add feedback for the person.", "allowWrite", c.allowWrite ? "" : `<div class="small" style="color:var(--warning);margin-top:2px">Off: 5 write tools on 4 connections are blocked.</div>`)}
        <div style="margin-top:12px">${Admin.ui.field("Default limit for new connections", `<div class="row">${Admin.ui.input(String(c.defaultLimit), `style="width:90px" inputmode="numeric"`)}<span class="small muted">requests a day</span></div>`)}</div>
        ${Admin.ui.field("Which apps are allowed", `<div class="stack">${["Claude", "ChatGPT", "Microsoft Copilot", "Any other app that supports sign-in with RecruitmentOS"].map((x, i) => Admin.ui.check(x, i < 3)).join("<br>")}</div>`)}
        ${Admin.ui.btn("Save switches", { kind: "primary", attrs: `onclick="Admin.toast('Saved (mockup). Recorded in the audit log.')"` })}
      </div></div>`;
  }

  window.IntPage = {
    token(id) {
      const t = S.tokens.find((x) => x.id === id);
      const uses = [["Today 11:38", "GET /api/vacancies?status=open", "200"], ["Today 11:23", "POST /api/candidates", "201"], ["Today 11:08", "GET /api/vacancies?status=open", "200"], ["Today 10:53", "POST /api/candidates", "422"]];
      Admin.drawer(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(t.name)}</h2>${Admin.ui.btn("Close", { kind: "ghost", attrs: `onclick="Admin.close()"` })}</div>
        <div class="row" style="margin:8px 0 12px">${Admin.ui.badge(tokLabel(t), tokTone(t))}<span class="small muted">${t.id}</span></div>
        <dl class="ig-kv"><dt>Owner</dt><dd>${esc(t.owner)}</dd><dt>Team</dt><dd>${esc(t.team)}</dd><dt>Scopes</dt><dd>${t.scopes.map((s) => `<span class="ig-scope">${esc(s)}</span>`).join("")}</dd>
        <dt>Created</dt><dd>${esc(t.created)}</dd><dt>Expires</dt><dd>${esc(t.expires)}</dd><dt>Last used</dt><dd>${esc(t.lastUsed)} from ${esc(t.ip)}</dd><dt>Calls (7 days)</dt><dd>${t.uses7.toLocaleString("en-GB")}</dd></dl>
        <h3 style="margin-top:16px">Recent use</h3>
        ${t.uses7 ? Admin.ui.table(["When", "Request", "Result"], uses.map(([w, r, c]) => [`<span class="small">${w}</span>`, `<code>${esc(r)}</code>`, Admin.ui.badge(c, c.startsWith("2") ? "ok" : "warn")])) : `<p class="muted">Not used in the last 7 days.</p>`}
        <div class="row" style="margin-top:12px">${t.status === "Active" ? Admin.ui.btn("Revoke token", { kind: "danger", attrs: `onclick="IntPage.revokeToken('${t.id}')"` }) : ""}${Admin.ui.btn("See in audit log", { kind: "ghost", attrs: `onclick="Admin.close();Admin.navigate('audit?area=Users')"` })}</div>`);
    },
    revokeToken(id) {
      const t = S.tokens.find((x) => x.id === id);
      Admin.modal(`<h2>Revoke “${esc(t.name)}”?</h2>
        <ul><li>Owner: ${esc(t.owner)} (${esc(t.team)})</li><li>Used ${t.uses7.toLocaleString("en-GB")} times in the last 7 days · last used ${esc(t.lastUsed)} from ${esc(t.ip)}</li><li>Anything using it stops working straight away. This cannot be undone; the owner must create a new token.</li></ul>
        ${Admin.ui.field("Reason (sent to the owner)", Admin.ui.input("", `id="ig-reason" placeholder="e.g. Not needed after the HRIS move"`))}
        <div class="row">${Admin.ui.btn("Revoke token", { kind: "danger", attrs: `onclick="IntPage.doRevokeToken('${t.id}')"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
    },
    doRevokeToken(id) { const t = S.tokens.find((x) => x.id === id); t.status = "Revoked"; Admin.close(); Admin.rerender(); Admin.toast(`Token revoked. ${t.owner.split(" ")[0]} has been told (mockup).`); },
    policy(k, v) { S.policy[k] = v; },
    savePolicy() {
      const over = S.tokens.filter((t) => t.status === "Active" && t.days > parseInt(S.policy.maxExpiry === "1 year" ? 365 : S.policy.maxExpiry, 10)).length;
      Admin.toast(over ? `Saved (mockup). ${over} existing token${over > 1 ? "s" : ""} expire later than the new limit and keep their date.` : "Token rules saved (mockup)");
    },
    company(key, el) {
      const on = el.checked, c = S.company;
      if (key === "allowAi" && !on) {
        el.checked = true;
        Admin.modal(`<h2>Turn off AI connections?</h2><ul><li>${S.ai.length} connections from ${new Set(S.ai.map((a) => a.user)).size} people stop working straight away</li><li>About 560 requests were made today</li><li>Connections are paused, not deleted. Turning this back on restores them.</li></ul>
          <div class="row">${Admin.ui.btn("Turn off", { kind: "danger", attrs: `onclick="IntPage.setCompany('allowAi',false)"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
        return;
      }
      if (key === "allowWrite" && on) {
        el.checked = false;
        const n = S.ai.filter((a) => a.write.length).length;
        Admin.modal(`<h2>Allow AI apps to make changes?</h2><p>AI apps will be able to change records for the person who connected them, within that person's own permissions.</p>
          <ul><li>${n} connections already ask for write tools: ${[...new Set(S.ai.flatMap((a) => a.write))].join(", ")}</li><li>Every change is recorded as “via ${"AI app"}” in the record history and audit log</li></ul>
          <div class="row">${Admin.ui.btn("Allow write tools", { kind: "primary", attrs: `onclick="IntPage.setCompany('allowWrite',true)"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
        return;
      }
      if (key === "allowCv" && !on) Admin.toast(`CV text reading off for all ${S.ai.filter((a) => a.cv).length} connections that had it (mockup)`);
      c[key] = on; Admin.rerender();
    },
    setCompany(k, v) { S.company[k] = v; Admin.close(); Admin.rerender(); Admin.toast("Saved (mockup). Recorded in the audit log."); },
    cv(id, on) { S.ai.find((x) => x.id === id).cv = on; Admin.toast(on ? "CV text reading allowed for this connection" : "CV text reading turned off for this connection"); },
    conn(id) {
      const a = S.ai.find((x) => x.id === id);
      const calls = [["10:14", "search_candidates", "“data analysts with Power BI in Dubai”", "ok"], ["10:13", "get_candidate", "Fatima Al Zaabi", "ok"], ["10:13", "read_cv_text", "Fatima Al Zaabi · CV.pdf", a.cv && S.company.allowCv ? "ok" : "blocked"], ["09:58", "add_note", "Omar Farouk", S.company.allowWrite ? "ok" : "blocked"]];
      Admin.drawer(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(a.app)} · ${esc(a.user)}</h2>${Admin.ui.btn("Close", { kind: "ghost", attrs: `onclick="Admin.close()"` })}</div>
        <p class="muted" style="margin-top:4px">Connected ${esc(a.since)} · ${esc(a.team)} · last used ${esc(a.lastUsed)}</p>
        <h3>What it can do</h3>
        <div class="stack">${a.scopes.map((s) => Admin.ui.check(s, true)).join("<br>")}<br>${a.write.map((s) => Admin.ui.check(s + " (write)", S.company.allowWrite, S.company.allowWrite ? "" : "disabled")).join("<br>")}</div>
        ${!S.company.allowWrite && a.write.length ? `<p class="small muted">Write tools are off for the whole company.</p>` : ""}
        <div style="margin-top:12px">${Admin.ui.check("May read CV text", a.cv && S.company.allowCv, S.company.allowCv ? `id="ig-cv"` : "disabled")}</div>
        <div style="margin-top:12px">${Admin.ui.field("Requests a day", `<div class="row">${Admin.ui.input(String(a.limit), `id="ig-limit" style="width:100px" inputmode="numeric"`)}<span class="small muted">${a.used} used today</span></div>`)}</div>
        <h3>Recent requests</h3>
        ${Admin.ui.table(["Time", "Tool", "On", "Result"], calls.map(([t, tool, on, r]) => [`<span class="small">${t}</span>`, `<code>${tool}</code>`, `<span class="small">${esc(on)}</span>`, Admin.ui.badge(r === "ok" ? "Allowed" : "Blocked", r === "ok" ? "ok" : "bad")]))}
        <div class="row" style="margin-top:12px">${Admin.ui.btn("Save", { kind: "primary", attrs: `onclick="IntPage.saveConn('${a.id}')"` })}${Admin.ui.btn("Revoke connection", { kind: "danger", attrs: `onclick="IntPage.revokeAi('${a.id}')"` })}</div>`);
    },
    saveConn(id) {
      const a = S.ai.find((x) => x.id === id), lim = parseInt(document.getElementById("ig-limit").value, 10), cv = document.getElementById("ig-cv");
      if (!(lim > 0)) { Admin.toast("Enter a number of requests above 0"); return; }
      a.limit = lim; if (cv) a.cv = cv.checked; Admin.close(); Admin.rerender(); Admin.toast("Connection updated (mockup)");
    },
    revokeAi(id) {
      const a = S.ai.find((x) => x.id === id);
      Admin.modal(`<h2>Revoke ${esc(a.app)} for ${esc(a.user)}?</h2><ul><li>${a.used} requests today · last used ${esc(a.lastUsed)}</li><li>${esc(a.app)} loses access straight away. ${esc(a.user.split(" ")[0])} can connect it again unless AI connections are turned off.</li></ul>
        <div class="row">${Admin.ui.btn("Revoke", { kind: "danger", attrs: `onclick="IntPage.doRevokeAi('${a.id}')"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
    },
    doRevokeAi(id) { const i = S.ai.findIndex((x) => x.id === id); const a = S.ai.splice(i, 1)[0]; Admin.close(); Admin.rerender(); Admin.toast(`${a.app} disconnected for ${a.user} (mockup)`); },
  };

  Admin.register({
    id: "integrations",
    group: "Integrations",
    title: "API & AI connections",
    icon: "bot",
    spec: ["IAM-008", "API-007", "IAM-090"],
    changes: "New. Today people manage their own tokens and AI connections only; admins can now see and revoke every one in the company and set company-wide rules.",
    render(ctx) {
      const { ui } = ctx;
      const tab = ctx.query.get("tab") || "tokens";
      const head = ui.pageHeader("API & AI connections", "Every API token and connected AI app in the company, who owns it and what it can reach.",
        ui.btn("Open audit log", { kind: "ghost", ic: "log", attrs: `onclick="Admin.navigate('audit')"` }));
      if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No tokens or AI connections yet", emptyText: "People create API tokens and connect AI apps from their own profile. They will appear here.", emptyAction: ui.btn("Set token rules", { kind: "primary", attrs: `onclick="Admin.setState('normal')"` }) });
      const active = S.tokens.filter((t) => t.status === "Active");
      const kpis = `<div class="grid g4" style="margin-bottom:16px">
        ${ui.kpi("Active tokens", active.length, `<bdi>${active.filter((t) => t.days <= 14).length} expire within 14 days</bdi>`)}
        ${ui.kpi("AI connections", S.company.allowAi ? S.ai.length : "Off", `<bdi>${new Set(S.ai.map((a) => a.user)).size} people · ${new Set(S.ai.map((a) => a.app)).size} apps</bdi>`)}
        ${ui.kpi("API calls (7 days)", "2,242", N("0.4 % errors"))}
        ${ui.kpi("AI requests today", S.ai.reduce((n, a) => n + a.used, 0), "CV text read 37 times")}</div>`;
      const tabs = ui.tabs("int", [{ id: "tokens", label: "API tokens" }, { id: "ai", label: "AI connections" }], tab);
      return STYLE + head + kpis + tabs + (tab === "ai" ? aiTab() : tokensTab());
    },
    mount(root) {
      const box = root.querySelector("#ig-tokens");
      if (!box) return;
      const q = root.querySelector("#ig-q"), team = root.querySelector("#ig-team"), st = root.querySelector("#ig-status");
      q.addEventListener("input", () => { S.tFilter.q = q.value; box.innerHTML = tokenRows(); });
      team.addEventListener("change", () => { S.tFilter.team = team.value; box.innerHTML = tokenRows(); });
      st.addEventListener("change", () => { S.tFilter.status = st.value.replace(/^All .*/, "All"); box.innerHTML = tokenRows(); });
    },
  });
})();
