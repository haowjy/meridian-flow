/** Resolves a thread's agent-selected gateway model into client-facing capability state. */

import type { Thread } from "@meridian/contracts/threads";
import { extractAgentGatewayMeta, type PackageRepository } from "../../packages/index.js";
import type { Gateway } from "../gateway/index.js";
import { resolveModelState } from "../gateway/index.js";

export async function resolveThreadModelState(input: {
  thread: Pick<Thread, "projectId" | "userId" | "currentAgent">;
  packageRepository: PackageRepository;
  gateway: Pick<Gateway, "getDefaultModel" | "listModels">;
}) {
  let requestedModel: string | undefined;
  if (input.thread.currentAgent) {
    const context = await input.packageRepository.getAgentWithLinkedSkills(
      input.thread.projectId,
      input.thread.userId,
      input.thread.currentAgent,
    );
    requestedModel = context.agent ? extractAgentGatewayMeta(context.agent).model : undefined;
  }
  return resolveModelState(input.gateway, requestedModel);
}
