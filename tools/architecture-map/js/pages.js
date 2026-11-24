export const NODE_KINDS = [
  "person",
  "client",
  "service",
  "store",
  "external",
  "files",
  "domain",
  "feature",
  "module",
  "package",
  "context",
  "group",
  "note",
];

export const MAP_KEYS = [
  "Kind",
  "Paths",
  "Docs",
  "Machines",
  "Opens",
  "Breaks",
  "Drift",
  "See",
  "Shot",
];
export const JOURNEY_KEYS = ["Map", "Machines", "Shot"];

const ID = "[A-Za-z][A-Za-z0-9_-]*";
const SEQ_ID = "[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*";
const LINE = {
  header: /^flowchart (?:LR|RL|TB|TD|BT)$/,
  node: new RegExp(`^(${ID})\\["([^"]*)"\\]:::(\\w+)$`),
  edge: new RegExp(`^(${ID}) (-->|<-->)\\|"([^"]+)"\\| (${ID})$`),
  noteLink: new RegExp(`^(${ID}) -\\.- (${ID})$`),
  sequenceHeader: /^sequenceDiagram$/,
  participant: new RegExp(`^(?:participant|actor) (${SEQ_ID})(?: as .+)?$`),
  message: new RegExp(`^(${SEQ_ID}) ?(?:-->>|->>|--x|-x|--\\)|-\\))[+-]? ?(${SEQ_ID}): .+$`),
  note: new RegExp(`^Note (?:over|left of|right of) (${SEQ_ID})(?:, ?(${SEQ_ID}))?: .+$`),
  activation: new RegExp(`^(?:activate|deactivate) (${SEQ_ID})$`),
  sequenceBlock: /^(?:loop|alt|opt|par|critical|break|rect|else|and|option)(?: .*)?$|^autonumber$/,
};
const LABEL_TAGS = /<br\/>|<\/?small>/g;

export function parsePage(text) {
  const lines = text.split("\n");
  const page = { title: "", intro: "", mermaid: null, sections: [], problems: [] };
  const fail = (line, message) => page.problems.push({ line, message });
  let fence = null;
  let section = null;
  let paragraph = [];
  const introParts = [];

  const endParagraph = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join(" ");
    if (section) section.paragraphs.push(joined);
    else if (page.title) introParts.push(joined);
    paragraph = [];
  };

  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const line = raw.trim();
    const marker = /^(`{3,})\s*(\S*)\s*$/.exec(line);
    if (fence) {
      if (marker && marker[1].length >= fence.length && !marker[2]) fence = null;
      else if (fence.kind === "mermaid") {
        parseMermaidLine(page.mermaid, line, n, fail);
        page.mermaid.source += `${line}\n`;
      }
      continue;
    }
    if (marker) {
      endParagraph();
      const kind = marker[2] === "mermaid" && !page.mermaid ? "mermaid" : "other";
      if (marker[2] === "mermaid") {
        if (page.mermaid) fail(n, "A second mermaid block: a page has one.");
        else
          page.mermaid = {
            type: null,
            source: "",
            line: n,
            nodes: [],
            edges: [],
            noteLinks: [],
            participants: [],
          };
      }
      fence = { length: marker[1].length, kind };
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      endParagraph();
      if (heading[1] === "#" && !page.title) page.title = heading[2];
      else if (heading[1] === "##") {
        section = { id: heading[2], line: n, paragraphs: [], items: [] };
        page.sections.push(section);
      }
      continue;
    }
    if (!line) {
      endParagraph();
      continue;
    }
    if (section && line.startsWith("- ")) {
      endParagraph();
      const item = /^- ([A-Za-z]+): ?(.*)$/.exec(line);
      section.items.push(
        item
          ? { key: item[1], value: item[2], line: n }
          : { key: null, value: line.slice(2), line: n },
      );
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  page.intro = introParts.join("\n\n");
  return page;
}

function parseMermaidLine(mermaid, line, n, fail) {
  if (!line || line.startsWith("%%")) return;
  if (!mermaid.type) {
    if (LINE.header.test(line)) mermaid.type = "flowchart";
    else if (LINE.sequenceHeader.test(line)) mermaid.type = "sequence";
    else
      fail(
        n,
        `The mermaid block must start with a flowchart or sequenceDiagram header, not: ${line}`,
      );
    return;
  }
  if (mermaid.type === "sequence") return parseSequenceLine(mermaid, line, n, fail);
  let m = LINE.node.exec(line);
  if (m) {
    const bad = m[2].replace(LABEL_TAGS, "").match(/[<>]/);
    if (bad)
      fail(
        n,
        `Box ${m[1]}'s label holds "${bad[0]}": only <br/> and <small>...</small> are allowed.`,
      );
    mermaid.nodes.push({ id: m[1], label: m[2], kind: m[3], line: n });
    return;
  }
  m = LINE.noteLink.exec(line);
  if (m) {
    mermaid.noteLinks.push({ from: m[1], to: m[2], line: n });
    return;
  }
  m = LINE.edge.exec(line);
  if (m) {
    const step = /^(\d+)\. /.exec(m[3]);
    mermaid.edges.push({
      from: m[1],
      to: m[4],
      both: m[2] === "<-->",
      label: m[3],
      step: step ? Number(step[1]) : null,
      line: n,
    });
    return;
  }
  fail(n, `A mermaid line the format doesn't allow: ${line}`);
}

