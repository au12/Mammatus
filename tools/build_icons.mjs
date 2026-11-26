// Render the Mammatus icon set from ui/logo.js with headless Chrome.
// node tools/build_icons.mjs [chromePath]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { iconSVG, logoSVG } from "../mammatus/static/js/ui/logo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "mammatus/static/icons");
fs.mkdirSync(out, { recursive: true });

const plain = iconSVG({ maskable: false });
const mask = iconSVG({ maskable: true });
fs.writeFileSync(path.join(out, "favicon.svg"), plain.replace('width="512" height="512"', ""));
// monochrome badge (Android status bar uses alpha only)
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="96" height="96"><g transform="translate(0 14)">${
  logoSVG({ animate: false }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "").replace(/<defs>[\s\S]*<\/defs>/, "").replace(/fill="url\(#[^)]+\)"/g, 'fill="#fff"')}</g></svg>`;

const browser = await puppeteer.launch({ executablePath: process.argv[2] || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
async function render(svg, size, file, transparent = false) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:${transparent ? "transparent" : "#000"}">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
for (const [svg, size, name, tr] of [
  [plain, 512, "icon-512.png", true], [plain, 192, "icon-192.png", true], [plain, 32, "icon-32.png", true],
  [mask, 512, "icon-maskable-512.png"], [mask, 180, "apple-touch-icon.png"], [badge, 96, "badge-96.png", true],
]) await render(svg, size, path.join(out, name), tr);
fs.copyFileSync(path.join(out, "icon-512.png"), path.join(root, "icon.png"));
// animated logo preview for the README
fs.writeFileSync(path.join(root, "docs/logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="160" height="160"><style>.mm-lobe{transform-box:fill-box;transform-origin:50% 0;animation:f 1.25s cubic-bezier(.25,1.35,.45,1) both;animation-delay:var(--d)}.mm-base{animation:b .7s both}@keyframes f{0%{transform:scale(.55,0);opacity:0}35%{opacity:1}100%{transform:none;opacity:1}}@keyframes b{0%{opacity:0}100%{opacity:1}}</style>${logoSVG({ animate: false }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</svg>`);
await browser.close();
console.log("icons written to", out);
