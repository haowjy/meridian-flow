/**
 * tool-renderers — the per-tool presentation registry that drives the activity
 * timeline's tier-2 rows.
 *
 * Each registered tool contributes: an icon, a single-line title that reads
 * the tool's input (e.g. `Read foo.md`, `$ wc -l src/...`, `Ran segment skill`),
 * an optional inline expansion (curated — search result rows, stream tail, skill
 * output), and an optional
 * external destination handler (`read` opens the file in the context sidebar).
 *
 * Three-tier contract from `kb/wiki/runtime/.../activity-thinking-model`:
 *   - **Tier 1 (default fallback)** — unknown tool. Static one-line row
 *     `tool_name(arg: …)`. No expand, no destination. Just acknowledges the
 *     call happened.
 *   - **Tier 2 (registered)** — the entries in this file. Per-tool one-liner
 *     plus per-tool click behaviour.
 *   - **Tier 3 (generative)** — model-authored React. Not implemented here.
 *
 * Hard rule: **never expose raw JSON in default UX**. Renderers produce
 * curated content (titles, result rows, terminal tail) only. If we need raw
 * JSON for debugging, it goes behind a dev-only setting — not into chat.
 */
import { t } from "@lingui/core/macro";
import {
  type JsonValue,
  meridianErrorFromStructuredToolOutput,
} from "@meridian/contracts/protocol";
import {
  FilePen,
  FileText,
  FolderTree,
  type LucideIcon,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ToolView } from "./group-delivery-segments";
import { ReadPreviewExpand } from "./ReadPreviewExpand";
import { normalizeToolResultRows, truncate } from "./tool-result-preview";

export type ToolRenderContext = {
  writeMode?: "direct" | "draft";
};

export type ToolRenderer = {
  Icon: LucideIcon;
  iconTint?: "muted" | "primary";
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView, context?: ToolRenderContext) => ReactNode;
  /**
   * Inline expansion content. `null` = no expand affordance on this row
   * (the row is a static announcement) or routes via `onClick` instead.
   */
  expand?: (tool: ToolView) => ReactNode | null;
  /**
   * External destination — e.g. `read` jumps to the file in the context
   * sidebar. When set, the click target uses this instead of toggling
   * inline expand. Today these are stubs; the destinations are not yet
   * wired through the project shell.
   */
  onClick?: (tool: ToolView) => void;
};

/* ── input helpers ─────────────────────────────────────────────────────── */

function inputObject(tool: ToolView): Record<string, JsonValue> {
  // The wire format can hand us either a parsed JSON object (settled tool_use)
  // or a JSON-string carrying the same object (mid-stream TOOL_CALL_ARGS that
  // hasn't been re-parsed by the time the view is read). Accept both.
  const raw = tool.input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, JsonValue>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, JsonValue>;
      }
    } catch {
      /* fall through to empty */
    }
  }
  return {};
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Title slot for path-bearing tools (`read`, `edit`, `write`, `list`).
 *
 * Shows the **full path** rather than a stripped basename. When the row is
 * narrower than the path, the path left-truncates so the informative tail
 * (filename / leaf directory) stays visible and the boring scaffolding
 * drops, e.g. `apps/server/.../foo.ts`. The verb is in its own shrink-0
 * span so it never gets eaten by the truncation.
 *
 * Why not basename: `basename(path)` looks clean for `foo.md` and `src`
 * but lies for everything else — `Listed work` could be any of three
 * different `work/`s, `Read foo.md` could be any of dozens. The full
 * path is the actual information; clipping is a display concern that
 * CSS handles.
 */
function PathTitle({ verb, path }: { verb: ReactNode; path: string }) {
  return (
    <span className="flex w-full min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{verb}</span>
      <span className="truncate-start min-w-0 flex-1 text-ink-subtle">{path}</span>
    </span>
  );
}

/* ── inline-expand renderers (curated, never JSON) ─────────────────────── */

