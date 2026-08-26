/** Real Chromium geometry contract for production Home rows and their loading state. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let compiledCss = "";
let compiledJs = "";

test.beforeAll(async () => {
  const mocks = path.join(appRoot, "e2e/support/home-row-browser-mocks.tsx");
  const result = await build({
    configFile: false,
    root: appRoot,
    logLevel: "silent",
    plugins: [tailwindcss()],
    resolve: {
      alias: ["@lingui/core/macro", "@lingui/react/macro", "@lingui/react"].map((find) => ({
        find,
        replacement: mocks,
      })),
    },
    build: { write: false, rollupOptions: { input: "e2e/support/home-row-browser-entry.tsx" } },
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
  if (!css || !js) throw new Error("Vite did not emit the Home-row fixture");
  compiledCss = String(css.source);
  compiledJs = js.code;
});

test("keeps centered Work geometry and preserves ordinary identity", async ({ page }, testInfo) => {
  const widths = testInfo.project.name === "fine-pointer" ? [1440, 1100, 840, 390] : [390];
  await page.setContent(
    '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>',
  );
  await page.addStyleTag({ content: compiledCss });
  await page.addScriptTag({ content: compiledJs, type: "module" });
  await expect(page.locator('[data-home-row="ordinary-1"]')).toBeVisible();

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.locator("[data-home-row-layout]").evaluateAll((layouts) =>
      layouts.map((layout) => {
        const work = layout.querySelector("[data-home-row-work]");
        if (!work) throw new Error("Home row lacks its Work lane");
        const rowBox = layout.getBoundingClientRect();
        const workBox = work.getBoundingClientRect();
        return {
          centerDelta: Math.abs((rowBox.left + rowBox.right - workBox.left - workBox.right) / 2),
          workFontSize: getComputedStyle(work).fontSize,
        };
      }),
    );
    expect(geometry.every(({ centerDelta }) => centerDelta <= 0.5)).toBe(true);
    expect(geometry.slice(0, 35).every(({ workFontSize }) => workFontSize === "12px")).toBe(true);
    const realGeometry = await page.locator("[data-home-row]").evaluateAll((rows) =>
      rows.map((row) => {
        const title = row.querySelector("span[data-home-row-line]");
        const date = row.querySelector("time");
        const action = row.querySelector("[data-home-row-actions]");
        if (!title || !date || !action) throw new Error("Incomplete Home row fixture");
        const actionBox = action.getBoundingClientRect();
        return {
          titleFontSize: getComputedStyle(title).fontSize,
          dateFontSize: getComputedStyle(date).fontSize,
          actionWidth: actionBox.width,
          actionHeight: actionBox.height,
        };
      }),
    );
    expect(realGeometry.every(({ titleFontSize }) => titleFontSize === "13px")).toBe(true);
    expect(realGeometry.every(({ dateFontSize }) => dateFontSize === "12px")).toBe(true);
    if (testInfo.project.name === "coarse-pointer") {
      expect(
        realGeometry.every(
          ({ actionWidth, actionHeight }) => actionWidth === 44 && actionHeight === 44,
        ),
      ).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }

  const ordinaryText = await page
    .locator('[data-home-row^="ordinary-"] span[data-home-row-line]')
    .evaluateAll((titles) =>
      titles.map((title) => ({ client: title.clientWidth, scroll: title.scrollWidth })),
    );
  expect(ordinaryText.every(({ client, scroll }) => scroll <= client)).toBe(true);
  const ordinaryWorks = await page
    .locator('[data-home-row^="ordinary-"] [data-home-row-work]')
    .evaluateAll((works) =>
      works.map((work) => ({ client: work.clientWidth, scroll: work.scrollWidth })),
    );
  expect(ordinaryWorks.every(({ client, scroll }) => scroll <= client)).toBe(true);

  const longTitle = page.locator('[data-home-row="long"] span[data-home-row-line]');
  const longWork = page.locator('[data-home-row="long"] [data-home-row-work]');
  expect(await longTitle.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await longWork.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
});
