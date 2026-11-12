// Proof code. Runs the bundled replay in headless Chromium, at full speed and with the
// processor slowed four times (Chrome's own throttle), and prints the timings.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const bundle = readFileSync(process.argv[2], "utf8");
const browser = await chromium.launch();
try {
  for (const slow of [1, 4]) {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: slow });
    await page.setContent("<!doctype html><title>tree</title>");
    await page.addScriptTag({ content: bundle });
    for (const [nodes, records] of [[3000, 30000], [22000, 31000], [10000, 100000]]) {
      const result = await page.evaluate(([n, r]) => globalThis.treeBench(n, r), [nodes, records]);
      console.log(`browser x${slow} slower: ${JSON.stringify(result)}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
