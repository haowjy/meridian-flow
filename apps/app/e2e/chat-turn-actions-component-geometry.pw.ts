/** Real Chromium component-fixture contract for chat turn action rows. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let compiledCss = "";
let compiledJs = "";

test.beforeAll(async () => {
  const mocks = path.join(appRoot, "e2e/support/chat-turn-actions-browser-mocks.tsx");
  const result = await build({
    configFile: false,
    root: appRoot,
    logLevel: "silent",
    plugins: [tailwindcss()],
    resolve: {
      alias: [
        "@lingui/core/macro",
        "@lingui/react/macro",
        "@lingui/react",
        "@/client/query/useAgentCatalog",
      ].map((find) => ({ find, replacement: mocks })),
    },
    build: {
      write: false,
      rollupOptions: {
        input: "e2e/support/chat-turn-actions-browser-entry.tsx",
        // One script tag: the transcript's lazy renderers must not split into chunks.
        output: { inlineDynamicImports: true },
      },
    },
  });
  const output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
    "output" in item ? item.output : [],
  );
  const css = output.find(
    (item): item is Rollup.OutputAsset => item.type === "asset" && item.fileName.endsWith(".css"),
  );
  const js = output.find(
    (item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry,
  );
  if (!css || !js) throw new Error("Vite did not emit the chat turn-actions fixture");
  compiledCss = String(css.source);
  compiledJs = js.code;
});

async function mount(page: Page) {
  await page.setContent(
    '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>',
  );
  await page.addStyleTag({ content: compiledCss });
  await page.addScriptTag({ content: compiledJs, type: "module" });
  await expect(page.locator("#reply [data-assistant-turn-actions]")).toBeVisible();
}

test("a writer message's actions sit directly below its bubble, on its right edge", async ({
  page,
}, testInfo) => {
  const widths = testInfo.project.name === "fine-pointer" ? [1100, 390] : [390];
  await mount(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const row of ["short", "long", "inherited"]) {
      const geometry = await page.locator(`#${row}`).evaluate((item) => {
        const bubble = item.querySelector(".user-message-bubble")?.getBoundingClientRect();
        const actions = item.querySelector("[data-user-turn-actions]")?.getBoundingClientRect();
        const button = item
          .querySelector('[aria-label="Hand off from here"]')
          ?.getBoundingClientRect();
        if (!bubble || !actions || !button) throw new Error(`Incomplete writer row ${item.id}`);
        return { bubble, actions, button, row: item.getBoundingClientRect() };
      });
      const where = `${row} at ${width}px`;
      expect(geometry.actions.top, where).toBeGreaterThanOrEqual(geometry.bubble.bottom);
      expect(geometry.actions.top - geometry.bubble.bottom, where).toBeLessThanOrEqual(8);
      expect(Math.abs(geometry.button.right - geometry.bubble.right), where).toBeLessThanOrEqual(1);
      expect(geometry.button.left, where).toBeGreaterThanOrEqual(geometry.bubble.left);
      expect(geometry.actions.bottom, where).toBeLessThanOrEqual(geometry.row.bottom);
    }
    // A queued message offers no Hand off; its label still sits under the bubble.
    const queued = await page.locator("#queued").evaluate((item) => ({
      bubble: item.querySelector(".user-message-bubble")?.getBoundingClientRect(),
      label: item.querySelector('[data-user-turn-status="queued"]')?.getBoundingClientRect(),
      actions: item.querySelector("[data-user-turn-actions]"),
    }));
    expect(queued.actions).toBeNull();
    expect(queued.label?.top).toBeGreaterThanOrEqual(queued.bubble?.bottom ?? Infinity);
  }
});
