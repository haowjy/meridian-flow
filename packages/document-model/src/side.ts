import { commentVisibility, readInline, shownStyleKeys } from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type BlockId,
  COMMENT_STYLE_PREFIX,
  type InlineItem,
  type NodeRule,
  sameValue,
} from "./shape.js";
import { StructureView } from "./structure.js";

export class Side {
  readonly view: StructureView;
  private readonly visible: (comment: string) => boolean;
  private readonly inlines = new Map<BlockId, InlineItem[]>();
  private readonly carriedBy = new Map<BlockId, ReadonlySet<string>>();

  constructor(readonly docs: RoomDocs) {
    this.view = new StructureView(docs);
    this.visible = commentVisibility(this.view);
  }

  rule(id: BlockId): NodeRule | undefined {
    const node = this.view.node(id);
    return node === undefined ? undefined : this.docs.shape.node(node);
  }

  inline(id: BlockId): InlineItem[] {
    let items = this.inlines.get(id);
    if (!items) {
      const rule = this.rule(id);
      items = rule?.textblock
        ? readInline(this.docs.textOf(id), rule, this.docs.shape, this.visible)
        : [];
      this.inlines.set(id, items);
    }
    return items;
  }

  carried(id: BlockId): ReadonlySet<string> {
    const known = this.carriedBy.get(id);
    if (known) return known;
    const comments = new Set<string>();
    const rule = this.rule(id);
    if (rule?.textblock)
      for (const key of shownStyleKeys(this.docs.textOf(id), rule, this.docs.shape))
        if (key.startsWith(COMMENT_STYLE_PREFIX))
          comments.add(key.slice(COMMENT_STYLE_PREFIX.length));
    this.carriedBy.set(id, comments);
    return comments;
  }
}

export function blockDiffers(live: Side, fork: Side, id: BlockId): boolean {
  for (const name of ["parent", "order", "node"] as const)
    if (!sameValue(live.view.value(name, id), fork.view.value(name, id))) return true;
  if (!sameValue(live.view.attrs(id), fork.view.attrs(id))) return true;
  return live.rule(id)?.textblock === true && !sameValue(live.inline(id), fork.inline(id));
}
