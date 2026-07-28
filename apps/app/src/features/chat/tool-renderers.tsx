/**
 * tool-renderers — the per-tool presentation registry that drives the activity
 * timeline's tier-2 rows.
 *
 * Each registered tool contributes a single-line title that reads the tool's
 * input (e.g. `Read Chapter 1`, `Searched "dragon"`, `Invoked the Outline
 * skill`) and an optional inline expansion (curated — search result rows,
 * stream tail, or skill output). Glyphs are not here: they belong to the
 * command, which `ToolRow` resolves.
 *
 * Three-tier contract documented in `.context/tool-expands.md`:
 *   - **Tier 1 (default fallback)** — unknown tool. Static one-line row
 *     showing the humanized tool name only. No expand or interaction.
 *   - **Tier 2 (registered)** — the entries in this file. Per-tool one-liner
 *     plus optional curated expansion.
 *   - **Tier 3 (generative)** — model-authored React. Not implemented here.
 *
 * Titles never derive their own tense: both forms come from `tool-command`, so
 * the visible row and the screen-reader announcement cannot disagree.
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
import { ChevronRight, FileText, Folder } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { BoundLine, ClippedProse } from "./ClippedExpand";
import {
  type CommandExpand,
  descriptorFor,
  humanizeToolName,
  type ToolActivityPhrase,
  toolActivityPhrase,
} from "./command-descriptor";
import { DocumentName } from "./DocumentName";
import { documentDisplayName, folderDisplayName } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import { PassageDoor } from "./PassageDoor";
import { type OutlineHeading, readPayloadMarkup, readPayloadOutline } from "./read-payload";
import { humanizeSkillSlug, stringInput, toolInputObject, type WriteMode } from "./tool-command";
import {
  boundLabel,
  type CappedList,
  capList,
  LISTING_CAP,
  matchCountLabel,
  moreMatchesLabel,
  normalizeListing,
  normalizeSearchHits,
  type SearchHitRow,
  type SearchResultRows,
  searchCardSummary,
  type ToolResultRow,
  type ToolResultRows,
  truncate,
} from "./tool-result-preview";

export type ToolRenderContext = {
  writeMode?: WriteMode;
};

/**
 * Builds an expand's contents on demand. Returning one is a promise that there
 * is something behind the chevron; returning `null` from `expand` means the
 * row shows no chevron at all, because an affordance that opens onto nothing
 * is worse than one that was never offered.
 *
 * The split matters as expands grow: deciding *whether* there is content is
 * cheap, rendering it is not, and a settled turn holds a dozen closed rows.
 */
export type ToolExpand = () => ReactNode;

export type ToolRenderer = {
  /** Single-line summary of the tool action. Already i18n'd. */
  title: (tool: ToolView, context?: ToolRenderContext) => ReactNode;
  /** Deferred inline expansion. `null` = no expand affordance on this row. */
  expand?: (tool: ToolView) => ToolExpand | null;
};

/* ── input helpers ─────────────────────────────────────────────────────── */

