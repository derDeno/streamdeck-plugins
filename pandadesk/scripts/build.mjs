import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

const plugin = "de.pandaboards.pandadesk.sdPlugin";
await mkdir(`${plugin}/bin`, { recursive: true });
await Promise.all([build({
  entryPoints: ["src/plugin.ts"], outfile: `${plugin}/bin/plugin.js`,
  bundle: true, platform: "node", target: "node24", format: "cjs",
}), build({
  entryPoints: ["src/i18n.ts"], outfile: `${plugin}/ui/i18n.js`,
  bundle: true, platform: "browser", target: "chrome130", format: "iife", globalName: "PandaDeskI18n",
})]);
