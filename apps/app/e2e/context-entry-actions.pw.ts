/** Browser contract for the feature-owned Radix right-click interaction. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import viteReact from "@vitejs/plugin-react";
import { build, type Rollup } from "vite";
import { linguiMacroBabelPlugin } from "../dev/vite-plugins";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fixtureScript: string;

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    root: appRoot,
    logLevel: "silent",
    resolve: { alias: { "@": path.join(appRoot, "src") } },
    plugins: [linguiMacroBabelPlugin(), viteReact()],
    build: {
      write: false,
      lib: {
        entry: "e2e/context-entry-actions.fixture.tsx",
        formats: ["iife"],
        name: "ContextEntryActionsFixture",
      },
    },
  });
  const builds = Array.isArray(result) ? result : [result];
  const output = builds.flatMap((buildResult) => {
    if (!("output" in buildResult)) throw new Error("Vite unexpectedly entered watch mode");
    return buildResult.output;
  });
  const script = output.find(
    (item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry,
  );
  if (!script) throw new Error("Vite did not emit the context-action fixture");
  fixtureScript = script.code;
});

test("opens on right click, restores focus on dismissal, and dispatches after selection", async ({
  page,
}) => {
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    (window as Window & { process?: unknown }).process = { env: { NODE_ENV: "production" } };
  });
  await page.addScriptTag({ content: fixtureScript });

  const trigger = page.getByRole("button", { name: "Chapter one" });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click({ button: "right", position: { x: 12, y: 8 } });
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await trigger.click({ button: "right", position: { x: 12, y: 8 } });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { selectedAction?: string }).selectedAction),
    )
    .toBe("rename");
  await expect(page.getByRole("menu")).toBeHidden();
});
