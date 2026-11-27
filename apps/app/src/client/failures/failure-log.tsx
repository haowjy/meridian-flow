import { type FailureLog, noFailureLog } from "@meridian/contracts/failures";
import { createBatchedFailureLog } from "@meridian/thread-client";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { apiFetch } from "@/client/api/http-client";
import { appendTraceEvent } from "@/client/trace-store";
import { useRequestAccount } from "@/features/project/context/request-account-context";

const Context = createContext<FailureLog>(noFailureLog);
export function FailureLogProvider({ children }: { children: ReactNode }) {
  const account = useRequestAccount();
  const binding = useMemo(() => {
    let abort = new AbortController();
    const log = createBatchedFailureLog({
      local: appendTraceEvent,
      async send(records) {
        const response = await apiFetch(
          "/api/diagnostics/failures",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: account.id, records }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2_000)]),
          },
          account,
        );
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
  }, [account]);
  useEffect(() => {
    binding.open();
    return () => binding.close();
  }, [binding]);
  return <Context.Provider value={binding.log}>{children}</Context.Provider>;
}
export function useFailureLog(): FailureLog {
  return useContext(Context);
}
