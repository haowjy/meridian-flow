/** Source-level update reconciliation preserves edited definitions and their retained local references. */
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { compileAgentDefinition } from "./agent-definition-compiler.js";
import type { AgentSourceSnapshot } from "./agent-source-revision.js";
import { parseMarkdownDefinition, parseMarsToml } from "./mars-source.js";
import type { SkillFiles } from "./skill-files.js";

type Entity = {
  kind: "agent" | "skill";
  slug: string;
  files: SkillFiles;
  config?: Record<string, unknown>;
};
export function sourceEntities(source: AgentSourceSnapshot): Entity[] {
  const overlays =
    typeof source.files["mars.toml"] === "string"
      ? parseMarsToml(source.files["mars.toml"], { packageNameFallback: source.coordinate })
          .agentOverlays
      : {};
  const entities: Entity[] = [];
  for (const name of Object.keys(source.files).sort()) {
    const agent = /^agents\/([^/]+)\.md$/.exec(name);
    if (agent)
      entities.push({
        kind: "agent",
        slug: agent[1],
        files: { [name]: source.files[name] },
        ...(Object.hasOwn(overlays, agent[1]) ? { config: overlays[agent[1]] } : {}),
      });
    const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(name);
    if (skill)
      entities.push({
        kind: "skill",
        slug: skill[1],
        files: Object.fromEntries(
          Object.entries(source.files).filter(([path]) => path.startsWith(`skills/${skill[1]}/`)),
        ),
      });
  }
  return entities;
}
export function replaceSourceEntity(target: AgentSourceSnapshot, entity: Entity): void {
  const prefix = entity.kind === "agent" ? `agents/${entity.slug}.md` : `skills/${entity.slug}/`;
  for (const name of Object.keys(target.files))
    if (entity.kind === "agent" ? name === prefix : name.startsWith(prefix))
      delete target.files[name];
  Object.assign(target.files, structuredClone(entity.files));
  if (entity.kind === "agent") {
    const manifest: Record<string, unknown> =
      typeof target.files["mars.toml"] === "string"
        ? parse(target.files["mars.toml"])
        : { package: { name: target.coordinate } };
    const overlays = (manifest.agents ?? {}) as Record<string, unknown>;
    if (entity.config === undefined) delete overlays[entity.slug];
    else overlays[entity.slug] = entity.config;
    if (Object.keys(overlays).length) manifest.agents = overlays;
    else delete manifest.agents;
    target.files["mars.toml"] = stringify(manifest as Parameters<typeof stringify>[0]);
  }
}
export function reconcilePackageSource(
  current: AgentSourceSnapshot,
  upstream: AgentSourceSnapshot,
  incoming: AgentSourceSnapshot,
  forceReset = false,
) {
  const key = (entity: Entity) => `${entity.kind}/${entity.slug}`;
  const old = new Map(sourceEntities(current).map((entity) => [key(entity), entity]));
  const baseline = new Map(sourceEntities(upstream).map((entity) => [key(entity), entity]));
  const next = new Map(sourceEntities(incoming).map((entity) => [key(entity), entity]));
  const source = structuredClone(incoming);
  const kept = new Map<string, Entity>();
  if (!forceReset) {
    for (const [id, entity] of old)
      if (!isDeepStrictEqual(entity, baseline.get(id))) kept.set(id, entity);
    // Edited parents must not lose a child/skill that upstream prunes.
    for (const entity of kept.values()) {
      if (entity.kind !== "agent") continue;
      const markdown = entity.files[`agents/${entity.slug}.md`];
      if (typeof markdown !== "string") throw new Error("Agent definition is not text");
      const compiled = compileAgentDefinition({
        ...parseMarkdownDefinition(markdown),
        config: entity.config,
      });
      if (!compiled.ok) throw new Error("Retained Agent definition cannot be compiled");
      const meta = compiled.definition.metadata;
      const references = [
        ...(meta.subagents ?? []).map((slug) => `agent/${slug}`),
        ...(meta.skills?.load ?? []).map((slug) => `skill/${slug}`),
        ...(meta.skills && "available" in meta.skills ? (meta.skills.available ?? []) : []).map(
          (slug) => `skill/${slug}`,
        ),
      ];
      for (const reference of references) {
        const prior = old.get(reference);
        if (!next.has(reference) && !kept.has(reference) && prior) kept.set(reference, prior);
      }
    }
    for (const entity of kept.values()) replaceSourceEntity(source, entity);
    if (
      [...kept.values()].some((entity) => entity.kind === "agent") &&
      typeof current.files["mars.toml"] === "string" &&
      typeof source.files["mars.toml"] === "string"
    ) {
      const previous = parse(current.files["mars.toml"]);
      const manifest = parse(source.files["mars.toml"]);
      // One snapshot has one dependency graph. Keeping authored Agent edits keeps
      // its entire prior closure; upstream/reset may advance it only without those edits.
      for (const section of ["dependencies", "local-dependencies"]) {
        const oldDeclarations = (previous[section] ?? {}) as Record<string, unknown>;
        const declarations = (manifest[section] ?? {}) as Record<string, unknown>;
        const otherSection = section === "dependencies" ? "local-dependencies" : "dependencies";
        const other = (manifest[otherSection] ?? {}) as Record<string, unknown>;
        for (const [name, value] of Object.entries(oldDeclarations)) {
          delete other[name];
          declarations[name] = value;
          const retained = current.dependencies?.[name];
          if (!retained) throw new Error(`Retained dependency is missing: ${name}`);
          source.dependencies = { ...source.dependencies, [name]: retained };
        }
        if (Object.keys(declarations).length)
          manifest[section] = declarations as Parameters<typeof stringify>[0];
      }
      source.files["mars.toml"] = stringify(manifest);
    }
  }
  const summary = (entity: Entity) => ({ kind: entity.kind, slug: entity.slug });
  return {
    source,
    willKeep: [...kept.values()].map(summary),
    willUpdate: [...next]
      .filter(([id, entity]) => !kept.has(id) && !isDeepStrictEqual(old.get(id), entity))
      .map(([, entity]) => summary(entity)),
    willRetire: [...old]
      .filter(([id]) => !next.has(id) && !kept.has(id))
      .map(([, entity]) => summary(entity)),
    willRemove: [],
  };
}
