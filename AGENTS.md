# AGENTS Guidance

Mermaid Quick Rules (Minimal)

- Quote labels with spaces, parentheses, punctuation, or HTML.
  - Nodes: `Node["Label"]`, Edges: `A -->|"edge"| B`, Subgraphs: `subgraph "Title (X)"` … `end`.
- Put `<br/>` only inside quoted labels.
- Use ASCII operators in labels (`>=`, `<=`) instead of unicode.
- Don’t change diagram types or structure; fix parse errors by adding quotes, not refactors.
- Leave `class` directives as‑authored; move prose into labels only if asked.
- If asked to revert, restore the exact previous lines.
- Before saving: quick scan for unbalanced quotes.
