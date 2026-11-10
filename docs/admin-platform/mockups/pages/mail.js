/* Outgoing mail: provider (Resend or SMTP), sender, domain authentication, queue, limits. Spec 07 §1-§2. */
(function () {
  const S = {
    provider: "resend", // active provider
    choice: "resend", // radio selection in the form
    smtp: { host: "smtp.alnoor.example.test", port: "587", enc: "STARTTLS", user: "recruitment-mailer", from: "no-reply@recruitmentos.ae" },
    sender: { name: "RecruitmentOS · Al Noor Holding", address: "no-reply@recruitmentos.ae", replyTo: "talent@example.test", prefix: "[RecruitmentOS]", actorName: true },
    dmarc: "missing",
    qFilter: "All",
    paused: false,
    redirect: false,
    queue: [
      { id: "m-9834", to: "layla.hassan@example.test", subject: "Interview booked: Fatima Al Zaabi on Wednesday 12 November", event: "Interview scheduled", status: "Queued", when: "12 s ago", attempts: 0 },
      { id: "m-9833", to: "rahul.menon@example.test", subject: "Arjun Nair moved to Assessment", event: "Application moved stage", status: "Queued", when: "40 s ago", attempts: 0 },
      { id: "m-9832", to: "sara.haddad@example.test", subject: "New applicant for Senior Data Analyst: Omar Farouk", event: "Candidate applied", status: "Sending", when: "Now", attempts: 1 },
      { id: "m-9829", to: "khalid.almansoori@example.test", subject: "Approve offer for Hannah Clarke?", event: "Offer needs approval", status: "Failed", when: "Today 10:31", attempts: 3, error: "Provider timeout after 30 s (Resend 504). Next automatic try in 8 minutes (4 of 5)." },
      { id: "m-9828", to: "mariam.alsuwaidi@example.test", subject: "Approve offer for Hannah Clarke?", event: "Offer needs approval", status: "Sent", when: "Today 10:31", attempts: 1 },
      { id: "m-9821", to: "rahul.menon@example.test", subject: "Your RecruitmentOS summary for today", event: "Daily digest", status: "Sent", when: "Today 08:00", attempts: 1 },
      { id: "m-9790", to: "rahul.menon@example.test", subject: "Your CV import has finished", event: "CV import finished", status: "Sent", when: "Yesterday 17:22", attempts: 1 },
      { id: "m-9702", to: "daniel.okafor@example.test", subject: "Feedback needed: Hannah Clarke", event: "Interview feedback due", status: "Failed", when: "8 Nov 16:45", attempts: 5, error: "Gave up after 5 tries: recipient account is suspended." },
      { id: "m-9688", to: "noura.alketbi@example.test", subject: "Change to your interview with Arjun Nair", event: "Interview changed or cancelled", status: "Failed", when: "8 Nov 11:20", attempts: 5, error: "550 5.7.1 Message rejected by the receiving server: sender domain has no DMARC policy." },
    ],
    suppressed: [{ email: "old.candidate@example.test", reason: "3 hard bounces (mailbox does not exist)", since: "2 Nov 2026" }],
  };
  const esc = Admin.ui.esc;
  const N = (s) => `<bdi dir="ltr">${s}</bdi>`;
  const tone = (s) => ({ Queued: "", Sending: "info", Sent: "ok", Failed: "bad", Cancelled: "" }[s] || "");
  const sw = (on, attrs = "") => `<label class="ml-sw"><input type="checkbox" ${on ? "checked" : ""} ${attrs}><span></span></label>`;

  const STYLE = `<style>
    .ml-sw{position:relative;display:inline-block;width:34px;height:20px;vertical-align:middle;flex:none}
    .ml-sw input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
    .ml-sw span{position:absolute;inset:0;border-radius:999px;background:var(--border-strong);transition:background .15s;pointer-events:none}
    .ml-sw span::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:14px;height:14px;border-radius:50%;background:var(--surface);transition:inset-inline-start .15s}
    .ml-sw input:checked+span{background:var(--primary)}
    .ml-sw input:checked+span::after{inset-inline-start:17px}
    .ml-sw input:focus-visible+span{outline:2px solid var(--focus);outline-offset:2px}
    .ml-opt{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--border-strong);border-radius:12px;padding:14px;cursor:pointer;background:var(--surface)}
    .ml-opt.on{border-color:var(--primary);box-shadow:0 0 0 2px var(--primary-soft)}
    .ml-opt input{margin-top:3px}
    .ml-pre{background:var(--surface-subtle);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;margin:0;direction:ltr;text-align:left}
    .ml-val{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;direction:ltr;unicode-bidi:embed}
    .ml-chips{display:flex;gap:6px;flex-wrap:wrap}
    .ml-chips button.on{background:var(--primary-soft);color:var(--primary-text);border-color:var(--primary)}
    .ml-kv{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;margin:0}
    .ml-kv dt{color:var(--muted)} .ml-kv dd{margin:0}
    .ml-line{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
    .ml-line:last-child{border-bottom:0}
  </style>`;

  // ---------- Provider & sender ----------
  function providerTab() {
    const c = S.choice, s = S.smtp, snd = S.sender;
    const opt = (id, title, desc, badge) => `<label class="ml-opt ${c === id ? "on" : ""}"><input type="radio" name="ml-prov" value="${id}" ${c === id ? "checked" : ""} onchange="MailPage.choose('${id}')">
      <div style="flex:1"><div class="row" style="justify-content:space-between"><b>${title}</b>${badge}</div><div class="small muted" style="margin-top:4px">${desc}</div></div></label>`;
    const resendBox = `<div class="card" style="margin-top:12px"><h3>Resend</h3>
        <dl class="ml-kv"><dt>Status</dt><dd>${S.provider === "resend" ? Admin.ui.badge("Connected", "ok") : Admin.ui.badge("Not in use", "")} <span class="small muted">last message accepted 2 minutes ago</span></dd>
        <dt>API key</dt><dd><span class="ml-val">re_••••••••••••3f9a</span> ${Admin.ui.btn("Replace", { kind: "sm", attrs: `onclick="Admin.toast('Paste a new key to replace it (mockup). Keys are stored encrypted and never shown again.')"` })}</dd>
        <dt>Region</dt><dd>Ireland (eu-west-1)</dd><dt>Bounces</dt><dd>Reported back to RecruitmentOS automatically</dd></dl></div>`;
    const smtpBox = `<div class="card" style="margin-top:12px"><h3>Custom SMTP server</h3>
        <div class="grid g2">
          ${Admin.ui.field("Server (host)", Admin.ui.input(s.host, `id="ml-host"`))}
          ${Admin.ui.field("Port", Admin.ui.input(s.port, `id="ml-port" inputmode="numeric"`), "587 for STARTTLS, 465 for TLS")}
          ${Admin.ui.field("Encryption", Admin.ui.select(["STARTTLS", "TLS"], s.enc, `id="ml-enc"`))}
          ${Admin.ui.field("Username", Admin.ui.input(s.user, `id="ml-user" autocomplete="off"`))}
          ${Admin.ui.field("Password", `<input class="input" type="password" id="ml-pass" placeholder="•••••••• set · type to replace" autocomplete="new-password">`, "Stored encrypted. Never shown again after saving.")}
          ${Admin.ui.field("From address", Admin.ui.input(s.from, `id="ml-from"`), "Must be allowed by your mail server.")}
        </div>
        <div class="row">${Admin.ui.btn("Test connection", { ic: "plug", attrs: `onclick="MailPage.testConnection()"` })}<span class="small muted" id="ml-test-state">Not tested yet</span></div></div>`;
    const switchRow = c !== S.provider ? `<div class="callout warn" style="margin-top:12px"><div class="row" style="justify-content:space-between"><span>You are switching to <b>${c === "smtp" ? "a custom SMTP server" : "Resend"}</b>. Nothing changes until you save.</span>
        <span class="row">${Admin.ui.btn("Save and switch", { kind: "primary", attrs: `onclick="MailPage.confirmSwitch()"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="MailPage.choose('${S.provider}')"` })}</span></div></div>` : "";
    return `<div class="split">
      <div>
        <h2>How email is sent</h2>
        <div class="grid g2">
          ${opt("resend", "Resend", "Recommended. Nothing to run; handles bounces and delivery reports.", S.provider === "resend" ? Admin.ui.badge("Default · connected", "ok") : Admin.ui.badge("Available", ""))}
          ${opt("smtp", "Custom SMTP server", "Use your own mail server, for example Microsoft 365 or an on-site relay.", S.provider === "smtp" ? Admin.ui.badge("In use", "ok") : Admin.ui.badge("Not set up", ""))}
        </div>
        ${c === "resend" ? resendBox : smtpBox}${switchRow}
      </div>
      <div class="card"><h2>Sender</h2>
        ${Admin.ui.field("Sender name", Admin.ui.input(snd.name, `id="ml-sname"`))}
        ${Admin.ui.field("Sender address", Admin.ui.input(snd.address, `id="ml-saddr"`), "Must be on an authenticated domain: <b>recruitmentos.ae</b>")}
        ${Admin.ui.field("Reply-to", Admin.ui.input(snd.replyTo, `id="ml-reply"`), "Where replies go. Leave empty to block replies.")}
        ${Admin.ui.field("Subject prefix", Admin.ui.input(snd.prefix), "Added to the start of every subject.")}
        ${Admin.ui.check("Show who made the change, e.g. “Sara Haddad via RecruitmentOS”", snd.actorName)}
        <div class="row" style="margin-top:14px">${Admin.ui.btn("Save sender", { kind: "primary", attrs: `onclick="Admin.toast('Sender saved (mockup). Recorded in the audit log.')"` })}</div>
      </div></div>`;
  }

  // ---------- Domain ----------
  function domainTab() {
    const rec = [
      ["SPF", "TXT", "send.recruitmentos.ae", "v=spf1 include:amazonses.com ~all", "ok", "Lets Resend send for this domain"],
      ["Bounce", "MX", "send.recruitmentos.ae", "10 feedback-smtp.eu-west-1.amazonses.com", "ok", "Bounce reports come back here"],
      ["DKIM", "TXT", "resend._domainkey.recruitmentos.ae", "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7v1…QIDAQAB", "ok", "Signs every message so it cannot be faked"],
      ["DMARC", "TXT", "_dmarc.recruitmentos.ae", S.dmarc === "ok" ? "v=DMARC1; p=none; rua=mailto:dmarc-reports@recruitmentos.ae" : "No record found", S.dmarc, "Tells mail providers what to do with fakes"],
    ];
    const rows = rec.map(([chk, type, host, val, st, why]) => [
      `<b>${chk}</b><div class="small muted">${why}</div>`, `<code>${type}</code>`, `<span class="ml-val">${esc(host)}</span>`,
      `<span class="ml-val ${st === "missing" ? "muted" : ""}">${esc(val)}</span>`,
      st === "ok" ? Admin.ui.badge("OK", "ok") : Admin.ui.badge("Missing", "bad"),
    ]);
    const dmarcVal = "v=DMARC1; p=none; rua=mailto:dmarc-reports@recruitmentos.ae";
    return `<div class="row" style="justify-content:space-between;margin-bottom:12px">
        <div><h2 style="margin:0">recruitmentos.ae</h2><div class="small muted">Sending domain · last checked <span id="ml-checked">today 11:40</span></div></div>
        <div class="row">${S.dmarc === "ok" ? Admin.ui.badge("3 of 3 checks pass", "ok") : Admin.ui.badge("2 of 3 checks pass", "warn")}${Admin.ui.btn("Check again", { ic: "activity", attrs: `onclick="MailPage.checkDns()"` })}</div></div>
      ${S.dmarc !== "ok" ? `<div class="callout bad" style="margin-bottom:16px"><b>Add a DMARC record.</b> Without it, Gmail and Outlook are more likely to send RecruitmentOS emails to spam, and one receiving server already rejected a message. Ask whoever manages DNS for recruitmentos.ae to add:
        <div class="grid g3" style="margin-top:10px">
          ${Admin.ui.field("Type", `<div class="ml-pre">TXT</div>`)}${Admin.ui.field("Name / host", `<div class="ml-pre">_dmarc</div>`)}${Admin.ui.field("TTL", `<div class="ml-pre">3600</div>`)}</div>
        ${Admin.ui.field("Value", `<div class="row" style="flex-wrap:nowrap"><div class="ml-pre" style="flex:1">${dmarcVal}</div>${Admin.ui.btn("Copy", { attrs: `onclick="MailPage.copy('${dmarcVal}')"` })}</div>`, "Start with <code>p=none</code> (report only). After two weeks of clean reports, change it to <code>p=quarantine</code>.")}</div>` : `<div class="callout ok" style="margin-bottom:16px">All records found. Mail from recruitmentos.ae is fully authenticated.</div>`}
      ${Admin.ui.table(["Check", "Type", "Name", "Value", "Status"], rows)}
      <p class="small muted">DNS changes can take up to 48 hours to show. The app address (recruitmentos-preview.vercel.app today) is set on the <a href="#/domain">Domain</a> page and is separate from the sending domain.</p>`;
  }

  // ---------- Queue ----------
  function queueRows() {
    const list = S.queue.filter((m) => S.qFilter === "All" || m.status === S.qFilter);
    if (!list.length) return `<div class="card state">${Admin.icon("inbox")}<h2>Nothing ${S.qFilter.toLowerCase()}</h2><p class="muted">No messages with this status right now.</p></div>`;
    return Admin.ui.table(["Message", "To", "Status", "When", "Tries", ""], list.map((m) => [
      `<a href="javascript:void 0" onclick="MailPage.view('${m.id}')"><b>${esc(m.subject)}</b></a><div class="small muted">${esc(m.event)} · ${m.id}</div>${m.error ? `<div class="small" style="color:var(--danger)">${esc(m.error)}</div>` : ""}`,
      `<span class="small">${esc(m.to)}</span>`, Admin.ui.badge(m.status, tone(m.status)), `<span class="small"><bdi>${esc(m.when)}</bdi></span>`, m.attempts,
      `<div class="row" style="flex-wrap:nowrap">${m.status === "Failed" ? Admin.ui.btn("Retry", { kind: "sm", attrs: `onclick="MailPage.retry('${m.id}')"` }) : ""}${m.status === "Failed" || m.status === "Queued" ? Admin.ui.btn("Cancel", { kind: "sm", attrs: `onclick="MailPage.cancel('${m.id}')"` }) : ""}${Admin.ui.btn("View", { kind: "sm ghost", attrs: `onclick="MailPage.view('${m.id}')"` })}</div>`,
    ]));
  }
  function queueTab() {
    const n = (s) => S.queue.filter((m) => m.status === s).length;
    const failed = n("Failed");
    return `<div class="grid g4" style="margin-bottom:16px">
        ${Admin.ui.kpi("Queued", n("Queued"), "Oldest waiting 40 s")}
        ${Admin.ui.kpi("Sending", n("Sending"), "About 6 a minute right now")}
        ${Admin.ui.kpi("Sent (24 h)", "41", "<bdi>0 bounced</bdi>")}
        ${Admin.ui.kpi("Failed", failed, "<bdi>1 in the last 24 h · 2 older</bdi>")}</div>
      <div class="toolbar"><div class="ml-chips" role="group" aria-label="Filter by status">${["All", "Queued", "Sending", "Sent", "Failed"].map((s) => `<button class="btn sm ${S.qFilter === s ? "on" : ""}" aria-pressed="${S.qFilter === s}" onclick="MailPage.filter('${s}')">${s}${s !== "All" ? ` (${n(s)})` : ""}</button>`).join("")}</div>
        <span style="flex:1"></span>${failed ? Admin.ui.btn(`Retry all failed (${failed})`, { attrs: `onclick="MailPage.retryAll()"` }) : ""}</div>
      <div id="ml-queue">${queueRows()}</div>
      <p class="small muted">Every message is sent from the queue, never during a click. Failed messages are tried up to 5 times, waiting 1, 2, 4, 8 and then 16 minutes. Cancelled messages are kept in the <a href="#/notifications?tab=log">delivery log</a>.</p>`;
  }

  // ---------- Limits & safety ----------
  function limitsTab() {
    return `<div class="grid g2">
      <div class="card"><h2>Sending limits</h2>
        ${Admin.ui.field("Messages per minute", Admin.ui.select(["30", "60", "120", "300"], "120"), "Stay under your provider's limit. Resend allows about 120.")}
        ${Admin.ui.field("Messages per day", `<div class="row">${Admin.ui.input("3000", `style="width:110px" inputmode="numeric"`)}<span class="muted small">Warn admins at 80 %</span></div>`)}
        <div class="small muted" style="margin-bottom:4px">Used today: ${N("41 of 3,000")}</div>${Admin.ui.bar(41 / 30)}
        <div style="margin-top:12px">${Admin.ui.field("Per person", `<span>200 emails an hour, then the rest go into the digest. <a href="#/notifications?tab=defaults">Change in Notifications</a></span>`)}</div>
        ${Admin.ui.field("Tries before giving up", Admin.ui.select(["3", "5", "8"], "5"))}
        ${Admin.ui.btn("Save limits", { kind: "primary", attrs: `onclick="Admin.toast('Limits saved (mockup)')"` })}
      </div>
      <div class="stack">
        <div class="card"><h2>Safety switches</h2>
          <div class="ml-line"><div><b>Pause all outgoing mail</b><div class="small muted">Messages wait in the queue until you turn this off.</div></div>${sw(S.paused, `aria-label="Pause all outgoing mail" onchange="MailPage.pause(this)"`)}</div>
          <div class="ml-line"><div><b>Send everything to one test address</b><div class="small muted">For trying things out. Nobody else gets mail.</div></div>${sw(S.redirect, `aria-label="Redirect all mail" onchange="MailPage.redirect(this.checked)"`)}</div>
          ${S.redirect ? Admin.ui.field("Test address", Admin.ui.input("mail-capture@example.test")) : ""}
        </div>
        <div class="card"><h2>Bounces</h2>
          ${Admin.ui.field("Stop sending to an address after", Admin.ui.select(["1 hard bounce", "3 hard bounces", "5 hard bounces"], "3 hard bounces"), "The person's profile is flagged so an admin can fix the address.")}
          <h3>Blocked addresses</h3>
          ${Admin.ui.table(["Address", "Reason", "Since", ""], S.suppressed.map((x, i) => [`<span class="small">${esc(x.email)}</span>`, `<span class="small">${esc(x.reason)}</span>`, `<span class="small">${esc(x.since)}</span>`, Admin.ui.btn("Unblock", { kind: "sm", attrs: `onclick="MailPage.unblock(${i})"` })]), { empty: "No blocked addresses." })}
        </div>
      </div></div>`;
  }

  window.MailPage = {
    choose(id) { S.choice = id; Admin.rerender(); },
    testConnection() {
      const g = (id) => (document.getElementById(id) || {}).value || "";
      const host = g("ml-host") || S.smtp.host, port = g("ml-port") || S.smtp.port, enc = g("ml-enc") || S.smtp.enc, user = g("ml-user") || S.smtp.user;
      const ok = host.includes(".") && /^\d+$/.test(port);
      const lines = ok ? `Connecting to ${host}:${port} …\n< 220 ${host} ESMTP ready\n> EHLO recruitmentos.ae\n< 250-${host}\n< 250-SIZE 36700160\n< 250 ${enc === "STARTTLS" ? "STARTTLS" : "AUTH LOGIN PLAIN"}\n${enc === "STARTTLS" ? "> STARTTLS\n< 220 Ready to start TLS\n" : ""}TLS 1.3 established\n> AUTH LOGIN (as ${user})\n< 235 2.7.0 Authentication successful\n> QUIT\n< 221 Bye` : `Connecting to ${host}:${port} …\n! Could not resolve or connect to the server after 10 s.`;
      Admin.modal(`<h2>${ok ? "Connection works" : "Could not connect"}</h2>
        ${ok ? `<div class="callout ok" style="margin-bottom:10px">Signed in to ${esc(host)} using ${esc(enc)}.</div>` : `<div class="callout bad" style="margin-bottom:10px">Check the host name and port, and that the server allows connections from Vercel.</div>`}
        <h3>What the server said</h3><pre class="ml-pre">${esc(lines)}</pre><p class="small muted">The password is never shown in this log.</p>
        <div class="row">${Admin.ui.btn("Close", { kind: "primary", attrs: `onclick="Admin.close()"` })}</div>`);
      const st = document.getElementById("ml-test-state"); if (st) st.innerHTML = ok ? Admin.ui.badge("Test passed just now", "ok") : Admin.ui.badge("Test failed", "bad");
    },
    confirmSwitch() {
      const to = S.choice === "smtp" ? "your SMTP server" : "Resend";
      Admin.modal(`<h2>Send all email through ${to}?</h2>
        <ul><li>Affects every team: about 40 emails a day</li><li>3 messages waiting in the queue will go through ${to}</li><li>${S.choice === "smtp" ? "Bounce reports will not come back automatically; you will need a bounce mailbox" : "Resend reports bounces back automatically"}</li></ul>
        <div class="callout warn" style="margin-bottom:12px">Send a test email after switching.</div>
        <div class="row">${Admin.ui.btn("Switch provider", { kind: "primary", attrs: `onclick="MailPage.doSwitch()"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
    },
    doSwitch() { S.provider = S.choice; Admin.close(); Admin.rerender(); Admin.toast(`Email now goes through ${S.provider === "smtp" ? "your SMTP server" : "Resend"} (mockup). Recorded in the audit log.`); },
    sendTest() {
      Admin.modal(`<h2>Send a test email</h2><p class="muted" style="margin-top:0">Goes through ${S.provider === "smtp" ? "your SMTP server" : "Resend"} from ${esc(S.sender.address)}.</p>
        ${Admin.ui.field("Send to", Admin.ui.input("omar.alshair@example.test", `id="ml-to" type="email"`))}
        ${Admin.ui.field("Message", Admin.ui.select(["Short test message", "Interview scheduled (with sample record)", "Daily digest (with sample data)"], "Short test message", `id="ml-what"`))}
        <div id="ml-result"></div>
        <div class="row" style="margin-top:12px">${Admin.ui.btn("Send test", { kind: "primary", attrs: `id="ml-send" onclick="MailPage.doSend()"` })}${Admin.ui.btn("Close", { attrs: `onclick="Admin.close()"` })}</div>`);
    },
    doSend() {
      const to = document.getElementById("ml-to").value.trim(), out = document.getElementById("ml-result");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { out.innerHTML = `<div class="callout bad">Enter a valid email address.</div>`; return; }
      out.innerHTML = `<div class="callout">Sending…</div>`; document.getElementById("ml-send").disabled = true;
      setTimeout(() => {
        if (!document.getElementById("ml-result")) return;
        out.innerHTML = `<div class="callout ok"><b>Accepted by ${S.provider === "smtp" ? "smtp.alnoor.example.test" : "Resend"}.</b> Check ${esc(to)} (and the spam folder) in a minute.</div>
          <details style="margin-top:8px"><summary class="small">Provider response</summary><pre class="ml-pre">${S.provider === "smtp" ? "250 2.0.0 OK queued as 4Rz7Lk1m" : '{ "id": "re_8f1c2b7d4e9a", "status": "accepted" }'}</pre></details>
          ${S.dmarc !== "ok" ? `<p class="small muted">DMARC is still missing, so some inboxes may mark it as spam.</p>` : ""}`;
        document.getElementById("ml-send").disabled = false;
      }, 700);
    },
    checkDns() {
      const el = document.getElementById("ml-checked"); if (el) el.textContent = "just now";
      Admin.toast(S.dmarc === "ok" ? "All records found" : "Checked just now: DMARC still missing. DNS changes can take up to 48 hours.");
    },
    copy(v) { (navigator.clipboard ? navigator.clipboard.writeText(v).catch(() => {}) : Promise.resolve()); Admin.toast("Copied DMARC value"); },
    filter(s) { S.qFilter = s; Admin.rerender(); },
    retry(id) { const m = S.queue.find((x) => x.id === id); m.status = "Queued"; m.when = "Just now"; m.error = ""; Admin.rerender(); Admin.toast("Back in the queue (mockup). Recorded in the audit log."); },
    retryAll() { S.queue.filter((m) => m.status === "Failed").forEach((m) => { m.status = "Queued"; m.when = "Just now"; m.error = ""; }); Admin.rerender(); Admin.toast("All failed messages are back in the queue (mockup)"); },
    cancel(id) {
      const m = S.queue.find((x) => x.id === id);
      Admin.modal(`<h2>Cancel this email?</h2><p>“${esc(m.subject)}” to ${esc(m.to)} will not be sent. It stays in the delivery log as cancelled.</p>
        <div class="row">${Admin.ui.btn("Cancel email", { kind: "danger", attrs: `onclick="MailPage.doCancel('${id}')"` })}${Admin.ui.btn("Keep it", { attrs: `onclick="Admin.close()"` })}</div>`);
    },
    doCancel(id) { const m = S.queue.find((x) => x.id === id); m.status = "Cancelled"; m.error = ""; Admin.close(); Admin.rerender(); Admin.toast("Email cancelled (mockup)"); },
    view(id) {
      const m = S.queue.find((x) => x.id === id);
      Admin.drawer(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">Message ${m.id}</h2>${Admin.ui.btn("Close", { kind: "ghost", attrs: `onclick="Admin.close()"` })}</div>
        <div class="row" style="margin:8px 0 12px">${Admin.ui.badge(m.status, tone(m.status))}<span class="small muted">${esc(m.when)} · ${m.attempts} ${m.attempts === 1 ? "try" : "tries"}</span></div>
        ${m.error ? `<div class="callout bad" style="margin-bottom:12px">${esc(m.error)}</div>` : ""}
        <dl class="ml-kv"><dt>Subject</dt><dd>${esc(S.sender.prefix)} ${esc(m.subject)}</dd><dt>To</dt><dd>${esc(m.to)}</dd><dt>From</dt><dd>${esc(S.sender.name)} &lt;${esc(S.sender.address)}&gt;</dd><dt>Reply-to</dt><dd>${esc(S.sender.replyTo)}</dd><dt>Event</dt><dd>${esc(m.event)}</dd><dt>Sent through</dt><dd>${S.provider === "smtp" ? "Custom SMTP" : "Resend"}</dd></dl>
        <h3 style="margin-top:16px">Headers</h3>
        <pre class="ml-pre">Message-ID: &lt;${m.id}@recruitmentos.ae&gt;\nList-Unsubscribe: &lt;https://recruitmentos-preview.vercel.app/me/notifications&gt;\nX-RecruitmentOS-Event: ${esc(m.event)}\nContent-Type: multipart/alternative (HTML + plain text)</pre>
        <div class="row" style="margin-top:12px">${m.status === "Failed" ? Admin.ui.btn("Retry", { kind: "primary", attrs: `onclick="Admin.close();MailPage.retry('${m.id}')"` }) : ""}${Admin.ui.btn("Open delivery log", { kind: "ghost", attrs: `onclick="Admin.close();Admin.navigate('notifications?tab=log')"` })}</div>`);
    },
    pause(el) {
      if (!el.checked) { S.paused = false; Admin.rerender(); Admin.toast("Outgoing mail resumed (mockup)"); return; }
      el.checked = false;
      Admin.modal(`<h2>Pause all outgoing mail?</h2><ul><li>Every team stops getting emails, including interview invites and offer approvals</li><li>About 6 emails an hour will wait in the queue</li><li>In-app notifications keep working</li></ul>
        <div class="row">${Admin.ui.btn("Pause mail", { kind: "danger", attrs: `onclick="MailPage.doPause()"` })}${Admin.ui.btn("Cancel", { attrs: `onclick="Admin.close()"` })}</div>`);
    },
    doPause() { S.paused = true; Admin.close(); Admin.rerender(); Admin.toast("All outgoing mail paused (mockup)"); },
    redirect(on) { S.redirect = on; Admin.rerender(); },
    unblock(i) { const x = S.suppressed.splice(i, 1)[0]; Admin.rerender(); Admin.toast(`${x.email} unblocked (mockup)`); },
  };

  Admin.register({
    id: "mail",
    group: "Communication",
    title: "Outgoing mail",
    icon: "mail",
    spec: ["NTF-001", "EML-001", "EML-002", "EML-003", "EML-004", "EML-005", "EML-006"],
    changes: "New. Today Resend is set in environment variables only; admins can now see the sender, switch to their own SMTP server, check domain records, send a test and manage the mail queue.",
    render(ctx) {
      const { ui } = ctx;
      const tab = ctx.query.get("tab") || "provider";
      const head = ui.pageHeader("Outgoing mail", "How RecruitmentOS sends email, who it comes from, and what is waiting to go out.",
        ui.btn("Send test email", { kind: "primary", ic: "mail", attrs: `onclick="MailPage.sendTest()"` }));
      if (ctx.state !== "normal") return head + ui.stateBlock(ctx.state, { emptyTitle: "Email is not set up", emptyText: "Connect Resend or your own SMTP server so people get interview invites, approvals and digests by email.", emptyAction: ui.btn("Connect Resend", { kind: "primary", attrs: `onclick="Admin.toast('Opens Resend connection (mockup)')"` }) });
      const failed = S.queue.filter((m) => m.status === "Failed").length;
      const status = `${S.paused ? `<div class="callout bad" style="margin-bottom:12px"><b>All outgoing mail is paused.</b> Messages are waiting in the queue. <a href="#/mail?tab=limits">Resume</a></div>` : ""}
        ${S.redirect ? `<div class="callout warn" style="margin-bottom:12px"><b>Test mode:</b> all email goes to mail-capture@example.test.</div>` : ""}
        <div class="grid g4" style="margin-bottom:16px">
        ${ui.kpi("Provider", S.provider === "smtp" ? "SMTP" : "Resend", S.provider === "smtp" ? "smtp.alnoor.example.test" : ui.badge("Connected", "ok"))}
        ${ui.kpi("Domain", N(S.dmarc === "ok" ? "3 / 3" : "2 / 3"), S.dmarc === "ok" ? "All records OK" : `<a href="#/mail?tab=domain" style="color:var(--danger)">DMARC missing: fix</a>`)}
        ${ui.kpi("Sent (24 h)", "41", (() => { const n = S.queue.filter((m) => m.status === "Failed" && m.when.startsWith("Today")).length; return n ? `<bdi>${n} failed · retrying</bdi>` : "0 failed"; })())}
        ${ui.kpi("Waiting / failed", N(`${S.queue.filter((m) => m.status === "Queued").length} / ${failed}`), `<a href="#/mail?tab=queue">Open mail queue</a>`)}</div>`;
      const tabs = ui.tabs("mail", [{ id: "provider", label: "Provider & sender" }, { id: "domain", label: "Domain authentication" }, { id: "queue", label: "Mail queue" }, { id: "limits", label: "Limits & safety" }], tab);
      const body = tab === "domain" ? domainTab() : tab === "queue" ? queueTab() : tab === "limits" ? limitsTab() : providerTab();
      return STYLE + head + status + tabs + body;
    },
  });
})();
