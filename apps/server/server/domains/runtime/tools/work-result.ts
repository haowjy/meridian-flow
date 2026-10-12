/**
 * The `work` result (D65): the typed values the handler returns, and the short
 * text the model reads of them. One line per Work with only what the model
 * decides from; `verbose` adds dates. Ids never reach the text, and
 * `historySummary` reads the typed value.
 */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import { formatUtc } from "./ls-result.js";

/** A Work as the handler returns it. Write mode and pending changes use the writer's words. */
export interface ModelWork {
  slug: string | null;
  name: string;
  goal: string | null;
  status: string | null;
  archivedAt: string | null;
  writes: "draft mode" | "auto-apply";
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  pendingChangeCount?: number | null;
}

/** `work show`: the Work, its recent chats and its drafts. */
export interface WorkShowResult {
  work: ModelWork;
  recentThreads: { title: string | null; updatedAt: string | Date; status: string }[];
  drafts: { documentName: string | null; contextPath: string | null; createdDocument?: boolean }[];
}

/** How far a listed goal runs before it is cut. `show` prints it in full. */
const LIST_GOAL_LENGTH = 60;

const DONE: Record<string, (ref: string) => string> = {
  create: (ref) => `Created ${ref}.`,
  update: (ref) => `Updated ${ref}.`,
  archive: (ref) => `Archived ${ref}.`,
  unarchive: (ref) => `Unarchived ${ref}.`,
  delete: (ref) => `Deleted ${ref}; restorable for 30 days.`,
};

export function renderWorkResult(value: JsonValue, input: JsonObject): string {
  const verbose = input.verbose === true;
  const command = typeof input.command === "string" ? input.command : "";
  if (command === "list" && Array.isArray(value)) {
    const works = value as unknown as ModelWork[];
    if (works.length === 0) return input.archived === true ? "No archived Works." : "No Works.";
    return works.map((work) => workLines(work, verbose, LIST_GOAL_LENGTH)).join("\n");
  }
  if (command === "show" && isObject(value) && isObject(value.work)) {
    return renderShow(value as unknown as WorkShowResult, verbose);
  }
  if (isObject(value) && typeof value.name === "string" && command in DONE) {
    const work = value as unknown as ModelWork;
    return `${DONE[command]?.(workRef(work))}\n${workLines(work, verbose, LIST_GOAL_LENGTH)}`;
  }
  // `switch` says why it made no move; anything else stays as the handler gave it.
  if (isObject(value) && typeof value.message === "string") return value.message;
  return JSON.stringify(value);
}

function renderShow(result: WorkShowResult, verbose: boolean): string {
  const { work } = result;
  const sections = [
    [workLines(work, verbose, 0), ...(work.goal ? [`Goal: ${work.goal}`] : [])].join("\n"),
  ];
  if (result.recentThreads.length > 0) {
    sections.push(
      [
        "Recent chats:",
        ...result.recentThreads.map((thread) => {
          const notes = [
            thread.status === "archived" ? "archived" : undefined,
            verbose ? `updated ${formatUtc(thread.updatedAt)}` : undefined,
          ].filter((note) => note !== undefined);
          const title = thread.title?.trim() || "Untitled chat";
          return `  ${title}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
        }),
      ].join("\n"),
    );
  }
  if (result.drafts.length > 0) {
    sections.push(
      [
        "Drafts:",
        ...result.drafts.map((draft) => {
          const name = draft.contextPath
            ? `manuscript:/${draft.contextPath}`
            : (draft.documentName ?? "Untitled");
          return `  ${name}${draft.createdDocument ? " (new document)" : ""}`;
        }),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * One Work: slug, name, status, then the goal cut to `goalLength` (0 omits it),
 * write mode only when it's draft mode, pending changes only when there are
 * some, and archived. `verbose` adds a line of dates.
 */
function workLines(work: ModelWork, verbose: boolean, goalLength: number): string {
  const name = work.status ? `${work.name} (${work.status})` : work.name;
  const facts = [
    workRef(work),
    name,
    goalLength > 0 && work.goal ? clip(work.goal, goalLength) : undefined,
    work.writes === "draft mode" ? "draft mode" : undefined,
    work.pendingChangeCount ? pending(work.pendingChangeCount) : undefined,
    work.archivedAt ? "(archived)" : undefined,
  ].filter((fact) => fact !== undefined);
  const line = facts.join("  ");
  if (!verbose) return line;
  const dates = [
    `created ${formatUtc(work.createdAt)}`,
    `updated ${formatUtc(work.updatedAt)}`,
    work.lastActivityAt ? `last activity ${formatUtc(work.lastActivityAt)}` : undefined,
    work.archivedAt ? `archived ${formatUtc(work.archivedAt)}` : undefined,
  ].filter((date) => date !== undefined);
  return `${line}\n  ${dates.join(", ")}`;
}

function workRef(work: Pick<ModelWork, "slug">): string {
  return work.slug ? `@${work.slug}` : "@/";
}

function pending(count: number): string {
  return count === 1 ? "1 pending change" : `${count} pending changes`;
}

/** The text cut to `length` at a word boundary, marked with `…`. */
function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= length) return flat;
  const cut = flat.slice(0, length + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > length / 2 ? cut.slice(0, space) : flat.slice(0, length)).trimEnd()}…`;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
