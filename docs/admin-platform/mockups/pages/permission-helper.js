/* Permission helper: why can (or can't) this person do this? Reads window.AccessMock (pages/roles.js). Route #/permission-helper?user=u-105&team=...&rec=...&act=...&field=...&via=... */
(function () {
  const RECORDS = [
    { id: "rec-sse", kind: "Vacancy", res: "Vacancies", label: "Vacancy · Senior Software Engineer", team: "Talent Acquisition", unit: "Platform Engineering", assigned: ["Khalid Al Mansoori", "Sara Haddad"] },
    { id: "rec-fbp", kind: "Vacancy", res: "Vacancies", label: "Vacancy · Finance Business Partner", team: "Talent Acquisition", unit: "Finance", assigned: ["Sara Haddad"] },
    { id: "rec-cand", kind: "Candidate", res: "Candidates", label: "Candidate · Fatima Al Zaabi", team: "Talent Acquisition", unit: "Platform Engineering", assigned: ["Sara Haddad", "Khalid Al Mansoori"], notesAuthor: "Sara Haddad" },
    { id: "rec-app", kind: "Application", res: "Applications", label: "Application · Fatima Al Zaabi → Senior Software Engineer", team: "Talent Acquisition", unit: "Platform Engineering", assigned: ["Khalid Al Mansoori", "Sara Haddad"] },
    { id: "rec-int", kind: "Interview", res: "Interviews", label: "Interview · Fatima Al Zaabi, technical, 12 Nov", team: "Talent Acquisition", unit: "Platform Engineering", assigned: ["Layla Hassan", "Khalid Al Mansoori"] },
    { id: "rec-off", kind: "Offer", res: "Offers", label: "Offer · Fatima Al Zaabi, AED 38,500 / month", team: "Talent Acquisition", unit: "Platform Engineering", assigned: ["Khalid Al Mansoori", "Sara Haddad"] },
    { id: "rec-grad", kind: "Candidate", res: "Candidates", label: "Candidate · Yousef Al Hammadi", team: "Graduate Hiring", unit: "Human Resources", assigned: ["Rahul Menon"], notesAuthor: "Rahul Menon" },
    { id: "rec-gvac", kind: "Vacancy", res: "Vacancies", label: "Vacancy · Graduate Analyst 2027", team: "Graduate Hiring", unit: "Finance", assigned: ["Rahul Menon", "Aisha Rahman"] },
    { id: "rec-cfo", kind: "Candidate", res: "Candidates", label: "Candidate · Ritu Sharma (CFO search)", team: "Executive Search", unit: "Office of the CEO", assigned: ["Mariam Al Suwaidi"], notesAuthor: "Mariam Al Suwaidi" },
  ];
  const VIA = {
    app: { label: "Signed in to the app", scopes: null },
    token: { label: "API token “ATS sync” (created by this person)", scopes: { Candidates: ["View", "Create"], Vacancies: ["View"], Applications: ["View"] } },
    ai: { label: "AI connection “Claude connector” (read only)", scopes: "read" },
  };
  const EXAMPLES = [
    { tone: "ok", label: "Hiring manager edits a vacancy in his unit", q: { user: "u-105", team: "Talent Acquisition", rec: "rec-sse", act: "Edit" } },
    { tone: "bad", label: "Same hiring manager, vacancy in Finance", q: { user: "u-105", team: "Talent Acquisition", rec: "rec-fbp", act: "View" } },
    { tone: "bad", label: "Recruiter without CV upload imports CVs", q: { user: "u-104", team: "Talent Acquisition", rec: "rec-cand", act: "Import" } },
    { tone: "bad", label: "Interviewer tries to edit an interview", q: { user: "u-108", team: "Talent Acquisition", rec: "rec-int", act: "Edit" } },
    { tone: "ok", label: "Owner reads a candidate through the AI connection", q: { user: "u-101", team: "Talent Acquisition", rec: "rec-cand", act: "View", via: "ai" } },
    { tone: "bad", label: "Owner opens someone else's private notes", q: { user: "u-101", team: "Talent Acquisition", rec: "rec-cand", act: "View", field: "Private notes" } },
  ];
  const CSS = `<style>
    .ph-chain { list-style:none; margin:0; padding:0; counter-reset:ph; }
    .ph-chain li { display:grid; grid-template-columns:28px 1fr auto; gap:10px; padding:10px 0; border-bottom:1px solid var(--border); align-items:start; }
    .ph-chain li:last-child { border-bottom:0; }
    .ph-chain li::before { counter-increment:ph; content:counter(ph); width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font-size:12px; font-weight:700; background:var(--surface-subtle); border:1px solid var(--border); }
    .ph-chain li.pass::before { background:var(--success-bg); color:var(--success); border-color:transparent; }
    .ph-chain li.fail::before { background:var(--danger-bg); color:var(--danger); border-color:transparent; }
    .ph-chain li.skip { opacity:.6; }
    .ph-result { display:flex; gap:14px; align-items:center; }
    .ph-result .big { font-size:24px; font-weight:700; }
    .ph-ex { text-align:start; justify-content:flex-start; width:100%; }
  </style>`;

  function parseTeams(u) { return (u.teams || []).map(([team, s]) => { const [membership, configured] = s.split(" · "); return { team, membership, configured: configured || null }; }); }
  function subtree(units, name) {
    const root = units.find((u) => u.name === name); if (!root) return [];
    const out = [root.name]; const walk = (id) => units.filter((u) => u.parent === id).forEach((c) => { out.push(c.name); walk(c.id); });
    walk(root.id); return out;
  }
  function chainOf(units, name) {
    const out = []; let u = units.find((x) => x.name === name);
    while (u) { out.unshift(u.name); u = units.find((x) => x.id === u.parent); }
    return out.join(" › ");
  }

  function evaluate(M, data, user, teamName, rec, act, field, via) {
    const steps = [];
    const add = (state, title, detail) => steps.push({ state, title, detail });
    let denied = null;
    const fail = (title, detail, why) => { add("fail", title, detail); denied = why; };
    const m = parseTeams(user).find((t) => t.team === teamName);
    // 1 account
    if (user.status !== "Active") fail("Account status", `${user.name} is <b>${user.status.toLowerCase()}</b>.`, `${user.name}'s account is ${user.status.toLowerCase()}, so every check stops here.`);
    else add("pass", "Account status", `${user.name} is active and signed in.`);
    // 2 team membership
    if (!denied) {
      if (rec.team !== teamName) fail("Team membership", `The record belongs to <b>${rec.team}</b>, not ${teamName}.`, `records stay locked to their team.`);
      else if (!m) fail("Team membership", `${user.name} is not a member of <b>${teamName}</b>. Records stay locked to their team.`, `${user.name} is not a member of ${teamName}, and records never cross team lines.`);
      else add("pass", "Team membership", `Member of <b>${teamName}</b>, which owns this record.`);
    }
    // 3 ceiling
    let role = null;
    if (!denied) {
      const ref = M.refusal(m.membership, rec.res, act);
      if (ref && ref.kind === "na") fail("Team role ceiling", `${act} is not an action on ${rec.res.toLowerCase()}.`, `${act} does not exist for ${rec.res.toLowerCase()}.`);
      else if (ref) fail("Team role ceiling", `Team role <b>${m.membership}</b>. ${ref.msg}`, `their team role is ${m.membership}, and ${ref.msg.charAt(0).toLowerCase() + ref.msg.slice(1).replace(/\.$/, "")}.`);
      else add("pass", "Team role ceiling", `Team role <b>${m.membership}</b> may hold ${rec.res} → ${act}.`);
    }
    // 4 configured role
    if (!denied) {
      role = M.roles.find((r) => r.name === (m.configured || m.membership));
      const name = m.configured ? `configured role <a href="#/roles/${role.id}?tab=actions">${m.configured}</a>` : `built-in role <a href="#/roles/${role.id}?tab=actions">${m.membership}</a> (no configured role)`;
      if ((role.actions[rec.res] || []).includes(act)) add("pass", "Configured role", `Granted by ${name}: ${rec.res} → ${act}.`);
      else fail("Configured role", `Not granted by ${name}. It does not tick ${rec.res} → ${act}.`, `the role “${role.name}” does not grant ${rec.res} → ${act}.`);
    }
    // 5 record scope
    if (!denied) {
      const grp = rec.res === "Candidates" ? "candidates" : rec.res === "Team tasks" ? "tasks" : "vacancies";
      const sc = role.scope[grp];
      if (sc === "All records") add("pass", "Record scope", `Scope <b>All records</b>. Unit not checked.`);
      else if (sc === "My unit and below") {
        const ok = subtree(data.units, user.unit).includes(rec.unit);
        const d = `Scope <b>My unit and below</b>. Home unit: <b>${user.unit}</b>. Record's unit: <b>${chainOf(data.units, rec.unit)}</b>.`;
        ok ? add("pass", "Record scope (org unit)", d + ` ${rec.unit} is inside ${user.unit}.`)
          : fail("Record scope (org unit)", d + ` ${rec.unit} is outside ${user.unit}.`, `the record sits in ${rec.unit}, outside ${user.name.split(" ")[0]}'s unit (${user.unit}) and the role only covers “my unit and below”.`);
      } else {
        const ok = rec.assigned.includes(user.name);
        ok ? add("pass", "Record scope (assignment)", `Scope <b>Assigned to me</b>. ${user.name} is assigned.`)
          : fail("Record scope (assignment)", `Scope <b>Assigned to me</b>. Assigned: ${rec.assigned.join(", ")}.`, `the role only covers records assigned to them, and they are not assigned to this one.`);
      }
    }
    // 6 field rule
    if (!denied) {
      if (!field) add("na", "Field rule", "No field chosen: checking the whole record. Hidden fields would be removed from what they see.");
      else {
        const rule = role.fields[rec.kind + "." + field] || "Default";
        const write = M.WRITE.has(act);
        if (M.FIXED_FIELDS[rec.kind + "." + field]) add("pass", "Field rule", `<b>${field}</b> has no role rule; a fixed rule applies (next steps).`);
        else if (rule === "Hidden") fail("Field rule", `<b>${field}</b> is <b>Hidden</b> for ${role.name}.`, `${field} is hidden for the role “${role.name}”.`);
        else if (rule === "Read only" && write) fail("Field rule", `<b>${field}</b> is <b>Read only</b> for ${role.name}.`, `${field} is read only for the role “${role.name}”.`);
        else add("pass", "Field rule", `<b>${field}</b>: ${rule}.`);
      }
    }
    // 7 token / AI
    if (!denied) {
      const v = VIA[via];
      if (!v.scopes) add("na", "Token or AI connection", "Not used: signed in directly.");
      else if (v.scopes === "read") {
        M.WRITE.has(act) ? fail("Token or AI connection", `${v.label} can only read.`, `the AI connection is read only.`)
          : add("pass", "Token or AI connection", `${v.label} may ${act.toLowerCase()}. It can never do more than ${user.name}.`);
      } else {
        (v.scopes[rec.res] || []).includes(act) ? add("pass", "Token or AI connection", `${v.label} has scope ${rec.res} → ${act}.`)
          : fail("Token or AI connection", `${v.label} has no scope for ${rec.res} → ${act}.`, `the API token is not scoped for ${rec.res} → ${act}.`);
      }
    }
    // 8 fixed
    if (!denied) {
      if (field === "Private notes" && rec.notesAuthor !== user.name)
        fail("Fixed rules", `Private notes are only visible to their author (${rec.notesAuthor}). No role, not even Owner, can change this.`, `private notes belong to ${rec.notesAuthor} alone, and no role can ever share them.`);
      else add("pass", "Fixed rules", act === "Move stage" ? "Allowed stages only. Moving to Hired or Rejected is always done by a person." : "No fixed rule blocks this (private notes, shortlists, private saved views).");
    }
    // mark the rest as not reached
    const all = ["Account status", "Team membership", "Team role ceiling", "Configured role", "Record scope", "Field rule", "Token or AI connection", "Fixed rules"];
    all.slice(steps.length).forEach((t) => add("skip", t, "Not reached: an earlier check already denied."));
    return { steps, allowed: !denied, why: denied };
  }

  Admin.register({
    id: "permission-helper", group: "People & access", title: "Permission helper", icon: "help",
    spec: ["PRM-060", "PRM-064"],
    changes: "New. Pick a person, team, record and action to see Allowed or Denied with every check in order and a plain reason.",
    render(ctx) {
      const { ui, data } = ctx;
      const M = window.AccessMock;
      const head = ui.pageHeader("Permission helper", "Why can, or can't, this person do this? Every check runs in order, the same as the app.",
        ui.btn("Permission matrix", { ic: "shield", attrs: `onclick="Admin.navigate('permissions')"` }));
      if (!M) return head + ui.stateBlock("error", { errorText: "The roles model did not load." });
      if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No people to check", emptyText: "Invite a user to a team first.", emptyAction: ui.btn("Invite user", { kind: "primary", attrs: `onclick="Admin.navigate('users?invite=1')"` }) });
      const q = ctx.query;
      const user = data.users.find((u) => u.id === q.get("user")) || data.users.find((u) => u.id === "u-105");
      const myTeams = parseTeams(user).map((t) => t.team);
      const teamName = data.teams.some((t) => t.name === q.get("team")) ? q.get("team") : myTeams[0] || data.teams[0].name;
      const recs = RECORDS.filter((r) => r.team === teamName);
      const rec = recs.find((r) => r.id === q.get("rec")) || recs[0];
      const act = rec && M.APPLIES[rec.res].includes(q.get("act")) ? q.get("act") : "View";
      const fields = rec ? (M.FIELDS[rec.kind] || []) : [];
      const field = fields.includes(q.get("field")) ? q.get("field") : "";
      const via = VIA[q.get("via")] ? q.get("via") : "app";
      const opt = (v, l, sel) => `<option value="${ui.esc(v)}" ${v === sel ? "selected" : ""}>${ui.esc(l)}</option>`;
      const form = `<div class="card"><h2>Check access</h2>
        ${ui.field("Person", `<select class="input" data-q="user">${data.users.map((u) => opt(u.id, `${u.name} · ${u.title}${u.status !== "Active" ? " (" + u.status + ")" : ""}`, user.id)).join("")}</select>`,
          `Home unit: <b>${ui.esc(user.unit)}</b> · Teams: ${parseTeams(user).map((t) => `${ui.esc(t.team)} (${ui.esc(t.membership)}${t.configured ? " · " + ui.esc(t.configured) : ""})`).join(", ") || "none"}`)}
        ${ui.field("Team", `<select class="input" data-q="team">${data.teams.map((t) => opt(t.name, t.name + (myTeams.includes(t.name) ? "" : " (not a member)"), teamName)).join("")}</select>`)}
        ${ui.field("Record", recs.length ? `<select class="input" data-q="rec">${recs.map((r) => opt(r.id, r.label, rec.id)).join("")}</select>` : `<div class="muted small">No sample records in this team.</div>`,
          rec ? `Unit: ${ui.esc(chainOf(data.units, rec.unit))}` : "")}
        ${rec ? ui.field("Action", `<select class="input" data-q="act">${M.APPLIES[rec.res].map((a) => opt(a, a, act)).join("")}</select>`) : ""}
        ${rec ? ui.field("Field (optional)", `<select class="input" data-q="field">${opt("", "Whole record", field)}${fields.map((f) => opt(f, f, field)).join("")}</select>`) : ""}
        ${ui.field("Acting through", `<select class="input" data-q="via">${Object.entries(VIA).map(([k, v]) => opt(k, v.label, via)).join("")}</select>`)}
      </div>
      <div class="card"><h2>Examples</h2><div class="stack">${EXAMPLES.map((e, i) => `<button class="btn ph-ex" data-ex="${i}">${ui.badge(e.tone === "ok" ? "Allowed" : "Denied", e.tone)} ${ui.esc(e.label)}</button>`).join("")}</div></div>`;
      let result = `<div class="card state">${ui.icon("inbox")}<p>Choose a team with records to check.</p></div>`;
      if (rec) {
        const r = evaluate(M, data, user, teamName, rec, act, field, via);
        const subject = `${user.name} → ${act}${field ? " " + field + " on" : ""} ${rec.label}`;
        result = `<div class="card ${r.allowed ? "" : ""}" aria-live="polite">
          <div class="ph-result"><span class="badge ${r.allowed ? "ok" : "bad"}" style="font-size:16px;padding:4px 14px">${r.allowed ? "Allowed" : "Denied"}</span><span class="muted">${ui.esc(subject)}</span></div>
          <div class="callout ${r.allowed ? "ok" : "bad"}" style="margin-top:12px"><b>Why:</b> ${r.allowed
            ? `${ui.esc(user.name)} may ${act.toLowerCase()} this ${rec.kind.toLowerCase()} because every check passed${r.steps[3] ? `: the role grants it` : ""}${r.steps[4] && /unit/.test(r.steps[4].title) ? " and the record sits inside their unit" : ""}.`
            : `${ui.esc(user.name)} cannot ${act.toLowerCase()} this ${rec.kind.toLowerCase()} because ${r.why}`}</div>
          <h3 style="margin-top:16px">Checks, in order</h3>
          <ol class="ph-chain">${r.steps.map((s) => `<li class="${s.state}"><div><b>${ui.esc(s.title)}</b><div class="small muted">${s.detail}</div></div>
            ${s.state === "pass" ? ui.badge("Pass", "ok") : s.state === "fail" ? ui.badge("Denied here", "bad") : s.state === "na" ? ui.badge("Not used", "") : ui.badge("Not reached", "")}</li>`).join("")}</ol>
          <p class="small muted" style="margin:10px 0 0">Each check can only remove access. The same check runs for screens, the API, exports, search, notifications and AI connections.</p></div>`;
      }
      return CSS + `<div id="ph-page">${head}<div class="split" style="grid-template-columns:380px minmax(0,1fr)"><div class="stack">${form}</div><div>${result}</div></div></div>`;
    },
    mount(root, ctx) {
      const page = root.querySelector("#ph-page"); if (!page) return;
      page.addEventListener("change", (e) => {
        const k = e.target.dataset.q; if (!k) return;
        const q = new URLSearchParams(ctx.query); q.set(k, e.target.value);
        if (k === "user") { q.delete("team"); q.delete("rec"); }
        if (k === "team") q.delete("rec");
        if (k === "team" || k === "rec") q.delete("field");
        if (!e.target.value) q.delete(k);
        Admin.navigate("permission-helper?" + q);
      });
      page.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ex]"); if (!b) return;
        Admin.navigate("permission-helper?" + new URLSearchParams(EXAMPLES[+b.dataset.ex].q));
      });
    },
  });
})();
