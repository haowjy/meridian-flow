import type { LoroEditCore, WriteContext, WriteOutcome } from "@meridian/agent-edit/integration";
import type { FileAccessDenied, FileDestination, FileGrant } from "../../file-policy/index.js";

export type RoutedWriteContext = WriteContext & { grant: FileGrant<"edit"> };

export type RoutedReadContext = WriteContext & { grant: FileGrant; liveVersion?: boolean };

export type RoutedWriteOutcome = WriteOutcome & {
  refusedWrites?: { writeIds: string[]; denial: FileAccessDenied }[];
};

export type AgentEditCore = Pick<LoroEditCore, "read" | "write">;

export function sameDestination(left: FileDestination, right: FileDestination): boolean {
  if (left.kind === "live" || right.kind === "live") return left.kind === right.kind;
  return left.draftId === right.draftId;
}
