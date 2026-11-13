/**
 * Optimistic Work deletion with Undo, owned by the Manage Works dialog so the list and the
 * open Work share one delete state.
 *
 * Each delete is its own command record: its Undo window comes from that
 * record, so several deletes each keep their own, and closing a window
 * reaches every surface. A refused delete is the Work's command failure.
 */
import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { useWorkDeleteWindows, type WorkDeleteWindow } from "@/client/query/work-command-selectors";
import { closeWorkDeleteWindow, useWorkMutations } from "@/client/query/work-command-store";

export type WorkDeletion = {
  /** Open Undo windows, oldest delete first. */
  windows: readonly WorkDeleteWindow[];
  remove: (work: Work) => void;
  undo: (workId: string) => void;
  dismiss: (workId: string) => void;
  /** Ends every Undo window: opening a Work, starting one, or closing the dialog. */
  dismissAll: () => void;
};

export function useWorkDeletion(projectId: string): WorkDeletion {
  const client = useQueryClient();
  const { delete: deleteCommand, restore } = useWorkMutations(projectId);
  const windows = useWorkDeleteWindows(projectId);
  const close = useCallback(
    (workId: string) => closeWorkDeleteWindow(client, projectId, workId),
    [client, projectId],
  );
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const dismissAll = useCallback(() => {
    for (const open of windowsRef.current) close(open.workId);
  }, [close]);
  const remove = useCallback(
    (work: Work) => void deleteCommand({ workId: work.id }),
    [deleteCommand],
  );
  const undo = useCallback((workId: string) => void restore({ workId }), [restore]);
  return { windows, remove, undo, dismiss: close, dismissAll };
}
