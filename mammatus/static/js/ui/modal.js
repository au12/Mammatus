// Modal shell: optional left nav of sections, focus trap-lite, Esc to close.
import { h } from "../util.js";
import { icon } from "./icons.js";

export function openModal({ title, sections, initial, width, onClose }) {
  const back = h("div", { class: "modal-back", role: "dialog", "aria-modal": "true", "aria-label": title });
  const pane = h("div", { class: "pane" });
  const nav = sections.length > 1 ? h("nav") : null;
  const modal = h("div", { class: "modal glass-strong", style: width ? { width } : null },
    h("div", { class: "mh" }, h("b", {}, title), h("button", { class: "closex", "aria-label": "Close", html: icon("x", 18), onclick: () => close() })),
    h("div", { class: "mb", style: nav ? null : { gridTemplateColumns: "1fr" } }, nav, pane));
  back.append(modal);
  let current = null;
  const show = async (id) => {
    const s = sections.find((x) => x.id === id) || sections[0];
    current = s.id;
    if (nav) [...nav.children].forEach((b) => b.classList.toggle("sel", b.dataset.id === s.id));
    pane.replaceChildren();
    pane.scrollTop = 0;
    try { await s.render(pane, { refresh: () => show(current), close }); } catch (err) { pane.append(h("div", { class: "warnbox" }, err.message || String(err))); }
  };
  if (nav) for (const s of sections) nav.append(h("button", { "data-id": s.id, onclick: () => show(s.id) }, s.label));
  const onKey = (e) => { if (e.key === "Escape") close(); };
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add("open"));
  show(initial || sections[0].id);
  function close() {
    document.removeEventListener("keydown", onKey);
    back.classList.remove("open");
    setTimeout(() => back.remove(), 220);
    onClose?.();
  }
  return { close, show };
}

export function confirmDialog(message, { ok = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title: "Are you sure?", width: "min(420px, 100%)",
      sections: [{ id: "c", render: (p) => {
        p.append(h("p", { style: { margin: "0 0 18px", color: "var(--text-2)" } }, message),
          h("div", { class: "row", style: { justifyContent: "flex-end" } },
            h("button", { class: "btn", onclick: () => { done = true; m.close(); resolve(false); } }, "Cancel"),
            h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => { done = true; m.close(); resolve(true); } }, ok)));
      } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", { class: "note" }, hint) : null);
export const toggleRow = (title, sub, on, onChange) => {
  const sw = h("button", { class: `switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(!!on), "aria-label": title });
  sw.addEventListener("click", async () => {
    const next = !sw.classList.contains("on");
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    try { await onChange(next); } catch (e) { sw.classList.toggle("on", !next); throw e; }
  });
  return h("div", { class: "toggle" }, h("div", { class: "tt" }, h("b", {}, title), sub ? h("small", {}, sub) : null), sw);
};
export const seg = (options, value, onChange) => {
  const el = h("div", { class: "seg", role: "radiogroup" });
  for (const [v, label] of options) {
    el.append(h("button", { class: v === value ? "sel" : "", role: "radio", "aria-checked": String(v === value), onclick: (e) => {
      [...el.children].forEach((b) => { b.classList.remove("sel"); b.setAttribute("aria-checked", "false"); });
      e.currentTarget.classList.add("sel");
      e.currentTarget.setAttribute("aria-checked", "true");
      onChange(v);
    } }, label));
  }
  return el;
};

export function promptDialog(title, { label = "Name", value = "", ok = "Save", placeholder = "" } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title, width: "min(420px, 100%)",
      sections: [{ id: "p", render: (p) => {
        const inp = h("input", { class: "input", value, placeholder, maxlength: 60 });
        const form = h("form", {}, field(label, inp), h("div", { class: "row", style: { justifyContent: "flex-end" } },
          h("button", { class: "btn", type: "button", onclick: () => { done = true; m.close(); resolve(null); } }, "Cancel"),
          h("button", { class: "btn primary", type: "submit" }, ok)));
        form.addEventListener("submit", (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; done = true; m.close(); resolve(v); });
        p.append(form);
        setTimeout(() => { inp.focus(); inp.select(); }, 60);
      } }],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}
