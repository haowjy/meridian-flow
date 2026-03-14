---
detail: standard
audience: developer, designer
---
# Proposal Review Flow

Writer has a chapter open in manual mode. AI proposes edits. Writer reviews inline hunks and acts on each independently.

## Setup

Canonical document:

```
The morning light filtered through the curtains. Sarah reached for her
phone, checking the time. It was already past nine.

She stumbled into the kitchen, still half asleep. The coffee maker sat
on the counter, unplugged as usual.

"Great," she muttered. "Just great."
```

Writer prompt: "Make this more vivid and tighten the pacing."

## AI Proposals Arrive

AI sends 4 `edit_document` calls. Each creates one proposal with a `yjs_update`:

```
P1: "The morning light filtered through the curtains"
  -> "Pale morning light sliced through the gap in the curtains"

P2: "checking the time. It was already past nine."
  -> "checking the time. 9:14. Shit."

P3: "still half asleep. The coffee maker sat on the counter, unplugged as usual."
  -> "still half asleep. The coffee maker sat on the counter, unplugged. Of course."

P4: ""Great," she muttered. "Just great.""
  -> "She stared at the outlet. Didn't move."
```

## Pipeline Produces 4 Hunks

No overlapping ranges, no shared proposals -- each proposal is an independent hunk.

```
Projection pipeline:
  P1 solo diff → chars 0-50      (paragraph 1 opening)
  P2 solo diff → chars 78-122    (paragraph 1 ending)
  P3 solo diff → chars 125-200   (paragraph 2)
  P4 solo diff → chars 203-237   (paragraph 3)

  No overlaps → 4 independent hunks
```

## What the Writer Sees

Each hunk renders inline with deletion highlights (strikethrough/red) and insertion highlights (green). Action buttons appear at the hunk boundary.

```
+--------------------------------------------------------------------+
|                                                                      |
|  [-The morning light filtered through the curtains-]                 |
|  [+Pale morning light sliced through the gap in the curtains+]      |
|                                                 [Accept] [Reject]    |
|                                                                      |
|  . Sarah reached for her phone,                                      |
|                                                                      |
|  [-checking the time. It was already past nine.-]                    |
|  [+checking the time. 9:14. Shit.+]                                 |
|                                                 [Accept] [Reject]    |
|                                                                      |
|  She stumbled into the kitchen,                                      |
|                                                                      |
|  [-still half asleep. The coffee maker sat on the counter,           |
|   unplugged as usual.-]                                              |
|  [+still half asleep. The coffee maker sat on the counter,           |
|   unplugged. Of course.+]                                            |
|                                                 [Accept] [Reject]    |
|                                                                      |
|  [-"Great," she muttered. "Just great."-]                            |
|  [+She stared at the outlet. Didn't move.+]                         |
|                                                 [Accept] [Reject]    |
|                                                                      |
+--------------------------------------------------------------------+
```

The writer reads through the changes top-to-bottom, acting on each one.

## Writer Acts

| Hunk | Action | Why |
|------|--------|-----|
| P1 | Accept | Opening is stronger |
| P2 | Reject | Too blunt for this character's voice |
| P3 | Accept | Subtle improvement |
| P4 | Accept | Action over dialogue works better here |

Each action is an immediate Yjs transaction. No "submit review" step.

## Result

```
Pale morning light sliced through the gap in the curtains. Sarah
reached for her phone, checking the time. It was already past nine.

She stumbled into the kitchen, still half asleep. The coffee maker sat
on the counter, unplugged. Of course.

She stared at the outlet. Didn't move.
```

## Thread UI After Review

```
AI: edit_document("Vivid opening")           [Accepted]  [Undo]
AI: edit_document("Tighten time check")       [Rejected]  [Reapply]
AI: edit_document("Sharpen coffee detail")    [Accepted]  [Undo]
AI: edit_document("Action over dialogue")     [Accepted]  [Undo]
```

## Ctrl-Z Behavior

Writer immediately regrets rejecting P2. Presses Ctrl-Z:

```
Undo stack (most recent first):
  [4] Accept P4     (ORIGIN_ACCEPT)
  [3] Accept P3     (ORIGIN_ACCEPT)
  [2] Reject P2     (ORIGIN_REJECT)   <-- this gets undone
  [1] Accept P1     (ORIGIN_ACCEPT)

1st Ctrl-Z → undoes Accept P4 (P4 reappears as pending hunk)
2nd Ctrl-Z → undoes Accept P3 (P3 reappears as pending hunk)
3rd Ctrl-Z → undoes Reject P2 (P2 reappears as pending hunk)
```

Writer has to undo through the stack. If they only want to un-reject P2, they can use **Thread Reapply** instead (see [Thread Undo](thread-undo.md)).

## Edge Case: Overlapping Proposals

Same scenario, but AI also sends P5 that touches the same region as P1:

```
P1: "The morning light" -> "Pale morning light"
P5: "The morning light filtered" -> "The morning light streamed"
```

Both touch "The morning light" -- overlapping ranges. Pipeline merges them:

```
+--------------------------------------------------------------------+
|  [-The morning light filtered through the curtains-]                 |
|  [+Pale morning light streamed through the curtains+]               |
|                                                 [Accept] [Reject]    |
+--------------------------------------------------------------------+

  This is ONE grouped hunk carrying [P1, P5].
  Accept applies both yjs_updates. Reject rejects both.
  Writer cannot pick P1 without P5.
```

## Edge Case: Stale Proposal

Writer types "black cat" manually while AI proposal P6 also inserts "black ":

```
P6: "The cat" -> "The black cat"
Writer types the same edit directly.

Projection pipeline:
  Clone canonical (already has "black cat")
  Apply P6 yjs_update → no change (Yjs deduplicates)
  Diff → empty

P6 is auto-marked "stale". No hunk rendered.
Thread UI: "No longer relevant"
```

## Edge Case: Multi-Paragraph Proposal

AI rewrites two paragraphs in one `edit_document` call:

```
P7: replaces paragraphs 1 and 2 entirely

Raw hunks span both paragraphs, but both carry [P7].
Proposal atomicity → one grouped hunk.
Writer accepts or rejects the whole rewrite.
```

If the writer wants paragraph-level control, the AI should make separate proposals per paragraph.

## Cross-References

- [Frontend Diff Model](../spec/frontend-diff-model.md) -- grouping algorithm, attribution pipeline
- [Local-First Authority](../spec/local-first-authority.md) -- transaction code
- [Undo Design](../spec/undo.md) -- session Ctrl-Z and thread undo
