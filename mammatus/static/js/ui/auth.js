// Sign-in, first-run setup, invite registration and password reset screens.
import { h, $ } from "../util.js";
import { api, post } from "../api.js";
import { logoSVG } from "./logo.js";

const input = (attrs) => h("input", { class: "input", ...attrs });

function card(title, sub, body, foot) {
  return h("div", { class: "auth" }, h("form", { class: "card glass-strong", novalidate: true },
    h("div", { class: "head" }, h("div", { html: logoSVG({ size: 58 }) }), h("h1", {}, title), sub ? h("p", {}, sub) : null),
    ...body, foot ? h("div", { class: "foot" }, foot) : null));
}

function bind(root, handler) {
  const form = $("form", root);
  const err = $(".err", root);
  const btn = $("button[type=submit]", root);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "One moment…";
    try { await handler(Object.fromEntries(new FormData(form))); } catch (ex) {
      err.textContent = ex.status === 429 ? "Too many attempts. Wait a few minutes and try again." : ex.message;
      root.querySelector(".card").animate([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], { duration: 260 });
    } finally { btn.disabled = false; btn.textContent = label; }
  });
}

const pwHint = "At least 10 characters. A short phrase works well.";

export function authFlow(state) {
  return new Promise((resolve) => {
    const hash = new URLSearchParams(location.hash.slice(1));
    let root;
    const mount = (el) => { root?.remove(); root = el; document.body.append(el); el.querySelector("input")?.focus(); };
    const done = () => { root?.remove(); history.replaceState(null, "", location.pathname); resolve(); };

    const login = (msg = "") => {
      mount(card("Welcome back", "Sign in to Mammatus.", [
        h("label", { class: "field" }, h("span", {}, "Username"), input({ name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true })),
        h("label", { class: "field" }, h("span", {}, "Password"), input({ name: "password", type: "password", autocomplete: "current-password", required: true })),
        h("div", { class: "err", role: "alert" }, msg),
        h("button", { class: "btn primary", type: "submit" }, "Sign in"),
      ], "Forgot your password? Ask the admin for a reset link."));
      bind(root, async ({ username, password }) => {
        const r = await post("/auth/login", { username: username.trim(), password });
        if (r.mfa) totp(r.ticket); else done();
      });
    };

    const totp = (ticket) => {
      mount(card("Two-step check", "Enter the 6-digit code from your authenticator app.", [
        h("label", { class: "field" }, h("span", { class: "sr" }, "Code"), input({ name: "code", class: "input codeinput", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, pattern: "[0-9]*", required: true })),
        h("div", { class: "err", role: "alert" }),
        h("button", { class: "btn primary", type: "submit" }, "Verify"),
      ], h("a", { href: "#", onclick: (e) => { e.preventDefault(); login(); } }, "Back to sign in")));
      const code = $("input", root);
      code.addEventListener("input", () => { code.value = code.value.replace(/\D/g, ""); if (code.value.length === 6) $("form", root).requestSubmit(); });
      bind(root, async ({ code }) => { await post("/auth/login/totp", { ticket, code }); done(); });
    };

    const setup = () => {
      mount(card("Set up Mammatus", "Create the admin account. The one-time setup code is printed in the container log.", [
        h("label", { class: "field" }, h("span", {}, "Setup code"), input({ name: "code", autocomplete: "off", spellcheck: "false", required: true, style: { fontFamily: "var(--mono)" } })),
        h("div", { class: "grid2" },
          h("label", { class: "field" }, h("span", {}, "Username"), input({ name: "username", autocomplete: "username", autocapitalize: "none", required: true })),
          h("label", { class: "field" }, h("span", {}, "Display name"), input({ name: "displayName", autocomplete: "name" }))),
        h("label", { class: "field" }, h("span", {}, "Password"), input({ name: "password", type: "password", autocomplete: "new-password", required: true }), h("small", { class: "note" }, pwHint)),
        h("div", { class: "err", role: "alert" }),
        h("button", { class: "btn primary", type: "submit" }, "Create admin account"),
      ]));
      bind(root, async (v) => { await post("/auth/setup", { ...v, username: v.username.trim() }); done(); });
    };

    const register = async (token) => {
      let info;
      try { info = await api(`/auth/invite/${encodeURIComponent(token)}`); } catch (e) { return login("That invite link is invalid or has expired."); }
      mount(card("You're invited", info.note ? `Invite: ${info.note}` : "Create your Mammatus account.", [
        h("div", { class: "grid2" },
          h("label", { class: "field" }, h("span", {}, "Username"), input({ name: "username", autocomplete: "username", autocapitalize: "none", required: true })),
          h("label", { class: "field" }, h("span", {}, "Display name"), input({ name: "displayName", autocomplete: "name" }))),
        h("label", { class: "field" }, h("span", {}, "Password"), input({ name: "password", type: "password", autocomplete: "new-password", required: true }), h("small", { class: "note" }, pwHint)),
        h("div", { class: "err", role: "alert" }),
        h("button", { class: "btn primary", type: "submit" }, "Create account"),
      ], h("a", { href: "#", onclick: (e) => { e.preventDefault(); login(); } }, "I already have an account")));
      bind(root, async (v) => { await post("/auth/register", { ...v, token, username: v.username.trim() }); done(); });
    };

    const reset = async (token) => {
      let info;
      try { info = await api(`/auth/reset/${encodeURIComponent(token)}`); } catch (e) { return login("That reset link is invalid or has expired."); }
      mount(card("Choose a new password", info.username ? `For ${info.username}` : "", [
        h("label", { class: "field" }, h("span", {}, "New password"), input({ name: "password", type: "password", autocomplete: "new-password", required: true }), h("small", { class: "note" }, pwHint)),
        h("div", { class: "err", role: "alert" }),
        h("button", { class: "btn primary", type: "submit" }, "Save password"),
      ]));
      bind(root, async ({ password }) => {
        const r = await post("/auth/reset", { token, password });
        if (r.signin) done(); else login("Password saved. Sign in with it now.");
      });
    };

    if (state.setup) setup();
    else if (hash.get("invite")) register(hash.get("invite"));
    else if (hash.get("reset")) reset(hash.get("reset"));
    else login();
  });
}
