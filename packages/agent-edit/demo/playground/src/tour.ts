// Scripted tour: replays the harness highlights in the live editor so a viewer
// sees the headline behaviors without typing.
import type { WriteCommand, WriteContext } from "@meridian/agent-edit";

import type { PlaygroundEnv } from "./env.js";

const TOUR_DOC = "tour.mdx";
const TOUR_SEED = `# Tour: write() in action

The sword hummed beneath the old shrine.

Moonlight pooled across the floor.`;

type Logger = (label: string, body: string, ok: boolean) => void;

interface TourOptions {
  env: PlaygroundEnv;
  log: Logger;
}

const SLOW = 700;

export async function runScriptedTour({ env, log }: TourOptions) {
  await step(env, log, "tour: create tour doc", {
    command: "create",
    file: TOUR_DOC,
    content: TOUR_SEED,
  });
  await step(env, log, "tour: view (refreshes block-hash snapshot)", {
    command: "view",
    file: TOUR_DOC,
    format: "full",
  });

  const turnId = "tour-multi-write-turn";
  const after = firstBlockHash(env, TOUR_DOC);
  if (after) {
    await step(
      env,
      log,
      "tour: insert (same turnId)",
      {
        command: "insert",
        file: TOUR_DOC,
        after,
        content: "A foxfire lantern flared to life.",
      },
      { ...env.defaultContext, turnId },
    );
    await step(
      env,
      log,
      'tour: replace "sword" → "blade" (same turnId)',
      { command: "replace", file: TOUR_DOC, find: "sword", content: "blade" },
      { ...env.defaultContext, turnId },
    );
    await step(env, log, "tour: undo (reverses BOTH writes in the turn)", {
      command: "undo",
      file: TOUR_DOC,
    });
    await step(env, log, "tour: redo (restores BOTH writes in the turn)", {
      command: "redo",
      file: TOUR_DOC,
    });
  }

  await step(env, log, "tour: cross-block find/replace", {
    command: "replace",
    file: TOUR_DOC,
    find: "old shrine.\n\nMoonlight pooled",
    content: "old shrine as moonlight pooled",
  });

  // Concurrent / reconciled scenario: simulate a human edit landing on the
  // live doc between agent writes.
  await env.coordinator.applyHumanUpdate(TOUR_DOC, "human-demo", (doc) => {
    const block = env.model.getBlocks(doc)[0];
    if (block) env.model.applyTextEdit(doc, block, { from: 0, to: 0 }, "Human note: ");
  });
  log("tour: human direct edit applied (out-of-band)", "(injected via applyHumanUpdate)", true);
  await step(env, log, 'tour: agent replace after human edit ("blade" → "katana")', {
    command: "replace",
    file: TOUR_DOC,
    find: "blade",
    content: "katana",
  });
  log("tour: complete", "Switch file to tour.mdx in the command panel to inspect.", true);
}

async function step(
  env: PlaygroundEnv,
  log: Logger,
  label: string,
  command: WriteCommand,
  context?: WriteContext,
) {
  try {
    const response = await env.core.write(command, context ?? env.defaultContext);
    log(label, response, !response.startsWith("status: error"));
  } catch (cause) {
    log(label, String(cause), false);
  }
  await sleep(SLOW);
}

function firstBlockHash(env: PlaygroundEnv, docId: string): string | undefined {
  try {
    const doc = env.coordinator.requireDocument(docId);
    const blocks = env.model.getBlocks(doc);
    return blocks[0] ? env.model.getBlockId(blocks[0]) : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
