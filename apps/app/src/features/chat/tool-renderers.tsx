/**
 * tool-renderers — the per-tool presentation registry that drives the activity
 * timeline's tier-2 rows.
 *
 * Each registered tool contributes: an icon, a single-line title that reads
 * the tool's input (e.g. `Read Chapter 1`, `Searched "dragon"`, `Ran the Outline skill`),
 * an optional inline expansion (curated — search result rows, stream tail, or
 * skill output).
 *
 * Three-tier contract documented in `.context/CONTEXT.md`:
 *   - **Tier 1 (default fallback)** — unknown tool. Static one-line row
 *     showing the humanized tool name only. No expand or interaction.
 *   - **Tier 2 (registered)** — the entries in this file. Per-tool one-liner
 *     plus optional curated expansion.
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
import { FilePen, FolderTree, type LucideIcon, Search, Sparkles, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { documentDisplayName, folderDisplayName, isContextUri } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import {
  humanizeSkillSlug,
  stringInput,
  toolActivityVocabulary,
  toolInputObject,
} from "./tool-activity-vocabulary";
import { normalizeToolResultRows, truncate } from "./tool-result-preview";

export type ToolRenderContext = {
  writeMode?: "direct" | "draft";
};

export type ToolRenderer = {
  Icon: LucideIcon;
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView, context?: ToolRenderContext) => ReactNode;
  /** Inline expansion content. `null` = no expand affordance on this row. */
  expand?: (tool: ToolView) => ReactNode | null;
};

/* ── input helpers ─────────────────────────────────────────────────────── */

function inputObject(tool: ToolView): Record<string, JsonValue> {
  return toolInputObject(tool);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolVerb(tool: ToolView, complete: ReactNode, active: ReactNode): ReactNode {
  return tool.status === "complete" ? complete : active;
}

function DocumentName({ path }: { path: string }) {
  const displayName = documentDisplayName(path);
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{displayName.title}</span>
      {displayName.qualifier ? (
        <span className="shrink-0 text-ink-subtle">({displayName.qualifier})</span>
      ) : null}
    </span>
  );
}

function DisplayNameTitle({ verb, path }: { verb: ReactNode; path: string }) {
  return (
    <span className="flex w-full min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{verb}</span>
      <DocumentName path={path} />
    </span>
  );
}

/* ── inline-expand renderers (curated, never JSON) ─────────────────────── */

function ResultRows({ rows }: { rows: ReturnType<typeof normalizeToolResultRows> }) {
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={`${row.title}|${row.subtitle ?? ""}|${row.snippet ?? ""}`} className="space-y-0.5">
          <div className="text-compact font-medium text-prose-foreground">
            {isContextUri(row.title) ? <DocumentName path={row.title} /> : row.title}
          </div>
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
  return stringInput(inputObject(tool), "skillname");
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
    const skillName = slug ? humanizeSkillSlug(slug) : undefined;
    return skillName
      ? t`The ${skillName} skill isn't available in this chat.`
      : t`That skill isn't available in this chat.`;
  }
  if (kind === "no-longer-available") {
    const skillName = slug ? humanizeSkillSlug(slug) : undefined;
    return skillName
      ? t`The ${skillName} skill is no longer available in this chat — start a new chat to use the current version.`
      : t`This skill is no longer available in this chat — start a new chat to use the current version.`;
  }
  return null;
}

function InvokeSkillTitle({ tool }: { tool: ToolView }) {
  const slug = invokeSkillSlug(tool);
  if (!slug) {
    return toolVerb(tool, t`Ran skill`, toolActivityVocabulary(tool)?.active ?? t`Running skill…`);
  }
  const skillName = humanizeSkillSlug(slug);
  return toolVerb(
    tool,
    t`Ran the ${skillName} skill`,
    toolActivityVocabulary(tool)?.active ?? t`Running skill…`,
  );
}

function writeFailureStatus(output: JsonValue | null): string | null {
  if (output == null) return null;
  if (typeof output === "object" && !Array.isArray(output)) {
    const status = asString((output as Record<string, JsonValue>).status);
    if (status) return status;
  }
  const message =
    typeof output === "string" ? output : meridianErrorFromStructuredToolOutput(output).message;
  return /^status:\s*([a-z_]+)/i.exec(message.trim())?.[1]?.toLowerCase() ?? null;
}

function writeFailureDocumentName(tool: ToolView): string | null {
  const path = asString(inputObject(tool).path);
  if (!path) return null;
  const { title, qualifier } = documentDisplayName(path);
  return qualifier ? `${title} (${qualifier})` : title;
}

