# Connected conversation tools

These model-facing tools are sequential, read-only, and advertised at the next
prompt bake. Existing bakes keep their frozen tools. They accept project-local
`cN` and `pN` refs, never internal IDs. Omitted `ref` means the caller.

All three readers use the same authorization: a live target in the caller's
project, owned by the same writer, with the same lineage root. Spawn, fork and
handoff edges connect a lineage. A trashed target is not readable directly;
a fork still reads the inherited prefix of a trashed source.

## `thread_ls`

Input: `{ ref?, depth?: 1 | 2 | 3, cursor? }`. Default depth is 1.

The text result includes the path to the root (up to 16 hops), current thread,
and up to 50 descendant nodes. Trashed path hops are labelled; trashed nodes
are omitted. Spawn edges use the parent. Fork and handoff edges use the cutoff
turn's owner, including inherited cutoffs. Nodes are selected newest first per
level and displayed beneath their parent. Status is `awake` or `asleep` from
the run lease; subagents also show their saved spawn outcome.

An own-child overflow supplies a cursor for the same ref. Deeper overflows
name the parent and remaining count. Cursors preserve PostgreSQL microsecond
precision and are bound to their target ref.

## `thread_history`

Input:

```ts
{
  ref?: string;
  order?: "newest_first" | "oldest_first"; // default newest_first
  cursor?: string;
  limit?: number; // default 40 visible items, max 200
  include?: ("thinking" | "tool_args" | "tool_results" |
             "system_messages" | "system_prompt")[];
  expand?: string; // position.sequence; position alone reads the turn header/error
}
```

Pages are chronological in either traversal direction and stop at prompt epoch
boundaries. Every page names the Agent, bake, segment and opening event. The
composed prompt is opt-in, once when a cursor opens a segment. Inherited items
name their source. The first newest-first page may show an in-progress preview;
that preview is outside the stable settled-prefix cursor chain.

Defaults show writer and agent requests, assistant prose, and one-line tool
markers. Thinking, results and system messages are opt-in. `tool_args` and
`expand` expose dated edit records, not current documents. A complete or
refused undo, failed compaction, and handoff seed remain classified system
items; only a complete turn with a bake opens a new segment.

Document copies never render: read and diff results, search excerpts, reference
reads and write echoes become pointers. This also applies to `expand`.
`isError` results remain verbatim. Nested history results are omitted. Missing
call/registration evidence produces a result stub instead of an unknown copy.

The caller's model tokenizer determines size estimates, including CJK rates.
List items are capped at 2,000 estimated tokens, pages at 8,000, and expansions
at 16,000. Truncated items give an expansion handle. A page scans at most 2,000
raw items; hidden-only stretches return a progress cursor rather than holding
an unbounded snapshot. Opt-in prompts reserve at most 4,000 tokens of the page.

Result metadata always records `documentRevisions`: an explicit empty list
without quoted edits, or null revision evidence for quoted edits. Null evidence
is already stale and is not sent for current-revision lookup. Thus compaction
clears quoted edits but preserves a history result that contains no edits.

## `thread_report`

Input: `{ ref: string, run?: number }`. The ref must resolve to a subagent;
run numbers are positive and count finished reports. Scope matches the other
readers. Missing finished reports remain `unavailable` rather than waiting.

## Errors

Domain readers return `{ ok: false, error: MeridianError }`. Tool registrations
project these into canonical error results (`isError: true` with the structured
`MeridianError` as output). Codes include
`thread_not_found`, `thread_not_connected`, `invalid_cursor`, `item_not_found`,
and `invalid_run` (report only). The report HTTP route maps authorization
failures to HTTP 404/403 instead of returning a successful report response.

The writer's [transcript route][transcript] remains raw and unchanged by these
model-only projections.

[transcript]: thread-transcript.md

## `spawn` context: `from`

`spawn({ prompt, from?: "current" | string, ... })` accepts one prior-conversation
ref. `current` resolves to the caller. The same live owner/project/lineage check
runs before creating the child. Invalid, trashed and disconnected targets return
structured tool errors without a child, run or debit. Error codes are
`invalid_from` for a non-string value, `thread_not_found` for a malformed,
missing or trashed ref, and `thread_not_connected` for another lineage.

The child's first user turn holds the task prompt followed by a
`thread-reference` custom block. Its source ref, title, Agent, last activity and
read instructions are frozen at spawn. No source history is copied; the child
can call `thread_history` and `thread_ls` on the reference. Retitling the source
does not change the child's request prefix. `agent.spawn.fromThreadId` is only
a live UI hint; the block is the durable record.

`./mf thread view` shows the reference and its frozen fields (`--json`);
`./mf thread context --all` shows the actual model input. Spawn events in
`./mf thread send --json` / `events --json` carry `fromThreadId`.
New handoff briefs use the same read instruction when the bake in effect at S
advertises history. Only when S has no bake does tool registration decide. Earlier
briefs retain their frozen text.
