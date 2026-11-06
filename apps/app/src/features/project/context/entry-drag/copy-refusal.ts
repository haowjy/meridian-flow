/**
 * A refused Copy, derived from the operations journal: what to say about it. The journal keeps a
 * refused Copy until the writer closes its toast or Retry lands, so a refusal that arrived while
 * this tab was closed still reads here.
 */
import { plural, t } from "@lingui/core/macro";
import type { ContextError } from "@meridian/contracts/protocol";
import type { CopyDesired, NamespaceIntent, OperationRecord } from "@meridian/resource-replica";
import { schemeLabel } from "../context-schemes";
import { entryNameNow, type PlacementView, type ReadyCopy } from "./move-plan";

export type CopyRefusal = {
  operationId: string;
  message: string;
  /** The same Copy again; absent once a source or the destination is gone. */
  copy?: ReadyCopy;
};

/** The refused Copies of a project, oldest first. */
export function copyRefusals(
  view: PlacementView & { operations: readonly OperationRecord[] },
  projectId: string,
): CopyRefusal[] {
  return view.operations.flatMap((operation) => {
    if (operation.projectId !== projectId) return [];
    const intent = operation.intents.find((candidate) => candidate.state === "needs-repair");
    if (intent?.desired.kind !== "copy") return [];
    const copy = intent.desired;
    const names = copy.roots.map((root) =>
      entryNameNow(view, { kind: root.kind, id: root.sourceId }),
    );
    const sources = names.map((name, index) => name ?? copy.roots[index]?.predictedName ?? "");
    const destination = destinationName(view, copy);
    const scheme = destinationScheme(view, copy);
    return [
      {
        operationId: operation.operationId,
        message: describeRefusal(sources, destination, reasonOf(intent)),
        ...(destination && scheme && names.every(Boolean)
          ? {
              copy: {
                kind: "ready" as const,
                destinationName: destination,
                scheme,
                into: copy.destination.parent,
                ...(copy.destination.position ? { position: copy.destination.position } : {}),
                copies: copy.roots.map((root, index) => ({
                  entry: { kind: root.kind, id: root.sourceId },
                  name: sources[index] ?? root.predictedName,
                  view: root.view,
                })),
              },
            }
          : {}),
      },
    ];
  });
}

/** The destination's name, or null once the destination is gone. */
function destinationName(view: PlacementView, copy: CopyDesired): string | null {
  const { parent } = copy.destination;
  return parent.kind === "root"
    ? schemeLabel(parent.scheme)
    : (view.placement.folderLocation(parent.folderId)?.name ?? null);
}

function destinationScheme(view: PlacementView, copy: CopyDesired) {
  const { parent } = copy.destination;
  return parent.kind === "root"
    ? parent.scheme
    : view.placement.folderLocation(parent.folderId)?.scheme;
}

/** What the server (or the replica, before sending) said was wrong, when it said. */
function reasonOf(intent: NamespaceIntent): string | null {
  const outcome = intent.attempts.at(-1)?.outcome;
  // Refused before it was sent: a source or the destination was already gone.
  if (!outcome) return t`A source or the destination is no longer there.`;
  if (outcome.kind === "refusal") {
    const details = outcome.error.details;
    const reason = details && typeof details === "object" && "reason" in details && details.reason;
    if (reason === "source_behind") return t`The latest edits hadn't reached the server.`;
    if (reason === "no_draft") return t`That Work no longer has a draft of it.`;
    return null;
  }
  if (outcome.kind !== "operation" || outcome.receipt.result.ok) return null;
  return describeContextError(outcome.receipt.result.error);
}

function describeContextError(error: ContextError): string | null {
  switch (error.code) {
    case "not_found":
    case "stale_source":
      return t`A source is no longer there.`;
    case "destination_missing":
    case "stale_target":
      return t`The destination is no longer there.`;
    case "permission_denied":
      return t`You can't copy there.`;
    case "context_unavailable":
      return t`That Work isn't available.`;
    default:
      return null;
  }
}

function describeRefusal(
  sources: readonly string[],
  destination: string | null,
  reason: string | null,
): string {
  const [only] = sources;
  const said =
    sources.length === 1 && only
      ? destination
        ? t`Couldn't copy ${only} to ${destination}.`
        : t`Couldn't copy ${only}.`
      : destination
        ? plural(sources.length, {
            one: `Couldn't copy # item to ${destination}.`,
            other: `Couldn't copy # items to ${destination}.`,
          })
        : plural(sources.length, {
            one: "Couldn't copy # item.",
            other: "Couldn't copy # items.",
          });
  return reason ? `${said} ${reason}` : said;
}
