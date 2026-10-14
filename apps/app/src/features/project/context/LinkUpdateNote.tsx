/**
 * The quiet line a renamed item shows when its move carried links with it.
 * It reads the move's receipt from the replica journal (the operation id was
 * issued at admission), appears when the receipt settles, and lives until the
 * receipt's own deadline (settlement plus four seconds, however often its row
 * remounts). A move that updated no links shows nothing: the writer just did it
 * and can see where the row went. Refused moves show nothing.
 * A row with no rename in flight mounts nothing; account-owned operation watches
 * end at terminal evidence or the deadline, independently of row mounting. The announcement goes to the app's one polite region, once per
 * operation.
 */
import { plural } from "@lingui/core/macro";
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import { announce } from "@/client/stores";
import { cn } from "@/lib/utils";
import { useOptionalAccountResourceReplica } from "./account-feature-context";
import { type LinkNoteSubject, renameOperationLifecycle } from "./rename-operation-lifecycle";

const FADE_MS = 400;

/** Selection and observation belong to the replica lifetime, not the row's lifetime. */
export function useRenameOperation(projectId: string, subject: LinkNoteSubject) {
  const replica = useOptionalAccountResourceReplica();
  const lifecycle = replica ? renameOperationLifecycle(replica) : null;
  const selection = useSyncExternalStore(
    lifecycle?.subscribe ?? (() => () => {}),
    () => lifecycle?.get(projectId, subject) ?? null,
    () => null,
  );
  return {
    operationId: selection?.operationId ?? null,
    feedback: selection?.feedback ?? null,
    remember: (operationId: string) => void lifecycle?.remember(projectId, subject, operationId),
  };
}

/** Links that follow a settled move; refused moves, deletes and moves without links count none. */
function movedLinkCount(receipt: ContextOperationReceipt | null): number {
  if (receipt?.command.kind !== "move") return 0;
  const { result } = receipt as Extract<ContextOperationReceipt, { command: { kind: "move" } }>;
  return result.ok ? (result.value.linkUpdate?.links ?? 0) : 0;
}

// Operations already announced; entries leave once their deadline has passed.
const announced = new Map<string, number>();

function announceOnce(operationId: string, deadline: number, message: string): void {
  const now = Date.now();
  for (const [id, until] of announced) if (until < now) announced.delete(id);
  if (announced.has(operationId)) return;
  announced.set(operationId, deadline);
  announce(message);
}

export function LinkUpdateNote(props: {
  projectId: string;
  subject: LinkNoteSubject;
  /** The operation id `setLocation` or `setFolderLocation` returned, or null before any rename. */
  operationId: string | null;
  /** `stacked` takes its own line under a name that must keep its full width. */
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const { operationId, ...rest } = props;
  return operationId ? <ActiveNote key={operationId} {...rest} operationId={operationId} /> : null;
}

function ActiveNote({
  projectId,
  subject,
  operationId,
  layout = "inline",
  className,
}: {
  projectId: string;
  subject: LinkNoteSubject;
  operationId: string;
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  // A stacked note opens its line from zero height, so the row grows rather than jumps.
  const [entered, setEntered] = useState(false);
  const selection = useRenameOperation(projectId, subject);
  const settled = selection.operationId === operationId ? selection.feedback : null;
  const links = movedLinkCount(settled?.receipt ?? null);
  const deadline = settled?.deadline;
  const visible = links > 0;
  const message = plural(links, { one: "Updated # link", other: "Updated # links" });

  useEffect(() => {
    if (deadline === undefined) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      setPhase("gone");
      return;
    }
    // Presentation follows the operation's absolute settlement deadline.
    const gone = window.setTimeout(() => setPhase("gone"), remaining);
    if (!visible) return () => window.clearTimeout(gone);
    setPhase(remaining <= FADE_MS ? "fading" : "shown");
    setEntered(false);
    const enter = window.requestAnimationFrame(() => setEntered(true));
    announceOnce(operationId, deadline, message);
    const fade = window.setTimeout(() => setPhase("fading"), Math.max(0, remaining - FADE_MS));
    return () => {
      window.cancelAnimationFrame(enter);
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [operationId, visible, deadline, message]);

  if (!visible || phase === "gone") return null;
  if (layout === "stacked") {
    const open = entered && phase === "shown";
    return (
      <span
        aria-hidden
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          "motion-reduce:grid-rows-[1fr] motion-reduce:opacity-100 motion-reduce:transition-none",
          className,
        )}
      >
        <span className="min-h-0 overflow-hidden">
          <span className="block truncate text-xs leading-4 text-muted-foreground">{message}</span>
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "ml-2 shrink-0 text-xs text-muted-foreground transition-opacity duration-300",
        phase === "fading" && "opacity-0",
        "motion-reduce:opacity-100 motion-reduce:transition-none",
        className,
      )}
    >
      {message}
    </span>
  );
}
