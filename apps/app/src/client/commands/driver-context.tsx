import {
  CommandDriver,
  type CommandKind,
  type CommandRecord,
  type DriverSnapshot,
} from "@meridian/command-driver";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { requireReload, sendsHeld, watchDelivery } from "@/client/release/release";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { createBroadcastChannel, createFetchTransport, createWebLock } from "./browser-ports";
import { createIndexedDbJournal } from "./indexeddb-journal";

export const CommandDriverContext = createContext<CommandDriver | null>(null);

const NOTHING: DriverSnapshot = { records: [], notSent: false, paused: false };
const noSubscription = () => () => undefined;

export type CommandDomain = {
  kinds: Record<string, CommandKind>;
  bind(driver: CommandDriver, accountId: string, opened?: Promise<void>): () => void;
};

export function combineDomains(...domains: CommandDomain[]): CommandDomain {
  return {
    kinds: Object.assign({}, ...domains.map((domain) => domain.kinds)),
    bind: (driver, accountId, opened) => {
      const unbinds = domains.map((domain) => domain.bind(driver, accountId, opened));
      return () => {
        for (const unbind of unbinds) unbind();
      };
    },
  };
}

export function CommandDriverProvider({
  domains,
  children,
}: {
  domains: (client: QueryClient) => CommandDomain;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const client = useQueryClient();
  const router = useRouter();
  const [{ driver, domain }] = useState(() => {
    if (typeof window === "undefined") return { driver: null, domain: null };
    const made = domains(client);
    return {
      domain: made,
      driver: new CommandDriver({
        journal: createIndexedDbJournal(accountId),
        lock: createWebLock(accountId),
        transport: createFetchTransport(accountId),
        changes: createBroadcastChannel(accountId),
        online: () => navigator.onLine,
        held: sendsHeld,
        unreadable: requireReload,
        routes: {
          lookup: (id) => `/api/commands/${id}`,
          resolve: (id) => `/api/commands/${id}/resolve`,
        },
        kinds: made.kinds,
        log: (payload) =>
          appendTraceEvent({
            timestamp: new Date().toISOString(),
            level: "warn",
            source: "client",
            name: "command.unanswered",
            payload,
          }),
      }),
    };
  });
  useEffect(() => {
    if (!driver || !domain) return;
    watchDelivery(() => driver.delivering);
    const opened = driver.open();
    let stopWaiting = () => {};
    opened.catch(() => {
      stopWaiting = driver.subscribe(() => {
        if (!driver.hasRead) return;
        stopWaiting();
        void router.invalidate({
          filter: (match) => match.routeId === "/_authenticated/p/$projectId",
        });
      });
    });
    const unbind = domain.bind(driver, accountId, opened);
    const nudge = () => driver.nudge();
    const visible = () => {
      if (document.visibilityState !== "visible") return;
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
      stopWaiting();
      unbind();
      driver.stop();
      watchDelivery(() => false);
    };
  }, [driver, domain, accountId, router]);
  return <CommandDriverContext.Provider value={driver}>{children}</CommandDriverContext.Provider>;
}

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
