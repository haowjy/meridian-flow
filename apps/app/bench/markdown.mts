/**
 * Browser Markdown bench. Run from the repo: pnpm --filter @meridian/app bench:markdown
 * Builds the actual production renderer, opens it in headless Chrome without a
 * dev server, and measures synchronous React commits plus forced layout (not
 * paint). 4,000 whitespace-token appends run at 30/s; mounts use ten cold roots.
 * Save stdout to compare checkouts. BENCH_INTERVAL_MS=0 is a quick diagnostic,
 * not comparable to the default streaming run. Build artifacts are temporary.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      lib: {
        entry: path.join(app, "bench/markdown.tsx"),
        name: "MarkdownBench",
        formats: ["iife"],
        fileName: () => "bench.js",
      },
    },
  });
  await writeFile(
    path.join(out, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="root" class="text-tier-chat"></div><script src="bench.js"></script>',
  );
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`file://${out}/index.html`);
  const result = await page.evaluate(
    (interval) => window.runMarkdownBench(interval),
    Number(process.env.BENCH_INTERVAL_MS ?? 1000 / 30),
  );
  if (errors.length) throw new AggregateError(errors, "Markdown bench browser errors");
  process.stdout.write(
    `${JSON.stringify({ browser: await browser.version(), intervalMs: Number(process.env.BENCH_INTERVAL_MS ?? 1000 / 30), ...result }, null, 2)}\n`,
  );
} finally {
  await browser?.close();
  if (!process.env.BENCH_KEEP) await rm(out, { recursive: true, force: true });
}
