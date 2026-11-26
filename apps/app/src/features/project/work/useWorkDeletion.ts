/**
 * Optimistic Work deletion with Undo, owned by the Manage Works dialog so the list and the
 * open Work share one delete state.
 *
 * Each delete opens its own Undo window, so several deletes each keep their own, and
 * closing a window reaches every surface. A refused delete is the Work's command failure.
 */
import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { useCommandDriver } from "@/client/commands/driver-context";
import { useWorkDeleteWindows, type WorkDeleteWindow } from "@/client/query/work-command-selectors";
import { closeWorkDeleteWindow, useWorkMutations } from "@/client/query/work-mutations";

export type WorkPlace = { list: string; after: readonly string[] };

const places = new Map<string, WorkPlace>();
const focusing = new Set<string>();

export const workPlace = (workId: string) => places.get(workId) ?? null;

export function rememberWorkPlace(workId: string, place: WorkPlace): void {
  places.set(workId, place);
}

/** True once per delete from a list: its Undo takes the focus the deleted row had. */
export function takeWorkFocus(workId: string): boolean {
  return focusing.delete(workId);
}

export type WorkDeletion = {
  windows: readonly WorkDeleteWindow[];
  remove: (work: Work, place?: WorkPlace) => void;
  undo: (work: Work) => void;
  dismissAll: () => void;
};

export function useWorkDeletion(projectId: string): WorkDeletion {
  const client = useQueryClient();
  const driver = useCommandDriver();
  const { delete: deleteCommand, restore } = useWorkMutations(projectId);
  const windows = useWorkDeleteWindows(projectId);
  const close = useCallback(
    (workId: string) => closeWorkDeleteWindow(client, driver, projectId, workId),
    [client, driver, projectId],
  );
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  const dismissAll = useCallback(() => {
    for (const open of windowsRef.current) close(open.workId);
  }, [close]);
  const remove = useCallback(
    (work: Work, place?: WorkPlace) => {
      if (place) {
        places.set(work.id, place);
        focusing.add(work.id);
      } else places.delete(work.id);
      void deleteCommand({ workId: work.id });
    },
    [deleteCommand],
  );
  const undo = useCallback(
    (work: Work) => void restore({ workId: work.id, name: work.name }),
    [restore],
  );
  return { windows, remove, undo, dismissAll };
}
