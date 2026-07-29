/** Core document-language instruction baked into every model system prompt. */

const htmlTableEscalations = [
  {
    reason: "`rowspan` or `colspan`",
    wire: [
      "<table>",
      "  <thead>",
      "    <tr>",
      '      <th colspan="2">Name</th>',
      '      <th rowspan="2" align="right">Rank</th>',
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      "      <td>Iron</td>",
      "      <td>Body</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n"),
  },
  {
    reason: "literal multi-line cell text",
    wire: [
      "<table>",
      "  <thead>",
      "    <tr>",
      "      <th>Note</th>",
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      "      <td>line one&#10;line two</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n"),
  },
  {
    reason: "no header row",
    wire: [
      "<table>",
      "  <tbody>",
      "    <tr>",
      "      <td>Skill<br />Type</td>",
      "      <td>Rank</td>",
      "    </tr>",
      "    <tr>",
      "      <td>Iron Body</td>",
      "      <td>7</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n"),
  },
  {
    reason: "mixed header and body cells in one row",
    wire: [
      "<table>",
      "  <tbody>",
      "    <tr>",
      "      <th>Skill</th>",
      "      <td>Iron Body</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n"),
  },
  {
    reason: "ragged rows",
    wire: [
      "<table>",
      "  <thead>",
      "    <tr>",
      "      <th>Skill</th>",
      "      <th>Rank</th>",
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      "      <td>Iron Body</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n"),
  },
  {
    reason: "per-cell alignment that is not one column alignment",
    wire: [
      "<table>",
      "  <thead>",
      "    <tr>",
      '      <th align="left">Value</th>',
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      '      <td align="right">7</td>',
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n"),
  },
] as const;

const layoutSpellings = [
  {
    form: '`<Layout align="center">`',
    wire: '<Layout align="center">\n  The sword remembers.\n</Layout>',
  },
  {
    form: '`<Layout align="right">`',
    wire: '<Layout align="right">\n  ## Dateline\n</Layout>',
  },
  {
    form: '`widths="120,,80"`',
    wire: [
      '<Layout widths="120,,80">',
      "  | Stat | Detail | Value |",
      "  | ---- | ------ | ----: |",
      "  | STR  | Power  |    15 |",
      "</Layout>",
    ].join("\n"),
  },
] as const;

export const DOCUMENT_DIALECT_CONTRACT = {
  gfm: {
    wire: [
      "# Chapter",
      "",
      "Plain **bold**, *italic*, ~~struck~~, and `code` text with [an external link](https://example.com).",
      "",
      "> A quote.",
      "",
      "- one",
      "- two",
      "",
      "---",
    ].join("\n"),
  },
  wikilink: {
    wire: "[[Chapter 213]]",
    labeledLiteral: "[[Chapter 213|Arrival]]",
  },
  codeFences: [
    {
      language: "typescript",
      wire: "```typescript\nconst rank = 7;\n```",
    },
    {
      language: "mermaid",
      wire: "```mermaid\ngraph TD\n  Trial --> Ascension\n```",
    },
  ],
  pipeTable: {
    wire: "| Skill     | Rank |\n| :-------- | ---: |\n| Iron Body |    7 |",
    hardBreakWire: "| Detail    |\n| --------- |\n| one\\\ntwo |",
  },
  htmlTableEscalations,
  layouts: layoutSpellings,
  image: {
    assetId: "realm-map",
    path: "assets/realm-map.png",
    wire: "![Realm map](assets/realm-map.png)",
  },
} as const;

export const DOCUMENT_DIALECT_ROUND_TRIP_SPELLINGS = [
  { id: "gfm", wire: DOCUMENT_DIALECT_CONTRACT.gfm.wire },
  { id: "wikilink", wire: DOCUMENT_DIALECT_CONTRACT.wikilink.wire },
  ...DOCUMENT_DIALECT_CONTRACT.codeFences.map((spelling) => ({
    id: `fence-${spelling.language}`,
    wire: spelling.wire,
  })),
  { id: "table-pipes", wire: DOCUMENT_DIALECT_CONTRACT.pipeTable.wire },
  {
    id: "table-pipe-hard-break",
    wire: DOCUMENT_DIALECT_CONTRACT.pipeTable.hardBreakWire,
  },
  ...DOCUMENT_DIALECT_CONTRACT.htmlTableEscalations.map((spelling, index) => ({
    id: `table-html-${index + 1}`,
    wire: spelling.wire,
  })),
  ...DOCUMENT_DIALECT_CONTRACT.layouts.map((spelling, index) => ({
    id: `layout-${index + 1}`,
    wire: spelling.wire,
  })),
  { id: "image-asset-path", wire: DOCUMENT_DIALECT_CONTRACT.image.wire },
] as const;

const htmlEscalationReasons = DOCUMENT_DIALECT_CONTRACT.htmlTableEscalations
  .map(({ reason }) => reason)
  .join(", ");
const alignmentForms = DOCUMENT_DIALECT_CONTRACT.layouts
  .slice(0, 2)
  .map(({ form }) => form)
  .join(" or ");
const widthsForm = DOCUMENT_DIALECT_CONTRACT.layouts[2].form;

export const DOCUMENT_DIALECT_CORE_INSTRUCTION = [
  "# Meridian document language",
  "",
  "Write manuscript documents as GFM Markdown. Prefer prose and ordinary GFM forms.",
  "",
  "Meridian adds these wire rules:",
  `- Link to another document as \`${DOCUMENT_DIALECT_CONTRACT.wikilink.wire}\`. The target is the label; \`${DOCUMENT_DIALECT_CONTRACT.wikilink.labeledLiteral}\` is literal text, not a link.`,
  `- Put block code in backtick fences with the language after the opening fence, such as \`${DOCUMENT_DIALECT_CONTRACT.codeFences[0].language}\`. A \`${DOCUMENT_DIALECT_CONTRACT.codeFences[1].language}\` language fence renders as a diagram.`,
  "- Keep a table in GFM pipes when it has one header row, rectangular rows, unit cells, consistent per-column alignment, and no literal newline in a cell. Within a pipe cell, spell an intentional hard break as a backslash immediately followed by a newline.",
  `- Use raw HTML \`<table>\` when a table needs ${htmlEscalationReasons}. In HTML cells, use \`&#10;\` for a literal newline and \`<br />\` for a hard break.`,
  `- Wrap exactly one paragraph, heading, or table in ${alignmentForms}, closed by \`</Layout>\`, for block alignment. On a table only, add ${widthsForm} to the opening \`Layout\`; widths are positive pixels, and an empty slot leaves that column automatic.`,
  `- Images use ordinary Markdown image syntax and an existing project-relative asset path, as in \`${DOCUMENT_DIALECT_CONTRACT.image.wire}\`. Do not emit internal \`asset:\` identifiers or signed URLs.`,
  "",
  "Specialized table, diagram, and link references are a deeper tier. When the harness offers one, load it before uncommon formatting; this core card remains authoritative for wire spelling.",
].join("\n");
