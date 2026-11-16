/**
 * The connections a writer has in a project: the account's and the project's, one per name. The
 * project's wins a shared name and the account's is shadowed, not removed. Pure, on the shape of
 * `layerByName` (the Agents levels), which the bake and the settings list both use.
 */
import type { McpConnectionId, McpConnectionLevel } from "@meridian/contracts/mcp";

export interface Resolved<T> {
  item: T;
  level: McpConnectionLevel;
  /** The project connection that stands in front of this account one, when there is one. */
  shadowedBy: McpConnectionId | null;
}

/** Account connections first, then the project's; each level has unique names. */
export function resolveByName<T>(
  levels: { account: readonly T[]; project: readonly T[] },
  identity: (item: T) => { id: McpConnectionId; name: string },
): Resolved<T>[] {
  const projectIdByName = new Map(
    levels.project.map((item) => [identity(item).name, identity(item).id]),
  );
  return [
    ...levels.account.map((item) => ({
      item,
      level: "account" as const,
      shadowedBy: projectIdByName.get(identity(item).name) ?? null,
    })),
    ...levels.project.map((item) => ({ item, level: "project" as const, shadowedBy: null })),
  ];
}

/** What a thread is offered: every connection no other level stands in front of. */
export const winners = <T>(resolved: readonly Resolved<T>[]): Resolved<T>[] =>
  resolved.filter((entry) => entry.shadowedBy === null);
