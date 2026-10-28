/**
 * Publishes the built-in launch-agent package to the immutable system catalog at startup.
 * Local development and bundled Nitro assets feed the same retained-source publisher.
 */

import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRevisionStore } from "../ports/agent-revision-store.js";
import type { AgentSourceSnapshot } from "./agent-source-revision.js";
import { installSystemAgentSource } from "./bound-agent-catalog.js";
import { parseMarsToml, serializeMarkdownDefinition } from "./mars-source.js";
import { readSkillFileFromDisk, type SkillFiles } from "./skill-files.js";

const LAUNCH_AGENT_PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../builtin/launch-agents",
);
const BUILTIN_LAUNCH_AGENT_ASSET_PREFIX = "builtin/launch-agents/";
const SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH =
  "apps/server/server/domains/packages/builtin/launch-agents";
let materializedLaunchAgentPackageDir: Promise<string> | null = null;

export async function seedLaunchAgentPackage(store: AgentRevisionStore): Promise<void> {
  await installSystemAgentSource(store, await readPackageDir(await resolveLaunchAgentPackageDir()));
}

async function readPackageDir(dir: string): Promise<AgentSourceSnapshot> {
  const files: SkillFiles = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, full).split(path.sep).join("/")] = await readSkillFileFromDisk(full);
  }
  if (typeof files["mars.toml"] !== "string") throw new Error("Package requires a UTF-8 mars.toml");
  const manifest = parseMarsToml(files["mars.toml"], { packageNameFallback: path.basename(dir) });
  return { coordinate: manifest.package.name, files };
}

async function resolveLaunchAgentPackageDir(): Promise<string> {
  try {
    await access(path.join(LAUNCH_AGENT_PACKAGE_DIR, "mars.toml"));
    return LAUNCH_AGENT_PACKAGE_DIR;
  } catch {
    const sourceFallback = await firstExistingPackageDir(launchAgentPackageDirCandidates());
    if (sourceFallback) return sourceFallback;
    materializedLaunchAgentPackageDir ??= materializeLaunchAgentPackageFromNitroAssets();
    return materializedLaunchAgentPackageDir;
  }
}

async function firstExistingPackageDir(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "mars.toml"));
      return candidate;
    } catch {
      // Try the next source-relative fallback.
    }
  }
  return null;
}

function launchAgentPackageDirCandidates(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "../../../server/domains/packages/builtin/launch-agents"),
    path.resolve(moduleDir, "../../../../", SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH),
    ...(process.env.MERIDIAN_TASK_DIR
      ? [path.join(process.env.MERIDIAN_TASK_DIR, SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH)]
      : []),
    path.resolve(process.cwd(), "server/domains/packages/builtin/launch-agents"),
    path.resolve(process.cwd(), SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH),
  ];
}

async function materializeLaunchAgentPackageFromNitroAssets(): Promise<string> {
  const serverAssets = await import(/* @vite-ignore */ "#nitro/virtual/server-assets");
  const root = await mkdtemp(path.join(tmpdir(), "meridian-launch-agents-"));
  const packageDir = path.join(root, "launch-agents");
  const keys = (await serverAssets.assets.getKeys()).filter((key: string) =>
    key.startsWith(BUILTIN_LAUNCH_AGENT_ASSET_PREFIX),
  );
  for (const key of keys) {
    const relative = key.slice(BUILTIN_LAUNCH_AGENT_ASSET_PREFIX.length);
    const target = path.join(packageDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await serverAssets.assets.getItem(key), "utf8");
  }
  return packageDir;
}

/** General adds no persona to the shared host prompt and pins the configured default model. */
export async function seedGeneralAgent(store: AgentRevisionStore, model: string): Promise<void> {
  await installSystemAgentSource(store, {
    coordinate: "meridian/general",
    files: {
      "mars.toml": '[package]\nname = "meridian-general"\n',
      "agents/general.md": serializeMarkdownDefinition(
        {
          name: "General",
          description: "General-purpose assistant.",
          mode: "primary",
          model,
        },
        "",
      ),
    },
  });
}
