/** Real-browser phone geometry contract for the Work detail information boundary. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let compiledCss: string;

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    root: appRoot,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: { write: false, rollupOptions: { input: "src/styles/globals.css" } },
  });
  const output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
    "output" in item ? item.output : [],
  );
  const css = output.find(
    (item): item is Rollup.OutputAsset => item.type === "asset" && item.fileName.endsWith(".css"),
  );
  if (!css) throw new Error("Vite did not emit the app stylesheet");
  compiledCss = String(css.source);
});

test("contains long Work detail content at 390px with touch-sized identity actions", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "coarse-pointer", "coarse-pointer geometry contract");
  await page.setViewportSize({ width: 390, height: 844 });
  const long =
    "The Unreasonably Long Ascension Chronicle Whose Identity Must Wrap Inside a Narrow Phone";
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1">
    <main data-testid="detail" class="app-scroll main-pane">
      <article class="project-screen-column min-w-0 gap-8">
        <header class="min-w-0"><div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0"><h1 class="break-words text-2xl font-semibold">${long}</h1></div>
          <button aria-label="Edit Work name" class="shrink-0 [@media(pointer:coarse)]:size-11">Edit</button>
        </div>
        <div data-testid="identity" class="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          <button class="[@media(pointer:coarse)]:min-h-11">All Work</button><span>Active</span>
          <button class="[@media(pointer:coarse)]:min-h-11">Manage Work</button>
        </div></header>
        <section class="min-w-0"><p class="whitespace-pre-line break-words">Goal ${long.repeat(3)}</p></section>
        <section class="min-w-0"><ul class="min-w-0"><li class="flex min-w-0 items-center gap-2">
          <span data-testid="resource" class="min-w-0 truncate">${long}.manuscript-resource-with-metadata</span>
          <span class="shrink-0">Updated today</span><button class="shrink-0 [@media(pointer:coarse)]:min-h-11">Open Scratch</button>
        </li></ul></section>
      </article>
    </main>`);
  await page.addStyleTag({ content: compiledCss });

  const geometry = await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>("[data-testid=detail]");
    if (!target) throw new Error("missing detail");
    const buttons = [...document.querySelectorAll("button")];
    return {
      viewport: document.documentElement.clientWidth,
      overflow: target.scrollWidth - target.clientWidth,
      targets: buttons.map((node) => ({
        name: node.textContent,
        height: node.getBoundingClientRect().height,
      })),
      identity: document.querySelector("[data-testid=identity]")?.textContent,
      resourceOverflow: (() => {
        const node = document.querySelector<HTMLElement>("[data-testid=resource]");
        return node ? node.scrollWidth > node.clientWidth : false;
      })(),
    };
  });
  expect(geometry.viewport).toBe(390);
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  expect(geometry.identity).toContain("All Work");
  expect(geometry.identity).toContain("Active");
  expect(geometry.identity).toContain("Manage Work");
  expect(geometry.resourceOverflow).toBe(true);
  expect(geometry.targets.every((target) => target.height >= 44)).toBe(true);
  await expect(page.getByRole("heading", { name: long })).toBeVisible();
});
