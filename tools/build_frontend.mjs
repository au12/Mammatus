// Production build: bundle + minify JS/CSS with content hashes, rewrite index.html and sw.js,
// precompress text assets. Output: mammatus/static-dist (served in preference to static/).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../mammatus/static");
const out = path.resolve(here, "../mammatus/static-dist");
const version = process.env.MAMMATUS_BUILD || crypto.randomBytes(4).toString("hex");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "assets"), { recursive: true });

// static files (sources are bundled separately)
const skip = new Set(["js", "css", "dev", "index.html", "sw.js"]);
for (const name of fs.readdirSync(src)) {
  if (skip.has(name)) continue;
  fs.cpSync(path.join(src, name), path.join(out, name), { recursive: true });
}

const common = { bundle: true, minify: true, sourcemap: false, target: ["es2020", "safari15"], legalComments: "none", logLevel: "warning" };

// 1. worker
const w = await esbuild.build({ ...common, entryPoints: [path.join(src, "js/data/frame-worker.js")], outdir: path.join(out, "assets"),
  entryNames: "worker-[hash]", format: "esm", metafile: true });
const workerFile = Object.keys(w.metafile.outputs).find((f) => f.endsWith(".js"));
const workerUrl = "/assets/" + path.basename(workerFile);

// 2. app (code-split: settings + QR vendor load on demand)
const a = await esbuild.build({ ...common, entryPoints: [path.join(src, "js/main.js")], outdir: path.join(out, "assets"),
  entryNames: "app-[hash]", chunkNames: "chunk-[hash]", splitting: true, format: "esm", metafile: true,
  define: { __WORKER_URL__: JSON.stringify(workerUrl) } });
const appFile = Object.entries(a.metafile.outputs).find(([, o]) => o.entryPoint)?.[0];

// 3. css
const c = await esbuild.build({ ...common, entryPoints: [path.join(src, "css/app.css")], outdir: path.join(out, "assets"),
  entryNames: "app-[hash]", metafile: true, loader: { ".css": "css" } });
const cssFile = Object.keys(c.metafile.outputs).find((f) => f.endsWith(".css"));

const rel = (f) => "/assets/" + path.basename(f);
let html = fs.readFileSync(path.join(src, "index.html"), "utf8");
html = html.replace('href="/css/app.css"', `href="${rel(cssFile)}"`)
  .replace('src="/js/main.js"', `src="${rel(appFile)}"`)
  .replace("</head>", `<link rel="modulepreload" href="${workerUrl}">\n</head>`);
fs.writeFileSync(path.join(out, "index.html"), html);

// 4. service worker with the precache list
const assets = fs.readdirSync(path.join(out, "assets")).filter((f) => !f.startsWith("chunk-")).map((f) => `/assets/${f}`);
const precache = ["/", ...assets, "/manifest.webmanifest", "/icons/icon-192.png?v=3", "/icons/badge-96.png?v=3", "/data/boundaries.bin", "/data/stars.bin", "/data/cities.json"];
let sw = fs.readFileSync(path.join(src, "sw.js"), "utf8");
sw = sw.replace('const VERSION = "dev";', `const VERSION = ${JSON.stringify(version)};`)
  .replace(/const PRECACHE = \[[^\]]*\];/, `const PRECACHE = ${JSON.stringify(precache)};`);
fs.writeFileSync(path.join(out, "sw.js"), (await esbuild.transform(sw, { minify: true, target: "es2020" })).code);

// 5. precompress
const textExt = new Set([".js", ".css", ".html", ".json", ".svg", ".webmanifest", ".bin", ".mjs"]);
let raw = 0, gz = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!textExt.has(path.extname(e.name))) continue;
    const buf = fs.readFileSync(p);
    if (buf.length < 1024) continue;
    const z = zlib.gzipSync(buf, { level: 9 });
    if (z.length < buf.length * 0.92) { fs.writeFileSync(p + ".gz", z); raw += buf.length; gz += z.length; }
  }
};
walk(out);
fs.writeFileSync(path.join(out, "BUILD"), `${version}\n`);
const size = (f) => (fs.statSync(path.join(out, "assets", path.basename(f))).size / 1024).toFixed(1);
console.log(`built ${version}: app ${size(appFile)} kB, worker ${size(workerFile)} kB, css ${size(cssFile)} kB; text ${(raw / 1024).toFixed(0)} kB -> ${(gz / 1024).toFixed(0)} kB gzip`);
