import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("does not keep first-send recovery copy", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "ChatView.tsx"),
    "utf8",
  );
  expect(source).not.toMatch(/Saved first message/);
  expect(source).not.toMatch(/Check the saved first message/);
  expect(source).not.toMatch(/Check status/);
  expect(source).not.toMatch(/Start over/);
  expect(source).toMatch(/failedSendRetry/);
});
