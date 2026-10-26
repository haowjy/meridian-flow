/** A non-chat action owns one failure, including its copy and retirement. */
import {
  classifyCommandFailure,
  type FailureEnd,
  type FailureOccurrence,
} from "@meridian/contracts/failures";
import { useCallback, useEffect, useRef, useState } from "react";
import { commandFailureInput } from "./command-failure";
import { useFailureLog } from "./failure-log";

export function useFailure() {
  const log = useFailureLog();
  const [failure, setFailure] = useState<(FailureOccurrence & { message: string }) | null>(null);
  const held = useRef(failure);
  const mounted = useRef(false);
  const end = useCallback(
    (reason: FailureEnd) => {
      if (held.current)
        log.record({
          occurrenceId: held.current.occurrenceId,
          failure: held.current.failure,
          phase: "ended",
          end: reason,
        });
      held.current = null;
      if (mounted.current) setFailure(null);
    },
    [log],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      end("moot");
    };
  }, [end]);
  const fail = useCallback(
    (error: unknown, message: string, actionable = true) => {
      end("moved_on");
      const value = {
        occurrenceId: crypto.randomUUID(),
        failure: classifyCommandFailure(commandFailureInput(error)),
        message,
      };
      // Copy remains in UI state only; never send it to the diagnostics endpoint.
      const record = { occurrenceId: value.occurrenceId, failure: value.failure };
      log.record({ ...record, phase: "recorded" });
      if (!mounted.current || !actionable) {
        log.record({ ...record, phase: "ended", end: "moot" });
        return;
      }
      held.current = value;
      setFailure(value);
    },
    [end, log],
  );
  return { failure, fail, end };
}
