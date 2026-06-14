// @ts-nocheck
/**
 * JsonTree — token-styled pretty-printed JSON renderer for the debug overlay.
 *
 * Key decisions:
 * - Renders via a single `<pre>` with `JSON.stringify(value, replacer, 2)`.
 *   A real lazy/collapsible tree was considered and rejected: the overlay is
 *   short-lived per-render, dev-only, and the snapshots inspected are bounded
 *   (one turn, one block, one event). The simpler renderer is much smaller and
 *   has no accidental coupling to the rendered data shape.
 * - Cycles, BigInt, and functions are handled so `JSON.stringify` cannot throw
 *   on store state that incidentally contains them.
 * - i18n exception: dev-only; intentionally bypasses Lingui.
 */
import { useMemo } from "react";

import { cn } from "@/lib/utils";

export type JsonTreeProps = {
  value: unknown;
  className?: string;
};

function makeSafeStringify(): (value: unknown) => string {
  return (value) => {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(
        value,
        (_key, v) => {
          if (typeof v === "bigint") return `${v.toString()}n`;
          if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
          if (typeof v === "symbol") return v.toString();
          if (v instanceof Error) {
            return { name: v.name, message: v.message, stack: v.stack };
          }
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return "[circular]";
            seen.add(v);
          }
          return v;
        },
        2,
      );
    } catch (err) {
      return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
    }
  };
}

export function JsonTree({ value, className }: JsonTreeProps) {
  const stringify = useMemo(() => makeSafeStringify(), []);
  const text = useMemo(() => stringify(value) ?? "undefined", [stringify, value]);
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-md border border-border-subtle bg-surface-subtle p-2 text-meta font-mono leading-snug text-foreground",
        className,
      )}
    >
      {text}
    </pre>
  );
}
