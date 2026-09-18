# Meridian Flow Agent design guide

A requirements-first static guide for root Agent v1. It shows the answer in the
first viewport and keeps design and implementation detail behind routes,
tables, diagrams, and native disclosures.

## Serve

```bash
cd docs/pr-evidence/agent-ux-target/guide
python3 -m http.server 41873
```

Open `http://localhost:41873/`. The site also works from `file://` for normal
pages and copied imagery. Source links point to the authoritative sibling
Markdown files in this PR package.

There is no build step and no external asset or network dependency.

## Route map

| Route | What it answers |
|---|---|
| `index.html` | Minimal root system and why normal chat stays quiet. |
| `requirements.html` | Vocabulary, functional and non-functional requirements, gates, non-requirements. |
| `architecture.html` | Ownership diagram, interfaces, patterns, libraries, rejected alternatives. |
| `experience.html` | Surface ownership, existing and new behavior, rebuilt desktop and mobile UX mockups. |
| `data.html` | Three readable record relationships, existing authorities, child extension. |
| `plan.html` | Walking skeleton through policy, management, cutover, children, and later distribution. |
| `cuts.html` | Prominent target removal inventory. |
| `evidence.html` | Provenance labels, authority order, local source links, verification notes. |

## Capture list

Guide captures are stored in `captures/` from final browser verification:

- `overview-1440x1000.png`
- `overview-390x844.png`
- `experience-1440x1000.png`
- `experience-390x844.png`

The experience gallery contains only the final rebuilt product captures:

- `new-chat`, `agent-picker`, `agents`, `agent-editor`, `import-review`, and
  `existing-chat`, each at `1440x1000` and `390x844`.

It deliberately excludes `candidate-screenshots`, prior target assets, and the
old generic-receipt proposal treatment. The copied Agents images show Edit plus
quiet More overflow for Export/Delete. The copied editor images omit persistent
version-impact copy.

## Source map

Authority order is fixed by the request:

1. [`agent-system-requirements.md`](../agent-system-requirements.md)
2. [`agent-system-design.md`](../agent-system-design.md)
3. [`agent-system-data-model.md`](../agent-system-data-model.md)
4. [`agent-ux-spec.md`](../agent-ux-spec.md)
5. [`agent-system-implementation-plan.md`](../agent-system-implementation-plan.md)

The guide links to the sibling authoritative documents rather than duplicating
them inside the static site.

## Verification notes

- Verified with `agent-browser` against this final directory at `1440x1000`
  and `390x844`: overview and experience rendered without page-level horizontal
  overflow; gallery mobile switching worked; browser console had no page errors.
- The original work artifact passed a local-reference check for all 28 internal
  HTML, image, source, CSS, and JavaScript references. This packaged copy keeps
  the same site and uses sibling links for the five authoritative documents.
- The responsive table wrapper may scroll its table locally on a narrow screen;
  the page itself does not horizontally overflow.
- Native `<details>` and gallery buttons are keyboard-operable. A skip link and
  visible focus rings support keyboard navigation. Reduced-motion users get no
  smooth scrolling.
