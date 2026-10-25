/** Account-bound client diagnostics: bounded local trace and best-effort authenticated batches. */
import { type FailureLog, noFailureLog } from "@meridian/contracts/failures";
import { createBatchedFailureLog } from "@meridian/thread-client";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";

const Context = createContext<FailureLog>(noFailureLog);
export function FailureLogProvider({
  accountId,
  children,
}: {
  accountId: string;
  children: ReactNode;
}) {
  const binding = useMemo(() => {
    let abort = new AbortController();
    const log = createBatchedFailureLog({
      local: appendTraceEvent,
      async send(records) {
        const response = await fetch("/api/diagnostics/failures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, records }),
          signal: abort.signal,
        });
        if (!response.ok) throw new Error("Failure ingest unavailable");
      },
    });
    return {
      log,
      open() {
        abort = new AbortController();
        log.open();
      },
      close() {
        log.close();
        abort.abort();
      },
    };
  }, [accountId]);
  useEffect(() => {
    binding.open();
    return () => binding.close();
  }, [binding]);
  return <Context.Provider value={binding.log}>{children}</Context.Provider>;
}
export function useFailureLog(): FailureLog {
  return useContext(Context);
}
