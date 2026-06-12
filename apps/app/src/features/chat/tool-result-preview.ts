// @ts-nocheck
/**
 * tool-result-preview — formats raw tool output into compact preview rows and
 * summaries for the activity-timeline tool renderers (`tool-renderers.tsx`).
 *
 * Pure, i18n-aware helpers that normalize heterogeneous tool JSON (search
 * results, fetched pages) into title/subtitle/snippet rows, summarize output,
 * and map tool names to friendly labels. Owns only display formatting.
 */
import { t } from "@lingui/core/macro";

import type { JsonValue } from "@meridian/contracts/protocol";

export type ToolResultRow = { title: string; subtitle?: string; snippet?: string };

export function normalizeToolResultRows(output: JsonValue | undefined): ToolResultRow[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const obj = output as Record<string, JsonValue>;

  if (Array.isArray(obj.results)) {
    return obj.results.slice(0, 4).flatMap((entry): ToolResultRow[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, JsonValue>;
      const title = typeof row.title === "string" ? row.title : t`(untitled)`;
      const subtitle =
        typeof row.url === "string"
          ? row.url
          : typeof row.source === "string"
            ? row.source
            : undefined;
      const snippet =
        typeof row.snippet === "string"
          ? row.snippet
          : typeof row.note === "string"
            ? row.note
            : undefined;
      return [{ title, subtitle, snippet }];
    });
  }

  if (typeof obj.url === "string" || typeof obj.summary === "string") {
    return [
      {
        title: (typeof obj.title === "string" && obj.title) || t`(fetched)`,
        subtitle: typeof obj.url === "string" ? obj.url : undefined,
        snippet:
          (typeof obj.summary === "string" && obj.summary) ||
          (typeof obj.excerpt === "string" ? obj.excerpt : undefined),
      },
    ];
  }

  return [];
}

export function summarizeToolOutput(output: JsonValue | undefined): string {
  if (output == null) return t`Completed.`;
  if (typeof output === "string") return truncate(output, 200);
  try {
    return truncate(JSON.stringify(output), 200);
  } catch {
    return t`Completed.`;
  }
}

export function friendlyToolName(toolName: string): string {
  return toolName;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
