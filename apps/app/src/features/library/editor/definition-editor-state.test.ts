// @ts-nocheck
import { describe, expect, it } from "vitest";

import {
  agentDraftFromDetail,
  applyAgentMetaFields,
  buildAgentSaveRequest,
  isAgentDefinitionEditable,
  isAgentDraftDirty,
  moveSkillInMeta,
  orderedSkillLinks,
} from "./definition-editor-state";

describe("definition-editor-state", () => {
  const agentDetail = {
    slug: "segmentation",
    body: "Original instructions",
    meta: {
      name: "Segmentation",
      description: "Segment cells",
      mode: "primary",
      legacy: true,
      skills: ["segment"],
    },
    config: {},
    source: "package" as const,
    packageName: "volumetry",
    originalContentChecksum: "abc",
    contentChecksum: "abc",
    isEdited: false,
    skillLinks: [
      {
        skillSlug: "segment",
        ordinal: 0,
        modelInvocable: true,
        userInvocable: null,
      },
    ],
  };

  it("treats package agents as editable and builtins as read-only", () => {
    expect(isAgentDefinitionEditable(agentDetail)).toBe(true);
    expect(isAgentDefinitionEditable({ ...agentDetail, source: "builtin" })).toBe(false);
  });

  it("preserves unknown meta keys when applying known fields", () => {
    const draft = agentDraftFromDetail(agentDetail);
    draft.meta = applyAgentMetaFields(draft.meta, {
      name: "Renamed",
      description: "New blurb",
      model: "claude-sonnet",
      effort: "high",
    });
    expect(draft.meta.legacy).toBe(true);
    expect(draft.meta.mode).toBe("primary");
    expect(draft.meta.model).toBe("claude-sonnet");
  });

  it("detects dirty drafts from body or meta.skills order, not modelInvocable", () => {
    const baseline = agentDraftFromDetail(agentDetail);
    const edited = agentDraftFromDetail(agentDetail);
    edited.body = "Edited instructions";
    expect(isAgentDraftDirty(baseline, edited)).toBe(true);

    const reordered = agentDraftFromDetail(agentDetail);
    reordered.meta = moveSkillInMeta({ ...reordered.meta, skills: ["segment", "analyze"] }, 1, -1);
    expect(isAgentDraftDirty(baseline, reordered)).toBe(true);
  });

  it("reorders meta.skills and omits skill links from save payload", () => {
    const draft = agentDraftFromDetail({
      ...agentDetail,
      meta: { ...agentDetail.meta, skills: ["a", "b"] },
      skillLinks: [
        { skillSlug: "a", ordinal: 0, modelInvocable: true, userInvocable: null },
        { skillSlug: "b", ordinal: 1, modelInvocable: false, userInvocable: null },
      ],
    });
    const moved = {
      ...draft,
      meta: moveSkillInMeta(draft.meta, 1, -1),
    };
    const saved = buildAgentSaveRequest(moved);
    expect(saved.meta.skills).toEqual(["b", "a"]);
    expect("skillLinks" in saved).toBe(false);
  });

  it("orders displayed skill links from meta.skills", () => {
    const links = orderedSkillLinks({
      ...agentDetail,
      meta: { ...agentDetail.meta, skills: ["analyze", "segment"] },
      skillLinks: [
        { skillSlug: "segment", ordinal: 1, modelInvocable: true, userInvocable: null },
        { skillSlug: "analyze", ordinal: 0, modelInvocable: false, userInvocable: null },
      ],
    });
    expect(links.map((link) => link.skillSlug)).toEqual(["analyze", "segment"]);
    expect(links[1]?.modelInvocable).toBe(true);
  });
});
