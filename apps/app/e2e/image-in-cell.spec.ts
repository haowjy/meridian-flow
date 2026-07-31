/**
 * A picture in a table cell is bounded by the cell it stands in.
 *
 * Only a real browser can answer this. The failure it guards against is a
 * layout cycle no unit test can see: an auto table sizes its columns from what
 * is inside them, a measured picture carries its own width in pixels, and
 * `max-width: 100%` cannot cap a percentage against a column the picture itself
 * just widened. The shipped symptom was a 1280px screenshot inserted at a 500px
 * viewport pushing the table to 1353px, and half the picture's resize grips
 * ending up on the far side of a horizontal scroller — reachable one pair at a
 * time and never together.
 *
 * So this case asserts the two things the writer can see: the table stays the
 * width the manuscript gave it, and every grip of a selected picture is inside
 * the scroller's visible box.
 */
import { deflateSync } from "node:zlib";

import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  cleanupProjectFixture,
  findTestUserId,
  login,
  openE2eDb,
  type ProjectFixture,
  seedProjectFixture,
} from "./support/e2e-db";

const DATABASE_URL = process.env.DATABASE_URL;

/** The review's viewport: narrow enough that a screenshot dwarfs the column. */
test.use({ viewport: { width: 500, height: 900 } });

test.describe("a picture in a table cell", () => {
  test("does not widen its table, and keeps all four grips reachable", async ({ page }) => {
    test.skip(!DATABASE_URL, "DATABASE_URL is required");
    const db = openE2eDb(DATABASE_URL ?? "");
    let fixture: ProjectFixture | undefined;

    try {
      // Signed in before the fixture is seeded: the seeding calls go through
      // this browser context, and the context API answers nobody.
      await login(page);
      fixture = await seedProjectFixture(db, page.request, {
        userId: await findTestUserId(db),
        titlePrefix: "Cell image",
      });
      await openManuscript(page, fixture);
      await insertTable(page);
      await insertImageThroughCellSlash(page, { width: 1280, height: 577 });

      const frame = page.locator(".meridian-image-node");
      await expect(frame).toHaveClass(/meridian-image-node--framed/);

      // The picture is measured — the case would prove nothing about a fence if
      // the file had arrived without a size to fence.
      const shape = await boxOf(frame);
      expect(shape.width / shape.height).toBeCloseTo(1280 / 577, 1);

      const scroller = page.locator(".ProseMirror .tableWrapper").first();
      const room = await scrollerRoom(scroller);
      expect(room.scrollWidth).toBeLessThanOrEqual(room.clientWidth + 1);
      const table = await boxOf(page.locator(".ProseMirror table"));
      expect(table.width).toBeLessThanOrEqual(room.clientWidth + 1);

      // The picture fills the cell it is in rather than the width of its file.
      const cell = page.locator(".ProseMirror td:has(.meridian-image-node)").first();
      expect(shape.width).toBeLessThanOrEqual((await boxOf(cell)).width);

      await selectPicture(page);
      const grips = page.locator(".meridian-image-resize__grip");
      await expect(grips).toHaveCount(4);

      // Selecting scrolls the picture into view. Whatever that lands on, every
      // grip has to be inside the box the writer can actually see.
      const visible = await visibleRect(scroller);
      for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
        const grip = await boxOf(page.locator(`.meridian-image-resize__grip--${corner}`));
        expect(
          grip.x >= visible.left - 1 && grip.x + grip.width <= visible.right + 1,
          `${corner} grip at ${Math.round(grip.x)} is outside ${Math.round(visible.left)}..${Math.round(visible.right)}`,
        ).toBe(true);
      }
    } finally {
      await (fixture ? cleanupProjectFixture(db, fixture) : Promise.resolve()).finally(() =>
        db.end(),
      );
    }
  });
});

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

/** `/` → Table, which is the writer's only door to one. */
async function insertTable(page: Page): Promise<void> {
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await expect(page.getByRole("option", { name: /table/i }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror table")).toBeVisible();
}

/**
 * The cell-local slash path: a caret in a body cell, `/`, Image, a file.
 *
 * The file chooser the picker opens is a real `<input type="file">`
 * (`core/editor/images/image-uploads.ts`), so Playwright answers it as the
 * operating system would.
 */
async function insertImageThroughCellSlash(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  const cell = page.locator(".ProseMirror table tr").nth(1).locator("td").first();
  await cell.click();
  await page.keyboard.type("/image");
  const imageRow = page.getByRole("option", { name: /image/i }).first();
  await expect(imageRow).toBeVisible();

  // The row is pressed rather than entered: Enter acts on whatever the menu has
  // highlighted, which is a race against its own filtering.
  const chooser = page.waitForEvent("filechooser");
  await imageRow.click();
  await (await chooser).setFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: pngBytes(size.width, size.height),
  });

  await expect(page.locator(".meridian-image-node")).toBeVisible();
  await expect(page.locator(".meridian-image-node img")).toBeVisible({ timeout: 20_000 });
}

/** A click on the picture is what wears the ring and the grips. */
async function selectPicture(page: Page): Promise<void> {
  await page.locator(".meridian-image-node img").click({ position: { x: 4, y: 4 } });
  await expect(page.locator(".meridian-image-resize").first()).toBeVisible();
}

async function boxOf(locator: Locator): Promise<{ x: number; width: number; height: number }> {
  const box = await locator.first().boundingBox();
  if (!box) throw new Error("element has no box");
  return box;
}

async function scrollerRoom(
  scroller: Locator,
): Promise<{ clientWidth: number; scrollWidth: number }> {
  return scroller.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
}

/** What the writer can see of the scroller, in page coordinates. */
async function visibleRect(scroller: Locator): Promise<{ left: number; right: number }> {
  return scroller.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.left + element.clientWidth };
  });
}

/**
 * A real PNG of exactly the asked size, built here rather than fetched: the
 * subject is what the editor does with a file's own dimensions, so the file has
 * to have them and nothing else about it matters.
 */
function pngBytes(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 3 + 1);
    raw[start] = 0; // filter: none
    for (let column = 0; column < width; column += 1) {
      raw[start + 1 + column * 3] = 47;
      raw[start + 2 + column * 3] = 111;
      raw[start + 3 + column * 3] = 79;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
