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

/** Every divider state, and the queued rows that become one. */
const DIVIDER_ROWS = [
  "#divider-auto",
  "#divider-manual",
  "#divider-pending",
  "#divider-stopped",
  "#divider-failed",
  "#queued-controls li",
];

test("a divider row speaks at one text size, on one line, at every width", async ({
  page,
}, testInfo) => {
  const widths = testInfo.project.name === "fine-pointer" ? [1100, 390] : [390];
  await mount(page);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const selector of DIVIDER_ROWS) {
      const rows = page.locator(selector);
      for (let index = 0; index < (await rows.count()); index += 1) {
        const where = `${selector}[${index}] at ${width}px`;
        const row = await rows.nth(index).evaluate((item) => {
          // The row is the first line: state words, controls, and the rule.
          const line = item.querySelector(":scope > div, :scope > section > div");
          if (!line) throw new Error("No divider line");
          const texts = [...line.querySelectorAll("span, button")]
            .filter((node) =>
              [...node.childNodes].some(
                (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
              ),
            )
            .filter((node) => (node as HTMLElement).offsetParent !== null)
            .map((node) => ({
              text: node.textContent,
              size: getComputedStyle(node).fontSize,
              top: node.getBoundingClientRect().top,
              bottom: node.getBoundingClientRect().bottom,
            }));
          return { texts, height: line.getBoundingClientRect().height };
        });
        expect(row.texts.length, where).toBeGreaterThan(0);
        const sizes = new Set(row.texts.map((text) => text.size));
        expect([...sizes], where).toHaveLength(1);
        // One line: every piece of text shares the row's single band.
        const top = Math.min(...row.texts.map((text) => text.top));
        const bottom = Math.max(...row.texts.map((text) => text.bottom));
        expect(bottom - top, where).toBeLessThanOrEqual(24);
        expect(row.height, where).toBeLessThanOrEqual(28);
      }
    }
  }
  // The row's words match its small actions: Stop sets the size.
  const [label, stop] = await Promise.all([
    page
      .locator("#divider-pending [data-compaction-label]")
      .evaluate((n) => getComputedStyle(n).fontSize),
    page
      .locator("#divider-pending")
      .getByRole("button", { name: "Stop compaction" })
      .evaluate((n) => getComputedStyle(n).fontSize),
  ]);
  expect(label).toBe(stop);
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

type Box = { x: number; y: number; width: number; height: number };

async function openTooltipBox(page: Page): Promise<Box> {
  const tooltip = page.locator('[data-slot="tooltip-content"]:not([data-state="closed"])');
  await expect(tooltip).toHaveCount(1);
  // Wait out the enter animation (fade and zoom) so the box is the settled one.
  await tooltip.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  const box = await tooltip.boundingBox();
  if (!box) throw new Error("No open tooltip box");
  return box;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("a turn action's tooltip opens below its button, clear of the message it acts on", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "fine-pointer", "hover contract");
  await mount(page);
  const cases = [
    { scope: "#short", message: "#short .user-message-bubble", names: ["Hand off from here"] },
    { scope: "#long", message: "#long .user-message-bubble", names: ["Hand off from here"] },
    {
      scope: "#reply",
      message: "#reply p",
      names: ["Copy", "Fork from here", "Hand off from here", "Turn information"],
    },
  ];
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const { scope, message, names } of cases) {
      await page.locator(message).hover();
      for (const name of names) {
        const where = `${name} in ${scope} at ${width}px`;
        await hoverCorner(page, name, scope);
        await expect(openTooltips(page), where).toHaveText([name]);
        const tooltip = await openTooltipBox(page);
        const button = await page
          .locator(scope)
          .getByRole("button", { name, exact: true })
          .boundingBox();
        const covered = await page.locator(message).boundingBox();
        if (!button || !covered) throw new Error(`Missing geometry for ${where}`);
        // Below, with a visible gap, and never over the message above.
        expect(tooltip.y, where).toBeGreaterThanOrEqual(button.y + button.height + 2);
        expect(overlaps(tooltip, covered), where).toBe(false);
      }
    }
  }

  // Near the viewport bottom there is no room below: collision handling flips it up.
  await page.setViewportSize({ width: 1100, height: 900 });
  const copy = page.locator("#reply").getByRole("button", { name: "Copy", exact: true });
  const resting = await copy.boundingBox();
  if (!resting) throw new Error("No Copy button");
  await page.setViewportSize({ width: 1100, height: Math.ceil(resting.y + resting.height + 8) });
  await page.mouse.move(10, 10);
  await hoverCorner(page, "Copy");
  const flipped = await openTooltipBox(page);
  const button = await copy.boundingBox();
  if (!button) throw new Error("No Copy button");
  expect(flipped.y + flipped.height).toBeLessThanOrEqual(button.y);
  expect(flipped.y).toBeGreaterThanOrEqual(0);
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
