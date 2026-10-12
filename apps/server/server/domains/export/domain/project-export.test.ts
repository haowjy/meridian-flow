/** Export contract: a portable, frozen vault whose Markdown links resolve to ZIP entries. */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { type CatalogDocument, documentRef } from "@meridian/contracts";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { createHolderLinkScope, walkLinkOccurrences } from "@meridian/markup/links";
import { splitObsidianFrontmatter } from "@meridian/markup/obsidian/frontmatter";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ExportLinkScope } from "../../collab/domain/export-link-scope.js";
import type { ExportDocument } from "../ports/export-snapshot.js";
import { buildExportLayout } from "./export-layout.js";
import { createProjectExport } from "./project-export.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema, export: true });
const ordinary = mdxCodec({ schema });
function uuid(name: string) {
  const h = createHash("md5").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
}
function document(id: string, uri: string, extra: Partial<ExportDocument> = {}): ExportDocument {
  const [scheme, path] = uri.split("://");
  const name = path?.split("/").at(-1) ?? "";
  return {
    id: uuid(id),
    uri,
    path: path ?? "",
    scheme: scheme ?? "",
    name,
    extension: "",
    fileType: "markdown",
    manifestScoped: true,
    workId: null,
    workName: null,
    rootThreadId: null,
    chatTitle: null,
    metadata: {},
    storageUrl: null,
    ...extra,
  };
}
function fixture() {
  const docs = [
    document("chapter", "manuscript://Chapter", {
      metadata: { properties: { format: "yaml", text: "aliases: [Gate]\n# kept\n" } },
    }),
    document("lore", "kb://Lore/Sects"),
    document("x", "kb://x"),
    document("X", "kb://X"),
    document("image", "kb://map.png", {
      name: "map",
      extension: "png",
      fileType: "image",
      storageUrl: "object://meridian/assets/map.png",
    }),
    document("scratch1", "scratch://@one/note", {
      path: "note",
      name: "note",
      workId: "one",
      workName: "Work",
      manifestScoped: false,
    }),
    document("scratch2", "scratch://@two/note", {
      path: "note",
      name: "note",
      workId: "two",
      workName: "work",
      manifestScoped: false,
    }),
    document("upload1", "uploads://@one/file.json", {
      path: "file.json",
      name: "file",
      extension: "json",
      fileType: "json",
      workId: "one",
      workName: "Work",
      manifestScoped: false,
    }),
    document("upload2", "uploads://@two/file.json", {
      path: "file.json",
      name: "file",
      extension: "json",
      fileType: "json",
      workId: "two",
      workName: "work",
      manifestScoped: false,
    }),
    document("no-upload", "uploads://@/file.json", {
      path: "file.json",
      name: "file",
      extension: "json",
      fileType: "json",
      manifestScoped: false,
    }),
    document("chat1", "scratch://@/c1/note", {
      path: "note",
      name: "note",
      rootThreadId: "chat1",
      chatTitle: "Chat",
      manifestScoped: false,
    }),
    document("chat2", "scratch://@/c2/note", {
      path: "note",
      name: "note",
      rootThreadId: "chat2",
      chatTitle: "chat",
      manifestScoped: false,
    }),
  ];
  const blocks = [
    schema.node("paragraph", null, [
      schema.text(
        "[[Not a link]] ![[Not an embed]] [ref] [^1] [[nested [trap](https://example.com)]] [[plain]](https://example.com) ",
      ),
      ...["lore", "x", "X", "upload1", "scratch1"].map((id) =>
        schema.text(id, [
          schema.marks.link!.create({
            href: docs.find((doc) => doc.id === uuid(id))!.uri,
            ref: id === "lore" ? `ahead:${uuid("lore-ahead")}` : documentRef(uuid(id)),
          }),
        ]),
      ),
    ]),
    schema.node("image", { src: `asset:${uuid("image")}`, alt: "map" }),
  ];
  const bytes = new Uint8Array(2 * 1024 * 1024);
  bytes.set([137, 80, 78, 71, 255]);
  const reads: string[] = [];
  const service = createProjectExport({
    snapshot: {
      async read() {
        return {
          documents: docs.map((doc) => ({ ...doc })),
          sources: [],
          settlements: new Map([[uuid("lore-ahead"), uuid("lore")]]),
        };
      },
    },
    files: {
      async listAccess(_principal, ids) {
        return new Map(ids.map((id) => [id, { level: "read" } as never]));
      },
    },
    documents: {
      async resolveManifestMembership() {
        return { members: docs.map((doc) => doc.id) } as never;
      },
      async readForExport(id, scope) {
        reads.push(id);
        const holder = createHolderLinkScope(
          {
            uri: docs.find((doc) => doc.id === id)!.uri,
            projectId: "project",
            view: { kind: "live" },
          },
          {
            document(id) {
              const doc = docs.find((doc) => doc.id === id);
              return doc
                ? {
                    documentId: id,
                    uri: doc.uri,
                    projectId: "project",
                    owner: {} as CatalogDocument["owner"],
                    presence: "live",
                    readable: true,
                    nameable: true,
                  }
                : null;
            },
            settlement: () => null,
            documentAt: () => null,
            documentFor: () => null,
            assetFor: () => null,
            assetAddress: () => ({ kind: "last", uri: "kb://map.png" }),
          },
        );
        return {
          ok: true,
          value: codec.serialize(
            id === uuid("chapter")
              ? blocks
              : [schema.node("paragraph", null, schema.text("Content"))],
            scope(holder),
          ),
        };
      },
    },
    objects: {
      async get() {
        return { ok: true, value: { bytes, mimeType: "image/png" } };
      },
    },
  });
  return { service, docs, blocks, bytes, reads };
}
async function entries(stream: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return unzipSync(Buffer.concat(chunks));
}
/** Scripted acceptance check: every relative Markdown link names an actual archive entry. */
function checkRelativeLinks(files: Record<string, Uint8Array>) {
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.endsWith(".md")) continue;
    const blocks = ordinary.parse(splitObsidianFrontmatter(strFromU8(bytes)).body).blocks;
    for (const {
      attrs: { href },
    } of walkLinkOccurrences(blocks)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const target = posix.normalize(
        posix.join(posix.dirname(path), decodeURIComponent(href.split(/[?#]/)[0]!)),
      );
      expect(files[target], `${path} -> ${href}`).toBeDefined();
    }
  }
}
describe("project exports", () => {
  it("downloads lossless frontmatter and export-only literals without introducing links", async () => {
    const { service, blocks } = fixture();
    const snapshot = await service.prepare("project", "account", {
      scratch: false,
      uploads: false,
    });
    const chapter = await snapshot.read(uuid("chapter"));
    expect(chapter.filename).toBe("Chapter.md");
    expect(chapter.excludedLinks).toBe(2);
    expect((await snapshot.read(uuid("x"))).filename).toBe("x (2).md");
    const text = strFromU8(chapter.bytes);
    expect(text).toContain("---\naliases: [Gate]\n# kept\n---\n");
    expect(text).toContain("[lore](../Knowledge%20Base/Lore/Sects.md)");
    expect(text).toContain("[[Not a link]] ![[Not an embed]]");
    expect(text).toContain("\\[ref]");
    expect(text).toContain("\\[^1]");
    expect(ordinary.serialize(blocks, UNSCOPED_DOCUMENT_LINKS)).not.toContain("[[Not a link]]");
    const parsed = ordinary.parse(splitObsidianFrontmatter(text).body).blocks;
    const links = walkLinkOccurrences(parsed).filter((link) => link.kind === "link");
    expect(links).toHaveLength(5);
  });
  it("streams default and optional vaults with binary integrity and all relative links resolving", async () => {
    const { service, bytes } = fixture();
    const defaults = await service.prepare("project", "account", {
      scratch: false,
      uploads: false,
    });
    const files = await entries(defaults.stream("Serial"));
    expect(Object.keys(files).some((path) => path.includes("/Works/"))).toBe(false);
    expect(files["Serial/Knowledge Base/X.md"]).toBeDefined();
    expect(files["Serial/Knowledge Base/x (2).md"]).toBeDefined();
    expect(createHash("sha256").update(files["Serial/Knowledge Base/map.png"]!).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(JSON.parse(strFromU8(files["Serial/meridian-export.json"]!)).excludedLinks).toBe(2);
    checkRelativeLinks(files);
    const full = await service.prepare("project", "account", { scratch: true, uploads: true });
    const all = await entries(full.stream("Serial"));
    for (const path of [
      "Work/Scratch/note.md",
      "work (2)/Scratch/note.md",
      "Work/Uploads/file.json",
      "work (2)/Uploads/file.json",
      "No Work/Uploads/file.json",
      "No Work/Scratch/Chat/note.md",
      "No Work/Scratch/chat (2)/note.md",
    ])
      expect(all[`Serial/Works/${path}`]).toBeDefined();
    expect(JSON.parse(strFromU8(all["Serial/meridian-export.json"]!)).excludedLinks).toBe(0);
    checkRelativeLinks(all);
  });
  it("keeps frozen identities and paths when a target moves during streaming", async () => {
    const { service, docs, reads } = fixture();
    const snapshot = await service.prepare("project", "account", { scratch: true, uploads: true });
    const stream = snapshot.stream("Serial");
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(reads).not.toContain(uuid("chapter"));
    docs.find((doc) => doc.id === uuid("lore"))!.uri = "user://Moved";
    const files = await entries(
      (async function* () {
        yield first.value;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      })(),
    );
    expect(files["Serial/Knowledge Base/Lore/Sects.md"]).toBeDefined();
    checkRelativeLinks(files);
  });
  it("counts case-only folders and reserves portable filenames", () => {
    const { paths, roots } = buildExportLayout(
      [
        document("one", "kb://Lore/note"),
        document("two", "kb://lore/note"),
        document("bad", "kb://CON"),
      ],
      { scratch: true, uploads: false },
      [
        {
          uri: "scratch://@empty/",
          scheme: "scratch",
          workId: "empty",
          workName: "Empty Work",
          rootThreadId: null,
          chatTitle: null,
        },
      ],
    );
    expect(roots.get("scratch://@empty/")).toBe("Works/Empty Work/Scratch");
    const holder = createHolderLinkScope(
      { uri: "kb://Lore/note", projectId: "project", view: { kind: "live" } },
      {
        document: () => null,
        documentAt: () => null,
        documentFor: () => null,
        settlement: () => null,
        assetAddress: () => null,
        assetFor: () => null,
      },
    );
    const scope = new ExportLinkScope(
      uuid("one"),
      holder,
      paths,
      new Map([[uuid("one"), "kb://Lore/note"]]),
      new Map(),
      roots,
      new Map(),
      () => {
        throw new Error("An included ahead root should spell relatively");
      },
    );
    expect(
      scope.spellLink({ href: "scratch://@empty/Future", ref: `ahead:${uuid("future")}` }).href,
    ).toBe("../../Works/Empty%20Work/Scratch/Future.md");
    expect(paths.get(uuid("two"))).toBe("Knowledge Base/lore (2)/note.md");
    expect(paths.get(uuid("bad"))).toBe("Knowledge Base/_CON.md");
  });
});
