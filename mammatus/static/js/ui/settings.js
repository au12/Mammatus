// Settings & admin: units, display, notifications (push devices + rules), account security, users, system.
import { h, copyText, esc } from "../util.js";
import { icon } from "./icons.js";
import { get, post, patch, put, del } from "../api.js";
import { openModal, field, toggleRow, seg, confirmDialog } from "./modal.js";
import { toast, toastError } from "./toast.js";
import { units, setUnits } from "../units.js";
import { ago, full, timeZone, setTimeZone } from "../time.js";
import { logoSVG } from "./logo.js";
import * as pwa from "../pwa.js";

const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} kB`);
const when = (ts) => (ts ? ago(ts * 1000) : "never");

export function openSettings(app, initial) {
  const sections = [
    { id: "general", label: "General", render: (p) => general(app, p) },
    { id: "notifications", label: "Notifications", render: (p, ctx) => notifications(app, p, ctx) },
    { id: "account", label: "Account", render: (p, ctx) => account(app, p, ctx) },
  ];
  if (app.user.role === "admin") {
    sections.push({ id: "users", label: "Users", render: (p, ctx) => users(app, p, ctx) },
      { id: "system", label: "System", render: (p, ctx) => system(app, p, ctx) });
  }
  sections.push({ id: "about", label: "About", render: (p) => about(app, p) });
  return openModal({ title: "Settings", sections, initial });
}

// ------------------------------------------------------------------ general
function general(app, p) {
  const U = units();
  const set = (k, v) => { const next = { ...units(), [k]: v }; setUnits(next); app.savePref("units", next); app.onUnitsChanged(); };
  p.append(h("h4", {}, "Units"),
    h("div", { class: "grid2" },
      field("Temperature", seg([["F", "°F"], ["C", "°C"]], U.temp, (v) => set("temp", v))),
      field("Precipitation", seg([["in", "in"], ["mm", "mm"]], U.precip, (v) => { set("precip", v); set("snow", v === "mm" ? "cm" : "in"); })),
      field("Wind", seg([["mph", "mph"], ["kt", "kt"], ["kmh", "km/h"], ["ms", "m/s"]], U.wind, (v) => set("wind", v))),
      field("Pressure", seg([["mb", "mb"], ["inHg", "inHg"]], U.pressure, (v) => set("pressure", v))),
      field("Distance", seg([["mi", "mi"], ["km", "km"]], U.dist, (v) => set("dist", v))),
      field("Height", seg([["ft", "ft"], ["m", "m"]], U.height, (v) => set("height", v)))));
  const tzSel = h("select", { class: "input" });
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [timeZone()];
  const cur = app.prefs.tz || app.catalog.tz || timeZone();
  for (const z of zones) tzSel.append(h("option", { value: z, selected: z === cur }, z.replace(/_/g, " ")));
  tzSel.addEventListener("change", () => { setTimeZone(tzSel.value); app.savePref("tz", tzSel.value); app.onUnitsChanged(); });
  p.append(h("h4", {}, "Time"), field("Time zone", tzSel, "Times across the app use this zone."));
  p.append(h("h4", {}, "Display"),
    toggleRow("Smooth transitions", "Cross-fade between forecast hours.", app.prefs.smooth !== false, (v) => app.savePref("smooth", v)),
    toggleRow("Animate lightning", "Bolts flash as strikes happen, and replay in the order they happened when they come into view. Off shows still bolts; also off when the system asks for reduced motion.", app.prefs.lightningAnim !== false, (v) => { app.savePref("lightningAnim", v); app.lightning.wake(); app.renderer.requestRender(); }),
    toggleRow("Battery saver", "Fewer wind particles, animation capped at 30 fps and sooner idle. On by default for phones.", app.renderer.lowPower, (v) => { app.savePref("lowPower", v); toast("Battery saver changes apply after reload", { action: { label: "Reload", fn: () => location.reload() } }); }),
    toggleRow("Remember map position", "Reopen where you left off.", app.prefs.rememberView !== false, (v) => app.savePref("rememberView", v)));
  const opacity = h("input", { type: "range", min: 40, max: 100, value: Math.round((app.prefs.opacity ?? 0.88) * 100), style: { width: "100%", accentColor: "#c3a8ff" } });
  opacity.addEventListener("input", () => { app.savePref("opacity", opacity.value / 100, true); app.applyOpacity(); });
  p.append(field("Layer opacity", opacity));
}

// ------------------------------------------------------------------ notifications
async function notifications(app, p, ctx) {
  const support = pwa.pushSupport();
  p.append(h("h4", {}, "This device"));
  const state = h("div");
  p.append(state);
  const renderState = async () => {
    state.replaceChildren();
    if (!support.ok) { state.append(h("div", { class: "warnbox" }, support.reason)); return; }
    const sub = await pwa.currentSubscription();
    state.append(toggleRow("Push notifications", sub ? "This device will get alerts even when Mammatus is closed." : "Get alerts on this device even when the app is closed.", !!sub, async (on) => {
      try {
        if (on) { await pwa.subscribe(app.catalog.vapid); toast("Notifications on", { body: "This device is subscribed.", type: "ok" }); }
        else { await pwa.unsubscribe(); toast("Notifications off for this device"); }
      } catch (err) { toastError(err, "Couldn't change notifications"); }
      renderState(); renderDevices();
    }));
    if (sub) state.append(h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn sm", onclick: async () => {
      try { const r = await post("/push/test"); toast(r.sent ? "Test sent" : "No devices reached", { body: r.sent ? `Delivered to ${r.sent} device${r.sent > 1 ? "s" : ""}.` : "Try turning notifications off and on.", type: r.sent ? "ok" : "error" }); } catch (err) { toastError(err); }
    } }, h("span", { html: icon("send", 14) }), "Send a test")));
  };
  await renderState();

  p.append(h("h4", {}, "Your devices"));
  const devices = h("div", { class: "list" });
  p.append(devices);
  const renderDevices = async () => {
    const list = await get("/push/devices");
    devices.replaceChildren(...(list.length ? list.map((d) => h("div", { class: "item" },
      h("div", {}, h("b", {}, d.label), h("small", {}, `${d.service} · added ${when(d.created)} · last delivery ${when(d.lastOk)}`)),
      h("button", { class: "closex", title: "Remove", html: icon("trash", 16), onclick: async () => { await del(`/push/devices/${d.id}`); renderDevices(); renderState(); } }))) : [h("div", { class: "note" }, "No devices subscribed yet.")]));
  };
  await renderDevices();

  p.append(h("h4", {}, "Rules"));
  const rulesBox = h("div", { class: "list" });
  p.append(rulesBox);
  const pointName = (id) => app.points.find((x) => x.id === id)?.name || "Removed place";
  const metrics = app.catalog.metrics;
  const describe = (r) => {
    const pp = r.params;
    if (r.kind === "nws") return [`NWS ${pp.types || "warnings"} at ${pointName(r.pointId)}`, `${pp.minSeverity || "Moderate"} or worse`];
    if (r.kind === "threshold") { const m = metrics[pp.metric]; return [`${m.label} ${pp.metric === "tmin" ? "≤" : "≥"} ${pp.value} ${m.unit} at ${pointName(r.pointId)}`, `Within ${pp.hours || 48} h, any of ${pp.models?.length || "the default"} models`]; }
    if (r.kind === "precip_soon") return [`Precipitation starting soon at ${pointName(r.pointId)}`, "About 1 hour ahead, from 15-minute forecasts"];
    if (r.kind === "run") return [`New ${app.model(pp.model)?.short || pp.model} run`, pp.complete ? "When the run finishes" : "When the first hours arrive"];
    return [r.kind, ""];
  };
  const renderRules = async () => {
    const rules = await get("/rules");
    rulesBox.replaceChildren(...rules.map((r) => {
      const [t, s] = describe(r);
      const sw = h("button", { class: `switch${r.enabled ? " on" : ""}`, "aria-label": "Enabled", onclick: async () => {
        r.enabled = !r.enabled; sw.classList.toggle("on", r.enabled);
        await put(`/rules/${r.id}`, { kind: r.kind, pointId: r.pointId, params: r.params, enabled: r.enabled }).catch(toastError);
      } });
      return h("div", { class: "item", style: { gridTemplateColumns: "1fr auto auto" } }, h("div", {}, h("b", {}, t), h("small", {}, s)), sw,
        h("button", { class: "closex", title: "Delete", html: icon("trash", 16), onclick: async () => { await del(`/rules/${r.id}`); renderRules(); } }));
    }));
    if (!rules.length) rulesBox.append(h("div", { class: "note" }, "No rules yet. Add one below — for example, warnings at home, or 4+ inches of snow in the next 3 days."));
  };
  await renderRules();

  // add rule form
  const form = h("div", { class: "glass", style: { padding: "14px", marginTop: "12px", boxShadow: "none", background: "rgba(255,255,255,.03)" } });
  p.append(form);
  let kind = "nws";
  const drawForm = () => {
    form.replaceChildren(h("div", { style: { marginBottom: "10px" } }, seg([["nws", "NWS alerts"], ["threshold", "Threshold"], ["precip_soon", "Rain soon"], ["run", "New run"]], kind, (v) => { kind = v; drawForm(); })));
    const needsPoint = kind !== "run";
    if (needsPoint && !app.points.length) { form.append(h("div", { class: "note" }, "Save a place first: tap the map, then the star in the details panel.")); return; }
    const pointSel = h("select", { class: "input" }, ...app.points.map((x) => h("option", { value: x.id }, x.name)));
    const inputs = {};
    if (needsPoint) form.append(field("Place", pointSel));
    if (kind === "nws") {
      inputs.types = h("select", { class: "input" }, h("option", { value: "warnings" }, "Warnings"), h("option", { value: "watches" }, "Warnings and watches"), h("option", { value: "all" }, "Everything, including advisories"));
      inputs.minSeverity = h("select", { class: "input" }, ...["Minor", "Moderate", "Severe", "Extreme"].map((s) => h("option", { value: s, selected: s === "Moderate" }, s)));
      form.append(h("div", { class: "grid2" }, field("Types", inputs.types), field("Minimum severity", inputs.minSeverity)));
    } else if (kind === "threshold") {
      inputs.metric = h("select", { class: "input" }, ...Object.entries(metrics).map(([k, m]) => h("option", { value: k }, `${m.label} (${m.unit})`)));
      inputs.value = h("input", { class: "input", type: "number", step: "any", value: "4" });
      inputs.hours = h("select", { class: "input" }, ...[[24, "24 hours"], [48, "2 days"], [72, "3 days"], [120, "5 days"], [168, "7 days"]].map(([v, l]) => h("option", { value: v, selected: v === 72 }, l)));
      form.append(h("div", { class: "grid2" }, field("Metric", inputs.metric), field("Value", inputs.value)), field("Look ahead", inputs.hours, "Fires once when the models first agree, and again only if it gets worse."));
    } else if (kind === "precip_soon") {
      form.append(h("p", { class: "note", style: { margin: "0 0 10px" } }, "Get a heads-up when rain or snow is about to start, using 15-minute forecasts. Checks every 10 minutes."));
    } else if (kind === "run") {
      inputs.model = h("select", { class: "input" }, ...app.catalog.models.map((m) => h("option", { value: m.id }, m.name)));
      inputs.complete = h("select", { class: "input" }, h("option", { value: "0" }, "When the first hours arrive"), h("option", { value: "1" }, "When the run is complete"));
      form.append(h("div", { class: "grid2" }, field("Model", inputs.model), field("Notify", inputs.complete)));
    }
    form.append(h("button", { class: "btn primary", onclick: async () => {
      const params = {};
      if (kind === "nws") Object.assign(params, { types: inputs.types.value, minSeverity: inputs.minSeverity.value });
      if (kind === "threshold") Object.assign(params, { metric: inputs.metric.value, value: +inputs.value.value, hours: +inputs.hours.value });
      if (kind === "run") Object.assign(params, { model: inputs.model.value, complete: inputs.complete.value === "1" });
      try {
        await post("/rules", { kind, pointId: needsPoint ? +pointSel.value : null, params, enabled: true });
        toast("Rule added", { type: "ok", body: (await pwa.currentSubscription()) ? "" : "Turn on push for this device to get it when the app is closed." });
        renderRules();
      } catch (err) { toastError(err); }
    } }, h("span", { html: icon("plus", 15) }), "Add rule"));
  };
  drawForm();
}

// ------------------------------------------------------------------ account
async function account(app, p, ctx) {
  const me = app.user;
  const name = h("input", { class: "input", value: me.displayName || "", maxlength: 60 });
  p.append(h("h4", {}, "Profile"), h("div", { class: "row", style: { alignItems: "flex-end", flexWrap: "nowrap" } },
    h("div", { style: { flex: 1 } }, field("Display name", name)),
    h("button", { class: "btn", style: { marginBottom: "12px" }, onclick: async () => { await patch("/auth/me", { displayName: name.value }); me.displayName = name.value || me.username; app.renderAvatar(); toast("Saved", { type: "ok" }); } }, "Save")),
  h("p", { class: "note", style: { marginTop: "-6px" } }, `Signed in as ${me.username}${me.role === "admin" ? " (admin)" : ""}.`));

  // password
  const cur = h("input", { class: "input", type: "password", autocomplete: "current-password" });
  const nw = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  p.append(h("h4", {}, "Password"), h("div", { class: "grid2" }, field("Current", cur), field("New", nw, "10+ characters.")),
    h("button", { class: "btn", onclick: async () => {
      try { await post("/auth/password", { current: cur.value, new: nw.value }); cur.value = nw.value = ""; toast("Password changed", { body: "Other sessions were signed out.", type: "ok" }); } catch (err) { toastError(err, "Password not changed"); }
    } }, "Change password"));

  // 2FA
  p.append(h("h4", {}, "Two-step verification"));
  const tf = h("div");
  p.append(tf);
  const renderTotp = () => {
    tf.replaceChildren();
    if (me.totp) {
      const pw = h("input", { class: "input", type: "password", placeholder: "Password" });
      const code = h("input", { class: "input codeinput", inputmode: "numeric", maxlength: 6, placeholder: "123456" });
      tf.append(h("div", { class: "row", style: { marginBottom: "10px" } }, h("span", { class: "pill ok" }, "On"), h("span", { class: "note" }, "Codes from your authenticator app are required at sign-in.")),
        h("div", { class: "grid2" }, field("Password", pw), field("Current code", code)),
        h("button", { class: "btn danger", onclick: async () => {
          try { await post("/auth/totp/disable", { code: code.value, password: pw.value }); me.totp = false; renderTotp(); toast("Two-step verification turned off"); } catch (err) { toastError(err); }
        } }, "Turn off"));
    } else {
      tf.append(h("p", { class: "note", style: { margin: "0 0 10px" } }, "Add a second step at sign-in with an authenticator app (1Password, Google Authenticator, Authy…). Strongly recommended for accounts reachable from the internet."),
        h("button", { class: "btn", onclick: async () => {
          try {
            const { secret, uri } = await post("/auth/totp/setup");
            const { default: qrcode } = await import("../vendor/qrcode.mjs");
            const qr = qrcode(0, "M"); qr.addData(uri); qr.make();
            const code = h("input", { class: "input codeinput", inputmode: "numeric", maxlength: 6, placeholder: "123456" });
            tf.replaceChildren(h("div", { style: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "16px", alignItems: "start" } },
              h("div", { class: "qr", html: qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) }),
              h("div", {}, h("p", { class: "note", style: { marginTop: 0 } }, "Scan with your authenticator app, or enter this key:"),
                h("div", { class: "copyline", style: { marginBottom: "10px" } }, h("input", { class: "input", readonly: true, value: secret.replace(/(.{4})/g, "$1 ").trim() }),
                  h("button", { class: "btn icon", title: "Copy", html: icon("copy", 16), onclick: () => copyText(secret).then(() => toast("Copied")) })),
                field("Then enter the 6-digit code", code),
                h("button", { class: "btn primary", onclick: async () => {
                  try { await post("/auth/totp/enable", { code: code.value }); me.totp = true; renderTotp(); toast("Two-step verification is on", { type: "ok" }); } catch (err) { toastError(err, "Code didn't match"); }
                } }, "Verify and turn on"))));
          } catch (err) { toastError(err); }
        } }, h("span", { html: icon("shield", 15) }), "Set up"));
    }
  };
  renderTotp();

  // sessions
  p.append(h("h4", {}, "Signed-in sessions"));
  const sess = h("div", { class: "list" });
  p.append(sess);
  const renderSessions = async () => {
    const list = await get("/auth/sessions");
    sess.replaceChildren(...list.map((s) => h("div", { class: "item" },
      h("div", {}, h("b", {}, deviceName(s.agent), s.current ? h("span", { class: "pill accent", style: { marginLeft: "8px" } }, "This device") : null),
        h("small", {}, `${s.ip || "unknown IP"} · active ${when(s.lastSeen)} · since ${when(s.created)}`)),
      s.current ? null : h("button", { class: "btn sm", onclick: async () => { await del(`/auth/sessions/${s.id}`); renderSessions(); } }, "Sign out"))));
  };
  await renderSessions();
  p.append(h("div", { class: "row", style: { marginTop: "18px" } }, h("button", { class: "btn danger", onclick: () => app.logout() }, h("span", { html: icon("logout", 15) }), "Sign out")));
}

function deviceName(ua = "") {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}

// ------------------------------------------------------------------ admin: users & invites
async function users(app, p, ctx) {
  p.append(h("h4", {}, "Invite someone"));
  const note = h("input", { class: "input", placeholder: "Who is this for? (optional)", maxlength: 80 });
  const role = h("select", { class: "input" }, h("option", { value: "user" }, "User"), h("option", { value: "admin" }, "Admin"));
  const out = h("div");
  p.append(h("div", { class: "grid2" }, field("Note", note), field("Role", role)),
    h("button", { class: "btn primary", onclick: async () => {
      try {
        const r = await post("/admin/invites", { note: note.value || null, role: role.value, days: 7 });
        const inp = h("input", { class: "input", readonly: true, value: r.url });
        out.replaceChildren(h("div", { class: "copyline", style: { marginTop: "10px" } }, inp, h("button", { class: "btn", onclick: () => copyText(r.url).then(() => toast("Invite link copied", { type: "ok" })) }, h("span", { html: icon("copy", 15) }), "Copy")),
          h("p", { class: "note" }, `Single use, expires ${full(new Date(r.expires * 1000))}. Send it privately.`));
        if (navigator.share) out.append(h("button", { class: "btn sm", onclick: () => navigator.share({ title: "Join me on Mammatus", url: r.url }).catch(() => {}) }, h("span", { html: icon("share", 14) }), "Share…"));
        renderInvites();
      } catch (err) { toastError(err); }
    } }, h("span", { html: icon("plus", 15) }), "Create invite link"), out);

  const inv = h("div", { class: "list" });
  p.append(h("h4", {}, "Pending invites"), inv);
  const renderInvites = async () => {
    const list = (await get("/admin/invites")).filter((i) => !i.used && i.expires * 1000 > Date.now());
    inv.replaceChildren(...(list.length ? list.map((i) => h("div", { class: "item" }, h("div", {}, h("b", {}, i.note || "Invite"), h("small", {}, `${i.role} · expires ${full(new Date(i.expires * 1000))}`)),
      h("button", { class: "btn sm", onclick: async () => { await del(`/admin/invites/${i.id}`); renderInvites(); } }, "Revoke"))) : [h("div", { class: "note" }, "None.")]));
  };
  await renderInvites();

  p.append(h("h4", {}, "Users"));
  const tbl = h("table", { class: "t" });
  p.append(h("div", { style: { overflowX: "auto" } }, tbl));
  const renderUsers = async () => {
    const list = await get("/admin/users");
    tbl.replaceChildren(h("tr", {}, h("th", {}, "User"), h("th", {}, "Role"), h("th", {}, "Last seen"), h("th", {}, "")));
    for (const u of list) {
      const self = u.id === app.user.id;
      const menu = h("div", { class: "row", style: { justifyContent: "flex-end", flexWrap: "nowrap" } });
      if (!self) {
        menu.append(
          h("button", { class: "btn sm", title: "Create a password reset link", onclick: async () => {
            const r = await post(`/admin/users/${u.id}/reset`); await copyText(r.url); toast("Reset link copied", { body: "Valid for 2 days, single use.", type: "ok" });
          } }, "Reset"),
          h("button", { class: "btn sm", onclick: async () => { await patch(`/admin/users/${u.id}`, { disabled: !u.disabled }); renderUsers(); } }, u.disabled ? "Enable" : "Disable"),
          h("button", { class: "btn sm danger icon", title: "Delete user", html: icon("trash", 14), onclick: async () => {
            if (await confirmDialog(`Delete ${u.username}? Their places, rules and devices are removed too.`, { ok: "Delete", danger: true })) { await del(`/admin/users/${u.id}`); renderUsers(); }
          } }));
      }
      const roleSel = h("select", { class: "input", style: { height: "30px", width: "auto" }, disabled: self }, h("option", { value: "user", selected: u.role === "user" }, "User"), h("option", { value: "admin", selected: u.role === "admin" }, "Admin"));
      roleSel.addEventListener("change", async () => { try { await patch(`/admin/users/${u.id}`, { role: roleSel.value }); } catch (err) { toastError(err); renderUsers(); } });
      tbl.append(h("tr", {},
        h("td", {}, h("b", {}, u.displayName || u.username), h("div", { class: "note" }, `${u.username}${u.totp ? " · 2FA" : ""}${u.disabled ? " · disabled" : ""}`)),
        h("td", {}, roleSel), h("td", { class: "note" }, when(u.lastSeen || u.lastLogin)), h("td", {}, menu)));
    }
  };
  await renderUsers();
}

// ------------------------------------------------------------------ admin: system
async function system(app, p, ctx) {
  const s = await get("/admin/system");
  const hrs = (sec) => (sec > 86400 ? `${(sec / 86400).toFixed(1)} days` : `${(sec / 3600).toFixed(1)} h`);
  const rows = [
    ["Version", s.version], ["Uptime", hrs(s.uptime)], ["Users", s.users], ["Live connections", s.listeners],
    ["Frame cache", `${fmtBytes(s.cache.bytes)} of ${fmtBytes(s.cache.cap)}`],
    ["Terrain", !s.terrain ? "—" : s.terrain.enabled ? `${fmtBytes(s.terrain.bytes)} of ${fmtBytes(s.terrain.cap)} cached` : "off (MAMMATUS_TERRAIN_URL)"],
    ["Disk free", s.disk ? `${fmtBytes(s.disk.free)} of ${fmtBytes(s.disk.total)}` : "—"],
    ["Public URL", s.publicUrl || "not set (invite links use the request host)"], ["Open-Meteo", `${s.openMeteoUrl} · ${s.openMeteoCalls} calls`],
  ];
  p.append(h("h4", {}, "Server"), h("table", { class: "t" }, ...rows.map(([k, v]) => h("tr", {}, h("td", { class: "note" }, k), h("td", {}, String(v))))));
  p.append(h("h4", {}, "Model runs"), h("table", { class: "t" }, h("tr", {}, h("th", {}, "Model"), h("th", {}, "Latest"), h("th", {}, "Checked"), h("th", {}, "Status")),
    ...Object.entries(s.runs).map(([m, r]) => h("tr", {}, h("td", {}, app.model(m)?.short || m), h("td", { class: "num" }, r.latest ? `${r.latest.slice(0, 8)} ${r.latest.slice(8)}z` : "—"),
      h("td", { class: "note" }, r.polled ? ago(r.polled * 1000) : "—"), h("td", {}, r.error ? h("span", { class: "pill warn", title: r.error }, "Retrying") : h("span", { class: "pill ok" }, "OK"))))));
  const st = s.stats || {};
  p.append(h("h4", {}, "Frame pipeline"), h("p", { class: "note" }, Object.entries(st).map(([k, v]) => `${k}: ${typeof v === "number" ? (v > 1e6 ? fmtBytes(v) : Math.round(v * 100) / 100) : v}`).join(" · ")),
    h("button", { class: "btn", onclick: async () => {
      if (!(await confirmDialog("Clear all cached frames? They'll be rebuilt on demand.", { ok: "Clear cache", danger: true }))) return;
      await post("/admin/cache/clear"); toast("Cache cleared", { type: "ok" }); ctx.refresh();
    } }, h("span", { html: icon("trash", 15) }), "Clear frame cache"));
  const audit = await get("/admin/audit");
  p.append(h("h4", {}, "Security log"), h("div", { style: { maxHeight: "300px", overflow: "auto" } }, h("table", { class: "t" },
    ...audit.slice(0, 200).map((a) => h("tr", {}, h("td", { class: "note", style: { whiteSpace: "nowrap" } }, ago(a.ts * 1000)), h("td", {}, a.event), h("td", { class: "note" }, [a.user, a.ip, a.detail].filter(Boolean).join(" · ")))))));
}

// ------------------------------------------------------------------ about
function about(app, p) {
  p.append(h("div", { style: { display: "grid", justifyItems: "center", gap: "10px", padding: "10px 0 6px", textAlign: "center" } },
    h("div", { html: logoSVG({ size: 76, loop: true, cls: "mm-brief" }) }), h("h3", { style: { margin: 0, fontWeight: 650, letterSpacing: ".02em" } }, "Mammatus"),
    h("span", { class: "note" }, `Version ${app.catalog.version}`)),
  h("h4", {}, "Data"),
  h("p", { class: "note" }, "Model data: NOAA HRRR, RRFS and GFS via the NOAA Open Data Dissemination program; ECMWF IFS and AIFS open data (CC BY 4.0). Radar: NOAA MRMS. Lightning: NOAA GOES-R Geostationary Lightning Mapper. Fronts: NWS Weather Prediction Center. Satellite: courtesy of SSEC, University of Wisconsin–Madison (RealEarth). Alerts: National Weather Service. Point forecasts and soundings: Open-Meteo (CC BY 4.0). Basemap: Natural Earth and US Census via us-atlas. Earth imagery: NASA Blue Marble and Black Marble. Stars: Yale Bright Star Catalog."),
  h("h4", {}, "Keyboard"),
  h("table", { class: "t" }, ...[["Space", "Play / pause"], ["← →", "Previous / next hour"], ["/", "Search"], ["L", "Layer picker"], ["G", "Globe / map"], ["F", "Forecast for the selected point"], ["Esc", "Close"]].map(([k, v]) => h("tr", {}, h("td", {}, h("span", { class: "kbd" }, k)), h("td", {}, v)))));
}
