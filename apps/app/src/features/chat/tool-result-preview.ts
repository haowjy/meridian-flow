/**
 * Pure, i18n-aware helpers for curated tool-result rows and bounded preview
 * text. Owns only display formatting.
 */
import { t } from "@lingui/core/macro";

import type { JsonValue } from "@meridian/contracts/protocol";

export type ToolResultRow = { title: string; subtitle?: string; snippet?: string };

export function normalizeToolResultRows(output: JsonValue | undefined): ToolResultRow[] {
  if (Array.isArray(output)) {
    return output.slice(0, 4).flatMap((entry): ToolResultRow[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, JsonValue>;
      if (typeof row.uri !== "string" || typeof row.excerpt !== "string") return [];
      return [
        {
          title: row.uri,
          subtitle: typeof row.line === "number" ? t`Line ${row.line}` : undefined,
          snippet: row.excerpt,
        },
      ];
    });
  }

  if (!output || typeof output !== "object") return [];
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

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
