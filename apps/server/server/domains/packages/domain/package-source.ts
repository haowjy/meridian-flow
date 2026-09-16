/** Materialize complete Mars sources and a dependency-first graph before any durable writes. */
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentPackageInstallation } from "../ports/agent-revision-store.js";
import type { MarsPackageFetcher } from "../ports/mars-package-fetcher.js";
import { AgentSourceError, type AgentSourceSnapshot } from "./agent-source-revision.js";
import { parseMarsToml } from "./mars-source.js";
import { readSkillFileFromDisk, type SkillFiles } from "./skill-files.js";

export interface PackageSourceNode {
  source: AgentSourceSnapshot;
  dependencies: Record<string, string>;
  origin: AgentPackageInstallation["origin"];
}

export async function readPackageGraph(input: {
  sourceDir: string;
  kind: "local" | "downloaded";
  fetcher: MarsPackageFetcher;
  origin?: AgentPackageInstallation["origin"];
}): Promise<PackageSourceNode[]> {
  const graph: PackageSourceNode[] = [];
  const seen = new Map<string, PackageSourceNode>();
  const visiting = new Set<string>();
  const cleanup: Array<() => Promise<void>> = [];
  async function visit(
    dir: string,
    key: string,
    origin: AgentPackageInstallation["origin"],
    boundary?: string,
  ): Promise<PackageSourceNode> {
    if (visiting.has(key)) throw new AgentSourceError(`Cyclic package dependency: ${key}`);
    const previous = seen.get(key);
    if (previous) return previous;
    visiting.add(key);
    const files: SkillFiles = {};
    async function readTree(current: string) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await readTree(full);
        else if (entry.isFile())
          files[path.relative(dir, full).split(path.sep).join("/")] =
            await readSkillFileFromDisk(full);
      }
    }
    await readTree(dir);
    if (typeof files["mars.toml"] !== "string")
      throw new AgentSourceError("Package requires a UTF-8 mars.toml");
    const manifest = parseMarsToml(files["mars.toml"], { packageNameFallback: path.basename(dir) });
    const dependencies: Record<string, string> = {};
    for (const dependency of manifest.dependencies) {
      let child: PackageSourceNode;
      if (dependency.path) {
        const resolved = await realpath(path.resolve(dir, dependency.path));
        if (
          boundary &&
          (path.relative(boundary, resolved).startsWith("..") ||
            path.isAbsolute(path.relative(boundary, resolved)))
        )
          throw new AgentSourceError("Local dependency escapes the fetched package tree");
        child = await visit(
          resolved,
          resolved,
          boundary ? null : { url: resolved, ref: "", commitSha: null },
          boundary,
        );
      } else if (dependency.url) {
        const ref = dependency.version ?? "main";
        const identity = `${dependency.url}#${ref}`;
        if (visiting.has(identity))
          throw new AgentSourceError(`Cyclic package dependency: ${identity}`);
        const retained = seen.get(identity);
        if (retained) child = retained;
        else {
          const fetched = await input.fetcher.fetch({ url: dependency.url, ref });
          cleanup.push(fetched.cleanup);
          child = await visit(
            fetched.sourceDir,
            identity,
            {
              url: dependency.url,
              ref,
              commitSha: fetched.commitSha,
            },
            await realpath(fetched.sourceDir),
          );
        }
      } else throw new AgentSourceError(`Dependency "${dependency.name}" has no path or URL`);
      dependencies[dependency.name] = child.source.coordinate;
    }
    const node: PackageSourceNode = {
      source: { coordinate: manifest.package.name, files },
      dependencies,
      origin,
    };
    const duplicate = graph.find((item) => item.source.coordinate === node.source.coordinate);
    if (duplicate)
      throw new AgentSourceError(`Multiple package sources claim "${node.source.coordinate}"`);
    graph.push(node);
    seen.set(key, node);
    visiting.delete(key);
    return node;
  }
  try {
    const dir = await realpath(input.sourceDir);
    const origin = input.origin ?? { url: dir, ref: "", commitSha: null };
    await visit(
      dir,
      input.kind === "downloaded" ? `${origin.url}#${origin.ref}` : dir,
      origin,
      input.kind === "downloaded" ? dir : undefined,
    );
    return graph;
  } finally {
    for (const release of cleanup.reverse()) await release();
  }
}
