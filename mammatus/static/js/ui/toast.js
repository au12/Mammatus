import { h } from "../util.js";

let host;
export function toast(title, { body = "", type = "info", ms = 4200, action } = {}) {
  host ||= document.body.appendChild(h("div", { class: "toasts", role: "status", "aria-live": "polite" }));
  const el = h("div", { class: `toast glass-strong ${type}` }, h("i", { class: "ti" }),
    h("div", { style: { flex: 1, minWidth: 0 } }, h("b", {}, title), body ? h("span", {}, body) : null),
    action ? h("button", { class: "btn sm", onclick: () => { action.fn(); close(); } }, action.label) : null);
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 260); };
  el.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON") close(); });
  host.append(el);
  while (host.children.length > 3) host.firstChild.remove();
  if (ms) setTimeout(close, ms);
  return close;
}
export const toastError = (err, title = "Something went wrong") => toast(title, { body: err?.message || String(err), type: "error", ms: 6000 });
