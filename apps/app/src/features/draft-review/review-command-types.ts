/** Presentation types retained while B2 replaces the command owner. */
export type DraftRef = { projectId: string; workId: string; documentId: string; itemKey: string };
export type ServerRefusal = { serverCode?: string; serverReason?: string; removal?: unknown };
export type BranchCommandFailure = { code: string } & ServerRefusal;
export type ChangeCommandMode = "apply" | "discard";
export type ChangeFailureCode = string;
export type ChangeCommandState = {
  phase: "failed";
  code: ChangeFailureCode;
  mode: ChangeCommandMode;
} & ServerRefusal;
export type ChangeSelection = {
  classIds: readonly string[];
  admissionTokens: readonly string[];
  operationIds: readonly string[];
  keys?: readonly string[];
};
