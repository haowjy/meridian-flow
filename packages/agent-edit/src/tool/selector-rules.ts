import { splitDocumentFile } from "../document-address.js";

export type SelectorCommand = "read" | "insert" | "replace" | "remove";

export interface SelectorFields {
  in?: unknown;
  around?: string;
  find?: string;
  all?: boolean;
  after?: string;
  before?: string;
}

interface SelectorIssue {
  field: keyof SelectorFields | "target" | "arguments";
  message: string;
}

const ONE_SCOPE_MESSAGE = "in, around and a #fragment are alternatives, not together";

export function selectorIssues(
  command: SelectorCommand,
  fields: SelectorFields,
  target: string,
): SelectorIssue[] {
  const hasFragment = splitDocumentFile(target).fragment !== undefined;
  const has = {
    in: fields.in !== undefined,
    around: fields.around !== undefined,
    find: fields.find !== undefined,
    all: fields.all === true,
    after: fields.after !== undefined,
    before: fields.before !== undefined,
  };
  const issues: SelectorIssue[] = [];

  if (command === "remove") {
    if (has.in === hasFragment) {
      issues.push({
        field: has.in ? "in" : "target",
        message: "remove needs exactly one of `in` or a #heading-slug in path",
      });
    }
    return issues;
  }

  if (has.in && has.around) issues.push({ field: "around", message: ONE_SCOPE_MESSAGE });
  if (hasFragment && (has.in || has.around)) {
    issues.push({ field: has.in ? "in" : "around", message: ONE_SCOPE_MESSAGE });
  }
  if (command === "read") return issues;

  if (has.around && !has.find) {
    issues.push({
      field: "around",
      message:
        command === "insert"
          ? "around narrows find, so it needs find"
          : "around narrows find, so it needs find",
    });
  }
  if (has.all && !has.find) issues.push({ field: "all", message: "all applies to find matches" });

  if (command === "insert") {
    if (has.after && has.before) {
      issues.push({ field: "before", message: "after and before are alternatives, not both" });
    }
    if ((has.after || has.before) && has.find) {
      issues.push({
        field: "find",
        message: "after or before positions by block and find positions by text, not both",
      });
    }
    if (!has.find && (has.in || hasFragment)) {
      issues.push({
        field: has.in ? "in" : "target",
        message: "insert positions with after, before or find",
      });
    }
  }

  if (command === "replace" && !has.find && !has.in && !hasFragment) {
    issues.push({
      field: "arguments",
      message: "replace needs `in`, `find` or a #heading-slug in path",
    });
  }
  return issues;
}
