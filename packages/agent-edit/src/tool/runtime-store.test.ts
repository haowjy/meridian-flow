// Runtime-store cache invalidation, recovery, redo rehydration, and sync contracts.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createAgentEditCore } from "../index.js";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import { blockTexts, humanText, outcomeText } from "./test-support/assertions.js";
import {
  codecFactory,
  context,
  harness,
  model,
  REVERSAL_CLIENT_ID,
  THREAD_ID,
} from "./test-support/write-tool-harness.js";

describe("runtime store", () => {
  it("invalidates a thread runtime and rebuilds the next edit from recovered live state", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." }, { undoClientId: REVERSAL_CLIENT_ID });
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      { ...context, turnId: "turn-before-invalidate" },
    );

    const live = ctx.liveDoc("chapter.md");
    const beforeVector = Y.encodeStateVector(live);
    humanText(live, 0, { from: 0, to: 0 }, "Human ");
    await ctx.journal.append("chapter.md", Y.encodeStateAsUpdate(live, beforeVector), {
      origin: "human:user-a",
      seq: 0,
    });

    await ctx.core.invalidateThread("chapter.md", THREAD_ID);

    const edit = await ctx.core.write(
      { command: "replace", file: "chapter.md", find: "blade", content: "saber" },
      context,
    );

    expect(outcomeText(edit)).toContain("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Human Alpha saber."]);
  });

  it("commits a fresh-process destructive write without calling its own edit a sweep", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    const responseContext = {
      ...context,
      turnId: "turn-before-fresh-process",
      responseIdentity: {
        providerResponseId: "response-before-fresh-process",
        editScopeId: "response-before-fresh-process",
      },
    };
    const staged = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta shield." },
      responseContext,
    );
    expect(outcomeText(staged)).toContain("status: success");
    await ctx.core.commitResponse("response-before-fresh-process");

    const freshCore = createAgentEditCore({
      journal: ctx.journal,
      coordinator: ctx.coordinator,
      lifecycle: ctx.lifecycle,
      codec: codecFactory,
      links: createStaticDocumentLinks(),
      model,
    });

    const edit = await freshCore.write(
      { command: "replace", file: "chapter.md", find: "sword", content: "blade" },
      { ...context, turnId: "turn-fresh-process-no-read" },
    );

    expect(outcomeText(edit)).toContain("status: success");
    expect(outcomeText(edit)).not.toContain("swept");
    expect(
      edit.result.blocks?.some((group) =>
        group.items.some((block) => block.body === "Beta shield."),
      ),
    ).toBe(true);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade.", "Beta shield."]);
  });
});
