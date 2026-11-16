// A block the model named that the document no longer holds lands at the nearest block both hold.
import type { DocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ResolveWriteParams } from "../resolver/resolve.js";

export type Retargeted =
  | { aimed: ResolveWriteParams; note?: string }
  /** The edit deletes text the document no longer holds, so there is nothing to change. */
  | { aimed: null };

/**
 * Re-aims a one-block `in`, `after` or `before` from the model's view onto the current
 * document, both given as handles of a document that shares block hashes. A block both hold
 * is named by its hash (a number counted in the view would point at another block here). A
 * block only the view holds is gone: an insert goes where it stood, after the nearest block
 * before it that the document still holds; a replace becomes that insert; a remove has
 * nothing to remove. A selector the view cannot resolve is left as it is.
 */
export function retargetGoneBlock(
  model: Pick<AgentEditModel, "projectBlocks">,
  params: ResolveWriteParams,
  view: DocHandle,
  current: DocHandle,
): Retargeted {
  const field = params.command === "insert" ? (params.after ? "after" : "before") : "in";
  const named = params[field];
  if (typeof named !== "string" && typeof named !== "number") return { aimed: params };

  const seen = model.projectBlocks(view);
  const now = model.projectBlocks(current);
  const held = new Map(now.map((block) => [block.fullHash, block]));
  const index =
    typeof named === "number"
      ? named - 1
      : (() => {
          const hash = named.trim().toLowerCase();
          const matches = seen.flatMap((block, i) => (block.fullHash.startsWith(hash) ? [i] : []));
          return matches.length === 1 ? matches[0] : -1;
        })();
  const block = seen[index];
  if (!block) return { aimed: params };
  const here = held.get(block.fullHash);
  if (here) return { aimed: { ...params, [field]: here.fullHash } };

  if (params.command === "remove" || (params.command === "replace" && !params.content)) {
    return { aimed: null };
  }
  const before = seen
    .slice(0, index)
    .reverse()
    .find((candidate) => held.has(candidate.fullHash));
  const anchor = before ? held.get(before.fullHash) : now[0];
  if (!anchor) return { aimed: params };
  const { in: _in, find: _find, around: _around, all: _all, ...rest } = params;
  const hash = named;
  return {
    aimed: {
      ...rest,
      command: "insert",
      ...(before ? { after: anchor.fullHash } : { before: anchor.fullHash }),
    },
    note: `Block ${hash} is gone, so your text landed ${before ? `after ${anchor.hash}` : `before ${anchor.hash}`}, where it stood.`,
  };
}
