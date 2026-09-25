import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(packageDir, "dist/release");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(packageDir, "src/release-cli.ts")],
  outfile: path.join(output, "release.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  packages: "bundle",
  banner: { js: "#!/usr/bin/env node" },
});
await writeFile(
  path.join(output, "release.mjs"),
  'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./release.cjs");\n',
);
const migrations = path.join(packageDir, "src/migrations");
const outputMigrations = path.join(output, "migrations");
await mkdir(path.join(outputMigrations, "meta"), { recursive: true });
await cp(path.join(migrations, "meta/_journal.json"), path.join(outputMigrations, "meta/_journal.json"));
for (const entry of await readdir(migrations, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".sql")) {
    await cp(path.join(migrations, entry.name), path.join(outputMigrations, entry.name));
  }
}
await cp(path.join(packageDir, "src/functions"), path.join(output, "functions"), {
  recursive: true,
});
