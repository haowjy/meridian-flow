/** The model a chat runs its Agent on, and setting or clearing it as a command that survives reloads. */
import { useCallback, useMemo } from "react";

import { useCommandDriver, useCommands } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import {
  projectThreadModel,
  THREAD_SET_MODEL_KIND,
  type ThreadSetModelBody,
  threadModelLane,
} from "./thread-model-command";

/** The chat's override as the writer last set it, before the server has it, else the server's. */
export function useThreadModel(threadId: string, serverModel: string | null): string | null {
  const records = useCommands();
  return useMemo(
    () => projectThreadModel(records, threadId, serverModel),
    [records, threadId, serverModel],
  );
}

/** `model: null` clears the override. The change shows at once through `useThreadModel`. */
export function useSetThreadModel(threadId: string): (model: string | null) => void {
  const driver = useCommandDriver();
  return useCallback(
    (model) => {
      if (!driver) return;
      const body: ThreadSetModelBody = { threadId, model };
      void submitCommand(driver, {
        kind: THREAD_SET_MODEL_KIND,
        lanes: [threadModelLane(threadId)],
        body,
      });
    },
    [driver, threadId],
  );
}
