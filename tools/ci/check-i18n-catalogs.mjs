#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import config from "../../apps/app/lingui.config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = join(repoRoot, "apps/app");

function readCatalog(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const scratch = mkdtempSync(join(tmpdir(), "meridian-i18n-"));
const scratchApp = join(scratch, "app");
let drifted = [];
try {
  const catalogs = config.catalogs.map((catalog) => ({
    ...catalog,
    path: join(scratchApp, relative(appDir, resolve(appDir, catalog.path))),
  }));
  for (const catalog of config.catalogs) {
    for (const locale of config.locales) {
      const path = resolve(
        appDir,
        catalog.path.replaceAll("{locale}", locale) + config.format.catalogExtension,
      );
      const contents = readCatalog(path);
      if (contents === null) continue;
      const target = join(scratchApp, relative(appDir, path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
  }

  const configPath = join(scratch, "lingui.config.mjs");
  writeFileSync(
    configPath,
    `import config from ${JSON.stringify(pathToFileURL(join(appDir, "lingui.config.ts")).href)};
export default { ...config, rootDir: ${JSON.stringify(appDir)}, catalogs: ${JSON.stringify(catalogs)} };\n`,
  );
  for (const command of ["extract", "compile"]) {
    execFileSync("pnpm", ["exec", "lingui", command, "--config", configPath], {
      cwd: appDir,
      stdio: ["ignore", "pipe", "inherit"],
    });
  }

  drifted = readdirSync(scratchApp, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const generatedPath = join(entry.parentPath, entry.name);
      const path = join(appDir, relative(scratchApp, generatedPath));
      let contents = readFileSync(generatedPath, "utf8");
      if (path.endsWith(".ts")) {
        contents = execFileSync(
          "pnpm",
          ["exec", "biome", "check", "--write", "--stdin-file-path", path],
          { cwd: repoRoot, input: contents, encoding: "utf8" },
        );
      }
      return contents === readCatalog(path) ? null : path;
    })
    .filter((path) => path !== null)
    .sort();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (drifted.length > 0) {
  console.error("ERROR: locale catalogs are out of date with the source:");
  for (const path of drifted) console.error(`  ${relative(repoRoot, path)}`);
  console.error(
    "\nRun: pnpm --filter @meridian/app lingui:extract && pnpm --filter @meridian/app lingui:compile",
  );
  console.error("then commit the catalogs with the copy change.");
  process.exit(1);
}

console.log("Locale catalogs are current.");
