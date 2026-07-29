/** Behavioral contract shared by every document-link resolver adapter. */

import { describe, expect, it } from "vitest";
import type { DocumentLinkCandidate } from "../../document-link-resolution.js";
import type { DocumentLinkResolver } from "../../ports/document-link-resolver.js";

export const DOCUMENT_LINK_CONTRACT_IDS = {
  project: "00000000-0000-4000-8000-000000000901",
  work: "00000000-0000-4000-8000-000000000902",
  chapter: "00000000-0000-4000-8000-000000000903",
  character: "00000000-0000-4000-8000-000000000904",
  workNote: "00000000-0000-4000-8000-000000000905",
  ambiguous: "00000000-0000-4000-8000-000000000906",
} as const;

export interface DocumentLinkResolverContractHarness {
  resolver: DocumentLinkResolver;
  remember(candidate: DocumentLinkCandidate): Promise<void>;
}

export function registerDocumentLinkResolverContract(
  name: string,
  createHarness: () => Promise<DocumentLinkResolverContractHarness>,
): void {
  describe(`${name} document-link resolver contract`, () => {
    it("resolves exact titles and aliases without persisting resolution state", async () => {
      const harness = await createHarness();
      await harness.remember(chapter());
      await harness.remember(character());

      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: { kind: "wikilink", name: "Chapter 213" },
        }),
      ).resolves.toMatchObject({
        documentId: DOCUMENT_LINK_CONTRACT_IDS.chapter,
        title: "Chapter 213",
        uri: "manuscript://chapters/Chapter 213.md",
      });
      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: { kind: "wikilink", name: "  the stormblade " },
        }),
      ).resolves.toMatchObject({
        documentId: DOCUMENT_LINK_CONTRACT_IDS.character,
        uri: "manuscript://characters/Kael.md",
      });
    });

    it("resolves manuscript, work, and relative spellings through one port", async () => {
      const harness = await createHarness();
      await harness.remember(chapter());
      await harness.remember(character());
      await harness.remember(workNote());

      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: { kind: "scheme", uri: "manuscript://chapters/Chapter 213" },
        }),
      ).resolves.toMatchObject({
        documentId: DOCUMENT_LINK_CONTRACT_IDS.chapter,
        scheme: "manuscript",
      });
      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: {
            kind: "relative",
            path: "../characters/Kael.md",
            baseUri: "manuscript://chapters/Chapter 213.md",
          },
        }),
      ).resolves.toMatchObject({
        documentId: DOCUMENT_LINK_CONTRACT_IDS.character,
        uri: "manuscript://characters/Kael.md",
      });
      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          workId: DOCUMENT_LINK_CONTRACT_IDS.work,
          target: { kind: "scheme", uri: "work://notes/Pacing.md" },
        }),
      ).resolves.toMatchObject({
        documentId: DOCUMENT_LINK_CONTRACT_IDS.workNote,
        uri: `work://${DOCUMENT_LINK_CONTRACT_IDS.work}/notes/Pacing.md`,
      });
    });

    it("returns nothing for misses, invalid traversal, and ambiguous names", async () => {
      const harness = await createHarness();
      await harness.remember(chapter());

      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: { kind: "wikilink", name: "Not written yet" },
        }),
      ).resolves.toBeNull();
      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: {
            kind: "relative",
            path: "../../outside.md",
            baseUri: "manuscript://chapter.md",
          },
        }),
      ).resolves.toBeNull();

      await harness.remember({
        ...chapter(),
        documentId: DOCUMENT_LINK_CONTRACT_IDS.ambiguous,
        path: "alternate/Chapter 213.md",
      });
      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: { kind: "wikilink", name: "Chapter 213" },
        }),
      ).resolves.toBeNull();
    });

    it("observes documents added after the resolver is created", async () => {
      const harness = await createHarness();
      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: { kind: "wikilink", name: "Chapter 213" },
        }),
      ).resolves.toBeNull();

      await harness.remember(chapter());

      await expect(
        harness.resolver.resolve({
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          target: { kind: "wikilink", name: "Chapter 213" },
        }),
      ).resolves.toMatchObject({ documentId: DOCUMENT_LINK_CONTRACT_IDS.chapter });
    });
  });
}

function chapter(): DocumentLinkCandidate {
  return {
    projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
    documentId: DOCUMENT_LINK_CONTRACT_IDS.chapter,
    title: "Chapter 213",
    aliases: ["The Trial"],
    scheme: "manuscript",
    path: "chapters/Chapter 213.md",
    workId: null,
  };
}

function character(): DocumentLinkCandidate {
  return {
    projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
    documentId: DOCUMENT_LINK_CONTRACT_IDS.character,
    title: "Kael",
    aliases: ["The Stormblade"],
    scheme: "manuscript",
    path: "characters/Kael.md",
    workId: null,
  };
}

function workNote(): DocumentLinkCandidate {
  return {
    projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
    documentId: DOCUMENT_LINK_CONTRACT_IDS.workNote,
    title: "Pacing",
    scheme: "work",
    path: "notes/Pacing.md",
    workId: DOCUMENT_LINK_CONTRACT_IDS.work,
  };
}
