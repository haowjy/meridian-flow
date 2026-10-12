import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLinkRef } from "@meridian/contracts";
import { documentLinks } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { handleDocumentLinkResolveRequest } from "../../lib/document-link-route.js";
import {
  barrier,
  importDbEnabled,
  loose,
  useImportDb,
  vault,
} from "./__test-support__/import-db.js";
import { createImportService } from "./domain/import-service.js";

describe.skipIf(!importDbEnabled)("import conversion (postgres)", () => {
  const fx = useImportDb();
  const { db, ports, context, projectDocuments, ok } = fx;
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
  it("converts the main fixture by identity: properties, aliases, links, findings, reverse order and an area move", async () => {
    const { source, selection } = vault("obsidian-vault");
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
    const chapter1 = await read("kb://obsidian-vault/Chapters/Chapter 1 - The Gate");
    expect(chapter1.startsWith("# Chapter 1: The Gate\n")).toBe(true);
    for (const link of [
      "[the protagonist](<../Characters/Lin Feng>)",
      "[Cultivation Realms > Foundation](<../Lore/Cultivation Realms#Foundation>)",
      "[Sects](../Lore/Sects)",
      "![map.png](kb://obsidian-vault/attachments/map.png)",
      "words [Cultivation Realms](<../Lore/Cultivation Realms>).",
      // Kept-literal syntax stays visible text.
      "%% This reveal belongs in chapter twenty. %%",
      "==warm as blood==. #foreshadowing",
      "[!warning] A costly breakthrough",
      "[^debt]",
    ])
      expect(chapter1).toContain(link);
    const ch2 = await read("kb://obsidian-vault/Chapters/Ch 2");
    for (const link of [
      "Previously: [Chapter 1 - The Gate](<Chapter 1 - The Gate>).",
      "[the sect register](../Lore/Sects)",
      "[a clan ledger](<Sects and Clans>)",
      "\n\n[Chapter 1 - The Gate](<Chapter 1 - The Gate>)\n\n",
      "[Lin](<../Characters/Lin Feng>)",
    ])
      expect(ch2).toContain(link);
    expect(await read("kb://obsidian-vault/Chapters/Chapter 4 - The Ledger")).toContain(
      "[Magic System](<../Lore/Magic System>) and [magic system](<../Lore/magic system>)",
    );
    const lore = await read("kb://obsidian-vault/Lore/Lore");
    expect(lore).toContain("[Cultivation Realms](<Cultivation Realms>)");
    expect(lore).toContain("[Sects](Sects)");
    expect(lore).not.toContain("aliases:");
    const report = await service.report(plan.importId, projectId);
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
    const findings = byPath("Chapters/Chapter 1 - The Gate.md").findings;
    // The spoiler risk leads the document's findings.
    expect(findings[0]).toEqual({ code: "hidden_notes", params: { count: 1 } });
    expect(findings).toContainEqual({
      code: "kept_as_text",
      params: { callouts: 1, highlights: 1, tags: 1, footnotes: 2 },
    });
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["heading_not_followed", "block_ref_dropped"]),
    );
    expect(byPath("Chapters/Ch 2.md").findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["hidden_notes", "note_embed_to_link"]),
    );
    // Moving the chapters across areas keeps every link; refs, not addresses, decide.
    await ok(context().move("kb://obsidian-vault/Chapters/", "manuscript://Chapters/"));
    expect(await read("manuscript://Chapters/Ch 2")).toContain(
      "[the sect register](kb://obsidian-vault/Lore/Sects)",
    );
    expect(await read("manuscript://Chapters/Chapter 1 - The Gate")).toContain(
      "![map.png](kb://obsidian-vault/attachments/map.png)",
    );
    for (const [holder, path] of [
      ["manuscript://Chapters/Chapter 1 - The Gate", "Chapters/Chapter 1 - The Gate.md"],
      ["manuscript://Chapters/Ch 2", "Chapters/Ch 2.md"],
      ["kb://obsidian-vault/Lore/Lore", "Lore.md"],
    ] as const) {
      const resolved = await resolveStoredRefs(holder, byPath(path).documentId);
      expect(resolved.links.length).toBeGreaterThan(0);
      expect(new Set(resolved.states)).toEqual(new Set(["document"]));
    }
  });
  it("converts the edge vault: aliases, ahead links, literal code and comments, ties, skips and D16/D17", async () => {
    const { selection } = vault("obsidian-vault-edge");
    const service = createImportService(ports()),
      plan = await service.plan(projectId, userId, selection.manifest);
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
    const report = await service.report(plan.importId, projectId);
    const byPath = (path: string) => {
      const entry = report.entries.find((entry) => entry.path === path);
      if (!entry) throw new Error(path);
      return entry;
    };
    const read = async (uri: string) => (await ok(context().read(uri))).content;
    const edge = await read("kb://obsidian-vault-edge/Edge");
    for (const text of [
      "[World Bible](World)",
      "[Crane](<Characters/Lin Feng>)",
      "[Chapter 9](<Chapter 9>)",
      "[Budget](A/Budget)",
      "[Chapter 3 - Ash](<Chapter 3 - Ash>)",
      "`[[World Bible]]`",
      // Literal text: the projection escapes the brackets, the stored text is unchanged.
      "%% \\[\\[Little Crane]] a hidden note %%",
      '<a href="Characters/Lin Feng">Crane</a>',
      "![map.png](kb://obsidian-vault-edge/attachments/map.png)",
    ])
      expect(edge).toContain(text);
    const edgeFindings = byPath("Edge.md").findings;
    expect(edgeFindings).toEqual(
      expect.arrayContaining([
        { code: "hidden_notes", params: { count: 1 } },
        {
          code: "link_via_alias",
          params: { text: "World Bible", path: "kb://obsidian-vault-edge/World" },
        },
        {
          code: "link_via_alias",
          params: { text: "Little Crane", path: "kb://obsidian-vault-edge/Characters/Lin Feng" },
        },
        {
          code: "link_unresolved",
          params: { text: "Chapter 9", folder: "kb://obsidian-vault-edge/" },
        },
        {
          code: "link_ambiguous",
          params: {
            text: "Budget",
            count: 2,
            path: "kb://obsidian-vault-edge/A/Budget",
            candidates: ["kb://obsidian-vault-edge/A/Budget", "kb://obsidian-vault-edge/B/Budget"],
          },
        },
        { code: "image_size_dropped", params: { name: "map.png", size: "300" } },
      ]),
    );
    // Same-folder note wins over the equally short tie.
    expect(await read("kb://obsidian-vault-edge/A/Holder")).toContain("[Budget](Budget)");
    // Unreadable frontmatter is stored verbatim, reported and absent from the prose.
    expect((await read("kb://obsidian-vault-edge/Broken")).trim()).toBe(
      "Body without frontmatter.",
    );
    expect(byPath("Broken.md").findings).toContainEqual({
      code: "properties_unreadable",
      params: {},
    });
    const broken = (await projectDocuments()).find(
      (row) => row.id === byPath("Broken.md").documentId,
    );
    expect(broken?.metadata).toMatchObject({
      properties: { format: "yaml", text: "aliases: [broken\nstatus: draft\n" },
      aliases: [],
    });
    expect(byPath("Templates.base")).toMatchObject({ state: "skipped" });
    expect(report.entries.filter((entry) => entry.path.startsWith(".trash/"))).toEqual([
      expect.objectContaining({ state: "skipped" }),
    ]);
    // D16: the note counts up beside the folder spelled like it.
    expect(byPath("Lore.markdown").uri).toBe("kb://obsidian-vault-edge/Lore (2)");
    // D17: a PDF under a prose name lands with its registered extension.
    expect(byPath("scan.txt")).toMatchObject({
      kind: "binary",
      uri: "kb://obsidian-vault-edge/scan.pdf",
    });
    expect(byPath("scan.txt").findings.map((finding) => finding.code)).toContain(
      "binary_extension",
    );
    // The shared registry types `.toml` as plain text, not code; either way it is not converted.
    expect(byPath("config.toml")).toMatchObject({ state: "landed", findings: [] });
    expect(await read(byPath("config.toml").uri ?? "")).toBe('title = "\\[\\[literal]]"\n');
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
  function imageSelection() {
    const selection = loose({
      "Chapter.md": "![[map.png]]",
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
    expect(
      (await service.report(plan.importId, projectId)).entries
        .flatMap((entry) => entry.findings)
        .filter((finding) => finding.code === "picture_elsewhere"),
    ).toEqual([]);
  });
  it("reports a figure captured by another file and still lands the planned binary id counted up", async () => {
    const selection = imageSelection(),
      service = createImportService(ports());
    const plan = await service.plan(projectId, userId, selection.manifest);
    await service.land(projectId, plan.importId, 0, selection.bytes[0]);
    await ok(
      context().writeBinary("kb://vault/attachments/map.png", {
        fileType: "image",
        storageUrl: "other",
        mimeType: "image/png",
        sizeBytes: 1,
        origin: { type: "human", userId },
      }),
    );
    const result = await service.land(projectId, plan.importId, 1, selection.bytes[1]);
    expect(result.state).toBe("landed");
    expect(result.uri).toBe("kb://vault/attachments/map (2).png");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "picture_elsewhere",
        params: expect.objectContaining({
          holderId: plan.entries.find((entry) => entry.entryId === 0)?.documentId,
        }),
      }),
    );
    expect((await ok(context().read("kb://vault/Chapter"))).content).toContain(
      "attachments/map.png",
    );
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
    expect(picture.uri).toBe("kb://vault/attachments/map (2).png");
    expect((await ok(context().read("kb://vault/Chapter"))).content).toContain(
      "kb://vault/attachments/map (2).png",
    );
    expect(
      (await service.report(plan.importId, projectId)).entries.flatMap((entry) => entry.findings),
    ).not.toContainEqual(expect.objectContaining({ code: "picture_elsewhere" }));
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
      expect((await service.land(projectId, plan.importId, 1, selection.bytes[1])).uri).toBe(
        "kb://vault/attachments/map (2).png",
      );
    } finally {
      gate.release();
    }
    expect((await holder).state).toBe("landed");
    expect((await ok(context().read("kb://vault/Chapter"))).content).toContain(
      "kb://vault/attachments/map (2).png",
    );
  });
  it("routes a marked export to area roots, ignores invocation folder, skips Works and records sort off", async () => {
    const selection = loose({
      "Manuscript/Chapter.md":
        "---\naliases: [Opening]\n---\n[Sects](../Knowledge%20Base/Lore/Sects.md)",
      "Knowledge Base/Lore/Sects.md": "Sects",
      "Unfiled/Notes.md": "Notes",
      "Works/No Work/Uploads/file.md": "Excluded",
    });
    selection.manifest.sort = true;
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
    expect(plan.sort).toBe(false);
    expect(plan.entries.find((entry) => entry.entryId === 3)).toMatchObject({
      state: "skipped",
      reason: "export_works",
    });
    expect(plan.entries.find((entry) => entry.entryId === 0)?.uri).toBe("manuscript://Chapter");
    expect(plan.entries.find((entry) => entry.entryId === 1)?.uri).toBe("kb://Lore/Sects");
    expect(plan.entries.find((entry) => entry.entryId === 2)?.uri).toBe("unfiled://Notes");
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
    expect((await ok(context().read("manuscript://Chapter"))).content).toContain("kb://Old Lin");
    expect(result.findings).toContainEqual({
      code: "link_via_alias",
      params: { text: "World Bible", path: "kb://World" },
    });
    expect(result.findings).toContainEqual({
      code: "link_unresolved",
      params: { text: "Sects", folder: "manuscript://" },
    });
    expect(existing.documentId).not.toBe(world.documentId);
  });
  it("loose fixture chapters bind selected files first, then existing names, aliases and paths (IM15)", async () => {
    const human = { origin: { type: "human" as const, userId } };
    const lin = await ok(context().createTrackedDocument("kb://Characters/Lin Feng", "Lin", human));
    await ok(
      context().createTrackedDocument("kb://Lore/World", "World", {
        ...human,
        metadata: { aliases: ["World Bible"] },
      }),
    );
    const chapters = new URL("./__fixtures__/obsidian-vault/Chapters/", import.meta.url).pathname;
    const files = (extra: Record<string, string> = {}) => {
      const selection = loose({
        "Chapter 1 - The Gate.md": readFileSync(join(chapters, "Chapter 1 - The Gate.md")),
        "Ch 2.md": readFileSync(join(chapters, "Ch 2.md")),
        ...extra,
      });
      selection.manifest.destination.folderUri = "manuscript://";
      return selection;
    };
    async function landAll(selection: ReturnType<typeof loose>) {
      const service = createImportService(ports()),
        plan = await service.plan(projectId, userId, selection.manifest);
      for (const entry of plan.entries)
        await service.land(projectId, plan.importId, entry.entryId, selection.bytes[entry.entryId]);
      return (await service.report(plan.importId, projectId)).entries;
    }
    const first = await landAll(files({ "World Notes.md": "See [[World Bible]]." }));
    const chapter1 = await ok(context().read("manuscript://Chapter 1 - The Gate"));
    expect(chapter1.content).toContain("[the protagonist](<kb://Characters/Lin Feng>)");
    expect(chapter1.content).toContain("[Sects](Sects)");
    expect((await ok(context().read("manuscript://Ch 2"))).content).toContain(
      "Previously: [Chapter 1 - The Gate](<Chapter 1 - The Gate>).",
    );
    const findings = first.find((entry) => entry.filename === "Chapter 1 - The Gate.md")?.findings;
    expect(findings).toContainEqual({
      code: "link_to_existing",
      params: { text: "Lin Feng", path: "kb://Characters/Lin Feng" },
    });
    expect(findings).toContainEqual({
      code: "link_unresolved",
      params: { text: "Sects", folder: "manuscript://" },
    });
    expect((await ok(context().read("manuscript://World Notes"))).content).toContain(
      "[World Bible](kb://Lore/World)",
    );
    expect(first.find((entry) => entry.filename === "World Notes.md")?.findings).toContainEqual({
      code: "link_via_alias",
      params: { text: "World Bible", path: "kb://Lore/World" },
    });
    // The same chapters with their own Lin Feng: the selection wins over the project.
    const second = await landAll(files({ "Lin Feng.md": "Selected Lin" }));
    const selectedLin = second.find((entry) => entry.filename === "Lin Feng.md");
    expect(selectedLin?.documentId).not.toBe(lin.documentId);
    const secondChapter = second.find((entry) => entry.filename === "Chapter 1 - The Gate.md");
    expect((await ok(context().read(secondChapter?.uri ?? ""))).content).toContain(
      `[the protagonist](<${selectedLin?.name}>)`,
    );
    expect(secondChapter?.findings.map((finding) => finding.code)).not.toContain(
      "link_to_existing",
    );
    // Path-qualified ranking: the exact path at another area's root before a deeper suffix.
    await ok(context().createTrackedDocument("kb://Lore/Sects", "Sects", human));
    await ok(context().createTrackedDocument("manuscript://Archive/Lore/Sects", "Old", human));
    const third = loose({ "Qualified.md": "[[Lore/Sects]]" });
    third.manifest.destination.folderUri = "manuscript://";
    await landAll(third);
    expect((await ok(context().read("manuscript://Qualified"))).content).toContain(
      "[Sects](kb://Lore/Sects)",
    );
  });
});
