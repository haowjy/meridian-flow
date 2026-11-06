# Model `grep`

Check the model's `grep` tool on a project with manuscript, knowledge-base and
Scratch documents. Use an owned `MODEL_PROVIDER=mock pnpm dev` stack and drive
one tool call per reply with `./mf thread send`.

## Setup

Seed a project with enough documents to exercise paths and limits. A fixture can
be generated with `node tools/mf/fixtures/grep-scale.mjs > /tmp/grep-scale.json`
and loaded with `./mf seed /tmp/grep-scale.json --json`. Add a long no-space
document and a sentence-heavy document for the slow-pattern cases.

```bash
grep_case() { ./mf thread send "$T" go --mock \
  "[{\"toolCalls\":[{\"name\":\"grep\",\"args\":$1}]},{\"text\":\"done\"}]" --json; }
grep_case '{"pattern":"Azure Dragon Seal"}'
```

Inspect the tool result and the expanded transcript fold. A result must name
the matching document and passage, or say `No matches.`; a lower-bound result
must say `N of at least M files`.

Run the output and scope cases as separate replies, saving each result:

```bash
grep_case '{"pattern":"Azure Dragon Seal","output":"count"}'
grep_case '{"pattern":"Azure Dragon Seal","output":"files_with_matches"}'
grep_case '{"pattern":"Azure Dragon Seal","head_limit":2}'
grep_case '{"pattern":"Azure Dragon Seal","path":"manuscript://Act 1"}'
grep_case '{"pattern":"Azure Dragon Seal","path":"manuscript://Act 1/Chapter 1.md"}'
grep_case '{"pattern":"Azure.*Seal","glob":"**/*.md"}'
grep_case '{"pattern":"Azure Dragon Seal","path":"manuscript://Act 1","glob":"**/Chapter*.md"}'
```

## Cases

Run these semantic cases and compare the result with the fixture:

- Literal, case-insensitive, regex, word-boundary and heading patterns.
- `count`, `files_with_matches` and `head_limit` output modes. Count mode must
  not include passages; files-only mode must not read document text into the
  result; `head_limit` must report the lower bound when the scan stops early.
- `path` for a folder and one document, `glob` for names and addresses, and a
  combined `path`/`glob` query. Only documents in scope may appear.
- A pattern that crosses a line break, an escaped stored token, a sentence-long
  pattern, a pathological regex and a slow pattern. The slow pattern must stop
  at the 20-second budget without blocking health checks or another ordinary
  search.

Refusals must return tool errors rather than partial matches: lookbehind,
backreferences, an invalid pattern, a pattern over 512 characters, and
`path: "skills://"`. RE2 repeat limits still apply.

## State and access

Script a `write` before `grep` in the same reply. Newly staged text is found.
In a draft-mode Work, a draft-only token is found by the Work chat and omitted
by a No Work chat or a `version: "live"` read. A later reply sees the same draft
after derivation.

Restrict Agent document access and run the same query. Access is checked before
matching or counting; unreadable documents do not affect results or totals.

For staged visibility, script a write and grep in one model reply, then repeat
from a draft-mode Work and a No Work chat:

```bash
./mf thread send "$T" 'Stage then search' --mock '[{"toolCalls":[{"name":"write","args":{"command":"create","path":"manuscript://grep-staged.md","content":"GREPPABLE_STAGED_TOKEN"}},{"name":"grep","args":{"pattern":"GREPPABLE_STAGED_TOKEN"}}]},{"text":"done"}]' --json
grep_case '{"pattern":"GREPPABLE_STAGED_TOKEN","version":"live"}'
```

The Work chat finds a draft-only token, a No Work chat and a live-version query
omit it, and a later reply sees it after derivation. For refusals, run one call
per reply and expect a tool error without partial matches:

```bash
grep_case '{"pattern":"(?<=Azure) Seal"}'
grep_case '{"pattern":"Azure\\1"}'
grep_case '{"pattern":"["}'
grep_case "{\"pattern\":\"$(python3 -c 'print("x" * 513)')\"}"
grep_case '{"pattern":"Azure","path":"skills://"}'
```

The tool result is the gate. Do not use wall-clock measurements as pass criteria;
the only timing requirement here is the 20-second search budget.
