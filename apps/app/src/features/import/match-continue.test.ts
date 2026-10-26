/** Risk: Continue must not silently skip missing files, resend receipts, or pair duplicate names by order. */
import { expect, it } from "vitest";
import { fakeImportServer } from "./fake-import-server";
import { buildSelection } from "./manifest";
import { matchContinue } from "./match-continue";
import type { Selection } from "./selection";

const selection = (name: string, files: File[]): Selection => ({
  roots: [
    {
      rootId: 0,
      kind: "folder",
      name,
      files: files.map((file) => ({ path: file.name, file })),
      folders: [],
      unreadable: [],
    },
  ],
  leftOut: [],
});
it("pairs only awaiting files, marks changes, and leaves missing or wrong-root files undecided", async () => {
  const original = selection("Book", [
    new File(["a"], "a.md", { lastModified: 10 }),
    new File(["b"], "b.md", { lastModified: 10 }),
    new File(["c"], "c.md", { lastModified: 10 }),
  ]);
  const { command } = buildSelection(original, "i", "kb://");
  const server = fakeImportServer();
  await server.api.create("p", command);
  await server.api.send("p", "i", [
    { entryId: 0, file: original.roots[0].files[0].file, name: "a.md" },
  ]);
  const detail = await server.api.detail("p", "i");
  const picked = selection("Book", [
    original.roots[0].files[0].file,
    new File(["new text"], "b.md", { lastModified: 20 }),
    new File(["extra"], "new.md"),
  ]);
  const match = matchContinue(detail, picked);
  expect([...match.held.keys()]).toEqual([1]);
  expect(match.held.get(1)?.changed).toBe(true);
  expect(match.missing).toEqual([2]);
  expect((await server.api.detail("p", "i")).entries[2].state).toBe("awaiting");
  expect(
    matchContinue(
      detail,
      selection(
        "Wrong",
        picked.roots[0].files.map((item) => item.file),
      ),
    ).held.size,
  ).toBe(0);
  expect(matchContinue(detail, selection("Wrong", [])).wrongRoot).toBe(true);
  const duplicate = {
    ...detail,
    roots: [...detail.roots, { ...detail.roots[0], rootId: 1 }],
    entries: [detail.entries[1], { ...detail.entries[1], entryId: 9, rootId: 1 }],
  };
  expect(
    matchContinue(duplicate, selection("Book", [original.roots[0].files[1].file])).held.size,
  ).toBe(0);
});
