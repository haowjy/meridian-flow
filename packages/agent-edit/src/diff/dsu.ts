/** Disjoint sets of 0..n-1: elements joined by `union` share a `find` root. */
export class Dsu {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}
