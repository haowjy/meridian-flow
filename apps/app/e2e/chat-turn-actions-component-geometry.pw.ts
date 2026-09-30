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
        output: { codeSplitting: false },
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

/** The open tooltips, not ones fading out, by their accessible text. */
const openTooltips = (page: Page) =>
  page.locator('[data-slot="tooltip-content"]:not([data-state="closed"]) [role="tooltip"]');

/** Hover a button's top-left corner, well off its centered icon, arriving from where the pointer is. */
async function hoverCorner(page: Page, name: string, scope = "#reply") {
  const box = await page.locator(scope).getByRole("button", { name, exact: true }).boundingBox();
  if (!box) throw new Error(`No ${name} button`);
  await page.mouse.move(box.x + 2, box.y + 2, { steps: 8 });
}

test("a tooltip opens from anywhere on its button and swaps at once between neighbours", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "fine-pointer", "hover contract");
  await page.setViewportSize({ width: 1100, height: 900 });
  await mount(page);

  await hoverCorner(page, "Copy");
  await expect(openTooltips(page)).toHaveText(["Copy"]);
  // Left to right, then back right to left: the tooltip hangs over its
  // neighbours either way, and must never keep the pointer's last button.
  for (const name of ["Fork from here", "Hand off from here", "Turn information"]) {
    await hoverCorner(page, name);
    await expect(openTooltips(page)).toHaveText([name]);
  }
  for (const name of ["Hand off from here", "Fork from here", "Copy"]) {
    await hoverCorner(page, name);
    await expect(openTooltips(page)).toHaveText([name]);
  }

  // A writer message's Hand off, reached by its corner.
  await page.locator("#short .user-message-bubble").hover();
  await hoverCorner(page, "Hand off from here", "#short");
  await expect(openTooltips(page)).toHaveText(["Hand off from here"]);
});

test("keyboard focus opens a tooltip, and a button's own popover hides it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "fine-pointer", "hover contract");
  await page.setViewportSize({ width: 1100, height: 900 });
  await mount(page);
  const reply = page.locator("#reply");

  await reply.getByRole("button", { name: "Fork from here" }).focus();
  await expect(openTooltips(page)).toHaveText(["Fork from here"]);

  await hoverCorner(page, "Hand off from here");
  await page.mouse.down();
  await page.mouse.up();
  const picker = page.getByRole("dialog", { name: "Hand off to an Agent" });
  await expect(picker).toBeVisible();
  await expect(openTooltips(page)).toHaveCount(0);
  // Back onto the open trigger: the popover is the answer, not its tooltip.
  await page.mouse.move(10, 10, { steps: 4 });
  await hoverCorner(page, "Hand off from here");
  await expect(openTooltips(page)).toHaveCount(0);
  await expect(picker).toBeVisible();

  await reply.getByRole("button", { name: "Turn information" }).hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole("dialog").filter({ hasText: "Output tokens" })).toBeVisible();
  await expect(openTooltips(page)).toHaveCount(0);
});
