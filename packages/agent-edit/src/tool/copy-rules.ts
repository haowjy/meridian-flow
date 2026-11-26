// Cross-field rules for `from`, the source of a block copy or a document copy.
//
// They run inside the `write` contract (`superRefine`) beside the selector
// rule, and the field descriptions state them, since refinements don't export
// to JSON Schema.
import { splitDocumentFile } from "../document-address.js";

export interface CopySourceFields {
  command: string;
  content?: string;
  find?: string;
  from?: { path: string; in?: unknown };
}

interface CopySourceIssue {
  path: PropertyKey[];
  message: string;
}

const CONTENT_OR_FROM_MESSAGE = "Exactly one of `content` or `from` is required";

export function copySourceIssues(
  command: "insert" | "replace" | "copy",
  fields: CopySourceFields,
): CopySourceIssue[] {
  const issues: CopySourceIssue[] = [];
  const from = fields.from;
  const sourceFragment = from === undefined ? undefined : splitDocumentFile(from.path).fragment;

  if (command !== "copy" && (fields.content === undefined) === (from === undefined)) {
    issues.push({ path: from === undefined ? [] : ["from"], message: CONTENT_OR_FROM_MESSAGE });
  }
  if (from === undefined) return issues;
  if (from.in !== undefined && sourceFragment !== undefined) {
    issues.push({
      path: ["from", "in"],
      message: "from.in and a #fragment in from.path are alternatives, not both",
    });
  }
  if (fields.find !== undefined) {
    issues.push({
      path: ["find"],
      message:
        command === "insert"
          ? "from copies whole blocks; position them with after or before, not find"
          : "from copies whole blocks; select the blocks to replace with in or a #heading-slug in path, not find",
    });
  }
  return issues;
}
