/** Core document-language instruction baked into every model system prompt. */

const dialectSyntax = {
  fence: "```",
  pipeHardBreak: {
    wire: "\\\n",
    instruction: "a backslash immediately followed by a newline",
  },
  htmlTable: {
    open: "<table>",
    close: "</table>",
  },
  htmlLiteralNewline: "&#10;",
  htmlHardBreak: "<br />",
  layoutClose: "</Layout>",
  internalAssetPrefix: "asset:",
} as const;

const htmlTableEscalations = [
  {
    reason: "`rowspan` or `colspan`",
    wire: [
      dialectSyntax.htmlTable.open,
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
      dialectSyntax.htmlTable.close,
    ].join("\n"),
  },
  {
    reason: "literal multi-line cell text",
    wire: [
      dialectSyntax.htmlTable.open,
      "  <thead>",
      "    <tr>",
      "      <th>Note</th>",
      "    </tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr>",
      `      <td>line one${dialectSyntax.htmlLiteralNewline}line two</td>`,
      "    </tr>",
      "  </tbody>",
      dialectSyntax.htmlTable.close,
    ].join("\n"),
  },
  {
    reason: "no header row",
    wire: [
      dialectSyntax.htmlTable.open,
      "  <tbody>",
      "    <tr>",
      `      <td>Skill${dialectSyntax.htmlHardBreak}Type</td>`,
      "      <td>Rank</td>",
      "    </tr>",
      "    <tr>",
      "      <td>Iron Body</td>",
      "      <td>7</td>",
      "    </tr>",
      "  </tbody>",
      dialectSyntax.htmlTable.close,
    ].join("\n"),
  },
  {
    reason: "mixed header and body cells in one row",
    wire: [
      dialectSyntax.htmlTable.open,
      "  <tbody>",
      "    <tr>",
      "      <th>Skill</th>",
      "      <td>Iron Body</td>",
      "    </tr>",
      "  </tbody>",
      dialectSyntax.htmlTable.close,
    ].join("\n"),
  },
  {
    reason: "ragged rows",
    wire: [
      dialectSyntax.htmlTable.open,
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
      dialectSyntax.htmlTable.close,
    ].join("\n"),
  },
  {
    reason: "per-cell alignment that is not one column alignment",
    wire: [
      dialectSyntax.htmlTable.open,
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
      dialectSyntax.htmlTable.close,
    ].join("\n"),
  },
] as const;

const layoutSpellings = [
  {
    form: '`<Layout align="center">`',
    wire: `<Layout align="center">\n  The sword remembers.\n${dialectSyntax.layoutClose}`,
  },
  {
    form: '`<Layout align="right">`',
    wire: `<Layout align="right">\n  ## Dateline\n${dialectSyntax.layoutClose}`,
  },
  {
    form: '`widths="120,,80"`',
    wire: [
      '<Layout widths="120,,80">',
      "  | Stat | Detail | Value |",
      "  | ---- | ------ | ----: |",
      "  | STR  | Power  |    15 |",
      dialectSyntax.layoutClose,
    ].join("\n"),
  },
] as const;

export const DOCUMENT_DIALECT_CONTRACT = {
  syntax: dialectSyntax,
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
      opening: `${dialectSyntax.fence}typescript`,
      wire: `${dialectSyntax.fence}typescript\nconst rank = 7;\n${dialectSyntax.fence}`,
    },
    {
      language: "mermaid",
      opening: `${dialectSyntax.fence}mermaid`,
      wire: `${dialectSyntax.fence}mermaid\ngraph TD\n  Trial --> Ascension\n${dialectSyntax.fence}`,
    },
  ],
  pipeTable: {
    wire: "| Skill     | Rank |\n| :-------- | ---: |\n| Iron Body |    7 |",
    hardBreakWire: `| Detail    |\n| --------- |\n| one${dialectSyntax.pipeHardBreak.wire}two |`,
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
  `- Put block code in a language-tagged fence such as \`\`\`\` ${DOCUMENT_DIALECT_CONTRACT.codeFences[0].opening} \`\`\`\`. Use \`\`\`\` ${DOCUMENT_DIALECT_CONTRACT.codeFences[1].opening} \`\`\`\` for a diagram.`,
  `- Keep a table in GFM pipes when it has one header row, rectangular rows, unit cells, consistent per-column alignment, and no literal newline in a cell. Within a pipe cell, spell an intentional hard break as ${DOCUMENT_DIALECT_CONTRACT.syntax.pipeHardBreak.instruction}.`,
  `- Use raw HTML \`${DOCUMENT_DIALECT_CONTRACT.syntax.htmlTable.open}\` when a table needs ${htmlEscalationReasons}. In HTML cells, use \`${DOCUMENT_DIALECT_CONTRACT.syntax.htmlLiteralNewline}\` for a literal newline and \`${DOCUMENT_DIALECT_CONTRACT.syntax.htmlHardBreak}\` for a hard break.`,
  `- Wrap exactly one paragraph, heading, or table in ${alignmentForms}, closed by \`${DOCUMENT_DIALECT_CONTRACT.syntax.layoutClose}\`, for block alignment. On a table only, add ${widthsForm} to the opening \`Layout\`; widths are positive pixels, and an empty slot leaves that column automatic.`,
  `- Images use ordinary Markdown image syntax and an existing project-relative asset path, as in \`${DOCUMENT_DIALECT_CONTRACT.image.wire}\`. Do not emit internal \`${DOCUMENT_DIALECT_CONTRACT.syntax.internalAssetPrefix}\` identifiers or signed URLs.`,
  "",
  "Specialized table, diagram, and link references are a deeper tier. When the harness offers one, load it before uncommon formatting; this core card remains authoritative for wire spelling.",
].join("\n");
