/**
 * turn-written-documents — derives successful write/edit document touches from assistant turns.
 */
import { MUTATING_WRITE_COMMANDS } from "@meridian/agent-edit";
import type { JsonValue, Turn } from "@meridian/contracts/protocol";

import { contextUriFromWritePath } from "@/lib/context-uri";
import { groupDeliverySegments, type ToolView } from "./group-delivery-segments";

export type WrittenDocument = {
  path: string;
  uri: string;
};

export function turnWrittenDocuments(turn: Turn): WrittenDocument[] {
  const documents = new Map<string, WrittenDocument>();
  const sortedBlocks = [...turn.blocks].sort((a, b) => a.sequence - b.sequence);
  for (const segment of groupDeliverySegments(sortedBlocks)) {
    const tools =
      segment.kind === "tool-run" ? segment.tools : segment.kind === "tool" ? [segment.tool] : [];
    for (const tool of tools) {
      const path = successfulWritePath(tool);
      if (!path) continue;
      const uri = contextUriFromWritePath(path);
      if (!documents.has(uri)) {
        documents.set(uri, { path, uri });
      }
    }
  }
  return [...documents.values()];
}

function successfulWritePath(tool: ToolView): string | null {
  if (tool.toolName !== "write" && tool.toolName !== "edit") return null;
  if (!writeResultSucceeded(tool)) return null;
  const input = tool.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  // Only commands that actually modify the document count as a written file. A
  // `write(command="read")` is a query and `undo`/`redo` are reversals — none of
  // them are agent edits the footer should offer to undo. The `edit` tool carries
  // no command discriminator and is always a mutation, so a missing command counts.
  const command = (input as Record<string, JsonValue>).command;
  if (
    typeof command === "string" &&
    !(MUTATING_WRITE_COMMANDS as readonly string[]).includes(command)
  ) {
    return null;
  }
  const path = (input as Record<string, JsonValue>).path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function writeResultSucceeded(tool: ToolView): boolean {
  return tool.status === "complete" && !tool.isError;
}
