/** The conversations whose Scratch a lineage owner names. */
export interface ScratchLineage {
  projectId: string;
  rootThreadId: string;
  rootThreadRef: string;
  title?: string | null;
}
export interface ScratchLineages {
  byId(projectId: string, rootThreadId: string): Promise<ScratchLineage | null>;
  byRef(projectId: string, ref: string): Promise<ScratchLineage | null>;
  rootForThreadRef(projectId: string, ref: string): Promise<ScratchLineage | null>;
  list(projectId: string): Promise<ScratchLineage[]>;
}
