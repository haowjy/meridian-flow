import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { describe, expect, it } from "vitest";
import { decide, isDrafted, type NodeGrant, sourceDestination } from "./policy.js";
import type { AgentLink, FileFacts, FileWorkFacts, Principal } from "./types.js";

const OWNER = "owner";
const PROJECT = "project";
const work = (id: string, over: Partial<FileWorkFacts> = {}): FileWorkFacts => ({
  id,
  slug: id,
  isNoWork: false,
  archived: false,
  deleted: false,
  ...over,
});
const NO_WORK = work("no-work", { slug: null, isNoWork: true });

function file(
  scheme: ContextUriScheme,
  ownerWork: FileWorkFacts | null = null,
  over: Partial<FileFacts> = {},
): FileFacts {
  return {
    target: { kind: "document", documentId: "doc" },
    projectId: PROJECT,
    ownerAccountId: OWNER,
    projectDeleted: false,
    ownerWork,
    deleted: false,
    scheme,
    path: "a.md",
    self: { kind: "document", id: "doc" },
    ancestors: [{ kind: "project", id: PROJECT }],
    ...over,
  };
}

const ownerGrants: NodeGrant[] = [{ node: { kind: "project", id: PROJECT }, level: "edit" }];
const link = (permission: "read" | "edit", workId: string): AgentLink => ({
  threadId: `t-${permission}-${workId}`,
  permission,
  threadWorkId: workId,
});
const person: Principal = { accountId: OWNER };
const agent = (...chain: AgentLink[]): Principal => ({
  accountId: OWNER,
  agent: { chain, draftWork: null },
});

describe("file policy", () => {
  const A = work("a");
  const X = work("x");
  const archived = work("old", { archived: true });

  // [case, principal, facts, level, limitedBy]
  // biome-ignore format: one row per case
  const table: [string, Principal, FileFacts, string, string | null][] = [
    ["owner edits a project file", person, file("manuscript"), "edit", null],
    ["a stranger gets nothing", { accountId: "stranger" }, file("manuscript"), "none", "not_found"],
    ["a deleted document is gone", person, file("manuscript", null, { deleted: true }), "none", "deleted"],
    ["a deleted project is gone", person, file("kb", null, { projectDeleted: true }), "none", "deleted"],
    ["a deleted Work's scratch is gone", person, file("scratch", work("d", { deleted: true })), "none", "deleted"],
    ["an archived Work's scratch is read-only", person, file("scratch", archived), "read", "work_archived"],
    ["an archived Work's chat still edits manuscript", agent(link("edit", "old")), file("manuscript"), "edit", null],
    ["an edit agent edits manuscript", agent(link("edit", "a")), file("manuscript"), "edit", null],
    ["a read agent reads manuscript", agent(link("read", "a")), file("manuscript"), "read", "agent_read_only"],
    ["archive outranks a read agent's limit", agent(link("read", "a")), file("scratch", archived), "read", "work_archived"],
    // Uploads: read-only for every agent, writable for the person.
    ["the person edits uploads", person, file("uploads", A), "edit", null],
    ["an edit agent reads uploads", agent(link("edit", "a")), file("uploads", A), "read", "uploads_read_only"],
    ["a read agent reads uploads", agent(link("read", "a")), file("uploads", A), "read", "uploads_read_only"],
    // Own scratch follows the thread's current named Work.
    ["a read agent edits its Work's scratch", agent(link("read", "a")), file("scratch", A), "edit", null],
    ["a read agent reads another Work's scratch", agent(link("read", "a")), file("scratch", X), "read", "agent_read_only"],
    ["after work switch to X, X's scratch is its own", agent(link("read", "x")), file("scratch", X), "edit", null],
    ["after work switch to X, A's scratch is not", agent(link("read", "x")), file("scratch", A), "read", "agent_read_only"],
    ["No Work's scratch is a No Work agent's own", agent(link("read", "no-work")), file("scratch", NO_WORK), "edit", null],
    ["No Work's scratch is not a named Work agent's", agent(link("read", "a")), file("scratch", NO_WORK), "read", "agent_read_only"],
    // Delegation: the minimum over the chain.
    ["an edit child under a read parent reads manuscript", agent(link("edit", "a"), link("read", "a")), file("manuscript"), "read", "agent_read_only"],
    ["an edit child under a read parent edits their shared Work's scratch", agent(link("edit", "a"), link("read", "a")), file("scratch", A), "edit", null],
    ["a child in X under a read parent in A reads X's scratch", agent(link("edit", "x"), link("read", "a")), file("scratch", X), "read", "agent_read_only"],
    ["a read child under an edit parent reads manuscript", agent(link("read", "a"), link("edit", "a")), file("manuscript"), "read", "agent_read_only"],
  ];

  it.each(table)("%s", (_case, principal, facts, level, limitedBy) => {
    const result = decide(
      principal,
      facts,
      ownerGrants.filter(() => principal.accountId === OWNER),
    );
    expect([result.level, result.limitedBy]).toEqual([level, limitedBy]);
  });

  it("names the archived Work for refusal copy", () => {
    expect(decide(person, file("scratch", archived), ownerGrants).archivedWork).toEqual({
      id: "old",
      slug: "old",
    });
  });

  it("routes drafted sources to the agent's draft and caps them by the draft's Work", () => {
    const drafting = (draftWork: FileWorkFacts): [Principal, FileFacts] => [
      { accountId: OWNER, agent: { chain: [link("edit", draftWork.id)], draftWork } },
      file("manuscript", null, { draftWork }),
    ];
    const live = decide(...drafting(A), ownerGrants);
    expect(live.destination).toEqual({ kind: "draft", workId: "a", workSlug: "a" });
    expect(live.level).toBe("edit");
    const frozen = decide(...drafting(archived), ownerGrants);
    expect([frozen.level, frozen.limitedBy]).toEqual(["read", "work_archived"]);
    // Scratch and uploads stay live in draft mode (D9).
    const [principal] = drafting(archived);
    expect(decide(principal, file("scratch", A), ownerGrants).destination).toEqual({
      kind: "live",
    });
    expect(CONTEXT_URI_SCHEMES.filter(isDrafted)).toEqual(["manuscript", "kb", "user", "unfiled"]);
    for (const scheme of CONTEXT_URI_SCHEMES) {
      expect(sourceDestination(scheme, null)).toEqual({ kind: "live" });
    }
  });
});
