# draft-review TODO

- A refused Apply's message can still push manuscript text down
  ([#992](https://github.com/haowjy/meridian-flow/issues/992)). Move draft
  feedback to one surface outside the manuscript rather than patching each
  width.

- Ctrl+Z in the reviewing editor still checks a guarded Discard step against what the draft room
  holds, with no catch-up: discard there, type over the word in Live in another pane, and press
  Ctrl+Z within the pull's debounce (2 s, up to 10 s while typing goes on), and the AI's change
  comes back as a proposal over the writer's word. Nothing is lost, and it needs two panes and a
  fast switch. Ctrl+Z pops synchronously and can't wait on a round trip; the fix that ends the
  second rule is to pop at once, run the notice Undo's catch-up, and take the step back with the
  "couldn't come back" line when it shows a touch.