/** Writer copy is derived from failure shape; machine messages remain diagnostics only. */
export function writeToolFailureCopy(tool: ToolView): string {
  const name = writeFailureDocumentName(tool);
  switch (writeFailureStatus(tool.output)) {
    case "not_found":
    case "document_not_found":
      return name ? t`Couldn't find ${name}.` : t`That document couldn't be found.`;
    case "ambiguous_match":
      return name
        ? t`The requested passage in ${name} wasn't specific enough.`
        : t`The requested passage wasn't specific enough.`;
    case "cant_undo_dependent":
      return t`That change can't be undone because later edits depend on it.`;
    case "destructive_write_rejected":
      return t`That change could remove recent writing, so it wasn't applied.`;
    case "rejected_response_requires_reread":
      return name
        ? t`${name} changed while the AI was working. It needs to read the document again before editing.`
        : t`The document changed while the AI was working. It needs to read it again before editing.`;
    case "partial_failure":
      return name
        ? t`Some changes to ${name} couldn't be completed.`
        : t`Some changes couldn't be completed.`;
    case "invalid_write":
      return name ? t`That change couldn't be made in ${name}.` : t`That change couldn't be made.`;
    default:
      return name
        ? t`Something went wrong while changing ${name}.`
        : t`Something went wrong while making that change.`;
  }
}

function WriteToolTitle({ tool, context }: { tool: ToolView; context?: ToolRenderContext }) {
  const input = inputObject(tool);
  const path = asString(input.path);
  const command = asString(input.command);
  if (command === "read") {
    const complete = path ? <DisplayNameTitle verb={t`Read`} path={path} /> : t`Read file`;
    return toolVerb(tool, complete, t`Reading…`);
  }
  const isEdit = ["insert", "replace", "undo", "redo"].includes(command ?? "");
  if (tool.isError) {
    const verb =
      context?.writeMode === "draft"
        ? t`Couldn't draft`
        : isEdit
          ? t`Couldn't edit`
          : t`Couldn't write`;
    return path ? <DisplayNameTitle verb={verb} path={path} /> : verb;
  }
  const verb = context?.writeMode === "draft" ? t`Drafted` : isEdit ? t`Edited` : t`Wrote`;
  const complete = path ? (
    <DisplayNameTitle verb={verb} path={path} />
  ) : context?.writeMode === "draft" ? (
    t`Drafted file`
  ) : isEdit ? (
    t`Edited file`
  ) : (
    t`Wrote file`
  );
  const active = toolActivityVocabulary(tool, context?.writeMode)?.active ?? t`Writing…`;
  return toolVerb(tool, complete, active);
}

function writeExpand(tool: ToolView): ReactNode | null {
  if (!tool.isError) return null;
  return <div className="text-compact text-destructive">{writeToolFailureCopy(tool)}</div>;
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
  return <ResultRows rows={rows} />;
}

/* ── registry ──────────────────────────────────────────────────────────── */

function humanizeToolName(toolName: string): string {
  const words = toolName.replaceAll("_", " ");
  return words.length > 0 ? words[0].toUpperCase() + words.slice(1) : words;
}

/**
 * Tier-1 default — unknown tool. Static one-liner; no expand affordance,
 * no destination. Arguments are developer detail and never enter the title.
 */
const DEFAULT_RENDERER: ToolRenderer = {
  Icon: Wrench,
  title: (tool) => humanizeToolName(tool.toolName),
};

const RENDERERS: Record<string, ToolRenderer> = {
  write: {
    Icon: FilePen,
    title: (tool, context) => <WriteToolTitle tool={tool} context={context} />,
    expand: writeExpand,
  },
  ls: {
    Icon: FolderTree,
    title: (tool) => {
      const path = asString(inputObject(tool).path);
      // `ls` walks folder structure — "exploring", not reading content.
      const folder = path ? folderDisplayName(path) : undefined;
      const complete = path ? (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span>{t`Explored`}</span>
          <span className="truncate">{folder}</span>
        </span>
      ) : (
        t`Explored folders`
      );
      const active = folder
        ? t`Exploring ${folder}…`
        : (toolActivityVocabulary(tool)?.active ?? t`Exploring folders…`);
      return toolVerb(tool, complete, active);
    },
  },
  grep: {
    Icon: Search,
    title: (tool) => {
      const pattern = asString(inputObject(tool).pattern);
      const verb = toolVerb(
        tool,
        t`Searched`,
        toolActivityVocabulary(tool)?.active ?? t`Searching…`,
      );
      return pattern ? (
        <span>
          {verb} &quot;{truncate(pattern, 60)}&quot;
        </span>
      ) : (
        toolVerb(tool, t`Searched context`, verb)
      );
    },
    expand: resultRowsOrNothing,
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
