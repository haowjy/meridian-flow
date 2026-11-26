import { destinationFreeBlocks, grepBlockText } from "@meridian/agent-edit";
import type {
  AgentEditCodecFactory,
  AgentEditModel,
  DocHandle,
} from "@meridian/agent-edit/integration";

type ProjectedBlock = ReturnType<AgentEditModel["projectBlocks"]>[number];

export type GrepBlock = {
  block: ProjectedBlock;
  destinationFree: string;
  text: string;
};

export function grepBlocksOf(
  doc: DocHandle,
  model: AgentEditModel,
  markup: AgentEditCodecFactory["markup"],
  verbatim: boolean,
): GrepBlock[] {
  const blocks = model.projectBlocks(doc);
  const free = destinationFreeBlocks(
    markup,
    blocks.map((block) => block.node),
  );
  return blocks.map((block, index) => ({
    block,
    destinationFree: free[index] as string,
    text: grepBlockText(free[index] as string, block.node, verbatim),
  }));
}
