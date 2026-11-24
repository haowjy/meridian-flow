/**
 * A document's blocks as grep sees them: the one pipeline behind both the stored text a save
 * certifies and the text of a room-copy read, so the two agree by construction.
 */
import { destinationFreeBlocks, grepBlockText } from "@meridian/agent-edit";
import type {
  AgentEditCodecFactory,
  AgentEditModel,
  DocHandle,
} from "@meridian/agent-edit/integration";

type ProjectedBlock = ReturnType<AgentEditModel["projectBlocks"]>[number];

export type GrepBlock = {
  block: ProjectedBlock;
  /** The block's markdown with link and asset destinations removed. */
  destinationFree: string;
  /** What `grep` matches. `verbatim` is a code file, whose text is its code node's text. */
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
