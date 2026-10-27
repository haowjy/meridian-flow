# Model `grep`

Probes for the model's `grep` tool on a target-scale project (150 chapters of 7,000 words
and 300 KB entries of 800 words, 450 documents, 8.2M characters). Each case has what it
must return and the time it is predicted to take
([design](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-definition-design/design/grep-tool.md),
[prediction table](https://github.com/haowjy/meridian-flow-docs/blob/main/work/agent-definition-design/plan/grep-plan.md#predicted-after-content-mode)).
A case that takes more than twice its prediction is explained before merge.

## Setup

1. `MODEL_PROVIDER=mock pnpm dev` (`./mf` scripts the mock model; a stack with a provider key refuses `--mock`).
2. Generate and seed the project, then wait a few seconds for the derivation to fill
   `grep_text` (`select count(*), count(grep_text) from document_markdown_projections` shows equal counts):

   ```bash
   node tools/mf/fixtures/grep-scale.mjs > /tmp/grep-scale.json
   ./mf seed /tmp/grep-scale.json --json | tail -1   # threadId; seeding takes about a minute
   ```
3. `T=<threadId>`. Drive one call per reply, scripting the model's `grep`:

   ```bash
   grep_case() { ./mf thread send "$T" go --mock \
     "[{\"toolCalls\":[{\"name\":\"grep\",\"args\":$1}]},{\"text\":\"done\"}]" --json >/dev/null; }
   grep_case '{"pattern":"Azure Dragon Seal"}'
   ```
4. **Time** is the gap between the `tool_use` and `tool_result` blocks of the call (`./mf log`
   has no tool span). It includes the tool executor's own floor, about 35 ms (an
   instant refusal takes that long):

   ```sql
   select round(extract(epoch from (r.created_at - u.created_at)) * 1000) as ms,
          left(r.content->>'output', 200)
   from turn_blocks u join turn_blocks r
     on r.turn_id = u.turn_id and r.content->>'toolCallId' = u.content->>'toolCallId'
        and r.block_type = 'tool_result'
   where u.block_type = 'tool_use' and u.content->>'toolName' = 'grep'
   order by u.created_at desc limit 1;
   ```

   Run it with `docker exec meridian-dev-postgres-1 psql -U postgres -d "meridian_<checkout>" -tA`.
   Time each case three times.

## Cases

Fixture facts: "Lin Feng" opens every document; "Azure Dragon Seal" is in chapters 7, 19, 31, 43,
55, 67, 79, 91 and 103; "Qi Condensation 3 gave way to Qi Foundation 7" is in every tenth
chapter; `LIVE\_ONLY` (escaped) is in chapter-001 only. Seeding `basic.json` earlier adds
`manuscript://Chapter 1` and `kb://characters/Lin Feng`.

| Case | Args | Expect | Predicted | Measured (ms, 3 runs) |
|---|---|---|---|---|
| Literal, 9 documents | `Azure Dragon Seal` | the nine chapters, one passage each | 300–500 | 312, 328, 287 |
| Literal, `-i` | `azure dragon seal`, `-i` | the same nine | 300–500 | 789, 938, 749 |
| No match | `zzqxv` | `No matches.` | 30–300 | 136, 108, 102 |
| No match, `-i` | `ZZQXV`, `-i` | `No matches.` | 30–300 | 527, 521, 512 |
| Regex | `Qi (Condensation\|Foundation) [0-9]+` | 15 chapters, 2 matches each | 300–500 | 417, 533, 407 |
| Word boundary, everywhere | `\bLin\b` | first 50 files, "50 of at least 451 files" | 1000–1500 | 1160, 1155, 1078 |
| Heading anchor | `^#` | first 50 files, each `# Chapter n` | 1000–1500 | 1139, 1141, 1160 |
| Empty-line count | `^$`, `count` | `No matches.` (every block has text) | none | 430, 423, 422 |
| `\A` (no whole-text prefilter) | `\ALin` | matches at line starts, as `^Lin` | 1000–1500 | 1045, 1074, 1155 |
| `\A`, files only | `\ALin`, `files_with_matches` | files, no reads | 50–300 | 229, 118, 116 |
| Across a line break | `line\sfoo` | `No matches.` | 30–300 | 114, 144, 107 |
| `-i` alternation, everywhere | `lin feng\|su yan\|elder mo`, `-i` | 50 files with 130+ matches each | 1000–1500 | 2212, 2103, 2131 |
| `-i` alternation, count | same, `count` | counts, no reads | 50–300 | 963, 961, 975 |
| Files only, everywhere | `Lin Feng`, `files_with_matches` | 50 URIs and the total | 50–300 | 111, 172, 116 |
| Count, everywhere | `Lin Feng`, `count` | 50 URIs with "(1 match)" | 50–300 | 105, 108, 119 |
| `head_limit` | `Lin Feng`, `head_limit` 5 | 5 files and "5 of at least 451 files" | 200 | 196, 188, 300 |
| Folder | `Lin Feng`, `path` `kb://lore` | `kb://lore/entry-…` only | n/a | 655, 707, 665 |
| Glob, name only | `Lin Feng`, `glob` `*chapter-01*`, `files_with_matches` | `chapter-010` to `chapter-019` | n/a | 70, 69, 70 |
| Glob, address | `Lin Feng`, `path` `kb://`, `glob` `lore/**`, `count`, `head_limit` 2 | `kb://lore/…`, "2 of 100 files" | n/a | 67, 72, 59 |
| One document | `Azure`, `path` `manuscript://book/chapter-007` | that chapter | n/a | 79, 73, 72 |
| Escaped form | `LIVE_ONLY` | chapter-001 (stored `LIVE\_ONLY`) | n/a | 132, 134, 129 |
| Pathological | `(a+)+$`, `count`, `path` `kb://probe/aaa` (10,000 `a`) | one match | under 50 beyond the floor | 60, 54, 55 |

Refusals (`isError`), each in about 35–50 ms: `(?<=a)b` and `[` ("Invalid pattern: error parsing
regexp…"), `(a)\1`, a 513-character pattern ("Invalid arguments for grep: pattern: must be at
most 512 characters") and `path` `skills://` ("grep doesn't cover skills://").

State cases (mock script with a `write` step before the `grep`):

- **Staged text in the same reply.** `write` `insert` into `manuscript://book/chapter-004`
  "ZEBRAFINCH staged sentence.", then `grep` `ZEBRAFINCH`: finds chapter-004. The projection is
  current and has no draft row, so only the reply's staged-write check keeps it off the fast path.
- **Edited seconds ago.** The same text found in the next reply before the derivation ran, and after.
- **Draft-mode Work.** In a chat moved to a Work (`work` `create`, `switch`) with `write_mode`
  `draft`, insert "DRAFTONLYTOKEN" in chapter-006. `grep DRAFTONLYTOKEN` in that chat finds it;
  in a chat with no Work, and with `version: live` in the draft chat, it finds nothing.
- **Narrowed Agent access.** Not run live here: `compose.file-access-tools.db.test.ts` runs the
  tool through the file-access policy. Access is asked for before any document is matched or counted
  (`ContextFS.grep`), so neither the results nor the total can include an unreadable document.

## Measured against predicted

Run on `fc3c8349d` plus the uncommitted grep tool (the commit hash is in the PR), 2026-10-27,
the shared dev machine, Postgres 16 in the local container, `MODEL_PROVIDER=mock`.
Every case is inside twice its prediction. The slowest relative cases:

- `-i` literal, 750–940 ms against 300–500: `re2js` with `-i` costs about 500 ms over 8.2M
  characters even with no match (the `-i` no-match row), and the nine reads add about 250 ms.
- `-i` alternation with content, 2.1 s against 1–1.5 s: the same 500 ms scan, 50 reads of
  about 25 ms, and blocks that each hold 130 matches to count and window.
- `\bLin\b`, `^#` and `\ALin` (content, everywhere) cost the same, 1.1 s: they are 50 reads. `\A`
  loses only the whole-text prefilter, which matters when most documents have no match
  (`\ALin` with `files_with_matches` 120 ms against 120–140 ms for `\bLin\b`).
- "of at least N files": documents with an active draft row (here chapter-006) or a stale
  derivation take the slow path, and past the limit they are not read to be counted.
