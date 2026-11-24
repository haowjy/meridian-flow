import type { BlockId } from "./shape.js";

/** Union-find over block ids. */
export class Groups {
  private readonly parent = new Map<BlockId, BlockId>();
  constructor(ids: Iterable<BlockId>) {
    for (const id of ids) this.parent.set(id, id);
  }
  has(id: BlockId) {
    return this.parent.has(id);
  }
  add(id: BlockId) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  members() {
    return [...this.parent.keys()];
  }
  find(id: BlockId): BlockId {
    const up = this.parent.get(id) as BlockId;
    if (up === id) return id;
    const root = this.find(up);
    this.parent.set(id, root);
    return root;
  }
  join(a: BlockId, b: BlockId) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}
