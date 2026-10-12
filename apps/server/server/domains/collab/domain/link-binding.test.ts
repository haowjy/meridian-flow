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
  return { ordinary: createLinkBinder(deps), planned: createImportLinkBinder(deps), registered };
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

  it("an invalid id binds nothing rather than falling back to the written occupant", async () => {
    const subject = setup();
    const invalidId = "not-an-id" as DocumentId;
    const result = await subject.planned.bindMarkdown({
      holder: { documentId: HOLDER },
      markdown: "[x](kb://A)",
      targets: new Map([[0, invalidId]]),
    });
    expect(walkLinkOccurrences(result.blocks)[0]?.attrs).toMatchObject({ ref: null, href: "" });
    expect(result.invalidTargets).toEqual([{ occurrence: 0, documentId: invalidId }]);
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
