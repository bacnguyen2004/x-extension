import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "background"), { recursive: true });
mkdirSync(join(dist, "content"), { recursive: true });
mkdirSync(join(dist, "sidepanel"), { recursive: true });
mkdirSync(join(dist, "icons"), { recursive: true });

await esbuild.build({
  entryPoints: [join(root, "src/background/service-worker.ts")],
  outfile: join(dist, "background/service-worker.js"),
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [join(root, "src/content/x-navigation-guard.ts")],
  outfile: join(dist, "content/x-navigation-guard.js"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [join(root, "src/content/x-content.ts")],
  outfile: join(dist, "content/x-content.js"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [join(root, "src/sidepanel/sidepanel.ts")],
  outfile: join(dist, "sidepanel/sidepanel.js"),
  bundle: true,
  format: "iife",
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
});

cpSync(join(root, "src/sidepanel/sidepanel.html"), join(dist, "sidepanel/sidepanel.html"));
cpSync(join(root, "src/sidepanel/sidepanel.css"), join(dist, "sidepanel/sidepanel.css"));

const iconsSrc = join(root, "src/icons");
for (const name of ["icon16.png", "icon48.png", "icon128.png", "brand.png"]) {
  cpSync(join(iconsSrc, name), join(dist, "icons", name));
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.icons = {
  "16": "icons/icon16.png",
  "48": "icons/icon48.png",
  "128": "icons/icon128.png",
};
manifest.action = {
  ...manifest.action,
  default_icon: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
  },
};
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log("Built dist/ — Load unpacked: x-extension/dist");
