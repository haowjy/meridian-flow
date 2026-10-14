import { importNodeId } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { clientRowsFor, nodeIdsFor, sourceOfManifest, sourceOfSelection } from "./client-rows";
import type { ImportDestination } from "./destination";
import { buildManifest } from "./manifest";
import type { Selection } from "./selection";

const destination: ImportDestination = {
  scheme: "kb",
  path: "/Lore",
  uri: "kb://Lore/",
  name: "Lore",
  folderId: "lore-id",
};
const file = (path: string) => ({ path, file: new File(["x"], path.split("/").at(-1) ?? path) });

describe("clientRowsFor", () => {
  it("gives rows the ids the server derives, parented by id", async () => {
    const selection: Selection = {
      leftOut: [],
      roots: [
        {
          rootId: 3,
          kind: "folder",
          name: "vault",
          files: [file("Ch 1.md"), file("Sub/Ch 2.md")],
          folders: [],
          unreadable: [],
        },
      ],
    };
    const rows = await clientRowsFor(
      sourceOfSelection(selection),
      destination,
      nodeIdsFor("p", "imp"),
    );
    const id = (kind: "folder" | "entry", path: string) =>
      importNodeId({ projectId: "p", importId: "imp", rootId: 3, kind, path });
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get("vault")).toMatchObject({ id: await id("folder", ""), parentId: "lore-id" });
    expect(byName.get("Sub")).toMatchObject({
      id: await id("folder", "Sub"),
      parentId: await id("folder", ""),
    });
    expect(byName.get("Ch 2")).toMatchObject({
      id: await id("entry", "Sub/Ch 2.md"),
      parentId: await id("folder", "Sub"),
    });
  });

  it("drops a folder only an unreadable file implied once rebuilt from the manifest", async () => {
    const bad = file("Sub/Bad.md");
    bad.file.arrayBuffer = () => Promise.reject(new DOMException("gone", "NotFoundError"));
    const selection: Selection = {
      leftOut: [],
      roots: [
        {
          rootId: 0,
          kind: "folder",
          name: "vault",
          files: [file("Ch 1.md"), bad],
          folders: [],
          unreadable: [],
        },
      ],
    };
    const ids = nodeIdsFor("p", "imp");
    const predicted = await clientRowsFor(sourceOfSelection(selection), destination, ids);
    expect(predicted.map((row) => row.name)).toContain("Sub");

    const built = await buildManifest(selection, { importId: "imp", destinationUri: "kb://Lore/" });
    const rebuilt = await clientRowsFor(sourceOfManifest(built.manifest), destination, ids);
    expect(rebuilt.map((row) => row.name).sort()).toEqual(["Ch 1", "vault"]);
  });
});
