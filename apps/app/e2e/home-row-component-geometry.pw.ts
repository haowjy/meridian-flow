/** Real Chromium component-fixture geometry contract for Home rows and their loading state. */
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

test("right-aligns Work in its stable column and centers it across the full row", async ({
  page,
}, testInfo) => {
  const widths = testInfo.project.name === "fine-pointer" ? [1440, 1100, 840, 390] : [390];
  await page.setContent(
    '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>',
  );
  await page.addStyleTag({ content: compiledCss });
  await page.addScriptTag({ content: compiledJs, type: "module" });
  await expect(page.locator('[data-home-row="ordinary-1"]')).toBeVisible();

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const realGeometry = await page
      .locator("#real-rows [data-home-row-work]")
      .evaluateAll((works) =>
        works.map((work) => {
          const row = work.closest("[data-home-row]");
          if (!row) throw new Error("Home Work lane lacks its full row");
          const title = row.querySelector("span[data-home-row-line]");
          const preview = row.querySelector("[data-home-row-line] p");
          const inlineDate = row.querySelector("[data-home-row-line] time");
          const trailingDate = row.querySelector("[data-home-row-trailing] time");
          const action = row.querySelector("[data-home-row-actions]");
          if (!title || !preview || !inlineDate || !trailingDate || !action) {
            throw new Error("Incomplete Home row fixture");
          }
          const rowBox = row.getBoundingClientRect();
          const titleBox = title.getBoundingClientRect();
          const workBox = work.getBoundingClientRect();
          const trailingBox = trailingDate.parentElement?.getBoundingClientRect();
          if (!trailingBox) throw new Error("Home row lacks its trailing lane");
          const previewBox = preview.getBoundingClientRect();
          const inlineDateBox = inlineDate.getBoundingClientRect();
          const trailingDateBox = trailingDate.getBoundingClientRect();
          const actionBox = action.getBoundingClientRect();
          return {
            rowLeft: rowBox.left,
            rowRight: rowBox.right,
            workLeft: workBox.left,
            workRight: workBox.right,
            workVerticalCenterDelta: Math.abs(
              (rowBox.top + rowBox.bottom - workBox.top - workBox.bottom) / 2,
            ),
            lanesDoNotOverlap: titleBox.right <= workBox.left && workBox.right <= trailingBox.left,
            height: rowBox.height,
            titleFontSize: getComputedStyle(title).fontSize,
            previewFontSize: getComputedStyle(preview).fontSize,
            workFontSize: getComputedStyle(work).fontSize,
            workFontWeight: getComputedStyle(work).fontWeight,
            workColorMatchesTitle: getComputedStyle(work).color === getComputedStyle(title).color,
            workTextAlign: getComputedStyle(work).textAlign,
            inlineDateFontSize: getComputedStyle(inlineDate).fontSize,
            trailingDateFontSize: getComputedStyle(trailingDate).fontSize,
            trailingCenterDelta: {
              x: Math.abs(
                (trailingDateBox.left + trailingDateBox.right - actionBox.left - actionBox.right) /
                  2,
              ),
              y: Math.abs(
                (trailingDateBox.top + trailingDateBox.bottom - actionBox.top - actionBox.bottom) /
                  2,
              ),
            },
            previewDateGap: inlineDateBox.left - previewBox.right,
            actionWidth: actionBox.width,
            actionHeight: actionBox.height,
            hasOverflow: row.scrollWidth > row.clientWidth,
            titleFits: title.scrollWidth <= title.clientWidth,
            workFits: work.scrollWidth <= work.clientWidth,
          };
        }),
      );
    const [firstReal] = realGeometry;
    expect(firstReal).toBeDefined();
    expect(
      realGeometry.every(
        ({ workLeft, workRight }) =>
          Math.abs(workLeft - firstReal.workLeft) <= 0.5 &&
          Math.abs(workRight - firstReal.workRight) <= 0.5,
      ),
    ).toBe(true);
    expect(
      realGeometry.every(
        ({ rowLeft, rowRight, workLeft, workRight }) =>
          (workLeft + workRight) / 2 > (rowLeft + rowRight) / 2 + 8,
      ),
    ).toBe(true);
    expect(realGeometry.every(({ titleFontSize }) => titleFontSize === "13px")).toBe(true);
    expect(realGeometry.every(({ previewFontSize }) => previewFontSize === "13px")).toBe(true);
    expect(realGeometry.every(({ workFontSize }) => workFontSize === "12px")).toBe(true);
    expect(realGeometry.every(({ workTextAlign }) => workTextAlign === "right")).toBe(true);
    expect(
      realGeometry.every(({ workVerticalCenterDelta }) => workVerticalCenterDelta <= 0.5),
    ).toBe(true);
    expect(realGeometry.every(({ workFontWeight }) => workFontWeight === "500")).toBe(true);
    expect(realGeometry.every(({ workColorMatchesTitle }) => workColorMatchesTitle)).toBe(true);
    expect(realGeometry.every(({ lanesDoNotOverlap }) => lanesDoNotOverlap)).toBe(true);
    expect(realGeometry.every(({ hasOverflow }) => !hasOverflow)).toBe(true);
    expect(
      realGeometry.every(
        ({ inlineDateFontSize, trailingDateFontSize }) =>
          inlineDateFontSize === "12px" && trailingDateFontSize === "12px",
      ),
    ).toBe(true);
    expect(
      realGeometry.slice(0, 34).every(({ titleFits, workFits }) => titleFits && workFits),
    ).toBe(true);

    const loadingGeometry = await page
      .locator("#loading-rows [data-home-row-work]")
      .evaluateAll((works) =>
        works.map((work) => {
          const row = work.closest("li[data-home-row-layout]");
          if (!row) throw new Error("Loading Work lane lacks its full row");
          const rowBox = row.getBoundingClientRect();
          const workBox = work.getBoundingClientRect();
          const rowStyle = getComputedStyle(row);
          return {
            workLeft: workBox.left,
            workRight: workBox.right,
            workVerticalCenterDelta: Math.abs(
              (rowBox.top + rowBox.bottom - workBox.top - workBox.bottom) / 2,
            ),
            height:
              rowBox.height -
              Number.parseFloat(rowStyle.borderTopWidth) -
              Number.parseFloat(rowStyle.borderBottomWidth),
            hasOverflow: row.scrollWidth > row.clientWidth,
          };
        }),
      );
    expect(
      loadingGeometry.every(
        ({ workLeft, workRight }) =>
          Math.abs(workLeft - firstReal.workLeft) <= 0.5 &&
          Math.abs(workRight - firstReal.workRight) <= 0.5,
      ),
    ).toBe(true);
    expect(
      loadingGeometry.every(({ workVerticalCenterDelta }) => workVerticalCenterDelta <= 0.5),
    ).toBe(true);
    expect(loadingGeometry.every(({ hasOverflow }) => !hasOverflow)).toBe(true);

    const expectedHeight = testInfo.project.name === "coarse-pointer" ? 56 : 53.59375;
    expect(realGeometry.every(({ height }) => Math.abs(height - expectedHeight) <= 0.05)).toBe(
      true,
    );
    expect(loadingGeometry.every(({ height }) => Math.abs(height - expectedHeight) <= 0.05)).toBe(
      true,
    );

    if (testInfo.project.name === "coarse-pointer") {
      expect(
        realGeometry.every(
          ({ actionWidth, actionHeight }) => actionWidth === 44 && actionHeight === 44,
        ),
      ).toBe(true);
      expect(realGeometry.every(({ previewDateGap }) => previewDateGap === 8)).toBe(true);
    } else {
      expect(
        realGeometry.every(
          ({ trailingCenterDelta }) => trailingCenterDelta.x <= 0.5 && trailingCenterDelta.y <= 0.5,
        ),
      ).toBe(true);
    }

    const longGeometry = await page.locator('[data-home-row="long"]').evaluate((row) => {
      const nodes = [
        row.querySelector("span[data-home-row-line]"),
        row.querySelector("[data-home-row-work]"),
        row.querySelector("[data-home-row-line] p"),
      ];
      if (nodes.some((node) => !node)) throw new Error("Incomplete long Home row fixture");
      return nodes.map((node) => {
        const element = node as HTMLElement;
        const style = getComputedStyle(element);
        return {
          overflows: element.scrollWidth > element.clientWidth,
          overflow: style.overflow,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
        };
      });
    });
    expect(
      longGeometry.every(
        ({ overflows, overflow, textOverflow, whiteSpace }) =>
          overflows &&
          overflow === "hidden" &&
          textOverflow === "ellipsis" &&
          whiteSpace === "nowrap",
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
});
