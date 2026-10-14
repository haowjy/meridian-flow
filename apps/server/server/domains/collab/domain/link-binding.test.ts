/** Pure planned-binding contracts, including occurrence identity and capability isolation. */
import { yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { walkLinkOccurrences } from "@meridian/markup/links";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createStaticDocumentLinkScopes } from "../adapters/in-memory/static-document-link-scopes.js";
import {
  type BindMarkdownInput,
  createImportLinkBinder,
  createLinkBinder,
} from "./link-binding.js";

const A = "00000000-0000-4000-8000-000000000a01" as DocumentId;
const B = "00000000-0000-4000-8000-000000000a02" as DocumentId;
const HOLDER = "00000000-0000-4000-8000-000000000a03" as DocumentId;
const schema = buildDocumentSchema();
function setup() {
  const registered: string[] = [];
  const deps = {
    schema,
    codec: mdxCodec({ schema }),
    model: yProsemirrorModel(schema),
    coordinator: {
      withDocument: async () => {
        throw new Error("fresh binding never reads a room");
      },
    },
    links: createStaticDocumentLinkScopes({
      projectId: "binding",
      documents: [
        { documentId: A, uri: "kb://A" },
        { documentId: B, uri: "kb://moved/B" },
        { documentId: HOLDER, uri: "kb://holder" },
      ].map((document) => ({
        ...document,
        owner: { workId: null },
        projectId: "binding",
        presence: "live" as const,
        readable: true,
        nameable: true,
      })),
    }),
    registrar: {
      register: async (rows: readonly { aheadId: string }[]) => {
        registered.push(...rows.map(({ aheadId }) => `ahead:${aheadId}`));
      },
    },
    resolveFiletype: async () => "markdown",
    inTransaction: () => false,
  };
  const { coordinator: _coordinator, model: _model, ...importDeps } = deps;
  return {
    ordinary: createLinkBinder(deps),
    planned: createImportLinkBinder(importDeps),
    registered,
  };
}

describe("planned link binding", () => {
  it("binds each supplied occurrence to identity and registers only the remaining minted refs", async () => {
    const subject = setup();
    const result = await subject.planned.bindMarkdown({
      holder: { documentId: HOLDER },
      markdown: "[x](kb://A) [y](kb://unknown) [z](kb://later)",
      targets: new Map([
        [0, B],
        [1, B],
      ]),
    });
    const refs = walkLinkOccurrences(result.blocks).map(({ attrs }) => attrs.ref);
    expect(refs.slice(0, 2)).toEqual([`doc:${B}`, `doc:${B}`]);
    expect(result.aheadRefs).toEqual([{ occurrence: 2, ref: refs[2] }]);
    expect(subject.registered).toEqual([refs[2]]);
  });

  it("a pending target mints an ahead ref at its written address, never binding the occupant there", async () => {
    const subject = setup();
    const PLANNED = "00000000-0000-4000-8000-000000000a04" as DocumentId;
    const result = await subject.planned.bindMarkdown({
      holder: { documentId: HOLDER },
      markdown: "![map](kb://A.png) [x](kb://A) [y](kb://elsewhere)",
      targets: new Map([
        [0, PLANNED],
        [1, PLANNED],
        [2, B],
      ]),
      pending: new Set([PLANNED, B]),
    });
    const occurrences = walkLinkOccurrences(result.blocks);
    const refs = occurrences.map(({ attrs }) => attrs.ref);
    expect(refs[0]).toMatch(/^ahead:/);
    expect(refs[1]).toMatch(/^ahead:/);
    expect(refs[1]).not.toBe(`doc:${A}`);
    // A pending identity that is already live binds to itself.
    expect(refs[2]).toBe(`doc:${B}`);
    expect(result.aheadRefs).toEqual([
      { occurrence: 0, ref: refs[0] },
      { occurrence: 1, ref: refs[1] },
    ]);
    expect(subject.registered).toEqual([refs[0], refs[1]]);
  });

  it("adjacent occurrences sharing a written href keep their own identities", async () => {
    const subject = setup();
    const PLANNED = "00000000-0000-4000-8000-000000000a04" as DocumentId;
    const result = await subject.planned.bindMarkdown({
      holder: { documentId: HOLDER },
      markdown: "[a](p0)[b](p1)[c](p2) [web](https://example.com)",
      hrefs: new Map([
        [0, "kb://A"],
        [1, "kb://A"],
        [2, "kb://A"],
      ]),
      targets: new Map([
        [0, A],
        [1, PLANNED],
        [2, B],
      ]),
      pending: new Set([PLANNED]),
    });
    const occurrences = walkLinkOccurrences(result.blocks);
    expect(occurrences.map(({ label, attrs }) => [label, attrs.href])).toEqual([
      ["a", "kb://A"],
      ["b", "kb://A"],
      ["c", "kb://A"],
      ["web", "https://example.com"],
    ]);
    expect(occurrences[0]?.attrs.ref).toBe(`doc:${A}`);
    expect(occurrences[1]?.attrs.ref).toMatch(/^ahead:/);
    expect(occurrences[2]?.attrs.ref).toBe(`doc:${B}`);
    expect(result.aheadRefs).toEqual([{ occurrence: 1, ref: occurrences[1]?.attrs.ref }]);
  });

  it("an invalid id binds nothing rather than falling back to the written occupant", async () => {
    const subject = setup();
    const invalidId = "not-an-id" as DocumentId;
    const result = await subject.planned.bindMarkdown({
      holder: { documentId: HOLDER },
      markdown: "[x](kb://A)",
      targets: new Map([[0, invalidId]]),
    });
    expect(walkLinkOccurrences(result.blocks)[0]?.attrs).toMatchObject({ ref: null, href: "" });
    expect(subject.registered).toEqual([]);
  });

  it("the ordinary binder has no targets capability, including untyped callers", async () => {
    expectTypeOf<BindMarkdownInput>().not.toHaveProperty("targets");
    const subject = setup();
    await expect(
      subject.ordinary.bindMarkdown({
        holder: { documentId: HOLDER },
        markdown: "[x](kb://A)",
        targets: new Map([[0, B]]),
      } as never),
    ).rejects.toThrow("import binder");
    await expect(
      subject.planned.bindMarkdown({
        holder: { documentId: HOLDER },
        markdown: "[x](kb://A)",
        targets: new Map([[1, B]]),
      }),
    ).rejects.toThrow("occurrence");
  });
});
