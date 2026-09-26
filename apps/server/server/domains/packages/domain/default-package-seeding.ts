/**
 * Publishes configured first-party package sources to the immutable system catalog at startup.
 * Local development and bundled Nitro assets feed the same retained-source publisher.
 */

import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRevisionStore } from "../ports/agent-revision-store.js";
import type { MarsPackageFetcher } from "../ports/mars-package-fetcher.js";
import { installSystemAgentSource } from "./bound-agent-catalog.js";
import { serializeMarkdownDefinition } from "./mars-source.js";
import { readPackageGraph } from "./package-source.js";
import { publishAgentSource } from "./source-publication.js";

export interface DefaultPackageSeedConfig {
  /** Absolute or process-cwd-relative Mars package directories. */
  packageDirs: string[];
}

const LAUNCH_AGENT_PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../builtin/launch-agents",
);
const BUILTIN_LAUNCH_AGENT_ASSET_PREFIX = "builtin/launch-agents/";
const SOURCE_LAUNCH_AGENT_PACKAGE_RELATIVE_PATH =
  "apps/server/server/domains/packages/builtin/launch-agents";
let materializedLaunchAgentPackageDir: Promise<string> | null = null;

export function defaultPackageSeedConfigFromEnv(env: {
  DEFAULT_PACKAGE_DIRS?: string;
}): DefaultPackageSeedConfig {
  return {
    packageDirs: [
      LAUNCH_AGENT_PACKAGE_DIR,
      ...(env.DEFAULT_PACKAGE_DIRS ?? "")
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ],
  };
}

export async function seedDefaultAgentPackages(input: {
  store: AgentRevisionStore;
  fetcher: MarsPackageFetcher;
  config: DefaultPackageSeedConfig;
}): Promise<void> {
  for (const sourceDir of input.config.packageDirs) {
    const graph = await readPackageGraph({
      kind: "local",
      sourceDir: await resolvePackageSourceDir(path.resolve(sourceDir)),
      fetcher: input.fetcher,
    });
    await input.store.withCatalogTransaction(null, async () => {
      const heads = new Map(
        (await input.store.listInstallations(null)).map((item) => [item.coordinate, item]),
      );
      for (const node of graph) {
        const dependencies = Object.fromEntries(
          Object.entries(node.dependencies).map(([name, coordinate]) => {
            const head = heads.get(coordinate);
            if (!head) throw new Error(`Missing system package dependency ${coordinate}`);
            return [name, head.currentRevisionId];
          }),
        );
        const source = { ...node.source, dependencies };
        const installed = await input.store.installSource(source);
        const published = await publishAgentSource({
          store: input.store,
          ownerUserId: null,
          source,
          origin: node.origin,
          upstreamRevisionId: installed.packageRevisionId,
          expectedRevisionId: heads.get(source.coordinate)?.currentRevisionId,
        });
        heads.set(source.coordinate, published.installation);
      }
    });
  }
}

async function resolvePackageSourceDir(sourceDir: string): Promise<string> {
  try {
    await access(path.join(sourceDir, "mars.toml"));
    return sourceDir;
  } catch (error) {
    if (path.normalize(sourceDir) !== path.normalize(LAUNCH_AGENT_PACKAGE_DIR)) throw error;
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
