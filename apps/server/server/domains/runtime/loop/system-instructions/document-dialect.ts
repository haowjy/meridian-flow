/** Core document-language instruction baked into every model system prompt. */

const dialectSyntax = {
  fence: "```",
  htmlTable: {
    open: "<table>",
    close: "</table>",
  },
  htmlLiteralNewline: "&#10;",
  htmlHardBreak: "<br />",
  layoutClose: "</Layout>",
  internalAssetPrefix: "asset:",
} as const;

const tableSpelling = {
  ingressNote: "GFM pipe tables are understood on input but never echoed.",
  wire: [
    "<table>",
    "  <thead>",
    "    <tr>",
    "      <th>",
    "        <p>Skill</p>",
    "      </th>",
    "      <th>",
    "        <p>Details</p>",
    "      </th>",
    "    </tr>",
    "  </thead>",
    "  <tbody>",
    "    <tr>",
    "      <td>",
    "        <p>Iron Body</p>",
    "      </td>",
    "      <td>",
    '        <ul data-tight="false">',
    "          <li>",
    "            <p>Rank 7</p>",
    "          </li>",
    "        </ul>",
    "      </td>",
    "    </tr>",
    "  </tbody>",
    "</table>",
  ].join("\n"),
} as const;

function layoutSpelling(opening: string, body: string) {
  return {
    opening,
    wire: [opening, body, dialectSyntax.layoutClose].join("\n"),
  };
}

const layoutSpellings = [
  layoutSpelling('<Layout align="center">', "  The sword remembers."),
  layoutSpelling('<Layout align="right">', "  ## Dateline"),
  layoutSpelling(
    '<Layout widths="120,,80">',
    [
      "  <table>",
      "    <thead>",
      "      <tr>",
      "        <th>",
      "          <p>Stat</p>",
      "        </th>",
      "        <th>",
      "          <p>Detail</p>",
      "        </th>",
      "        <th>",
      "          <p>Value</p>",
      "        </th>",
      "      </tr>",
      "    </thead>",
      "    <tbody>",
      "      <tr>",
      "        <td>",
      "          <p>STR</p>",
      "        </td>",
      "        <td>",
      "          <p>Power</p>",
      "        </td>",
      "        <td>",
      "          <p>15</p>",
      "        </td>",
      "      </tr>",
      "    </tbody>",
      "  </table>",
    ].join("\n"),
  ),
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
  table: tableSpelling,
  layouts: layoutSpellings,
  image: {
    assetId: "realm-map",
    path: "assets/realm-map.png",
    wire: "![Realm map](assets/realm-map.png)",
    /** The one reason a picture leaves Markdown syntax: a display width. */
    sizedWire: '<img src="assets/realm-map.png" alt="Realm map" width="240" />',
  },
} as const;

export const DOCUMENT_DIALECT_ROUND_TRIP_SPELLINGS = [
  { id: "gfm", wire: DOCUMENT_DIALECT_CONTRACT.gfm.wire },
  { id: "wikilink", wire: DOCUMENT_DIALECT_CONTRACT.wikilink.wire },
  ...DOCUMENT_DIALECT_CONTRACT.codeFences.map((spelling) => ({
    id: `fence-${spelling.language}`,
    wire: spelling.wire,
  })),
  { id: "table-html", wire: DOCUMENT_DIALECT_CONTRACT.table.wire },
  ...DOCUMENT_DIALECT_CONTRACT.layouts.map((spelling, index) => ({
    id: `layout-${index + 1}`,
    wire: spelling.wire,
  })),
  { id: "image-asset-path", wire: DOCUMENT_DIALECT_CONTRACT.image.wire },
  { id: "image-sized", wire: DOCUMENT_DIALECT_CONTRACT.image.sizedWire },
] as const;

const alignmentForms = DOCUMENT_DIALECT_CONTRACT.layouts
  .slice(0, 2)
  .map(({ opening }) => `\`${opening}\``)
  .join(" or ");
const widthsOpening = DOCUMENT_DIALECT_CONTRACT.layouts[2].opening;
const widthsForm = `\`${widthsOpening.slice("<Layout ".length, -1)}\``;

export const DOCUMENT_DIALECT_CORE_INSTRUCTION = [
  "# Meridian document language",
  "",
  "Write manuscript documents as GFM Markdown. Prefer prose and ordinary GFM forms.",
  "",
  "Meridian adds these wire rules:",
  `- Link to another document as \`${DOCUMENT_DIALECT_CONTRACT.wikilink.wire}\`. The target is the label; \`${DOCUMENT_DIALECT_CONTRACT.wikilink.labeledLiteral}\` is literal text, not a link.`,
  `- Put block code in a language-tagged fence such as \`\`\`\` ${DOCUMENT_DIALECT_CONTRACT.codeFences[0].opening} \`\`\`\`. Use \`\`\`\` ${DOCUMENT_DIALECT_CONTRACT.codeFences[1].opening} \`\`\`\` for a diagram.`,
  `- Write every table as raw HTML \`${DOCUMENT_DIALECT_CONTRACT.syntax.htmlTable.open}\`. Put block children inside each \`<td>\` or \`<th>\`: \`<p>\`, \`<h1>\` through \`<h6>\`, \`<ul>\`, \`<ol>\`, \`<blockquote>\`, \`<pre><code class="language-...">\`, \`<hr />\`, or a nested \`<table>\`. Use \`${DOCUMENT_DIALECT_CONTRACT.syntax.htmlLiteralNewline}\` for a literal newline and \`${DOCUMENT_DIALECT_CONTRACT.syntax.htmlHardBreak}\` for a hard break. ${DOCUMENT_DIALECT_CONTRACT.table.ingressNote}`,
  `- Use this table form:\n\n\`\`\`html\n${DOCUMENT_DIALECT_CONTRACT.table.wire}\n\`\`\``,
  `- Wrap exactly one paragraph, heading, or table in ${alignmentForms}, closed by \`${DOCUMENT_DIALECT_CONTRACT.syntax.layoutClose}\`, for block alignment. On a table only, add ${widthsForm} to the opening \`Layout\`; widths are positive pixels, and an empty slot leaves that column automatic.`,
  `- Images use ordinary Markdown image syntax and an existing project-relative asset path, as in \`${DOCUMENT_DIALECT_CONTRACT.image.wire}\`. Do not emit internal \`${DOCUMENT_DIALECT_CONTRACT.syntax.internalAssetPrefix}\` identifiers or signed URLs.`,
  `- A picture is shown at its own size unless it carries a display width. To give it one, use raw HTML \`${DOCUMENT_DIALECT_CONTRACT.image.sizedWire}\`, where the width is whole pixels. Keep Markdown image syntax for every picture that has no width.`,
  "",
  "Specialized diagram and link references are a deeper tier. When the harness offers one, load it before uncommon formatting; this core card remains authoritative for wire spelling.",
].join("\n");
