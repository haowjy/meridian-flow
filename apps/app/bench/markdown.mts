/**
 * Browser Markdown bench. Run from the repo: pnpm --filter @meridian/app bench:markdown
 * Builds the actual production renderer, serves its files through Playwright
 * routing so module workers run, and opens it in headless Chrome. One 5,071-word
 * text block streams at 30 tokens/s; mounts use ten cold roots.
 * Save stdout to compare checkouts. BENCH_INTERVAL_MS=0 is a quick diagnostic,
 * not comparable to the default streaming run. BENCH_MOUNTS_ONLY=1 skips token
 * streaming for alternating mount comparisons. Build artifacts are temporary.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { linguiMacroBabelPlugin } from "../dev/vite-plugins";
import type { runMarkdownBench } from "./markdown";

declare global {
  interface Window {
    runMarkdownBench: typeof runMarkdownBench;
  }
}

const app = fileURLToPath(new URL("..", import.meta.url));
const out = await mkdtemp(path.join(tmpdir(), "meridian-markdown-"));
let browser: Browser | undefined;
try {
  await build({
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    root: app,
    logLevel: "error",
    resolve: { alias: { "@": path.join(app, "src") } },
    plugins: [linguiMacroBabelPlugin(), react(), tailwind()],
    build: {
      outDir: out,
      emptyOutDir: false,
      rollupOptions: {
        input: path.join(app, "bench/markdown.tsx"),
        output: {
          entryFileNames: "bench.js",
          assetFileNames: (asset) =>
            asset.name?.endsWith(".css") ? "app.css" : "assets/[name]-[hash][extname]",
        },
      },
    },
  });
  await writeFile(
    path.join(out, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="root" class="text-tier-chat"></div><script type="module" src="bench.js"></script>',
  );
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.route("https://markdown.bench/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/+/, "");
    const file = path.join(out, pathname || "index.html");
    if (!file.startsWith(`${out}${path.sep}`)) return route.abort();
    const extension = path.extname(file);
    await route.fulfill({
      body: await readFile(file),
      contentType:
        extension === ".html" ? "text/html" : extension === ".css" ? "text/css" : "text/javascript",
    });
  });
  await page.goto("https://markdown.bench/index.html");
  const result = await page.evaluate(
    ([interval, mountsOnly]) => window.runMarkdownBench(interval, mountsOnly),
    [
      Number(process.env.BENCH_INTERVAL_MS ?? 1000 / 30),
      process.env.BENCH_MOUNTS_ONLY === "1",
    ] as const,
  );
  if (errors.length) throw new AggregateError(errors, "Markdown bench browser errors");
  process.stdout.write(
    `${JSON.stringify({ browser: await browser.version(), intervalMs: Number(process.env.BENCH_INTERVAL_MS ?? 1000 / 30), ...result }, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  if (!process.env.BENCH_KEEP) await rm(out, { recursive: true, force: true });
}
