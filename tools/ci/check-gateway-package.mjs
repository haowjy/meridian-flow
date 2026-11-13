#!/usr/bin/env node
// Proves the packed @meridian-flow/gateway tarball works for a consumer outside the workspace:
// installs it with plain npm, imports every entry under Node, and typechecks the .d.ts files
// strictly, and a second time without @types/node for the Node-free entries. A type-only import of a workspace package (@meridian/contracts, ...) passes the
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

// Optional argument: a directory to leave the tarball in (the publish workflow uploads it).
const keepDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
const work = mkdtempSync(join(tmpdir(), "gateway-consumer-"));
try {
  const packDir = keepDir ?? join(work, "pack");
  const project = join(work, "consumer");
  mkdirSync(packDir, { recursive: true });
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
  // `.` and `./shapes` must stay free of Node types (see packages/gateway/AGENTS.md).
  const nodeFree = entries.filter((e) => e === packed.name || e === `${packed.name}/shapes`);

  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "gateway-consumer", private: true, type: "module" }),
  );
  // --ignore-scripts: nothing from the registry runs during the install. The @types/node range
  // is the workspace catalog's, so a new major cannot break the check on its own.
  const catalog = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
  const typesNode = catalog.match(/^\s*'?@types\/node'?:\s*(\S+)/m)?.[1];
  if (!typesNode) throw new Error("@types/node not found in pnpm-workspace.yaml catalog");
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, `@types/node@${typesNode}`],
    project,
  );

  const typecheck = (name, specifiers, types) => {
    const imports = specifiers.map((s, i) => `import * as m${i} from "${s}";`);
    writeFileSync(
      join(project, `${name}.ts`),
      `${imports.join("\n")}\nexport const entries = [${specifiers.map((_, i) => `m${i}`).join(", ")}];\n`,
    );
    writeFileSync(
      join(project, `tsconfig.${name}.json`),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "ES2022",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types,
        },
        files: [`${name}.ts`],
      }),
    );
    run(process.execPath, [tsc, "-p", `tsconfig.${name}.json`], project);
  };
  typecheck("all", entries, ["node"]);
  typecheck("node-free", nodeFree, []);

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
