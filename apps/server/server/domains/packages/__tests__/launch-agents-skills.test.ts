/** The built-in launch agents' model skill catalogs: every listed skill exists and the model may load it. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeAgentMeta, parseMarkdownDefinition } from "../domain/mars-source.js";
import { skillListingFromMarkdown } from "../domain/skill-listing.js";

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../builtin/launch-agents",
);

async function availableSkills(): Promise<Map<string, string[]>> {
  const catalogs = new Map<string, string[]>();
  for (const file of await readdir(path.join(PACKAGE_DIR, "agents"))) {
    const source = await readFile(path.join(PACKAGE_DIR, "agents", file), "utf8");
    const skills = normalizeAgentMeta(parseMarkdownDefinition(source).meta).skills;
    const available = Array.isArray(skills)
      ? skills
      : ((skills as { available?: string[] } | undefined)?.available ?? []);
    catalogs.set(path.basename(file, ".md"), [...available]);
  }
  return catalogs;
}

describe("launch agent skills", () => {
  it("lists only packaged skills the model may load", async () => {
    for (const [agent, slugs] of await availableSkills()) {
      for (const slug of slugs) {
        const markdown = await readFile(path.join(PACKAGE_DIR, "skills", slug, "SKILL.md"), "utf8");
        expect(skillListingFromMarkdown(markdown, slug).modelInvocable, `${agent}: ${slug}`).toBe(
          true,
        );
      }
    }
  });

  it("lets the review agents load story-review", async () => {
    const catalogs = await availableSkills();
    for (const agent of ["muse", "spark", "writer", "critic"]) {
      expect(catalogs.get(agent), agent).toContain("story-review");
    }
  });
});
