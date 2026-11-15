/**
 * What an edit to an Agents level lets an Agent do that it could not before. Pure: it compares two
 * effective catalogs (the levels' winners by name) and says which Agents became wider.
 *
 * Capability is what the runtime grants and nothing else: the permission, the tool set
 * `projectToolPolicy` yields and the Agents it may spawn. `ask` and `confirm` run as `allow`
 * until Flow enforces them, so the compile does not carry them and a change to them is not a
 * widening; when the runtime's projection carries them they count with no change here.
 */
import {
  type AgentLevel,
  type AgentPermission,
  DEFAULT_AGENT_PERMISSION,
  projectToolPolicy,
} from "@meridian/contracts/agents";
import type { CompiledAgent } from "./compile-package.js";

/** What an available Agent can do; null for one that is broken, clashing or deleted. */
export type AgentCapability = {
  permission: AgentPermission;
  tools: ReadonlySet<string>;
  subagents: ReadonlySet<string>;
  /** The skills it loads or may use: what ties a skill file to the Agents it can widen. */
  skills: ReadonlySet<string>;
} | null;

/** The Agent a name resolves to at one level set, whatever its state. */
export interface EffectiveAgent {
  name: string;
  level: AgentLevel;
  capability: AgentCapability;
}

/** Every name some level holds, with its winner. A name no level holds is absent. */
export type EffectiveAgents = ReadonlyMap<string, EffectiveAgent>;

/**
 * What a broken Agent that gets fixed is compared with: an Agent that can only read, with the
 * whole tool catalog (the permission caps what its writes do, not its tool list). Fixing a
 * read-only Agent therefore changes nothing, whether or not it lists tools; fixing one that
 * edits or may spawn Agents is a widening.
 */
const READ_ONLY_BASELINE: NonNullable<AgentCapability> = {
  permission: "read",
  tools: projectToolPolicy({}, "subagent"),
  subagents: new Set(),
  skills: new Set(),
};

export function capabilityOf(
  agent: Pick<CompiledAgent, "definition"> | undefined,
): AgentCapability {
  const meta = agent?.definition?.metadata;
  if (!meta) return null;
  return {
    permission: meta.permission ?? DEFAULT_AGENT_PERMISSION,
    tools: projectToolPolicy(meta, "subagent"),
    subagents: new Set(meta.subagents ?? []),
    skills: new Set([...(meta.skills?.load ?? []), ...(meta.skills?.available ?? [])]),
  };
}

/** One Agent that became wider: what it could do, what it can do now, and how. */
export interface Widened {
  slug: string;
  /** The Agent's display name after the change. */
  name: string;
  /** Whether the same change renamed it; a renamed Agent prints by slug alone. */
  renamed: boolean;
  level: AgentLevel;
  /** The level the Agent was found at before; differs from `level` when a new file shadows it. */
  from: AgentLevel;
  before: AgentPermission | "unavailable";
  after: AgentPermission;
  /** Tools it did not have. */
  tools: string[];
  /** Agents it may now spawn that it could not. */
  subagents: string[];
  /** The skills it loads or may use after the change. */
  skills: string[];
}

/**
 * The Agents that are wider in `after` than in `before`. An Agent with no item of its name in
 * `before` is new, compared with nothing, never a widening. An Agent that is unavailable or
 * absent in `after` is narrower.
 */
export function compareAgents(before: EffectiveAgents, after: EffectiveAgents): Widened[] {
  const widened: Widened[] = [];
  for (const [slug, now] of after) {
    const was = before.get(slug);
    if (!was || !now.capability) continue;
    const held = was.capability ?? READ_ONLY_BASELINE;
    const tools = [...now.capability.tools].filter((tool) => !held.tools.has(tool));
    const subagents = [...now.capability.subagents].filter((name) => !held.subagents.has(name));
    const rises = now.capability.permission === "edit" && held.permission === "read";
    if (!rises && tools.length === 0 && subagents.length === 0) continue;
    widened.push({
      slug,
      name: now.name,
      renamed: was.name !== now.name,
      level: now.level,
      from: was.level,
      before: was.capability?.permission ?? "unavailable",
      after: now.capability.permission,
      tools,
      subagents,
      skills: [...now.capability.skills],
    });
  }
  return widened.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The one sentence for a widening, in Changes and on the chat card. The slug
 * always prints; the display name goes beside it only when the same change did not rename the
 * Agent, so a rename cannot disguise what was widened.
 */
export function widenedLabel(item: Widened): string {
  const who =
    !item.renamed && item.name.toLowerCase() !== item.slug
      ? `${item.name} (${item.slug})`
      : item.slug;
  const place = item.level !== item.from ? ` (${item.level}, replaces ${item.from})` : "";
  const permission =
    item.after === "edit" && item.before !== "edit" ? `${item.before} → ${item.after}` : null;
  // An Agent that comes into being as an editor is told by its permission, not by every tool.
  const causes =
    permission && item.before === "unavailable"
      ? []
      : [
          ...(item.tools.length ? [`can now use ${item.tools.join(", ")}`] : []),
          ...(item.subagents.length ? [`can now spawn ${item.subagents.join(", ")}`] : []),
        ];
  return `${who}${place}: ${[permission, ...causes].filter(Boolean).join("; ")}`;
}
