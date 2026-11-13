#!/usr/bin/env node
// Proves the packed @meridian-flow/gateway tarball works for a consumer outside the workspace:
// installs it with plain npm, imports every entry under Node, and typechecks the .d.ts files
// strictly. A type-only import of a workspace package (@meridian/contracts, ...) passes the
// architecture check and the workspace build but ships declarations nobody can resolve.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const pkgDir = join(repo, "packages/gateway");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const tsc = join(repo, "node_modules/typescript/bin/tsc");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const work = mkdtempSync(join(tmpdir(), "gateway-consumer-"));
try {
  const packDir = join(work, "pack");
  const project = join(work, "consumer");
  mkdirSync(packDir);
  mkdirSync(project);

  // pnpm pack runs prepack (build) and applies publishConfig, so this is the published file.
  run("pnpm", ["pack", "--pack-destination", packDir], pkgDir);
  const tarball = join(
    packDir,
    readdirSync(packDir).find((f) => f.endsWith(".tgz")),
  );

  const packed = JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  const entries = Object.keys(packed.exports).map((key) => packed.name + key.slice(1));

  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "gateway-consumer", private: true, type: "module" }),
  );
  run("npm", ["install", "--no-audit", "--no-fund", tarball, "@types/node"], project);

  const imports = entries.map((entry, i) => `import * as m${i} from "${entry}";`);
  writeFileSync(
    join(project, "index.ts"),
    `${imports.join("\n")}\nexport const entries = [${entries.map((_, i) => `m${i}`).join(", ")}];\n`,
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "ES2022",
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: ["node"],
      },
      files: ["index.ts"],
    }),
  );
  run(process.execPath, [tsc, "-p", "tsconfig.json"], project);

  for (const entry of entries) {
    run(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`],
      project,
    );
  }
  console.log(
    `${pkg.name}@${pkg.version}: ${entries.length} entries import and typecheck for a consumer`,
  );
} catch (error) {
  console.error(`gateway consumer check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
