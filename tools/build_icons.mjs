// Render the Mammatus icon set from ui/logo.js with headless Chrome, and refresh everything else
// that embeds the mark: the splash logo in index.html and the animated docs/logo.svg.
// node tools/build_icons.mjs [chromePath]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { iconSVG, logoSVG } from "../mammatus/static/js/ui/logo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const stat = path.join(root, "mammatus/static");
const out = path.join(stat, "icons");
fs.mkdirSync(out, { recursive: true });

const plain = iconSVG({ maskable: false });
const tiny = iconSVG({ maskable: false, detail: "small" });
const mask = iconSVG({ maskable: true });
fs.writeFileSync(path.join(out, "favicon.svg"), tiny.replace(' width="512" height="512"', ""));

// monochrome badge (Android's status bar uses the alpha channel only): a deck with hanging pouches
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="96" height="96"><g fill="#fff">
<rect x="4" y="12" width="56" height="15" rx="7.5"/>
<ellipse cx="15" cy="29" rx="9.5" ry="12"/><ellipse cx="33" cy="31" rx="11.5" ry="17"/><ellipse cx="50" cy="28" rx="8.5" ry="10.5"/>
<ellipse cx="23.5" cy="27" rx="5" ry="8.5"/><ellipse cx="42.5" cy="27" rx="4.5" ry="7.5"/></g></svg>`;

const browser = await puppeteer.launch({ executablePath: process.argv[2] || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
async function render(svg, size, file) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
for (const [svg, size, name] of [
  [plain, 512, "icon-512.png"], [plain, 192, "icon-192.png"], [tiny, 32, "icon-32.png"],
  [mask, 512, "icon-maskable-512.png"], [mask, 180, "apple-touch-icon.png"], [badge, 96, "badge-96.png"],
]) await render(svg, size, path.join(out, name));
await browser.close();
fs.copyFileSync(path.join(out, "icon-512.png"), path.join(root, "icon.png"));

// splash logo, inlined so it animates before any script has loaded
const index = path.join(stat, "index.html");
const splash = logoSVG({ size: 104, loop: true, id: "mms_" }).replace(/\n/g, "");
fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(/<!--logo-->[\s\S]*?<!--\/logo-->/, () => `<!--logo-->${splash}<!--/logo-->`));

// animated, self-contained logo for the README
const css = fs.readFileSync(path.join(stat, "css/logo.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
const art = logoSVG({ size: 200, loop: true, id: "m" }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
fs.writeFileSync(path.join(root, "docs/logo.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" class="mm-logo mm-anim mm-loop" viewBox="0 0 100 100" width="200" height="200" role="img" aria-label="Mammatus"><style>${css}</style>${art}</svg>\n`);
console.log("icons written to", out);
