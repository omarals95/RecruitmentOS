/* Admin home. Pattern example for every page file. */
Admin.register({
  id: "home",
  group: "Overview",
  title: "Admin home",
  icon: "home",
  spec: ["UI-001", "OBS-001"],
  changes: "New. Today the Admin portal opens on the first tab; there is no overview.",
  render(ctx) {
    const { ui, data } = ctx;
    const head = ui.pageHeader("Admin home", `Everything you administer for <b>${ui.esc(data.company.name)}</b> in one place.`,
      ui.btn("Invite user", { kind: "primary", ic: "users", attrs: `onclick="Admin.navigate('users?invite=1')"` }));
    if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "No activity yet", emptyText: "Changes you and other admins make will show up here." });
    const attention = [
      ["warn", "2 users have not set up two-step sign-in", "users?filter=no-2fa"],
      ["warn", "Workflow “Engineering hiring” has a draft with 1 problem", "workflows"],
      ["bad", "DMARC record missing for recruitmentos.ae", "mail"],
      ["", "Field “Notice period” is not used on any screen", "fields"],
    ];
    return head + `
      <div class="grid g4" style="margin-bottom:16px">
        ${ui.kpi("Active users", "6", "1 invited · 1 suspended")}
        ${ui.kpi("Teams", data.teams.length, "19 members in total")}
        ${ui.kpi("Published workflows", "3", "1 draft in progress")}
        ${ui.kpi("Storage used", "318 KB", "of 5 GB CV storage")}
      </div>
      <div class="split">
        <div class="stack">
          <div class="card"><h2>Needs your attention</h2><ul class="list-plain">
            ${attention.map(([tone, t, href]) => `<li class="row"><span class="badge ${tone || "info"}">${tone === "bad" ? "Fix" : tone === "warn" ? "Check" : "Tidy"}</span><a href="#/${href}">${ui.esc(t)}</a></li>`).join("")}
          </ul></div>
          <div class="card"><h2>Recent admin changes</h2>${ui.table(["When", "Who", "Change"], [
            ["10:31", "Omar Alshair", "Published role <b>Recruiter, no CV upload</b> (version 2)"],
            ["09:58", "Mariam Al Suwaidi", "Added unit <b>Platform Engineering</b> under Engineering"],
            ["Yesterday", "Omar Alshair", "Changed brand colour to <code>#4338CA</code>"],
          ])}<p style="margin:8px 0 0"><a href="#/audit">Open audit log</a></p></div>
        </div>
        <div class="stack">
          <div class="card"><h2>System</h2>
            <div class="row" style="justify-content:space-between"><span>Health</span>${ui.badge("All checks passing", "ok")}</div>
            <div class="row" style="justify-content:space-between;margin-top:8px"><span>Typical page speed</span><b>230 ms</b></div>
            <div class="row" style="justify-content:space-between;margin-top:8px"><span>Mail delivery (24 h)</span><b>40 sent · 1 retrying</b></div>
            <p style="margin:10px 0 0"><a href="#/health">Open health &amp; monitoring</a></p></div>
          <div class="card"><h2>Shortcuts</h2><div class="stack">
            <a href="#/roles">Roles &amp; permissions</a><a href="#/workflows">Workflow designer</a><a href="#/fields">Custom fields</a><a href="#/branding">Look &amp; feel</a></div></div>
        </div>
      </div>`;
  },
});
