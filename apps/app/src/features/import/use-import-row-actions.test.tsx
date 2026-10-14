// @vitest-environment jsdom
/** The commands a run mark's menu runs: what each state offers and what each one calls. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ImportRunInfo } from "@/client/query/context-catalog-projection";
import { type ImportRowActions, useImportRowActions } from "./use-import-row-actions";

const imports = vi.hoisted(() => ({
  coordinator: { retry: vi.fn(), tryAgain: vi.fn(), discard: vi.fn() },
  openContinue: vi.fn(),
  openStop: vi.fn(),
}));
vi.mock("./ImportProvider", () => ({ useOptionalImports: () => imports }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function actionsFor(run: ImportRunInfo): Promise<ImportRowActions> {
  let actions: ImportRowActions | null = null;
  function Probe() {
    actions = useImportRowActions({ run });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  await act(async () => root.unmount());
  if (!actions) throw new Error("no actions");
  return actions;
}

const run: ImportRunInfo = {
  importId: "i",
  kind: "interrupted",
  arrived: 0,
  total: 1,
  failed: 0,
  remaining: 1,
  canRetry: false,
};

describe("run mark commands", () => {
  it("Stop opens the stop dialog for the import, and Continue opens Continue", async () => {
    const actions = await actionsFor(run);
    actions.stop?.();
    actions.continueImport?.();
    expect(imports.openStop).toHaveBeenCalledWith("i");
    expect(imports.openContinue).toHaveBeenCalledWith("i");
  });

  it("Retry failed files retries every failed file of the import", async () => {
    const actions = await actionsFor({ ...run, kind: "failed", failed: 1, canRetry: true });
    actions.retryFailed?.();
    expect(imports.coordinator.retry).toHaveBeenCalledWith("i");
  });
});
