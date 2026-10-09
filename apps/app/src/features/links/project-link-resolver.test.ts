/**
 * Where each internal link's answer comes from: the scope's local index at
 * once, or the server, and which of the two wins when both speak.
 */

import type { DocumentLinkAnswer } from "@meridian/contracts";
import { expect, it, vi } from "vitest";

import { resolveDocumentLinks } from "@/client/api/document-links-api";
import {
  classifyLinkTarget,
  createLinkResolution,
  type LinkKey,
  type LinkResolutionEntry,
} from "@/core/editor/links";

import { followProjectLink } from "./follow-link";
import { createProjectLinkResolver, type LinkResolutionScope } from "./project-link-resolver";
import type { LinkableDocument } from "./useLinkableDocuments";

vi.mock("@/client/api/document-links-api", () => ({ resolveDocumentLinks: vi.fn() }));
const server = vi.mocked(resolveDocumentLinks);

const KAEL = "00000000-0000-4000-8000-00000000000a";
const NINE = "00000000-0000-4000-8000-000000000009";
const AHEAD = "ahead:00000000-0000-4000-8000-0000000000a1";
const HOLDER = "manuscript://Holder.md";

const document = (documentId: string, name: string): LinkableDocument => ({
  documentId,
  title: name,
  uri: `manuscript://${name}.md`,
  workId: null,
});
const DOCUMENTS = [document(KAEL, "Kael"), document(NINE, "Nine")];

const found = (documentId: string, name: string): DocumentLinkAnswer => ({
  state: "document",
  document: {
    id: documentId,
    title: name,
    scheme: "manuscript",
    path: `${name}.md`,
    uri: `manuscript://${name}.md`,
    workId: null,
  },
  inDraft: false,
});

type Row = {
  rule: string;
  links: LinkKey[];
  /** The server's answer per link (keyed by ref, else href); "fail" fails the request. */
  server?: Record<string, DocumentLinkAnswer | "fail">;
  complete?: boolean;
  scope?: Partial<LinkResolutionScope>;
  /** Read right after asking, before the server has answered. */
  before: (string | null)[];
  after: (string | null)[];
  /** What reached the server (ref, else href). */
  asked: string[];
  /** A listener hears the server's answer land. */
  heard?: boolean;
  /** What a click right after asking waits for, as `resolve()` answers it. */
  clicked?: string | null;
};

const ROWS: Row[] = [
  {
    rule: "a doc ref the complete index holds resolves locally, wherever it lives now",
    links: [{ ref: `doc:${KAEL}`, href: "manuscript://Old Kael.md" }],
    before: ["resolved:Kael"],
    after: ["resolved:Kael"],
    asked: [],
  },
  {
    rule: "a doc ref the index does not hold asks, and the server's gone stands",
    links: [{ ref: `doc:${KAEL}`, href: "manuscript://Kael.md" }],
    complete: false,
    server: { [`doc:${KAEL}`]: { state: "gone" } },
    before: ["pending"],
    after: ["gone"],
    asked: [`doc:${KAEL}`],
  },
  {
    rule: "a no-ref link the index holds at its address resolves locally",
    links: [{ ref: null, href: "Kael.md" }],
    before: ["resolved:Kael"],
    after: ["resolved:Kael"],
    asked: [],
  },
  {
    rule: "a malformed ref is gone locally and never falls back to its address",
    links: [{ ref: "doc:kael", href: "manuscript://Kael.md" }],
    before: ["gone"],
    after: ["gone"],
    asked: [],
  },
  {
    rule: "an ahead ref always asks; missing with nothing there is doesn't exist yet",
    links: [{ ref: AHEAD, href: "manuscript://Ten.md" }],
    server: { [AHEAD]: { state: "missing", uri: "manuscript://Ten.md" } },
    before: ["pending"],
    after: ["unresolved"],
    asked: [AHEAD],
  },
  {
    rule: "an ahead ref at an indexed address resolves at once, and missing keeps it",
    links: [{ ref: AHEAD, href: "manuscript://Nine.md" }],
    server: { [AHEAD]: { state: "missing", uri: "manuscript://Nine.md" } },
    before: ["resolved:Nine"],
    after: ["resolved:Nine"],
    asked: [AHEAD],
  },
  {
    rule: "the server naming another document replaces the local answer",
    links: [{ ref: AHEAD, href: "manuscript://Nine.md" }],
    server: { [AHEAD]: found(KAEL, "Kael") },
    before: ["resolved:Nine"],
    after: ["resolved:Kael"],
    asked: [AHEAD],
  },
  {
    rule: "the server's gone replaces the local answer",
    links: [{ ref: AHEAD, href: "manuscript://Nine.md" }],
    server: { [AHEAD]: { state: "gone" } },
    before: ["resolved:Nine"],
    after: ["gone"],
    asked: [AHEAD],
    heard: true,
    clicked: "gone",
  },
  {
    rule: "a server failure keeps the local answer",
    links: [{ ref: AHEAD, href: "manuscript://Nine.md" }],
    server: { [AHEAD]: "fail" },
    before: ["resolved:Nine"],
    after: ["resolved:Nine"],
    asked: [AHEAD],
  },
  {
    rule: "a failed server question fails only itself, not the local answers in its batch",
    links: [
      { ref: `doc:${KAEL}`, href: "manuscript://Kael.md" },
      { ref: AHEAD, href: "manuscript://Ten.md" },
    ],
    server: { [AHEAD]: "fail" },
    before: ["resolved:Kael", "pending"],
    after: ["resolved:Kael", null],
    asked: [AHEAD],
  },
  {
    rule: "a failed question with nothing shown meanwhile is heard as no answer",
    links: [{ ref: AHEAD, href: "manuscript://Ten.md" }],
    server: { [AHEAD]: "fail" },
    before: ["pending"],
    after: [null],
    asked: [AHEAD],
    heard: true,
  },
  {
    rule: "a holder whose address has not arrived asks the server nothing",
    links: [
      { ref: AHEAD, href: "manuscript://Ten.md" },
      { ref: null, href: "Ten.md" },
    ],
    scope: { baseUri: null, holderDocumentId: "00000000-0000-4000-8000-0000000000bb" },
    before: [null, null],
    after: [null, null],
    asked: [],
  },
];