function parseSequenceLine(mermaid, line, n, fail) {
  const participants = (...ids) =>
    mermaid.participants.push(...ids.filter(Boolean).map((id) => ({ id, line: n })));
  const match = (re) => re.exec(line);
  const m =
    match(LINE.participant) ?? match(LINE.message) ?? match(LINE.note) ?? match(LINE.activation);
  if (m) participants(m[1], m[2]);
  else if (line === "end" || LINE.sequenceBlock.test(line)) return;
  else fail(n, `A sequenceDiagram line the format doesn't allow: ${line}`);
}

export function resolveParticipant(levels, name) {
  const hits = levels.flatMap((l) =>
    l.nodes
      .filter((n) => n.kind !== "context" && (n.id === name || `${l.id}-${n.id}` === name))
      .map((n) => ({ level: l, box: n })),
  );
  const bare = hits.filter((h) => h.box.id === name);
  if (bare.length > 1)
    return {
      error: `participant ${name} is the id of boxes on ${bare.map((h) => h.level.id).join(", ")}: write <page>-${name}, e.g. ${bare[0].level.id}-${name}.`,
    };
  if (hits.length !== 1)
    return {
      error: hits.length
        ? `participant ${name} names ${hits.length} boxes.`
        : `participant ${name} isn't a box id on any level page.`,
    };
  return hits[0];
}

export const item = (section, key) => section.items.find((it) => it.key === key);

export const pathsOf = (value) => [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export const linksOf = (value) =>
  [...value.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ label: m[1], href: m[2] }));

const isUrl = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href);

export function resolveHref(from, href) {
  if (isUrl(href)) return { path: null, fragment: null, url: href };
  const [file, fragment = null] = href.split("#");
  const out = file === "" ? from.split("/") : from.split("/").slice(0, -1);
  if (file !== "") {
    for (const part of file.split("/")) {
      if (part === "..") {
        if (!out.length) return { path: null, fragment };
        out.pop();
      } else if (part !== "." && part !== "") out.push(part);
    }
  }
  return { path: out.join("/"), fragment };
}

export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

export function globRegExp(glob) {
  const source = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}

export function unitOf(path, glob) {
  const depth = glob.split("/").length;
  const unit = path.split("/").slice(0, depth).join("/");
  return unit.split("/").length === depth && globRegExp(glob).test(unit) ? unit : null;
}

export function withoutFences(text) {
  let fence = 0;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^(`{3,})\s*(\S*)\s*$/.exec(line.trim());
      if (fence) {
        if (marker && marker[1].length >= fence && !marker[2]) fence = 0;
        return "";
      }
      if (marker) {
        fence = marker[1].length;
        return "";
      }
      return line;
    })
    .join("\n");
}

export function levelLinks(readme) {
  const out = [];
  let inList = false;
  for (const line of withoutFences(readme).split("\n")) {
    if (line.startsWith("## ")) inList = line.trim() === "## The pages";
    const m = inList && /^- \[([^\]]*)\]\(([\w-]+)\.md\)/.exec(line);
    if (m) out.push({ id: m[2], title: m[1], href: `${m[2]}.md` });
  }
  return out;
}

export async function loadLevelPages(read, mapDir) {
  const roots = levelLinks(await read(`${mapDir}/README.md`));
  const labels = new Map(roots.map((r) => [r.id, r.title]));
  const levels = new Map();
  for (const r of roots) {
    const queue = [{ id: r.id, path: `${mapDir}/${r.href}`, trail: [] }];
    while (queue.length) {
      const { id, path, trail } = queue.shift();
      if (levels.has(id)) continue;
      const page = parsePage(await read(path));
      if (trail.length) page.title = page.title.replace(`${trail.at(-1).page}: `, "");
      const title = labels.get(id) ?? page.title;
      levels.set(id, { id, title, path, page, trail });
      for (const s of page.sections) {
        const opens = linksOf(item(s, "Opens")?.value ?? "")[0];
        const target = opens && resolveHref(path, opens.href).path;
        if (!target?.startsWith(`${mapDir}/`) || !target.endsWith(".md")) continue;
        queue.push({
          id: target.slice(mapDir.length + 1, -3),
          path: target,
          trail: [...trail, { title, page: page.title, hash: `#${id}` }],
        });
      }
    }
  }
  return { roots: roots.map((r) => ({ id: r.id, title: r.title })), levels };
}
