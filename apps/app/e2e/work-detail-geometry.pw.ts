/** Real Chromium geometry regression mounted through the production Work detail component. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let compiledCss = "";
let compiledJs = "";
test.beforeAll(async () => {
  const mocks = path.join(appRoot, "e2e/support/work-detail-browser-mocks.tsx");
  const result = await build({
    configFile: false,
    root: appRoot,
    logLevel: "silent",
    plugins: [tailwindcss()],
    resolve: {
      alias: [
        "@lingui/core/macro",
        "@lingui/react/macro",
        "@tanstack/react-router",
        "@/client/query/useWorkDrafts",
        "@/client/query/useProjectContextTree",
        "@/client/query/useWorkThreads",
        "@/client/query/useWorks",
      ].map((find) => ({ find, replacement: mocks })),
    },
    build: { write: false, rollupOptions: { input: "e2e/support/work-detail-browser-entry.tsx" } },
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
  if (!css || !js) throw new Error("Vite did not emit the Work detail fixture");
  compiledCss = String(css.source);
  compiledJs = js.code;
});

test("production Work detail contains long content at 390px", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "coarse-pointer", "coarse-pointer geometry contract");
  await page.setViewportSize({ width: 390, height: 844 });
  const unbroken = "X".repeat(500);
  await page.setContent(
    '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>',
  );
  await page.evaluate(
    ({ unbroken }) => {
      window.__WORK_DETAIL_FIXTURE__ = {
        work: {
          id: "11111111-1111-4111-8111-111111111111",
          projectId: "project-1",
          createdByUserId: "user-1",
          name: `Long breakable Work identity ${unbroken}`,
          slug: "long",
          goal: unbroken,
          description: `Description ${unbroken}`,
          status: "active",
          archivedAt: null,
          deletedAt: null,
          aiWriteMode: "draft",
          unpushedChangeCount: 0,
          lastActivityAt: "2026-08-16T00:00:00Z",
          createdAt: "2026-08-16T00:00:00Z",
          updatedAt: "2026-08-16T00:00:00Z",
        },
        drafts: [
          {
            documentId: "doc",
            documentName: unbroken,
            contextPath: `/${unbroken}`,
            drafts: [{ status: "active" }],
          },
        ],
        scratch: {
          kind: "dir",
          name: "",
          path: "",
          children: [{ kind: "file", name: unbroken, path: `/${unbroken}` }],
        },
        uploads: {
          kind: "dir",
          name: "",
          path: "",
          children: [{ kind: "file", name: unbroken, path: `/${unbroken}` }],
        },
        threads: [
          { id: "thread", title: unbroken, runningTurnId: null, attention: "none", turnCount: 1 },
        ],
      };
    },
    { unbroken },
  );
  await page.addStyleTag({ content: compiledCss });
  await page.addScriptTag({ content: compiledJs, type: "module" });
  const scroll = page.locator(".app-scroll");
  await expect(scroll).toBeVisible();
  const width = await scroll.evaluate((node) => ({
    client: node.clientWidth,
    scroll: node.scrollWidth,
  }));
  expect(width.client).toBe(390);
  expect(width.scroll).toBe(width.client);
  await expect(page.getByRole("button", { name: "All Work" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage Work" })).toBeVisible();
  const targets = await page
    .locator("button")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(targets.every((height) => height >= 44)).toBe(true);
  const bounds = await page.locator("article button, article h1, article li").evaluateAll((nodes) =>
    nodes.map((node) => ({
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
    })),
  );
  expect(bounds.every(({ left, right }) => left >= 0 && right <= 390)).toBe(true);

  await page.getByRole("heading", { level: 1 }).click();
  await expect(page.locator('input[value^="Long breakable"]')).toBeVisible();
  expect(await scroll.evaluate((node) => node.scrollWidth)).toBe(390);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: unbroken, exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
  expect(await scroll.evaluate((node) => node.scrollWidth)).toBe(390);
});
