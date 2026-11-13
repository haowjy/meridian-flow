/*
 * Reads a map page (see README.md for the format). No DOM and no Node APIs, so the viewers and
 * check.mjs parse pages with the same code and cannot disagree about what a page says.
 */

export const REPO = "haowjy/meridian-flow";
export const BRANCH = "main";

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

/** The section list items each kind of page may carry. */
export const MAP_KEYS = ["Kind", "Paths", "Docs", "Machines", "Opens", "Breaks", "Drift", "See", "Shot"];
export const JOURNEY_KEYS = ["Map", "Machines", "Shot"];

const ID = "[A-Za-z][A-Za-z0-9_-]*";
// A hyphen joins two parts of an id; one before an arrow's dashes ("a-->>b") is the arrow's.
const SEQ_ID = "[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*";
const LINE = {
  header: /^flowchart (?:LR|RL|TB|TD|BT)$/,
  node: new RegExp(`^(${ID})\\["([^"]*)"\\]:::(\\w+)$`),
  edge: new RegExp(`^(${ID}) (-->|<-->)\\|"([^"]+)"\\| (${ID})$`),
  noteLink: new RegExp(`^(${ID}) -\\.- (${ID})$`),
  subgraph: new RegExp(`^subgraph ${ID}(?:\\["[^"]*"\\])?$`),
  sequenceHeader: /^sequenceDiagram$/,
  participant: new RegExp(`^(?:participant|actor) (${SEQ_ID})(?: as .+)?$`),
  message: new RegExp(`^(${SEQ_ID}) ?(?:-->>|->>|--x|-x|--\\)|-\\))[+-]? ?(${SEQ_ID}): .+$`),
  note: new RegExp(`^Note (?:over|left of|right of) (${SEQ_ID})(?:, ?(${SEQ_ID}))?: .+$`),
  activation: new RegExp(`^(?:activate|deactivate) (${SEQ_ID})$`),
  sequenceBlock: /^(?:loop|alt|opt|par|critical|break|rect|else|and|option)(?: .*)?$|^autonumber$/,
};
// A label may break lines and shrink a role line, nothing else.
const LABEL_TAGS = /<br\/>|<\/?small>/g;

/**
 * @typedef {{ line: number, message: string }} Problem
 * @returns {{
 *   title: string, intro: string,
 *   mermaid: null | {
 *     type: "flowchart" | "sequence" | null, source: string, line: number,
 *     nodes: {id, label, kind, line}[], edges: {from, to, both, label, step, line}[],
 *     noteLinks: {from, to, line}[],
 *     participants: {id, line}[],
 *   },
 *   sections: { id: string, line: number, paragraphs: string[], items: { key: string | null, value: string, line: number }[] }[],
 *   problems: Problem[],
 * }}
 */
export function parsePage(text) {
  const lines = text.split("\n");
  const page = { title: "", intro: "", mermaid: null, sections: [], problems: [] };
  const fail = (line, message) => page.problems.push({ line, message });
  let fence = null; // { length, kind: "mermaid" | "other" } inside a fenced block
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

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    const marker = /^(`{3,})\s*(\S*)\s*$/.exec(line);
    if (fence) {
      if (marker && marker[1].length >= fence.length && !marker[2]) fence = null;
      else if (fence.kind === "mermaid") {
        parseMermaidLine(page.mermaid, line, n, fail);
        page.mermaid.source += `${line}\n`;
      }
      return;
    }
    if (marker) {
      endParagraph();
      const kind = marker[2] === "mermaid" && !page.mermaid ? "mermaid" : "other";
      if (marker[2] === "mermaid") {
        if (page.mermaid) fail(n, "A second mermaid block: a page has one.");
        else page.mermaid = { type: null, source: "", line: n, nodes: [], edges: [], noteLinks: [], participants: [] };
      }
      fence = { length: marker[1].length, kind };
      return;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      endParagraph();
      if (heading[1] === "#" && !page.title) page.title = heading[2];
      else if (heading[1] === "##") {
        section = { id: heading[2], line: n, paragraphs: [], items: [] };
        page.sections.push(section);
      }
      return;
    }
    if (!line) return endParagraph();
    if (section && line.startsWith("- ")) {
      endParagraph();
      const item = /^- ([A-Za-z]+): ?(.*)$/.exec(line);
      section.items.push(item ? { key: item[1], value: item[2], line: n } : { key: null, value: line.slice(2), line: n });
      return;
    }
    paragraph.push(line);
  });
  endParagraph();
  page.intro = introParts.join("\n\n");
  return page;
}

function parseMermaidLine(mermaid, line, n, fail) {
  if (!line || line.startsWith("%%")) return;
  if (!mermaid.type) {
    if (LINE.header.test(line)) mermaid.type = "flowchart";
    else if (LINE.sequenceHeader.test(line)) mermaid.type = "sequence";
    else fail(n, `The mermaid block must start with a flowchart or sequenceDiagram header, not: ${line}`);
    return;
  }
  if (mermaid.type === "sequence") return parseSequenceLine(mermaid, line, n, fail);
  if (line === "end" || LINE.subgraph.test(line)) return;
  let m = LINE.node.exec(line);
  if (m) {
    const bad = m[2].replace(LABEL_TAGS, "").match(/[<>]/);
    if (bad) fail(n, `Box ${m[1]}'s label holds "${bad[0]}": only <br/> and <small>...</small> are allowed.`);
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
    mermaid.edges.push({ from: m[1], to: m[4], both: m[2] === "<-->", label: m[3], step: step ? Number(step[1]) : null, line: n });
    return;
  }
  fail(n, `A mermaid line the format doesn't allow: ${line}`);
}

function parseSequenceLine(mermaid, line, n, fail) {
  const participants = (...ids) => mermaid.participants.push(...ids.filter(Boolean).map((id) => ({ id, line: n })));
  let m;
  if ((m = LINE.participant.exec(line))) participants(m[1]);
  else if ((m = LINE.message.exec(line))) participants(m[1], m[2]);
  else if ((m = LINE.note.exec(line))) participants(m[1], m[2]);
  else if ((m = LINE.activation.exec(line))) participants(m[1]);
  else if (line === "end" || LINE.sequenceBlock.test(line)) return;
  else fail(n, `A sequenceDiagram line the format doesn't allow: ${line}`);
}

/** The item of a section with this key, or undefined. */
export const item = (section, key) => section.items.find((it) => it.key === key);

/** Backtick-quoted repo paths in a list value. */
export const pathsOf = (value) => [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** Markdown links in a list value: [{ label, href }]. */
export const linksOf = (value) => [...value.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ label: m[1], href: m[2] }));

const isUrl = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href);

/** A relative `href` from the page at repo path `from`: { path, fragment }, path null for a URL or one that climbs out of the repo. */
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

/** GitHub-style heading ids, so `page.md#heading` links land. */
export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

export const sourceUrl = (path) => `https://github.com/${REPO}/blob/${BRANCH}/${path}`;

export const MAP_DIR = ".context/system-architecture";

/** The index of the state machine pages. */
export const STATE_MACHINES_INDEX = ".context/state-machines/index.md";

/** The text with the lines inside fenced code blocks blanked, so line numbers stay. */
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

/** The level pages README.md lists under "## The pages": [{ id, title, href }], in order. */
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
