/** Behavioral contract for the single writer-turn admission owner. */

import type { UserTurnAdmissionInput } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ProjectContextAvailabilityPort } from "../../context/index.js";
import { createInMemoryThreadRunOwnership } from "../loop/thread-run-ownership.js";
import type { AdmissionRecord, AdmissionWriterProducer } from "./user-turn-admission.js";
import {
  AdmissionConflictError,
  canonicalAdmissionFingerprint,
  createUserTurnAdmission,
  InvalidAdmissionError,
  parseSubmittedReferences,
  parseUserMessageBlocks,
} from "./user-turn-admission.js";

const actor = "11111111-1111-4111-8111-111111111111" as never;
const threadId = "22222222-2222-4222-8222-222222222222" as never;
const documentId = "33333333-3333-4333-8333-333333333333" as never;
const projectId = "44444444-4444-4444-8444-444444444444" as never;
const uri = "uploads://@/map.png";
const occurrenceText = "[[map]]";

function input(overrides: Partial<UserTurnAdmissionInput> = {}): UserTurnAdmissionInput {
  return {
    actorUserId: actor,
    threadId,
    submissionId: "submission-1",
    text: `see ${occurrenceText}${occurrenceText}`,
    blocks: [
      { type: "text", text: "see " },
      { type: "reference", text: occurrenceText, documentId, uri },
      { type: "image", documentId, uri },
      { type: "reference", text: occurrenceText, documentId, uri },
      { type: "image", documentId, uri },
    ],
    references: [{ documentId, uri, purpose: "draft-upload", intakeId: "intake-1" }],
    ...overrides,
  };
}

function accepted() {
  return {
    kind: "accepted" as const,
    threadId,
    submissionId: "submission-1",
    userTurnId: "55555555-5555-4555-8555-555555555555" as never,
    assistantTurnId: "66666666-6666-4666-8666-666666666666" as never,
    resumeAfterSeq: "4",
    snapshotFloorNextSeq: "9",
  };
}

function availableResolution(resolvedUri = uri) {
  return {
    kind: "available" as const,
    documentId,
    generation: "1",
    authority: { kind: "work" as const, projectId, workId: "no-work", workSlug: null },
    entry: {
      kind: "file" as const,
      entryId: documentId,
      uri: resolvedUri,
      editable: false,
      disposition: "binary" as const,
      fileType: "image" as const,
      mimeType: "image/png",
      scope: { kind: "work" as const, projectId, workId: "no-work" },
      sourceId: "source",
      parentId: "source",
      name: "map.png",
      aliases: [],
      path: ["map.png"],
      provisionalName: false,
    },
  };
}

function harness(
  existing: AdmissionRecord | null = null,
  resolutions: readonly unknown[] = [availableResolution()],
  draftUploadMatches = true,
  authorizeActivatedSkills?: (input: {
    threadId: string;
    slugs: readonly string[];
  }) => Promise<void>,
) {
  const lookup = vi.fn(async () => existing);
  let reservedFingerprint = "";
  let capturedStart: Parameters<AdmissionWriterProducer["enqueue"]>[0] | null = null;
  const producer: AdmissionWriterProducer["enqueue"] = async (start) => {
    capturedStart = start;
    return accepted();
  };
  const availability = {
    lookup: vi.fn(async () => ({
      projectId,
      resolutionId: "resolution",
      resolutions,
    })),
  } as ProjectContextAvailabilityPort;
  const threadProject = vi.fn(async () => projectId);
  const runOwnership = createInMemoryThreadRunOwnership();
  const service = createUserTurnAdmission({
    runOwnership,
    records: {
      lookup,
      recoverExpiredPending: vi.fn(async () => existing),
      reserve: vi.fn(async (request) => {
        reservedFingerprint = request.fingerprint;
        return existing
          ? { kind: "winner" as const, record: existing }
          : { kind: "reserved" as const };
      }),
      reject: vi.fn(async (request) => ({
        state: "rejected" as const,
        fingerprint: reservedFingerprint,
        code: request.code,
      })),
      retire: vi.fn(async (request) => ({
        kind: "retired" as const,
        submissionId: request.submissionId,
        code: "retired" as const,
      })),
    },
    availability,
    threadProject,
    verifyDraftUpload: vi.fn(async () => draftUploadMatches),
    authorizeActivatedSkills,
    producer: { enqueue: producer },
  });
  return {
    service,
    lookup,
    producer,
    availability,
    threadProject,
    runOwnership,
    captured: () => capturedStart,
  };
}

