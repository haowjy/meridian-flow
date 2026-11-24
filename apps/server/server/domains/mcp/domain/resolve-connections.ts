import type { McpConnectionId, McpConnectionLevel } from "@meridian/contracts/mcp";

export interface Resolved<T> {
  item: T;
  level: McpConnectionLevel;
  shadowedBy: McpConnectionId | null;
}

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

export const winners = <T>(resolved: readonly Resolved<T>[]): Resolved<T>[] =>
  resolved.filter((entry) => entry.shadowedBy === null);
