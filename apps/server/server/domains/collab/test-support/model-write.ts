import { randomUUID } from "node:crypto";
import type { WriteCommand } from "@meridian/agent-edit/integration";
import type { RoutedWriteContext, RoutedWriteOutcome } from "../domain/agent-edit-cores.js";
import type { ModelEdits } from "../domain/model-edit.js";

/**
 * One model tool call as the chat loop sends it: a command whose effect is the write. The
 * account and project come from the grant unless the caller names them.
 */
export async function modelWrite(
  modelEdits: Pick<ModelEdits, "run" | "write">,
  command: WriteCommand,
  context: RoutedWriteContext,
  who?: { accountId: string; projectId: string },
): Promise<RoutedWriteOutcome> {
  const key = {
    responseId: context.responseIdentity?.providerResponseId ?? randomUUID(),
    toolCallId: command.tool_use_id ?? randomUUID(),
    accountId: (who?.accountId ?? context.grant.principal.accountId) as never,
    projectId: (who?.projectId ?? context.grant.facts.projectId) as never,
  };
  const { evidence } = await modelEdits.run({
    key,
    signal: new AbortController().signal,
    async effect() {
      const written = await modelEdits.write(command, context);
      return {
        toolResult: { toolCallId: key.toolCallId, content: [], result: { status: written.status } },
        evidence: written,
      };
    },
  });
  return evidence as RoutedWriteOutcome;
}
