/**
 * A model's move between a project's files and the account's `user://` files that touches an
 * Agents level. The server's move between two lists cannot be drafted, and an Agents level must
 * be: so the move is a copy at the destination and a delete at the source, both in the chat's
 * branch and both through the Agents check. The destination is a new document (the source's id,
 * its links and its history stay with the deleted source), and Undo takes the two steps back one
 * by one.
 */
import type { WriteToolInput } from "@meridian/agent-edit/integration";
import { modelResult } from "@meridian/agent-edit/integration";
import { agentsLevelOfUri } from "../agents-widening.js";
import { areaOfPath } from "./shown-paths.js";
import { writeToolError } from "./tool-context.js";
import { crossesLists } from "./tree-across-lists.js";

type MoveInput = Extract<WriteToolInput, { command: "move" }>;

const sourcesOf = (input: MoveInput) =>
  input.from.paths ?? (input.from.path === undefined ? [] : [input.from.path]);

/** The address a path names, as the model wrote it: `areaOfPath` is the one parser of those. */
function uriOf(path: string): string {
  const at = areaOfPath(path);
  return at ? `${at.area}${at.rest}` : path;
}

/** Whether the move leaves its list with an Agents level on either side. */
export function movesAcrossAgents(input: MoveInput): boolean {
  const to = areaOfPath(input.path);
  const sources = sourcesOf(input).map(areaOfPath);
  if (!to || sources.some((source) => !source)) return false;
  return (
    sources.some((source) => source && crossesLists(source.area, to.area)) &&
    [...sourcesOf(input), input.path].some((path) => agentsLevelOfUri(uriOf(path)) !== null)
  );
}

const leaf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";

const isError = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true;

/**
 * One write of the call, ready to run: everything it reads before it changes anything is done
 * (a copy reads its source outside the command's transaction), and what changes things is
 * `effect`. `refreshed` names the document whose projection must catch up once the command commits.
 */
export type PreparedWrite =
  | { refused: unknown }
  | { effect: () => Promise<unknown>; refreshed: () => string | undefined };

/**
 * Each source created at its destination with its text (a binary file is copied) and then
 * deleted, as the one command the call is. The writes are prepared first; `run` is the effect to
 * settle as the call's command.
 */
export async function prepareMoveAsCopyAndDelete(
  input: MoveInput,
  prepare: (write: WriteToolInput) => Promise<PreparedWrite>,
  /** The text of a document the move names; null for a file that is not text. */
  readText: (path: string) => Promise<string | null | { refused: unknown }>,
): Promise<
  { refused: unknown } | { run: () => Promise<unknown>; refreshed: Array<() => string | undefined> }
> {
  const sources = sourcesOf(input);
  const many = input.from.paths !== undefined;
  if (sources.some((from) => from.endsWith("/")))
    return {
      refused: writeToolError(
        "move",
        "A folder can't move between a project's files and the account's files; move its documents.",
      ),
    };
  const folder = input.path.endsWith("/") ? input.path : `${input.path}/`;
  const intoFolder = many || input.path.endsWith("/");
  const notMoved: string[] = [];
  const pairs: Array<{ to: string; copy: PreparedWrite & { effect: unknown }; remove: unknown }> =
    [];
  for (const from of sources) {
    const to = intoFolder ? `${folder}${leaf(from)}` : input.path;
    const text = await readText(from);
    const copy =
      typeof text === "object" && text !== null
        ? text
        : await prepare(
            text === null
              ? { command: "copy", path: to, from: { path: from } }
              : { command: "create", path: to, content: text },
          );
    const remove = "refused" in copy ? copy : await prepare({ command: "delete", path: from });
    if ("refused" in copy || "refused" in remove) {
      const refused = "refused" in copy ? copy.refused : (remove as { refused: unknown }).refused;
      if (!many) return { refused };
      notMoved.push(`${from} (not moved)`);
      continue;
    }
    pairs.push({ to, copy, remove });
  }
  if (pairs.length === 0)
    return { refused: writeToolError("move", `Nothing moved: ${notMoved.join("; ")}`) };
  const steps = pairs.flatMap(
    ({ copy, remove }) => [copy, remove] as Array<Extract<PreparedWrite, { effect: unknown }>>,
  );
  return {
    refreshed: steps.map((step) => step.refreshed),
    async run() {
      let evidence: unknown;
      for (const [at, step] of steps.entries()) {
        const done = await step.effect();
        // A step that fails fails the call, which rolls back what its earlier steps did.
        if (isError(done)) return done;
        if (at === steps.length - 2) evidence = (done as { evidence?: unknown }).evidence;
      }
      const landed = pairs.at(-1)?.to;
      return {
        output: modelResult({
          command: "move",
          status: "success",
          phase: "committed",
          payload: {
            ...(!many && landed ? { path: landed } : {}),
            destination: "draft" as const,
            tree: {
              ...(many ? { moved: { made: pairs.length, of: sources.length } } : {}),
              ...(notMoved.length > 0 ? { notMoved } : {}),
            },
          },
        }),
        metadata: { treeWrite: true },
        ...(evidence ? { evidence } : {}),
      };
    },
  };
}
