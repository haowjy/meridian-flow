import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLinkRef } from "@meridian/contracts";
import { documentLinks, linkAheadRefs } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { handleDocumentLinkResolveRequest } from "../../lib/document-link-route.js";
import {
  barrier,
  folder,
  importDbEnabled,
  loose,
  useImportDb,
  vault,
} from "./__test-support__/import-db.js";
import { createImportService } from "./domain/import-service.js";

describe.skipIf(!importDbEnabled)("import conversion (postgres)", () => {
  const fx = useImportDb();
  const { db, ports, context, projectDocuments, plannedUri, ok } = fx;
  let projectId: string, userId: string;
  beforeEach(() => {
    ({ projectId, userId } = fx.current());
  });
  /** Every stored ref the holder carries, resolved the way the editor's follower asks. */
  async function resolveStoredRefs(holderUri: string, holderId: string) {
    const rows = await db
      .select({ key: documentLinks.linkKey, address: documentLinks.address })
      .from(documentLinks)
      .where(eq(documentLinks.sourceDocumentId, holderId as never));
    const links = rows
      .filter((row) => parseLinkRef(row.key))
      .map((row) => ({ ref: row.key, href: row.address ?? "" }));
    const response = await handleDocumentLinkResolveRequest(
      {
        projectRepo: fx.current().app.projectRepo,
        documentLinks: fx.current().app.documentLinks,
        linkScopes: fx.current().app.linkScopes,
        workAuthorityResolver: fx.current().app.workAuthorityResolver,
        fileAccess: fx.current().app.fileAccess,
      },
      { projectId, userId: userId as never, request: { baseUri: holderUri, links } },
    );
    return { links, states: response.answers.map((answer) => answer.state) };
  }
  it("converts the main fixture by identity: properties, aliases, links, reverse order and an area move", async () => {
    const { source, selection } = vault("notes-folder");
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    // Holders before their targets, and the PNG last: every link is written before it exists.
    const rank = (path: string) =>
      path.endsWith(".png") ? 4 : path.startsWith("Chapters/") ? 0 : path === "Lore.md" ? 1 : 2;
    for (const entry of plan.entries
      .filter((entry) => entry.state === "planned")
      .sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? 1 : -1)))
      expect(
        (
          await service.land(
            projectId,
            plan.importId,
            entry.entryId,
            selection.bytes[entry.entryId],
          )
        ).state,
      ).toBe("landed");
    const read = async (uri: string) => (await ok(context().read(uri))).content;
    const chapter1 = await read("kb://notes-folder/Chapters/Chapter 1 - The Gate");
    expect(chapter1.startsWith("# Chapter 1: The Gate\n")).toBe(true);
    for (const link of [
      "[the protagonist](<../Characters/Lin Feng>)",
      "[Cultivation Realms > Foundation](<../Lore/Cultivation Realms#Foundation>)",
      "[Sects](../Lore/Sects)",
      "![map.png](kb://notes-folder/attachments/map.png)",
      "words [Cultivation Realms](<../Lore/Cultivation Realms>).",
      // Kept-literal syntax stays visible text.
      "%% This reveal belongs in chapter twenty. %%",
      "==warm as blood==. #foreshadowing",
      "[!warning] A costly breakthrough",
      "[^debt]",
    ])
      expect(chapter1).toContain(link);
    const ch2 = await read("kb://notes-folder/Chapters/Ch 2");
    for (const link of [
      "Previously: [Chapter 1 - The Gate](<Chapter 1 - The Gate>).",
      "[the sect register](../Lore/Sects)",
      "[a clan ledger](<Sects and Clans>)",
      "\n\n[Chapter 1 - The Gate](<Chapter 1 - The Gate>)\n\n",
      "[Lin](<../Characters/Lin Feng>)",
    ])
      expect(ch2).toContain(link);
    expect(await read("kb://notes-folder/Chapters/Chapter 4 - The Ledger")).toContain(
      "[Magic System](<../Lore/Magic System>) and [magic system](<../Lore/magic system>)",
    );
    const lore = await read("kb://notes-folder/Lore/Lore");
    expect(lore).toContain("[Cultivation Realms](<Cultivation Realms>)");
    expect(lore).toContain("[Sects](Sects)");
    expect(lore).not.toContain("aliases:");
    const report = await service.status(plan.importId, projectId);
    const byPath = (path: string) => {
      const entry = report.entries.find((entry) => entry.path === path);
      if (!entry) throw new Error(path);
      return entry;
    };
    const row = (await projectDocuments()).find(
      (row) => row.id === byPath("Chapters/Chapter 1 - The Gate.md").documentId,
    );
    const sourceText = readFileSync(join(source, "Chapters/Chapter 1 - The Gate.md"), "utf8");
    expect(row?.metadata).toMatchObject({
      properties: { format: "yaml", text: /^---\n([\s\S]*?)---\n/.exec(sourceText)?.[1] },
      aliases: ["Gate Opening", "First Chapter"],
    });
    // Moving the chapters across areas keeps every link; refs, not addresses, decide.
    await ok(context().move("kb://notes-folder/Chapters/", "manuscript://Chapters/"));
    expect(await read("manuscript://Chapters/Ch 2")).toContain(
      "[the sect register](kb://notes-folder/Lore/Sects)",
    );
    expect(await read("manuscript://Chapters/Chapter 1 - The Gate")).toContain(
      "![map.png](kb://notes-folder/attachments/map.png)",
    );
    for (const [holder, path] of [
      ["manuscript://Chapters/Chapter 1 - The Gate", "Chapters/Chapter 1 - The Gate.md"],
      ["manuscript://Chapters/Ch 2", "Chapters/Ch 2.md"],
      ["kb://notes-folder/Lore/Lore", "Lore.md"],
    ] as const) {
      const resolved = await resolveStoredRefs(holder, byPath(path).documentId);
      expect(resolved.links.length).toBeGreaterThan(0);
      expect(new Set(resolved.states)).toEqual(new Set(["document"]));
    }
  });
  it("persists edge outcomes: unreadable YAML, skips, a folder-spelled name, a PDF under a prose name and plain text", async () => {
    const selection = folder("edge", {
      "Broken.md": "---\naliases: [broken\nstatus: draft\n---\nBody without frontmatter.",
      "Templates.base": "views: []",
      ".trash/Old.md": "Deleted note.",
      "Lore.markdown": "Folder and note conflict.",
      "Lore.md/Child.md": "Child.",
      "scan.txt": "%PDF-1.4\n%%EOF\n",
      "config.toml": 'title = "[[literal]]"\n',
    });
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    for (const entry of plan.entries.filter((entry) => entry.state === "planned"))
      await service.land(projectId, plan.importId, entry.entryId, selection.bytes[entry.entryId]);
    const report = await service.status(plan.importId, projectId);
    const byPath = (path: string) => {
      const entry = report.entries.find((entry) => entry.path === path);
      if (!entry) throw new Error(path);
      return entry;
    };
    const read = async (uri: string) => (await ok(context().read(uri))).content;
    // Unreadable frontmatter is stored verbatim and absent from the prose.
    expect((await read("kb://edge/Broken")).trim()).toBe("Body without frontmatter.");
    const broken = (await projectDocuments()).find(
      (row) => row.id === byPath("Broken.md").documentId,
    );
    expect(broken?.metadata).toMatchObject({
      properties: { format: "yaml", text: "aliases: [broken\nstatus: draft\n" },
      aliases: [],
    });
    expect(byPath("Templates.base")).toMatchObject({ state: "skipped" });
    expect(byPath(".trash/Old.md")).toMatchObject({ state: "skipped" });
    // D16: the note counts up beside the folder spelled like it.
    expect(await plannedUri(byPath("Lore.markdown").documentId)).toBe("kb://edge/Lore (2)");
    // D17: a PDF under a prose name lands with its registered extension.
    expect(byPath("scan.txt")).toMatchObject({ kind: "binary" });
    expect(await plannedUri(byPath("scan.txt").documentId)).toBe("kb://edge/scan.pdf");
    // The shared registry types `.toml` as plain text, not code; either way it is not converted.
    expect(byPath("config.toml")).toMatchObject({ state: "landed" });
    expect(await read((await plannedUri(byPath("config.toml").documentId)) ?? "")).toBe(
      'title = "\\[\\[literal]]"\n',
    );
  });
  it("stores verbatim properties and binds a selected note by id after move and address capture", async () => {
    const selection = loose({
      "Lin Feng.md": "[[Sects]]",
      "Sects.md": "---\naliases: [Register]\n---\nImported sects",
    });
    const service = createImportService(ports());
    const plan = await service.plan(projectId, userId, selection.manifest);
    await ok(context().move("kb://Sects", "kb://Old"));
    await ok(
      context().createTrackedDocument("kb://Sects", "Impostor", {
        origin: { type: "human", userId },
      }),
    );
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    expect((await ok(context().read("kb://Lin Feng"))).content).toContain("(Old)");
    expect((await service.land(projectId, plan.importId, 1, selection.bytes[1])).state).toBe(
      "landed",
    );
    const row = (await projectDocuments()).find(
      (row) => row.id === plan.entries.find((entry) => entry.filename === "Sects.md")?.documentId,
    );
    expect(row?.metadata).toMatchObject({
      properties: { format: "yaml", text: "aliases: [Register]\n" },
      aliases: ["Register"],
    });
    expect((await ok(context().read("kb://Old"))).content.trim()).toBe("Imported sects");
  });
  function imageSelection(chapter = "![[map.png]]") {
    const selection = loose({
      "Chapter.md": chapter,
      "attachments/map.png": new Uint8Array([137, 80, 78, 71, 0, 1]),
    });
    selection.manifest.roots = [
      {
        rootId: 0,
        kind: "folder",
        name: "vault",
        appJson: '{"attachmentFolderPath":"attachments"}',
      },
    ];
    selection.manifest.folders = [{ rootId: 0, path: "attachments" }];
    selection.manifest.entries = selection.manifest.entries.map((entry, index) => ({
      ...entry,
      rootId: 0,
      path: index === 0 ? "Chapter.md" : "attachments/map.png",
    }));
    return selection;
  }
  it("actually interleaves image binding, attachment move, binary commit and holder commit", async () => {
    const selection = imageSelection(),
      deps = ports(),
      gate = barrier();
    const bind = deps.tree.bind;
    deps.tree.bind = async (...args) => {
      const result = await bind(...args);
      if (args[0].kind === "note") await gate.pause();
      return result;
    };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    const holder = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    try {
      await ok(context().move("kb://vault/attachments/", "kb://vault/images/"));
      expect((await service.land(projectId, plan.importId, 1, selection.bytes[1])).state).toBe(
        "landed",
      );
    } finally {
      gate.release();
    }
    expect((await holder).state).toBe("landed");
    expect((await ok(context().read("kb://vault/Chapter"))).content).toContain("images/map.png");
  });
  it("a file arriving at the planned picture address after the holder never captures its figure", async () => {
    const selection = imageSelection(),
      service = createImportService(ports());
    const plan = await service.plan(projectId, userId, selection.manifest);
    await service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await competitorAtPlannedPicture();
    const result = await service.land(projectId, plan.importId, 1, selection.bytes[1]);
    expect(result.state).toBe("landed");
    expect(await plannedUri(result.documentId)).toBe("kb://vault/attachments/map (2).png");
    expect((await ok(context().read("kb://vault/Chapter"))).content).toContain(
      "attachments/map (2).png",
    );
  });
  it("a document arriving at a planned code file's address after the holder never captures its link", async () => {
    const selection = loose({ "Holder.md": "[[tool.py]]", "tool.py": "print('imported')" }),
      service = createImportService(ports());
    const plan = await service.plan(projectId, userId, selection.manifest);
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    await ok(
      context().createTrackedDocument("kb://tool.py", "print('other')", {
        origin: { type: "human", userId },
      }),
    );
    const code = await service.land(projectId, plan.importId, 1, selection.bytes[1]);
    expect(await plannedUri(code.documentId)).toBe("kb://tool (2).py");
    expect((await ok(context().read("kb://Holder"))).content).toContain("tool (2).py");
  });
  it("Finish releases a link awaiting a file that was never imported to its address's occupant", async () => {
    const selection = imageSelection(),
      service = createImportService(ports());
    const plan = await service.plan(projectId, userId, selection.manifest);
    await service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await competitorAtPlannedPicture();
    const holderId = plan.entries.find((entry) => entry.entryId === 0)?.documentId ?? "";
    const { links } = await resolveStoredRefs("kb://vault/Chapter", holderId);
    const aheadId = parseLinkRef(links[0]?.ref ?? "");
    if (aheadId?.kind !== "ahead") throw new Error("expected an ahead ref");
    const settled = async () =>
      (
        await db
          .select({ id: linkAheadRefs.settledDocumentId })
          .from(linkAheadRefs)
          .where(eq(linkAheadRefs.aheadId, aheadId.aheadId))
      )[0]?.id ?? null;
    expect(await settled()).toBeNull();
    await service.finish(plan.importId, projectId);
    const competitor = (await projectDocuments()).find(
      (row) => row.id !== holderId && row.name === "map",
    );
    expect(competitor).toBeDefined();
    expect(await settled()).toBe(competitor?.id);
  });
  async function competitorAtPlannedPicture() {
    await ok(
      context().writeBinary("kb://vault/attachments/map.png", {
        fileType: "image",
        storageUrl: "other",
        mimeType: "image/png",
        sizeBytes: 1,
        origin: { type: "human", userId },
      }),
    );
  }
  it("a file already at the planned picture address never captures the holder's figure", async () => {
    const selection = imageSelection(),
      service = createImportService(ports());
    const plan = await service.plan(projectId, userId, selection.manifest);
    await competitorAtPlannedPicture();
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    const picture = await service.land(projectId, plan.importId, 1, selection.bytes[1]);
    expect(await plannedUri(picture.documentId)).toBe("kb://vault/attachments/map (2).png");
    expect((await ok(context().read("kb://vault/Chapter"))).content).toContain(
      "kb://vault/attachments/map (2).png",
    );
  });
  it("a picture landing between the holder's snapshot and its binding binds by id", async () => {
    const selection = imageSelection(),
      deps = ports(),
      gate = barrier();
    const bind = deps.tree.bind;
    deps.tree.bind = async (...args) => {
      if (args[0].kind === "note") await gate.pause();
      return bind(...args);
    };
    const service = createImportService(deps),
      plan = await service.plan(projectId, userId, selection.manifest);
    await competitorAtPlannedPicture();
    const holder = service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await gate.arrived;
    try {
      expect(
        await plannedUri(
          (await service.land(projectId, plan.importId, 1, selection.bytes[1])).documentId,
        ),
      ).toBe("kb://vault/attachments/map (2).png");
    } finally {
      gate.release();
    }
    expect((await holder).state).toBe("landed");
    expect((await ok(context().read("kb://vault/Chapter"))).content).toContain(
      "kb://vault/attachments/map (2).png",
    );
  });
  it("binds a sibling [[Gate]] to an extensionless note by its frontmatter alias", async () => {
    const selection = loose({
      Holder: "See [[Gate]].",
      Chapter: "---\naliases: [Gate]\n---\nBody",
    });
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    expect((await ok(context().read("kb://Holder"))).content).toContain("[Gate](Chapter)");
  });
  async function landHolder(text: string) {
    const selection = loose({ "Holder.md": text, "A.md": "target" });
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    return service.land(projectId, plan.importId, 0, selection.bytes[0]);
  }
  it("adjacent links to one selected note land and a link after them keeps its own destination", async () => {
    expect((await landHolder("[[A]][[A]] [web](https://example.com)")).state).toBe("landed");
    expect((await ok(context().read("kb://Holder"))).content).toContain(
      "](A) [web](https://example.com)",
    );
  });
  it("adjacent links naming distinct identities at one address stay separate", async () => {
    const selection = imageSelection("[[map.png]][file](kb://vault/attachments/map.png)");
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    await competitorAtPlannedPicture();
    expect((await service.land(projectId, plan.importId, 0, selection.bytes[0])).state).toBe(
      "landed",
    );
    expect(
      await plannedUri(
        (await service.land(projectId, plan.importId, 1, selection.bytes[1])).documentId,
      ),
    ).toBe("kb://vault/attachments/map (2).png");
    const content = (await ok(context().read("kb://vault/Chapter"))).content;
    // The converted link follows the planned picture; the hand-written one names the file there.
    expect(content).toContain("map (2).png");
    expect(content).toMatch(/\[file\]\([^)]*attachments\/map\.png\)/);
  });
  it("routes a marked export to area roots, ignores invocation folder and skips Works", async () => {
    const selection = loose({
      "Manuscript/Chapter.md":
        "---\naliases: [Opening]\n---\n[Sects](../Knowledge%20Base/Lore/Sects.md)",
      "Knowledge Base/Lore/Sects.md": "Sects",
      "Unfiled/Notes.md": "Notes",
      "Works/No Work/Uploads/file.md": "Excluded",
    });
    selection.manifest.roots = [
      {
        rootId: 0,
        kind: "folder",
        name: "Project",
        meridianExport: JSON.stringify({
          formatVersion: 1,
          areas: { manuscript: "Manuscript", kb: "Knowledge Base", unfiled: "Unfiled" },
          works: true,
          excludedLinks: 0,
        }),
      },
    ];
    selection.manifest.entries = selection.manifest.entries.map((entry, index) => ({
      ...entry,
      rootId: 0,
      path: [
        "Manuscript/Chapter.md",
        "Knowledge Base/Lore/Sects.md",
        "Unfiled/Notes.md",
        "Works/No Work/Uploads/file.md",
      ][index],
    }));
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    expect(plan.entries.find((entry) => entry.entryId === 3)).toMatchObject({
      state: "skipped",
      reason: "export_works",
    });
    expect(
      await plannedUri(plan.entries.find((entry) => entry.entryId === 0)?.documentId ?? ""),
    ).toBe("manuscript://Chapter");
    expect(
      await plannedUri(plan.entries.find((entry) => entry.entryId === 1)?.documentId ?? ""),
    ).toBe("kb://Lore/Sects");
    expect(
      await plannedUri(plan.entries.find((entry) => entry.entryId === 2)?.documentId ?? ""),
    ).toBe("unfiled://Notes");
    for (const entry of plan.entries.filter((entry) => entry.state === "planned"))
      expect(
        (
          await service.land(
            projectId,
            plan.importId,
            entry.entryId,
            selection.bytes[entry.entryId],
          )
        ).state,
      ).toBe("landed");
    expect((await ok(context().read("manuscript://Chapter"))).content).toContain("kb://Lore/Sects");
    expect(
      (await ok(context().list("kb://"))).entries.some((entry) => entry.uri.includes("Project")),
    ).toBe(false);
  });
  it("freezes existing name/alias choices at plan, shares paste path ranking and prefers selected files", async () => {
    const existing = await ok(
      context().createTrackedDocument("kb://Lin Feng", "Existing Lin", {
        origin: { type: "human", userId },
      }),
    );
    const world = await ok(
      context().createTrackedDocument("kb://World", "Existing World", {
        origin: { type: "human", userId },
        metadata: { aliases: ["World Bible"] },
      }),
    );
    const selection = loose({
      "Chapter.md": "[[Lin Feng|the protagonist]] [[World Bible]] [[Sects]]",
    });
    selection.manifest.destination.folderUri = "manuscript://";
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
    await ok(context().move("kb://Lin Feng", "kb://Old Lin"));
    await ok(
      context().createTrackedDocument("kb://Lin Feng", "Wrong Lin", {
        origin: { type: "human", userId },
      }),
    );
    const result = await service.land(projectId, plan.importId, 0, selection.bytes[0]);
    expect(result.state).toBe("landed");
    const chapter = (await ok(context().read("manuscript://Chapter"))).content;
    expect(chapter).toContain("kb://Old Lin");
    // The alias resolves to the frozen existing World by identity.
    expect(chapter).toContain("[World Bible](kb://World)");
    expect(existing.documentId).not.toBe(world.documentId);
  });
});
