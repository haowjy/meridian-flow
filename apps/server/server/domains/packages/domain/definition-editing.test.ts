/** Definition editing: revision honesty, skill-link reconciliation, restore badge. */
import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../index.js";
import {
  patchAgentSkillLink,
  restoreAgentDefinitionOriginal,
  saveAgentDefinition,
} from "./definition-editing.js";
import {
  agentDefinitionContentChecksum,
  definitionContentChecksum,
  normalizeAgentMeta,
} from "./mars-source.js";
import { listProjectLibraryInventory } from "./project-library.js";

describe("definition-editing", () => {
  const projectId = "project-1";
  const pristineMeta = normalizeAgentMeta({
    name: "Segmentation Agent",
    description: "Original description",
    skills: ["segment", "analyze"],
    subagents: [],
    mode: "primary",
  });
  const pristineBody = "Original instructions";
  const pristineConfig = { model: "claude-sonnet" };
  const pristineChecksum = agentDefinitionContentChecksum({
    body: pristineBody,
    meta: pristineMeta,
    config: pristineConfig,
  });

  function createStore() {
    return createInMemoryPackageStore({
      agents: [
        {
          id: "agent-1",
          projectId,
          slug: "segmentation",
          body: pristineBody,
          meta: pristineMeta,
          config: pristineConfig,
          packageInstallId: "pkg-1",
          originalContentChecksum: pristineChecksum,
          sourceType: "package",
          enabled: true,
        },
      ],
      skills: [
        {
          id: "skill-segment",
          projectId,
          slug: "segment",
          body: "segment body",
          meta: { name: "Segment" },
          files: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: null,
          sourceType: "package",
          enabled: true,
        },
        {
          id: "skill-analyze",
          projectId,
          slug: "analyze",
          body: "analyze body",
          meta: { name: "Analyze" },
          files: {},
          packageInstallId: "pkg-1",
          originalContentChecksum: null,
          sourceType: "package",
          enabled: true,
        },
      ],
      agentSkills: [
        {
          agentDefinitionId: "agent-1",
          skillId: "skill-segment",
          ordinal: 0,
          modelInvocable: true,
        },
        {
          agentDefinitionId: "agent-1",
          skillId: "skill-analyze",
          ordinal: 1,
          modelInvocable: true,
        },
      ],
      agentRevisions: [
        {
          id: "rev-0",
          agentDefinitionId: "agent-1",
          contentChecksum: pristineChecksum,
          body: pristineBody,
          meta: pristineMeta,
          config: pristineConfig,
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
  }

  it("clears edited state in library inventory after description save and restore original", async () => {
    const store = createStore();

    await store.transaction(async (tx) => {
      const saved = await saveAgentDefinition(tx, projectId, "segmentation", {
        body: pristineBody,
        meta: normalizeAgentMeta({
          ...pristineMeta,
          description: "Edited description",
        }),
        config: pristineConfig,
      });
      expect(saved.agent.isEdited).toBe(true);

      const restored = await restoreAgentDefinitionOriginal(tx, projectId, "segmentation");
      expect(restored.agent.isEdited).toBe(false);
      expect(restored.agent.contentChecksum).toBe(pristineChecksum);
      expect(restored.agent.meta.description).toBe("Original description");

      const library = await listProjectLibraryInventory(tx, projectId);
      const summary = library.agents.find((agent) => agent.slug === "segmentation");
      expect(summary?.isEdited).toBe(false);
    });
  });

  it("round-trips skill ordering through save and restore original", async () => {
    const store = createStore();

    await store.transaction(async (tx) => {
      const saved = await saveAgentDefinition(tx, projectId, "segmentation", {
        body: pristineBody,
        meta: normalizeAgentMeta({
          ...pristineMeta,
          skills: ["analyze", "segment"],
        }),
        config: pristineConfig,
      });
      expect(saved.agent.skillLinks.map((link) => link.skillSlug)).toEqual(["analyze", "segment"]);

      const restored = await restoreAgentDefinitionOriginal(tx, projectId, "segmentation");
      expect(restored.agent.skillLinks.map((link) => link.skillSlug)).toEqual([
        "segment",
        "analyze",
      ]);
      expect(skillSlugs(restored.agent.meta)).toEqual(["segment", "analyze"]);
    });
  });

  it("patches modelInvocable without marking the definition edited", async () => {
    const store = createStore();

    await store.transaction(async (tx) => {
      const patched = await patchAgentSkillLink(tx, projectId, "segmentation", "segment", {
        modelInvocable: false,
      });
      expect(patched.isEdited).toBe(false);
      expect(patched.skillLinks.find((link) => link.skillSlug === "segment")?.modelInvocable).toBe(
        false,
      );

      const library = await listProjectLibraryInventory(tx, projectId);
      expect(library.agents.find((agent) => agent.slug === "segmentation")?.isEdited).toBe(false);
    });
  });
});

function skillSlugs(meta: Record<string, unknown>): string[] {
  const skills = meta.skills;
  if (!Array.isArray(skills)) return [];
  return skills.filter((slug): slug is string => typeof slug === "string");
}

// Regression: checksums must be insensitive to JSON object key order, because
// Postgres jsonb scrambles key order — a checksum computed at import (file
// parse order) must match one recomputed over meta read back from the DB.
// See the canonicalization note above agentDefinitionContentChecksum.
describe("content checksum key-order insensitivity", () => {
  it("hashes agent meta identically regardless of key order (deep, incl. arrays)", () => {
    const meta = {
      name: "Probe",
      description: "d",
      skills: ["a", "b"],
      nested: { z: 1, a: { y: 2, b: 3 } },
      list: [{ z: 1, a: 2 }],
    };
    const reordered = {
      list: [{ a: 2, z: 1 }],
      nested: { a: { b: 3, y: 2 }, z: 1 },
      skills: ["a", "b"],
      description: "d",
      name: "Probe",
    };
    expect(agentDefinitionContentChecksum({ body: "b", meta })).toBe(
      agentDefinitionContentChecksum({ body: "b", meta: reordered }),
    );
  });

  it("hashes skill meta identically regardless of key order", () => {
    const meta = { description: "d", command: "bash run.sh", type: "reference" };
    const reordered = { type: "reference", command: "bash run.sh", description: "d" };
    expect(definitionContentChecksum({ body: "b", meta })).toBe(
      definitionContentChecksum({ body: "b", meta: reordered }),
    );
  });
});
