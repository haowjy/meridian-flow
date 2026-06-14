// @ts-nocheck
/**
 * group-inventory — source grouping for Library list sections.
 *
 * Package-sourced rows group under the human package name; builtins land in a
 * trailing "Built-in" bucket. User-authored rows use "Custom" when no package
 * name is present.
 */
import type { AgentSource } from "@meridian/contracts/agents";

type SourceKeyed = {
  source: AgentSource;
  packageName: string | null;
};

export function sourceGroupLabel(item: SourceKeyed): string {
  if (item.source === "builtin") return "Built-in";
  if (item.source === "package") return item.packageName ?? "Package";
  return item.packageName ?? "Custom";
}

export function groupBySource<T extends SourceKeyed>(items: T[]): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];

  for (const item of items) {
    const label = sourceGroupLabel(item);
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)?.push(item);
  }

  // Built-in reads last — installed capabilities first, platform defaults after.
  const builtinIndex = order.indexOf("Built-in");
  if (builtinIndex >= 0) {
    order.splice(builtinIndex, 1);
    order.push("Built-in");
  }

  return order.map((label) => ({ label, items: groups.get(label) ?? [] }));
}
