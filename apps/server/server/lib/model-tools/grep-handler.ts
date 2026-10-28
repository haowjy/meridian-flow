/**
 * The `grep` tool (file-access §6): a regex search over document text, restricted to what the
 * agent may read. Access is applied before matching, so neither the files nor the total
 * reveal a document the agent can't see. Each file is marked read-only when the agent can't
 * edit it.
 */
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { compileAddressGlob, compileGrep, type GrepFile } from "../../domains/context/index.js";
import {
  type GrepToolInput,
  grepPassage,
  refuseSkillGrep,
  type ShownLinkShowing,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import { listingCall } from "./listing-tools.js";
import { contextToolError, isToolError, type ToolWiringDeps, toolError } from "./tool-context.js";

const DEFAULT_HEAD_LIMIT = 50;
/** How long a scan may run before it returns what it has; under the tool timeout. */
const SCAN_BUDGET_MS = 20_000;

export function createGrepHandler(deps: ToolWiringDeps) {
  return async (input: unknown, ctx: ToolHandlerContext) => {
    const {
      pattern,
      path,
      glob,
      output_mode: mode = "content",
      "-i": ignoreCase = false,
      head_limit: headLimit = DEFAULT_HEAD_LIMIT,
      verbose = false,
      version,
    } = input as GrepToolInput;
    const skillRefusal = refuseSkillGrep(path);
    if (skillRefusal) return skillRefusal;
    const matcher = compileGrep(pattern, ignoreCase);
    if (!matcher.ok)
      return toolError({ code: "invalid_arguments", message: `Invalid pattern: ${matcher.error}` });
    const addressGlob = glob === undefined ? undefined : compileAddressGlob(glob);
    if (addressGlob && !addressGlob.ok)
      return toolError({
        code: "invalid_arguments",
        message: `Invalid glob: ${addressGlob.error}`,
      });

    const call = await listingCall(deps, ctx, version);
    if (isToolError(call)) return call;
    const { context, principal } = call;
    const result = await context.port.grep({
      matcher: matcher.value,
      ...(path ? { path } : {}),
      ...(addressGlob ? { glob: addressGlob.value } : {}),
      mode,
      headLimit,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(SCAN_BUDGET_MS)]),
      readable: async (ids) => {
        const access = await deps.fileAccess.listAccess(principal, ids as DocumentId[]);
        return new Map(
          [...access].flatMap(([id, { level }]) =>
            level === "none" ? [] : [[id, level] as const],
          ),
        );
      },
    });
    if (!result.ok) return contextToolError(result.error);
    const { files, totalFiles, exact, stopped } = result.value;
    return {
      // Host-only facts never reach the model.
      output: {
        files: files.map(
          ({ documentId: _id, revision: _revision, shown: _shown, ...file }) => file,
        ),
        totalFiles,
        exact,
        ...(stopped ? { stopped } : {}),
      },
      // Only returned, authorized files were shown, and only the passages their text shows whole.
      evidence: { shown: files.flatMap((file) => shownPassages(file, verbose)) },
      metadata: {
        documentRevisions: files.flatMap(({ documentId, uri, revision }) =>
          revision === null
            ? []
            : [{ documentId, uri, revision } satisfies DocumentRevisionEvidence],
        ),
      },
    };
  };
}

/**
 * A file's showing as the model receives it: a passage whose window cut its
 * block claims none of its links, since the window may have left one out or
 * split it. Whole passages keep theirs.
 */
function shownPassages(file: GrepFile, verbose: boolean): ShownLinkShowing[] {
  const shown = file.shown;
  if (!shown) return [];
  const links = file.matches.flatMap((passage, index) =>
    grepPassage(passage, verbose).whole ? (shown.passages[index] ?? []) : [],
  );
  if (links.length === 0) return [];
  return [{ documentId: file.documentId, holderUri: shown.holderUri, view: shown.view, links }];
}