function inputObject(tool: ToolView): Record<string, JsonValue> {
  return toolInputObject(tool);
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A command and what it acted on, laid out as one line.
 *
 * The command must outrank the parameter: making document names into doors
 * adds weight to the parameter, and without this the most important
 * distinction in the timeline — did the agent *look at* my book or *change*
 * it — is carried by the least emphasised word. The verb inherits the row's
 * ink/medium voice; the parameter steps back a shade and a weight.
 *
 * `DocumentName` sets its own tone, because for a document name tone and
 * linkability are coupled.
 */
function CommandTitle({ verb, parameter }: { verb: ReactNode; parameter?: ReactNode }) {
  return (
    <span className="flex w-full min-w-0 items-baseline gap-1.5">
      <span className="shrink-0">{verb}</span>
      {parameter ? (
        <span className="flex min-w-0 items-baseline font-normal text-muted-foreground">
          {parameter}
        </span>
      ) : null}
    </span>
  );
}

/** A parameter the timeline shows as text rather than as a destination. */
function TextParameter({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate">{children}</span>;
}

function PhraseTitle({ phrase }: { phrase: ToolActivityPhrase }) {
  return (
    <CommandTitle
      verb={phrase.verb}
      parameter={phrase.parameter ? <TextParameter>{phrase.parameter}</TextParameter> : undefined}
    />
  );
}

/* ── inline-expand renderers (curated, never JSON) ─────────────────────── */

function rowKey(row: ToolResultRow, index: number): string {
  return `${index}:${row.uri}`;
}

/**
 * A search result set, as one contained surface.
 *
 * The card exists so a set of results reads as a set: the transcript is a
 * column of the agent's actions, and eight passages loose in it would be eight
 * more actions. Its header carries the totals and nothing else — the row title
 * directly above already says what was searched for, and saying it twice makes
 * the card look like a different question.
 *
 * **Documents are separated by rules, not by spacing alone.** That separation
 * is the whole reason this shape was chosen over a looser list.
 */
function ResultRows({ results }: { results: SearchResultRows }) {
  const bound = boundLabel(results);
  return (
    <div className="rounded-md border border-border bg-result-card p-2.5">
      <p className="border-border-subtle border-b pb-2 text-meta text-ink-subtle">
        {searchCardSummary(results)}
      </p>
      <ul>
        {results.rows.map((row, index) => (
          <li
            key={`${index}:${row.uri}`}
            className={cn("py-2.5", index > 0 && "border-border-subtle border-t")}
          >
            <SearchHit row={row} />
          </li>
        ))}
      </ul>
      {bound ? <BoundLine>{bound}</BoundLine> : null}
    </div>
  );
}

/**
 * One document's section: its name, how much of the query it holds, its best
 * passage, and a way to see the rest without leaving the transcript.
 *
 * The disclosure sits *after* the passage it extends, not beside the document
 * name. In the header it would take focus before the passage a writer is
 * actually reading, and a focus order that disagrees with reading order is the
 * one thing keyboard users cannot recover from.
 */
function SearchHit({ row }: { row: SearchHitRow }) {
  const [open, setOpen] = useState(false);
  const [best, ...rest] = row.passages;
  return (
    <>
      <div className="flex min-w-0 items-baseline gap-[7px] text-compact font-medium text-prose-foreground">
        <DocumentName path={row.uri} />
        <MatchCount count={row.matchCount} />
      </div>
      <div className="mt-0.5">
        <PassageDoor path={row.uri} excerpt={best.excerpt} passage={best.passage} />
      </div>
      {rest.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={(event) => {
              // The row behind this section is the expand toggle; growing a
              // document must not fold the whole search away.
              event.stopPropagation();
              setOpen((wasOpen) => !wasOpen);
            }}
            className="focus-ring mt-1 inline-flex items-center gap-0.5 rounded-sm text-meta text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
          >
            {moreMatchesLabel(rest.length)}
            <ChevronRight
              aria-hidden
              className={cn("size-2.5 transition-transform", open && "rotate-90")}
            />
          </button>
          {open ? (
            // Indented against a rule so the extra passages read as belonging
            // to the document above them. It grows in place: the transcript is
            // the single scroll owner and no expand may own another.
            <div className="mt-1 ml-[13px] space-y-0.5 border-border-subtle border-l pl-2.5">
              {rest.map((passage, index) => (
                <PassageDoor
                  key={`${index}:${passage.excerpt.match}${passage.excerpt.trail}`}
                  path={row.uri}
                  excerpt={passage.excerpt}
                  passage={passage.passage}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * How much of the query this document holds, as a column. The bare number is
 * the point — a column reads by shape — so the words live where a screen
 * reader can still hear them.
 */
function MatchCount({ count }: { count: number }) {
  return (
    <span className="ml-auto inline-grid min-w-5 shrink-0 place-items-center rounded-full border border-border bg-muted px-1.5 py-px text-meta font-semibold text-ink-muted">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{matchCountLabel(count)}</span>
    </span>
  );
}

/**
 * One line per entry, the density every list-shaped expand shares. Exported as
 * a constant rather than a component so the outline can wear the same rhythm
 * while carrying different content.
 */
const LISTING_ROW = "flex min-w-0 items-baseline gap-[7px] py-0.5 text-compact";

/**
 * What the model received from `ls`. A record, not a file browser: the tree
 * panel already browses, and nothing consumes a folder route, so folders are
 * inert here and there is nothing else to click.
 */
function ListingRows({ results }: { results: ToolResultRows }) {
  const bound = boundLabel(results);
  return (
    <>
      <ul>
        {results.rows.map((row, index) => (
          <li key={rowKey(row, index)} className={LISTING_ROW}>
            {row.kind === "folder" ? (
              <>
                <Folder className="size-3 shrink-0 self-center text-ink-subtle" aria-hidden />
                <span className="min-w-0 truncate text-prose-foreground">
                  {folderDisplayName(row.uri)}
                </span>
              </>
            ) : (
              <>
                <FileText className="size-3 shrink-0 self-center text-ink-subtle" aria-hidden />
                <DocumentName path={row.uri} />
              </>
            )}
          </li>
        ))}
      </ul>
      {bound ? <BoundLine>{bound}</BoundLine> : null}
    </>
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
  return documentDisplayName(path);
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
  const writeMode = context?.writeMode ?? "direct";
  const path = asString(inputObject(tool).path);
  const descriptor = descriptorFor(tool);

  if (tool.isError) {
    const verb = descriptor.failureVerb(writeMode);
    return path ? <CommandTitle verb={verb} parameter={<DocumentName path={path} />} /> : verb;
  }

  const phrase = toolActivityPhrase(tool, writeMode);
  // A partial call has no settled path yet, so the row names no document —
  // and therefore offers no door onto one.
  if (tool.status !== "complete") return <PhraseTitle phrase={phrase} />;
  if (!path) return descriptor.pathlessTitle?.(writeMode) ?? <PhraseTitle phrase={phrase} />;
  return <CommandTitle verb={phrase.verb} parameter={<DocumentName path={path} />} />;
}

/**
 * What a `write` row opens onto, by command. A failure always wins: the most
 * useful thing a failed write can say is why it failed.
 */
const COMMAND_EXPANDS: Record<CommandExpand, (tool: ToolView) => ToolExpand | null> = {
  none: () => null,
  renderer: () => null,
  "output-preview": outputPreview,
  "output-outline": outputOutline,
  "submitted-content": submittedContent,
};

function writeExpand(tool: ToolView): ToolExpand | null {
  if (tool.isError) {
    return () => <div className="text-compact text-destructive">{writeToolFailureCopy(tool)}</div>;
  }
  return COMMAND_EXPANDS[descriptorFor(tool).expand](tool);
}

function readPath(tool: ToolView): string | undefined {
  return asString(inputObject(tool).path);
}

function outputPreview(tool: ToolView): ToolExpand | null {
  if (typeof tool.output !== "string") return null;
  const markup = readPayloadMarkup(tool.output);
  if (!markup) return null;
  const path = readPath(tool);
  return () => <QuotedPreview markup={markup} path={path} />;
}

function outputOutline(tool: ToolView): ToolExpand | null {
  if (typeof tool.output !== "string") return null;
  const headings = readPayloadOutline(tool.output);
  // A document with no headings falls back to whole blocks server-side, so the
  // payload really is prose and the row should show it as prose.
  if (!headings) return outputPreview(tool);
  const outline = capList(headings, LISTING_CAP);
  return () => <OutlineRows outline={outline} />;
}

/**
 * What the model submitted, read from the tool *input*: the output carries
 * formatted status and diagnostics, and only the input holds the exact content.
 * Never diff-coloured. Those tokens mean a real, persisted change, and this is
 * what was sent, which is a different claim; the receipt card owns the other.
 */
function submittedContent(tool: ToolView): ToolExpand | null {
  const content = asString(inputObject(tool).content);
  if (!content) return null;
  const path = readPath(tool);
  return () => (
    <div className="rounded-md border border-border-subtle bg-muted px-3 py-2">
      <QuotedPreview markup={content} path={path} />
    </div>
  );
}

function invokeExpand(tool: ToolView): ToolExpand | null {
  if (tool.isError) {
    const copy = invokeSkillFailureCopy(tool.output, invokeSkillSlug(tool));
    if (!copy) return null;
    return () => <div className="text-compact text-destructive">{copy}</div>;
  }
  return streamOrOutput(tool);
}

function streamOrOutput(tool: ToolView): ToolExpand | null {
  // While running: live tail keeps the freshest output visible. Once complete,
  // prefer the curated final `output` field (e.g. "exit 0", a summary line) —
  // the raw stream transcript is noise next to a tight terminal summary.
  if (tool.status === "complete" && typeof tool.output === "string" && tool.output.length > 0) {
    const value = tool.output;
    return () => <PlainOutput value={value} />;
  }
  if (tool.streamedOutput && tool.streamedOutput.length > 0) {
    const stream = tool.streamedOutput;
    return () => <StreamTail stream={stream} />;
  }
  if (typeof tool.output === "string" && tool.output.length > 0) {
    const stream = tool.output;
    return () => <StreamTail stream={stream} />;
  }
  return null;
}

function listingOrNothing(tool: ToolView): ToolExpand | null {
  const results = normalizeListing(tool.output ?? undefined);
  if (results.rows.length === 0) return null;
  return () => <ListingRows results={results} />;
}

function resultRowsOrNothing(tool: ToolView): ToolExpand | null {
  // A chevron is a promise, and here the contract keeps it: a search hit that
  // cannot fill a section is refused at normalization, so a non-empty payload
  // IS content. That lets the closed row answer "is there anything here?" by
  // looking at the array, and leaves every section — and the totals scan —
  // for the writer who actually opens it. A settled turn holds a dozen closed
  // rows; none of them should be parsing search results.
  const output = tool.output;
  if (!Array.isArray(output) || output.length === 0) return null;
  return () => (
    <ResultRows results={normalizeSearchHits(output, stringInput(inputObject(tool), "pattern"))} />
  );
}

/**
 * The passage the model read, or the content it submitted, as quoted matter.
 *
 * Top-anchored: the opening of the passage is what the writer wants. When it
 * doesn't fit, the door at the fade offers the whole document, which is a
 * different and larger thing than "more" of a finite payload.
 */
function QuotedPreview({ markup, path }: { markup: string; path?: string }) {
  return (
    <ClippedProse
      className="text-tier-quoted"
      footer={path ? <OpenDocumentDoor path={path} /> : null}
    >
      <Markdown>{markup}</Markdown>
    </ClippedProse>
  );
}

/**
 * The second door, at the point of need. The row title carries the first one,
 * at the top; this one sits where the writer has read to the bound.
 */
function OpenDocumentDoor({ path }: { path: string }) {
  return (
    <span className="flex min-w-0 text-meta">
      <DocumentName path={path} label="open" />
    </span>
  );
}

/**
 * What a skim saw. A list, not prose, so it takes the discrete-list treatment
 * whole: the listing rhythm, the listing cap, and a count when it is cut. An
 * outline read returned structure, and rendering it as paragraphs would claim
 * the model read the words under those headings.
 *
 * No fade and no door at the bottom. Those belong to continuous prose, where
 * the need to see the rest arrives only after reading; a clipped outline is
 * already answered by the row title's own door.
 */
function OutlineRows({ outline }: { outline: CappedList<OutlineHeading> }) {
  const bound = boundLabel(outline);
  return (
    <>
      <ul>
        {outline.rows.map((heading, index) => (
          <li
            key={`${index}:${heading.text}`}
            className={cn(LISTING_ROW, "text-prose-foreground")}
            style={{ paddingLeft: `${heading.level * 16}px` }}
          >
            <span className="min-w-0 truncate">{heading.text}</span>
          </li>
        ))}
      </ul>
      {bound ? <BoundLine>{bound}</BoundLine> : null}
    </>
  );
}

/* ── registry ──────────────────────────────────────────────────────────── */

/** A registered tool whose whole title is its phrase, with no document to name. */
function phraseTitle(tool: ToolView): ReactNode {
  // A failure is its own claim: `Searched "Elara"` over an error row says the
  // search happened.
  if (tool.isError) return descriptorFor(tool).failureVerb("direct");
  return <PhraseTitle phrase={toolActivityPhrase(tool)} />;
}

/**
 * Tier-1 default — unknown tool. Static one-liner; no expand affordance,
 * no destination. Arguments are developer detail and never enter the title.
 */
const DEFAULT_RENDERER: ToolRenderer = {
  title: (tool) => humanizeToolName(tool.toolName),
};

const RENDERERS: Record<string, ToolRenderer> = {
  write: {
    title: (tool, context) => <WriteToolTitle tool={tool} context={context} />,
    expand: writeExpand,
  },
  ls: {
    title: phraseTitle,
    expand: listingOrNothing,
  },
  search: {
    title: phraseTitle,
    expand: resultRowsOrNothing,
  },
  invoke: {
    title: phraseTitle,
    expand: invokeExpand,
  },
};

export function rendererFor(toolName: string): ToolRenderer {
  return RENDERERS[toolName] ?? DEFAULT_RENDERER;
}
