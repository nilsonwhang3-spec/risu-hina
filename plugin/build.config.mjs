// esbuild bundle -> a single IIFE RisuAI plugin file.
//
// Three constraints from Phase 0 shape this config:
//
//   * `eval` and `new Function` are blocked by the plugin iframe's CSP
//     (`script-src 'nonce-...' 'wasm-unsafe-eval'`, measured - docs/01). esbuild
//     never emits eval, but nothing may be added here that would.
//   * `script-src` has no `https:` on PocketRisu, so no external script can be
//     loaded at runtime. Everything must be in this one file.
//   * The `//@name ... //@version` header has to survive verbatim, and
//     `//@version` must land inside the first 500 bytes - RisuAI's update check
//     only reads `Range: bytes=0-512` (plugins.svelte.ts:297-301).
//
// The banner is therefore prepended as-is and kept short.

import { build, context } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

const args = new Set(process.argv.slice(2));
const isWatch = args.has("--watch");
const isMin = args.has("--minify");

const HEADER = resolve(__dirname, "src/plugin-header.txt");
const ENTRY = resolve(__dirname, "src/index.ts");
const OUTFILE = resolve(__dirname, `dist/risu-elf-${pkg.version}.js`);

// Where RisuAI will look for a newer build.
//
// GitHub, not the local backend. The order the user works in is "update the
// plugin from RisuAI, then update the backend from the plugin", so the
// plugin's update source has to work while the backend is down, out of date,
// or on a port this file cannot know.
//
// raw.githubusercontent.com, not `releases/latest/download/...`. RisuAI's
// check (plugins.svelte.ts checkPluginUpdate) is a plain browser `fetch` with
// a Range header from the RisuAI origin, so every hop needs CORS. The release
// URL redirects twice and none of the three responses carries
// Access-Control-Allow-Origin - the check throws and the `+` never shows
// (0.1.0 -> 0.3.0 was never offered on risu.xyz). raw.githubusercontent.com
// answers with `access-control-allow-origin: *` and Accept-Ranges, which is
// why RisuAI's own docs use it. So the release build also commits the bundle
// as plugin/Risu.Elf.Plugin.js (tools/bundle.py) for this URL to serve.
//
// Empty repo means no //@update-url at all rather than a placeholder: a URL
// that 404s makes RisuAI report a failed update check forever, which is worse
// than the honest absence of one.
const REPO = process.env.RISUELF_REPO || pkg.risuelfRepo || "";
const UPDATE_URL = process.env.RISUELF_UPDATE_URL
  || (REPO ? `https://raw.githubusercontent.com/${REPO}/master/plugin/Risu.Elf.Plugin.js` : "");

let banner = readFileSync(HEADER, "utf8").replace(/\$\{VERSION\}/g, pkg.version);
if (UPDATE_URL) {
  banner = banner.replace(/\$\{UPDATE_URL\}/g, UPDATE_URL);
} else {
  banner = banner.replace(/^\/\/@update-url.*\r?\n/m, "");
  console.warn(
    "[build] no //@update-url emitted - set risuelfRepo in package.json " +
    "(or RISUELF_REPO) to enable RisuAI's in-app plugin update."
  );
}

const versionOffset = banner.indexOf("//@version");
if (versionOffset < 0 || versionOffset > 400) {
  console.error(
    `[build] //@version must sit within the first ~400 bytes of the header ` +
    `(found at ${versionOffset}); RisuAI only reads the first 512 bytes when checking for updates.`
  );
  process.exit(1);
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  legalComments: "none",
  banner: { js: banner },
  // Identifiers stay readable even when minifying: a stack trace from inside a
  // sandboxed iframe is hard enough to read without mangled names.
  ...(isMin
    ? { minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false }
    : {}),
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "info",
};

if (isWatch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[build] watching src/ ...");
} else {
  await build(options);
  console.log(`[build] wrote ${OUTFILE}`);
}
