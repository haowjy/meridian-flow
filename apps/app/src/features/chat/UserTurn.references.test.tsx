// @vitest-environment jsdom
/**
 * A sent `@` reference follows its document: when the chat's catalog changes
 * after a delete, the chip turns dashed and stops following, with no reload.
 * All the chat's references are looked up together.
 */
import type {
  ProjectContextIdentityLookupResult,
  ProjectContextIdentityResolution,
  Turn,
} from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/project/context/open-project-document", () => ({
  useOpenProjectDocument: () => () => undefined,
  useProjectDocumentNavigationProjectId: () => "01900000-0000-7000-8000-0000000000aa",
}));

import { TooltipProvider } from "@/components/ui/tooltip";

import {
  createReferenceAvailability,
  ReferenceAvailabilityContext,
} from "./reference-availability";
import { UserTurn } from "./UserTurn";

const DOC = "01900000-0000-7000-8000-000000000001";
const OTHER = "01900000-0000-7000-8000-000000000002";
const generation = "1" as never;
const authority = { kind: "project", projectId: "p" } as never;

const available = (documentId: string, uri: string): ProjectContextIdentityResolution =>
  ({
    kind: "available",
    documentId,
    generation,
    authority,
    entry: { uri, name: uri.slice(uri.lastIndexOf("/") + 1) },
  }) as never;
const deleted = (documentId: string): ProjectContextIdentityResolution =>
  ({ kind: "deleted", documentId, generation, lastAuthority: authority }) as never;

function turn(id: string, documentId: string, uri: string): Turn {
  return {
    id,
    role: "user",
    status: "complete",
    blocks: [
      { id: `${id}-a`, blockType: "text", sequence: 0, textContent: "Check ", content: "Check " },
      {
        id: `${id}-b`,
        blockType: "text",
        sequence: 1,
        textContent: uri,
        content: { type: "reference", text: uri, documentId, uri },
      },
    ],
  } as unknown as Turn;
}

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

/** The reference chip whose label is the URI's file name. */
function chip(uri: string) {
  const name = uri.slice(uri.lastIndexOf("/") + 1);
  const element = [...host.querySelectorAll("[data-link-chip]")].find(
    (candidate) => candidate.textContent === name,
  );
  if (!element) throw new Error(`no chip for ${uri}`);
  return {
    state: element.getAttribute("data-link-chip"),
    disabled: element.getAttribute("aria-disabled"),
  };
}

describe("a sent @ reference", () => {
  it("turns dashed and stops following when a catalog change follows its deletion", async () => {
    let world: ProjectContextIdentityResolution[] = [
      available(DOC, "manuscript://gate.md"),
      available(OTHER, "kb://kael.md"),
    ];
    const lookup = vi.fn(
      async (ids: readonly string[]): Promise<ProjectContextIdentityLookupResult> => ({
        projectId: "p" as never,
        resolutionId: "r",
        resolutions: world.filter((resolution) => ids.includes(resolution.documentId)),
      }),
    );
    const store = createReferenceAvailability(lookup);
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ReferenceAvailabilityContext.Provider value={store}>
            <UserTurn turn={turn("u1", DOC, "manuscript://gate.md")} />
            <UserTurn turn={turn("u2", OTHER, "kb://kael.md")} />
          </ReferenceAvailabilityContext.Provider>
        </TooltipProvider>,
      ),
    );
    await settle();

    // Both turns' references went out in one request.
    expect(lookup).toHaveBeenCalledTimes(1);
    expect([...(lookup.mock.calls[0]?.[0] ?? [])].sort()).toEqual([DOC, OTHER]);
    expect(chip("manuscript://gate.md")).toEqual({ state: "filled", disabled: "false" });

    world = [deleted(DOC), available(OTHER, "kb://kael.md")];
    // The chat's catalog revision changed (the delete): ask again.
    act(() => store.refresh());
    await settle();

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(chip("manuscript://gate.md")).toEqual({ state: "dashed", disabled: "true" });
    expect(chip("kb://kael.md")).toEqual({ state: "filled", disabled: "false" });
  });
});
