/**
 * Toasts what the server refused, one toast per failure, each closing once it is no longer
 * refused or the writer leaves the project. A refused Move or delete keeps its mark on the row, so
 * one refused before this project opened is left to that mark, and one the writer has handled
 * does not come back. A refused Copy has no row left: it shows on every mount until its toast is
 * closed or Retry lands, because the journal keeps it until then.
 */
import { useEffect, useRef } from "react";
import { dismissFailure, dismissFailures } from "@/components/app/failure-toast";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
  useOptionalRemovedNotices,
} from "../account-feature-context";
import { entryFailures, entryToast, failureTitle, showFailure } from "./entry-failure";

export function RefusalToasts({ projectId }: { projectId: string }) {
  const resources = useAccountResourceReplica();
  const notices = useOptionalRemovedNotices();
  const { records, folders, placement, snapshot } = useAccountResourceProjection(projectId);
  /** Intents with no toast to come: refused before this mount, closed or retried. */
  const handled = useRef<Set<string> | null>(null);
  /** Each open toast's key, and what it says about which intents. */
  const shown = useRef(new Map<string, string>());

  useEffect(() => {
    if (!snapshot) return;
    const view = { records, folders, placement, operations: snapshot.operations };
    handled.current ??= new Set(
      entryFailures(view, projectId).flatMap(({ failure, intents }) =>
        failure.kind === "copy" ? [] : intents,
      ),
    );
    const done = handled.current;
    const open = entryFailures(view, projectId, done);
    for (const { failure, intents } of open) {
      const said = `${failureTitle(failure)}:${intents.join()}`;
      if (shown.current.get(failure.key) === said) continue;
      shown.current.set(failure.key, said);
      showFailure({ resources, projectId, notices }, failure, () => {
        for (const intent of intents) done.add(intent);
        shown.current.delete(failure.key);
      });
    }
    for (const key of shown.current.keys()) {
      if (open.some(({ failure }) => failure.key === key)) continue;
      shown.current.delete(key);
      dismissFailure(key);
    }
  }, [records, folders, placement, snapshot, projectId, resources, notices]);

  useEffect(
    () => () => {
      dismissFailures(entryToast(projectId));
      shown.current.clear();
      handled.current = null;
    },
    [projectId],
  );
  return null;
}