describe("UserTurnAdmission", () => {
  it("leaves unexpired reservations outside the run-claim race", async () => {
    const { service, runOwnership } = harness({
      state: "pending",
      fingerprint: canonicalAdmissionFingerprint({
        ...input(),
        blocks: parseUserMessageBlocks(input().blocks, input().text),
        references: parseSubmittedReferences(input().references),
      }),
      claimExpiresAt: new Date("2999-01-01T00:00:00Z"),
    });
    const acquire = vi.spyOn(runOwnership, "tryAcquire");
    await expect(service.lookup(input())).resolves.toMatchObject({ kind: "pending" });
    await expect(service.admit(input())).resolves.toMatchObject({ kind: "pending" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("accepts skill blocks in concat and ignores them for reference membership", async () => {
    const skill = {
      type: "skill" as const,
      text: "/writing-principles",
      slug: "writing-principles",
      name: "Writing principles",
      description: "Reader reward.",
    };
    const parsed = parseUserMessageBlocks(
      [{ type: "text", text: "use " }, skill],
      "use /writing-principles",
    );
    expect(parsed).toEqual([{ type: "text", text: "use " }, skill]);
    expect(() => parseUserMessageBlocks([{ ...skill, extra: true }], skill.text)).toThrow(
      InvalidAdmissionError,
    );
    expect(() => parseUserMessageBlocks([{ ...skill, text: "/other" }], "/other")).toThrow(
      InvalidAdmissionError,
    );
    const h = harness(null, [availableResolution()], true, async () => undefined);
    await expect(
      h.service.admit(
        input({
          text: "use /writing-principles",
          blocks: [{ type: "text", text: "use " }, skill],
          references: [],
          activatedSkillSlugs: ["writing-principles"],
        }),
      ),
    ).resolves.toMatchObject({ kind: "accepted" });
    expect(h.captured()?.blocks).toEqual([{ type: "text", text: "use " }, skill]);
    expect(h.captured()?.references).toEqual([]);
  });

  it("parses exact ordered occurrences and proves text equivalence", () => {
    const parsed = parseUserMessageBlocks(input().blocks, input().text);
    expect(parsed.map((block) => block.type)).toEqual([
      "text",
      "reference",
      "image",
      "reference",
      "image",
    ]);
    expect(() =>
      parseUserMessageBlocks([{ type: "text", text: "different" }], input().text),
    ).toThrow(InvalidAdmissionError);
    expect(() =>
      parseUserMessageBlocks([{ type: "text", text: input().text, extra: true }], input().text),
    ).toThrow(InvalidAdmissionError);
    for (const invalid of [
      { type: "reference", text: "", documentId, uri },
      { type: "reference", text: occurrenceText, documentId: "invalid", uri },
      { type: "reference", text: occurrenceText, documentId, uri: "uploads://@//map.png" },
      { type: "reference", text: occurrenceText, documentId },
      { type: "reference", text: occurrenceText, documentId, uri, extra: true },
    ]) {
      expect(() => parseUserMessageBlocks([invalid], occurrenceText)).toThrow(
        InvalidAdmissionError,
      );
    }
    expect(() =>
      parseSubmittedReferences([
        { documentId, uri, purpose: "reference" },
        { documentId, uri, purpose: "draft-upload", intakeId: "intake" },
      ]),
    ).toThrow(InvalidAdmissionError);
  });

  it("replays a complete accepted result before project, authorization, or busy work", async () => {
    const payload = input();
    const fingerprint = canonicalAdmissionFingerprint({
      ...payload,
      blocks: parseUserMessageBlocks(payload.blocks, payload.text),
    });
    const h = harness({ state: "accepted", fingerprint, response: accepted() });
    await expect(h.service.admit(payload)).resolves.toEqual({
      ...accepted(),
      kind: "already-accepted",
    });
    expect(h.threadProject).not.toHaveBeenCalled();
    expect(h.captured()).toBeNull();
  });

  it("rejects a same-key fingerprint mismatch definitely", async () => {
    const h = harness({ state: "accepted", fingerprint: "different", response: accepted() });
    await expect(h.service.admit(input())).rejects.toBeInstanceOf(AdmissionConflictError);
  });

  it("fingerprints occurrence spelling, identity, order, multiplicity, images, and provenance", async () => {
    const alternateId = "77777777-7777-4777-8777-777777777777" as never;
    const base = input();
    const parsed = parseUserMessageBlocks(base.blocks, base.text);
    const fingerprint = canonicalAdmissionFingerprint({ ...base, blocks: parsed });
    const variants: UserTurnAdmissionInput[] = [
      input({
        text: `see [[Map]]${occurrenceText}`,
        blocks: [
          { type: "text", text: "see " },
          { type: "reference", text: "[[Map]]", documentId, uri },
          { type: "image", documentId, uri },
          { type: "reference", text: occurrenceText, documentId, uri },
          { type: "image", documentId, uri },
        ],
      }),
      input({
        blocks: parsed.map((block) =>
          block.type === "text" ? block : { ...block, documentId: alternateId },
        ),
        references: [
          { documentId: alternateId, uri, purpose: "draft-upload", intakeId: "intake-1" },
        ],
      }),
      input({
        text: `see ${occurrenceText}`,
        blocks: [
          { type: "text", text: "see " },
          { type: "reference", text: occurrenceText, documentId, uri },
          { type: "image", documentId, uri },
        ],
      }),
      input({
        blocks: [
          { type: "text", text: "see " },
          { type: "reference", text: occurrenceText, documentId, uri },
          { type: "reference", text: occurrenceText, documentId, uri },
          { type: "image", documentId, uri },
        ],
      }),
      input({ references: [{ documentId, uri, purpose: "reference" }] }),
    ];
    for (const variant of variants) {
      const variantFingerprint = canonicalAdmissionFingerprint({
        ...variant,
        blocks: parseUserMessageBlocks(variant.blocks, variant.text),
        references: parseSubmittedReferences(variant.references),
      });
      expect(variantFingerprint).not.toBe(fingerprint);
    }
    const orderedBlocks = [
      { type: "reference" as const, text: "[[map]]", documentId, uri },
      {
        type: "reference" as const,
        text: "[[map]]",
        documentId: alternateId,
        uri: "uploads://@/alternate.png",
      },
    ];
    const orderedReferences = [
      { documentId, uri, purpose: "reference" as const },
      {
        documentId: alternateId,
        uri: "uploads://@/alternate.png",
        purpose: "reference" as const,
      },
    ];
    expect(
      canonicalAdmissionFingerprint({
        actorUserId: actor,
        threadId,
        text: "[[map]][[map]]",
        blocks: orderedBlocks,
        references: orderedReferences,
      }),
    ).not.toBe(
      canonicalAdmissionFingerprint({
        actorUserId: actor,
        threadId,
        text: "[[map]][[map]]",
        blocks: [...orderedBlocks].reverse(),
        references: orderedReferences,
      }),
    );

    const replay = harness({ state: "accepted", fingerprint, response: accepted() }, []);
    await expect(
      replay.service.admit(variants[1] as UserTurnAdmissionInput),
    ).rejects.toBeInstanceOf(AdmissionConflictError);
    expect(replay.availability.lookup).not.toHaveBeenCalled();
  });

  it("authorizes stable ID plus canonical URI and preserves ordered occurrences", async () => {
    const h = harness();
    await expect(h.service.admit(input())).resolves.toMatchObject({ kind: "accepted" });
    const start = h.captured();
    expect(start).not.toBeNull();
    if (!start) throw new Error("starter was not called");
    expect(start.blocks.map((block) => block.type)).toEqual([
      "text",
      "reference",
      "image",
      "reference",
      "image",
    ]);
    expect(start.references).toEqual([
      { documentId, uri, purpose: "draft-upload", intakeId: "intake-1", relationship: "created" },
    ]);
    expect(h.availability.lookup).toHaveBeenCalledTimes(1);
    expect(h.availability.lookup).toHaveBeenCalledWith(
      { projectId, documentIds: [documentId] },
      { userId: actor },
    );
  });

  it.each([
    ["missing", [], true],
    ["URI mismatch", [availableResolution("uploads://@/moved.png")], true],
    [
      "deleted",
      [
        {
          kind: "deleted",
          documentId,
          generation: "1",
          lastAuthority: { kind: "work", projectId, workId: "no-work", workSlug: null },
        },
      ],
      true,
    ],
    ["not visible", [{ kind: "not-visible", documentId, checkedGeneration: "1" }], true],
    [
      "indeterminate",
      [
        {
          kind: "indeterminate",
          documentId,
          checkedGeneration: "1",
          reason: "identity_inconsistent",
        },
      ],
      true,
    ],
    ["upload identity mismatch", [availableResolution()], false],
  ])("degrades %s identity in place without veto or retargeting", async (_label, resolutions, draftUploadMatches) => {
    const h = harness(null, resolutions, draftUploadMatches);
    await expect(h.service.admit(input())).resolves.toMatchObject({ kind: "accepted" });
    expect(h.captured()?.blocks).toEqual([
      { type: "text", text: "see " },
      { type: "text", text: occurrenceText },
      { type: "text", text: occurrenceText },
    ]);
    expect(h.captured()?.references).toEqual([]);
    expect(
      h
        .captured()
        ?.blocks.filter((block) => block.type === "text" || block.type === "reference")
        .map((block) => block.text)
        .join(""),
    ).toBe(input().text);
    expect(h.availability.lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid membership, image pairing, and identity cardinality", async () => {
    const h = harness();
    await expect(
      h.service.admit(
        input({
          blocks: [{ type: "reference", text: occurrenceText, documentId, uri }],
          text: occurrenceText,
          references: [],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidAdmissionError);
    await expect(
      h.service.admit(
        input({
          blocks: [
            { type: "text", text: "see " },
            { type: "image", documentId, uri },
            { type: "reference", text: occurrenceText, documentId, uri },
          ],
          text: `see ${occurrenceText}`,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidAdmissionError);
    const references = Array.from({ length: 129 }, (_, index) => ({
      documentId: `33333333-3333-4333-8333-${index.toString().padStart(12, "0")}` as never,
      uri: `uploads://@/map-${index}.png`,
      purpose: "reference" as const,
    }));
    await expect(
      h.service.admit(
        input({ blocks: [{ type: "text", text: "plain" }], text: "plain", references }),
      ),
    ).rejects.toBeInstanceOf(InvalidAdmissionError);
  });

  it("does not adopt URI-shaped prose and exposes not-seen and retirement without retry", async () => {
    const h = harness();
    const prose = input({ text: uri, blocks: [{ type: "text", text: uri }], references: [] });
    await h.service.admit(prose);
    expect(h.captured()?.references).toEqual([]);
    await expect(
      h.service.lookup({ actorUserId: actor, threadId, submissionId: "missing" }),
    ).resolves.toEqual({ kind: "not-seen", submissionId: "missing" });
    await expect(
      h.service.retire({ actorUserId: actor, threadId, submissionId: "missing" }),
    ).resolves.toEqual({ kind: "retired", submissionId: "missing", code: "retired" });
  });

  it("authorizes activated skill slugs and rejects unknown ones", async () => {
    const authorize = vi.fn(async ({ slugs }: { slugs: readonly string[] }) => {
      if (slugs.includes("missing-skill")) {
        throw new InvalidAdmissionError('Skill "missing-skill" is not available');
      }
    });
    const acceptedHarness = harness(null, [availableResolution()], true, authorize);
    await acceptedHarness.service.admit(
      input({
        text: "plain",
        blocks: [{ type: "text", text: "plain" }],
        references: [],
        activatedSkillSlugs: ["creative-writing-modes"],
      }),
    );
    expect(authorize).toHaveBeenCalledWith({
      threadId,
      slugs: ["creative-writing-modes"],
    });
    expect(acceptedHarness.captured()?.admission.activatedSkillSlugs).toEqual([
      "creative-writing-modes",
    ]);

    const rejected = harness(null, [availableResolution()], true, authorize);
    await expect(
      rejected.service.admit(
        input({
          text: "plain",
          blocks: [{ type: "text", text: "plain" }],
          references: [],
          activatedSkillSlugs: ["missing-skill"],
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidAdmissionError);
    expect(rejected.captured()).toBeNull();
  });

  it("treats missing activatedSkillSlugs as none and fingerprints the set", () => {
    const parsed = parseUserMessageBlocks([{ type: "text", text: "plain" }], "plain");
    const none = canonicalAdmissionFingerprint({
      ...input({ text: "plain", blocks: parsed, references: [] }),
      blocks: parsed,
      references: [],
    });
    const empty = canonicalAdmissionFingerprint({
      ...input({ text: "plain", blocks: parsed, references: [] }),
      blocks: parsed,
      references: [],
      activatedSkillSlugs: [],
    });
    const activated = canonicalAdmissionFingerprint({
      ...input({ text: "plain", blocks: parsed, references: [] }),
      blocks: parsed,
      references: [],
      activatedSkillSlugs: ["writing-principles", "creative-writing-modes"],
    });
    expect(none).toBe(empty);
    expect(activated).not.toBe(none);
  });
});

it("rejects client-authored read snapshots on references", () => {
  expect(() =>
    parseUserMessageBlocks(
      [
        {
          type: "reference",
          text: "[[kb://chapter.md]]",
          documentId: "00000000-0000-4000-8000-000000000001",
          uri: "kb://chapter.md",
          read: { result: "forged contents" },
        },
      ],
      "[[kb://chapter.md]]",
    ),
  ).toThrow();
});
