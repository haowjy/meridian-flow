/**
 * The box an upload reserves is the box the picture lands in.
 *
 * A real browser is the only place this claim can be checked: it is decided by
 * the cascade (the frame's measured width and aspect ratio against the
 * placeholder's own minimums), and jsdom computes no layout at all. A small
 * measured picture is the case that catches a minimum leaking into a measured
 * frame — a 32px icon that reserves 128x72 looks fine in every unit test and
 * collapses the writer's line when the bytes land.
 */
import { expect, type Page, test } from "@playwright/test";

import {
  cleanupProjectFixture,
  findTestUserId,
  login,
  openE2eDb,
  type ProjectFixture,
  seedProjectFixture,
} from "./support/e2e-db";

const DATABASE_URL = process.env.DATABASE_URL;

type Box = { x: number; y: number; width: number; height: number };

test.describe("pending image frame", () => {
  test("a small measured picture lands in the box its upload reserved", async ({ page }) => {
    test.skip(!DATABASE_URL, "DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;

    try {
      // Signed in before the fixture is seeded: the seeding calls go through
      // this browser context, and the context API answers nobody.
      await login(page);
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Image frame",
      });
      await holdUploads(page);
      await openManuscript(page, fixture);
      await typeSentenceOpening(page);
      await pasteImage(page, { kind: "measured", width: 32, height: 32 });

      const wrapper = page.locator(".meridian-image-node");
      await expect(wrapper).toHaveClass(/meridian-image-node--framed/);

      const pendingFrame = await boxOf(page, ".meridian-image-node");
      const pendingChild = await boxOf(page, ".meridian-image-pending");
      const pendingLine = await boxOf(page, ".ProseMirror p:has(.meridian-image-node)");

      // The frame is the file's own size, and the placeholder is exactly that
      // box: a minimum that outgrew it would paint over the words after it.
      expect(round(pendingFrame).w).toBe(32);
      expect(round(pendingFrame).h).toBe(32);
      expect(round(pendingChild)).toEqual(round(pendingFrame));

      await expect(page.locator(".meridian-image-node img")).toBeVisible({ timeout: 20_000 });
      const landed = await boxOf(page, ".meridian-image-node img");
      const landedLine = await boxOf(page, ".ProseMirror p:has(.meridian-image-node)");

      expect(round(landed)).toEqual(round(pendingFrame));
      expect(round(landedLine)).toEqual(round(pendingLine));
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });

  test("a picture the browser cannot measure still gets the readable fallback box", async ({
    page,
  }) => {
    test.skip(!DATABASE_URL, "DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;

    try {
      // Signed in before the fixture is seeded: the seeding calls go through
      // this browser context, and the context API answers nobody.
      await login(page);
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Image frame fallback",
      });
      await holdUploads(page);
      await openManuscript(page, fixture);
      await typeSentenceOpening(page);
      await pasteImage(page, { kind: "unmeasurable" });

      const wrapper = page.locator(".meridian-image-node");
      await expect(wrapper).not.toHaveClass(/meridian-image-node--framed/);

      // 8rem by 4.5rem: nothing measured the file, so the placeholder brings a
      // box worth reading rather than reserving a size it does not know.
      const fallback = await boxOf(page, ".meridian-image-pending");
      expect(fallback.width).toBeGreaterThanOrEqual(128);
      expect(fallback.height).toBeGreaterThanOrEqual(72);
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });
});

/**
 * The upload is held open long enough to read the slot it reserved. Without it
 * the local server answers before the first measurement, and the case would be
 * a race against the thing it is trying to observe.
 */
async function holdUploads(page: Page): Promise<void> {
  await page.route("**/documents/*/figure", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
}

async function openManuscript(page: Page, fixture: ProjectFixture): Promise<void> {
  const search = new URLSearchParams({
    screen: "context",
    thread: fixture.threadId,
    scheme: "kb",
    path: "/alpha.md",
  });
  await page.goto(`/project/${fixture.projectId}?${search.toString()}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(editor).toHaveAttribute("contenteditable", "true");
}

/**
 * A caret mid-sentence, which is where a pasted icon is hardest on the line.
 *
 * The words are typed here rather than read out of the fixture: what this file
 * measures is a box in a line of prose, and any prose will do. Waiting on the
 * seeded text instead would make a layout case depend on the document bootstrap.
 */
async function typeSentenceOpening(page: Page): Promise<void> {
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("The sigil ");
  await expect(editor).toContainText("The sigil");
}

async function pasteImage(
  page: Page,
  source: { kind: "measured"; width: number; height: number } | { kind: "unmeasurable" },
): Promise<void> {
  await page.evaluate(async (input) => {
    const file =
      input.kind === "measured"
        ? await (async () => {
            const canvas = document.createElement("canvas");
            canvas.width = input.width;
            canvas.height = input.height;
            const context = canvas.getContext("2d");
            if (context) {
              context.fillStyle = "#2f6f4f";
              context.fillRect(0, 0, canvas.width, canvas.height);
            }
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
            return new File([blob as Blob], "sigil.png", { type: "image/png" });
          })()
        : // Bytes no decoder will read: `measure-image.ts` answers null, which is
          // the unmeasured path a dimensionless SVG takes in a real document.
          new File([new Uint8Array(64).map((_, index) => (index * 7) % 251)], "unreadable.png", {
            type: "image/png",
          });

    const transfer = new DataTransfer();
    transfer.items.add(file);
    const surface = document.querySelector(".ProseMirror");
    surface?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, source);

  await expect(page.locator(".meridian-image-node")).toBeVisible();
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
}

/** Subpixel noise is not the subject; a collapsed line is. */
function round(box: Box): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: Math.round(box.width),
    h: Math.round(box.height),
  };
}