function show(entry: LinkResolutionEntry | null): string | null {
  return entry?.state === "resolved" ? `resolved:${entry.document.title}` : (entry?.state ?? null);
}

it("routes each link to the local index or the server", async () => {
  for (const row of ROWS) {
    const asked: string[] = [];
    server.mockReset();
    server.mockImplementation(async (_projectId, { links }) => {
      const keys = links.map(({ ref, href }) => ref ?? href);
      asked.push(...keys);
      if (keys.some((key) => row.server?.[key] === "fail")) throw new Error("offline");
      return {
        answers: keys.map((key) => {
          const answer = row.server?.[key];
          return answer && answer !== "fail" ? answer : { state: "unresolvable" };
        }),
      };
    });
    const resolution = createLinkResolution();
    const scope = { projectId: "p", workId: "w", baseUri: HOLDER, ...row.scope };
    resolution.registerResolver(
      createProjectLinkResolver(scope, {
        documents: DOCUMENTS,
        revision: "r",
        complete: row.complete ?? true,
      }),
      { baseUri: scope.baseUri },
    );

    resolution.request(row.links);
    let heard = false;
    resolution.subscribe(() => (heard = true));
    const [first] = row.links;
    const click = row.clicked !== undefined && first ? resolution.resolve(first) : null;
    expect
      .soft(
        row.links.map((link) => show(resolution.read(link))),
        row.rule,
      )
      .toEqual(row.before);
    // The mocked server answers in microtasks; one macrotask lets them all land.
    await new Promise((settled) => setTimeout(settled, 0));
    expect
      .soft(
        row.links.map((link) => show(resolution.read(link))),
        row.rule,
      )
      .toEqual(row.after);
    expect.soft(asked, row.rule).toEqual(row.asked);
    if (row.heard) expect.soft(heard, row.rule).toBe(true);
    if (click) expect.soft(show(await click), row.rule).toBe(row.clicked);

    // A gone link is not followed: nothing opens, and nothing is said.
    const [link] = row.links;
    const target = link && classifyLinkTarget(link.href);
    if (row.after[0] === "gone" && link && target) {
      const events: string[] = [];
      await followProjectLink({
        target,
        ref: link.ref,
        gesture: "current",
        resolution,
        open: async (opened) => {
          events.push(`open:${opened.documentId}`);
        },
        reporter: {
          report: (outcome) => events.push(`report:${outcome.state}`),
          clear: () => events.push("clear"),
        },
        signal: new AbortController().signal,
      });
      expect.soft(events, row.rule).toEqual(["clear"]);
    }
  }
});
