import { setTimeout as delay } from "node:timers/promises";
import type { CopiedContent, CopyPlan, PlannedCopyFile } from "../ports/context-copy.js";

export interface BoundTree {
  plan: CopyPlan;
  contents: Map<string, CopiedContent>;
}

export async function bindTree(
  plan: CopyPlan,
  bind: (file: PlannedCopyFile, plan: CopyPlan) => CopiedContent | Promise<CopiedContent>,
): Promise<BoundTree> {
  const contents = new Map<string, CopiedContent>();
  for (const file of plan.documents) {
    contents.set(file.source.documentId, await bind(file, plan));
    if (contents.size % 25 === 0) await delay(0);
  }
  return { plan, contents };
}
