/**
 * The account's one command driver: made when the authenticated shell mounts for an account,
 * stopped when it unmounts, so a command outlives the screen that made it but not the account.
 * Screens read records through `useCommands`; what they show of a record stays with each domain.
 */
import { CommandDriver, type CommandRecord, type DriverSnapshot } from "@meridian/command-driver";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createWorkKinds } from "@/client/query/work-commands";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { createBroadcastChannel, createFetchTransport, createWebLock } from "./browser-ports";
import { createIndexedDbJournal } from "./indexeddb-journal";

export const CommandDriverContext = createContext<CommandDriver | null>(null);

const NOTHING: DriverSnapshot = { records: [], notSent: false, paused: false };
const noSubscription = () => () => undefined;

export function CommandDriverProvider({ children }: { children: ReactNode }) {
  const accountId = useAccountId();
  const client = useQueryClient();
  const [driver] = useState(() =>
    typeof window === "undefined"
      ? null
      : new CommandDriver({
          journal: createIndexedDbJournal(accountId),
          lock: createWebLock(accountId),
          transport: createFetchTransport(accountId),
          changes: createBroadcastChannel(accountId),
          online: () => navigator.onLine,
          kinds: createWorkKinds(client),
          log: (payload) =>
            appendTraceEvent({
              timestamp: new Date().toISOString(),
              level: "warn",
              source: "client",
              name: "command.unanswered",
              payload,
            }),
        }),
  );
  useEffect(() => {
    if (!driver) return;
    void driver.open();
    const nudge = () => driver.nudge();
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      // A sign-in elsewhere may have made the account right again: try once.
      if (driver.getSnapshot().paused) driver.resume();
      driver.nudge();
    };
    // A page in the back-forward cache or frozen keeps a lock it cannot use.
    const suspend = () => driver.suspend();
    const resume = () => driver.resume();
    window.addEventListener("online", nudge);
    window.addEventListener("offline", nudge);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", resume);
    document.addEventListener("freeze", suspend);
    document.addEventListener("resume", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", nudge);
      window.removeEventListener("offline", nudge);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("freeze", suspend);
      document.removeEventListener("resume", resume);
      document.removeEventListener("visibilitychange", visible);
      driver.stop();
    };
  }, [driver]);
  return <CommandDriverContext.Provider value={driver}>{children}</CommandDriverContext.Provider>;
}

/** Null outside the authenticated shell and on the server. */
export function useCommandDriver(): CommandDriver | null {
  return useContext(CommandDriverContext);
}

export function useDriverSnapshot(): DriverSnapshot {
  const driver = useCommandDriver();
  return useSyncExternalStore(
    driver?.subscribe ?? noSubscription,
    driver?.getSnapshot ?? (() => NOTHING),
    () => NOTHING,
  );
}

export type CommandFilter = { kind?: string; lane?: string };

/** The account's stored records that match, oldest first. */
export function useCommands(filter: CommandFilter = {}): readonly CommandRecord[] {
  const { records } = useDriverSnapshot();
  const { kind, lane } = filter;
  return useMemo(
    () =>
      records.filter(
        (record) =>
          (kind === undefined || record.kind === kind) &&
          (lane === undefined || record.lanes.includes(lane)),
      ),
    [records, kind, lane],
  );
}

export function useCommand(id: string | null): CommandRecord | undefined {
  const { records } = useDriverSnapshot();
  return useMemo(() => records.find((record) => record.id === id), [records, id]);
}

/** One app-wide line: something has gone unanswered for a while, or the browser is offline with something waiting. */
export function useNotSentYet(): boolean {
  return useDriverSnapshot().notSent;
}
