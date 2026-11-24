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
import { liveListing } from "./file-access.js";
import { areaOfPath, namesEvidence, printedNames } from "./shown-paths.js";
import {
  contextToolError,
  isToolError,
  resolveToolCall,
  type ToolWiringDeps,
  toolError,
} from "./tool-context.js";

const DEFAULT_HEAD_LIMIT = 50;
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

    const call = await resolveToolCall(deps, ctx, version);
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
        const at = liveListing(version);
        const access = await deps.fileAccess.listAccess(principal, ids as DocumentId[], {
          ...(at ? { destination: at } : {}),
        });
        return new Map(
          [...access].flatMap(([id, { level, destination }]) =>
            level === "none" ? [] : [[id, { level, destination }] as const],
          ),
        );
      },
    });
    if (!result.ok) return contextToolError(result.error);
    const { files, totalFiles, exact, stopped } = result.value;
    const byArea = new Map<string, string[]>();
    for (const file of files) {
      const area = areaOfPath(file.uri)?.area;
      if (area) byArea.set(area, [...(byArea.get(area) ?? []), file.documentId]);
    }
    const shownNames = await Promise.all(
      [...byArea].map(([area, ids]) => printedNames(call, area, ids, version)),
    );
    const names = {
      whole: [],
      names: shownNames.flatMap((delta) => delta?.names ?? []),
    };
    return {
      output: {
        files: files.map(
          ({ documentId: _id, revision: _revision, shown: _shown, ...file }) => file,
        ),
        totalFiles,
        exact,
        ...(stopped ? { stopped } : {}),
      },
      evidence: {
        shown: files.flatMap((file) => shownPassages(file, verbose)),
        ...namesEvidence(names),
      },
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

// keep: a passage whose window cut a block claims none of its links, since the window may have left one out or split it
function shownPassages(file: GrepFile, verbose: boolean): ShownLinkShowing[] {
  const shown = file.shown;
  if (!shown) return [];
  const links = file.matches.flatMap((passage, index) =>
    grepPassage(passage, verbose).whole ? (shown.passages[index] ?? []) : [],
  );
  if (links.length === 0) return [];
  return [{ documentId: file.documentId, holderUri: shown.holderUri, view: shown.view, links }];
}