function ResultRows({ tool }: { tool: ToolView }) {
  const rows = normalizeToolResultRows(tool.output ?? undefined);
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={`${row.title}|${row.subtitle ?? ""}|${row.snippet ?? ""}`} className="space-y-0.5">
          <div className="text-compact font-medium text-prose-foreground">{row.title}</div>
          {row.subtitle ? (
            <div className="truncate font-mono text-meta text-muted-foreground">{row.subtitle}</div>
          ) : null}
          {row.snippet ? (
            <div className="text-xs leading-relaxed text-ink-muted">{row.snippet}</div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Terminal-style tail for stream-producing tools. Renders as
 * dimmed mono text — no card chrome, just the recent output. Keeps the last
 * ~14 lines so a chatty command can't unbalance the row.
 */
function StreamTail({ stream }: { stream: string }) {
  const lines = stream.split("\n");
  const visible = lines.length > 14 ? lines.slice(-14).join("\n") : stream;
  return (
    // Bounded, NON-scrolling teaser: the transcript viewport is the single scroll
    // owner, so this row must never own a nested scrollport. Slicing to 14 logical
    // lines does not bound *visual* height — one long line soft-wraps to many rows
    // in the narrow docked layout — so cap the box and clip. `justify-end` keeps the
    // newest output pinned to the bottom (older lines clip off the top under a fade).
    <div className="flex max-h-48 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]">
      <pre
        className="font-mono text-meta leading-relaxed break-words whitespace-pre-wrap text-ink-muted"
        aria-live="polite"
      >
        {visible}
      </pre>
    </div>
  );
}

function PlainOutput({ value }: { value: string }) {
  return (
    <div className="text-compact whitespace-pre-wrap text-ink-muted">{truncate(value, 800)}</div>
  );
}

function invokeSkillSlug(tool: ToolView): string | undefined {
  return asString(inputObject(tool).skillname);
}

/**
 * Classify server-side invoke gate failures. Matches the two strings emitted
 * by `skill-tools.ts` — kept separate from i18n so unit tests can lock the
 * contract without a Lingui compile context.
 */
export type InvokeSkillFailureKind = "unknown" | "no-longer-available";

export function classifyInvokeSkillFailure(output: string): InvokeSkillFailureKind | null {
  if (output.startsWith('Unknown skill "')) return "unknown";
  if (/^Skill "[^"]+" is no longer available\./.test(output)) return "no-longer-available";
  return null;
}

/**
 * Map server-side invoke gate failures to reader-facing copy. The dispatcher
 * emits machine strings with slug + available-skills suffix; chat never shows
 * those verbatim — only the two freeze-contract messages below.
 */
export function invokeSkillFailureCopy(
  output: JsonValue | null,
  slug: string | undefined,
): string | null {
  if (typeof output !== "string" || output.length === 0) return null;
  const kind = classifyInvokeSkillFailure(output);
  if (kind === "unknown") {
    return t`That skill isn't available in this chat.`;
  }
  if (kind === "no-longer-available") {
    return slug
      ? t`The ${slug} skill is no longer available in this chat — start a new chat to use the current version.`
      : t`This skill is no longer available in this chat — start a new chat to use the current version.`;
  }
  return null;
}

function InvokeSkillTitle({ tool }: { tool: ToolView }) {
  const slug = invokeSkillSlug(tool);
  const running = tool.status === "partial";
  if (!slug) {
    return running ? t`Running skill…` : t`Ran skill`;
  }
  return (
    <span className="flex w-full min-w-0 items-baseline gap-1">
      <span className="shrink-0">{running ? t`Running` : t`Ran`}</span>
      <span className="truncate-start min-w-0 flex-1 font-mono text-ink-subtle">{slug}</span>
      <span className="shrink-0">{running ? t`skill…` : t`skill`}</span>
    </span>
  );
}

function writeToolFailureText(output: JsonValue | null): string | null {
  if (output == null) return null;
  const message =
    typeof output === "string"
      ? output
      : meridianErrorFromStructuredToolOutput(output).message.trim();
  if (message.length === 0) return null;
  const lines = message.split("\n");
  const statusLine = lines[0] ?? "";
  if (statusLine.startsWith("status:")) {
    const body = lines.slice(1).join("\n").trim();
    return body.length > 0 ? body : statusLine;
  }
  return message;
}

function WriteToolTitle({ tool, context }: { tool: ToolView; context?: ToolRenderContext }) {
  const input = inputObject(tool);
  const path = asString(input.path);
  if (input.command === "read") {
    if (path) return <PathTitle verb={t`Read`} path={path} />;
    return t`Read file`;
  }
  if (tool.isError) {
    const verb = context?.writeMode === "draft" ? t`Draft write failed` : t`Write failed`;
    if (path) return <PathTitle verb={verb} path={path} />;
    return context?.writeMode === "draft" ? t`Draft write failed` : t`Write failed`;
  }
  const verb = context?.writeMode === "draft" ? t`Drafted` : t`Wrote`;
  if (path) return <PathTitle verb={verb} path={path} />;
  return context?.writeMode === "draft" ? t`Drafted file` : t`Wrote file`;
}

function writeExpand(tool: ToolView): ReactNode | null {
  if (!tool.isError) return null;
  const copy = writeToolFailureText(tool.output);
  if (!copy) return null;
  return <div className="text-compact text-destructive">{truncate(copy, 800)}</div>;
}

function invokeExpand(tool: ToolView): ReactNode | null {
  if (tool.isError) {
    const copy = invokeSkillFailureCopy(tool.output, invokeSkillSlug(tool));
    if (!copy) return null;
    return <div className="text-compact text-destructive">{copy}</div>;
  }
  return streamOrOutput(tool);
}

function streamOrOutput(tool: ToolView): ReactNode | null {
  // While running: live tail keeps the freshest output visible. Once complete,
  // prefer the curated final `output` field (e.g. "exit 0", a summary line) —
  // the raw stream transcript is noise next to a tight terminal summary.
  if (tool.status === "complete" && typeof tool.output === "string" && tool.output.length > 0) {
    return <PlainOutput value={tool.output} />;
  }
  if (tool.streamedOutput && tool.streamedOutput.length > 0) {
    return <StreamTail stream={tool.streamedOutput} />;
  }
  if (typeof tool.output === "string" && tool.output.length > 0) {
    return <StreamTail stream={tool.output} />;
  }
  return null;
}

function resultRowsOrNothing(tool: ToolView): ReactNode | null {
  const rows = normalizeToolResultRows(tool.output ?? undefined);
  if (rows.length === 0) return null;
  return <ResultRows tool={tool} />;
}

function readExpand(tool: ToolView): ReactNode | null {
  if (tool.status !== "complete" || typeof tool.output !== "string" || tool.output.length === 0) {
    return null;
  }
  return <ReadPreviewExpand content={tool.output} />;
}

/* ── registry ──────────────────────────────────────────────────────────── */

/**
 * Tier-1 default — unknown tool. Static one-liner; no expand affordance,
 * no destination. The user sees that *something* was called and what the
 * args were, summarised. Detail belongs behind a dev-only setting if we
 * ever add one.
 */
const DEFAULT_RENDERER: ToolRenderer = {
  Icon: Wrench,
  title: (tool) => {
    const args = inputObject(tool);
    const keys = Object.keys(args);
    if (keys.length === 0) return tool.toolName;
    const summarised = keys
      .slice(0, 2)
      .map((k) => `${k}: ${truncate(stringifyArg(args[k]), 28)}`)
      .join(", ");
    return `${tool.toolName}(${summarised})`;
  },
};

function stringifyArg(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

const RENDERERS: Record<string, ToolRenderer> = {
  read: {
    Icon: FileText,
    title: (tool) => {
      const path = asString(inputObject(tool).path);
      return path ? <PathTitle verb={t`Read`} path={path} /> : t`Read file`;
    },
    expand: readExpand,
  },
  edit: {
    Icon: FilePen,
    title: (tool) => {
      const path = asString(inputObject(tool).path);
      return path ? <PathTitle verb={t`Edited`} path={path} /> : t`Edited file`;
    },
    // TODO(ux): wire onClick to a diff destination.
  },
  write: {
    Icon: FilePen,
    title: (tool, context) => <WriteToolTitle tool={tool} context={context} />,
    expand: writeExpand,
    // TODO(ux): wire onClick to open the written file.
  },
  list: {
    Icon: FolderTree,
    title: (tool) => {
      const path = asString(inputObject(tool).path);
      return path ? <PathTitle verb={t`Listed`} path={path} /> : t`Listed directory`;
    },
  },
  search: {
    Icon: Search,
    title: (tool) => {
      const query = asString(inputObject(tool).query);
      return query ? t`Searched "${truncate(query, 60)}"` : t`Searched context`;
    },
    expand: resultRowsOrNothing,
  },
  bash: {
    Icon: Wrench,
    title: (tool) => {
      const command = asString(inputObject(tool).command);
      return command ? <PathTitle verb={t`Ran`} path={command} /> : t`Ran command`;
    },
    expand: streamOrOutput,
  },
  invoke: {
    Icon: Sparkles,
    title: (tool) => <InvokeSkillTitle tool={tool} />,
    expand: invokeExpand,
  },
};

export function rendererFor(toolName: string): ToolRenderer {
  return RENDERERS[toolName] ?? DEFAULT_RENDERER;
}
