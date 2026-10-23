# Rich mock provider

Use an owned stack with `MODEL_PROVIDER=mock pnpm dev`; discover its URLs with
`pnpm portless:list` and sign in through `/dev-login`. These checks exercise the
mock through real chat persistence and tools, not UI-injected fake rows.
[Controls and fixtures](../debugging.md#mock-provider-responses).

1. **Default and override.** Create a chat, send an ordinary message in the
   browser, and expect the scene sample with a Thinking fold. Send a different
   message with `./mf thread send <id> "override probe" --mock
   @tools/mf/fixtures/mock-thinking.json`. Expect a critique instead. Send another
   ordinary browser message and expect the scene default again. With a real
   provider stack, `--mock` must fail before message admission, not call the paid model.
2. **Thinking persistence.** Expand Thinking on the critique. Reload the page
   and expand it again. The text must match. Queue a scoped step containing only
   `reasoning`; verify its Thinking fold after completion and reload.
3. **Streaming and stop.** Queue a scoped sample with `chunkSize: 4` and
   `chunkDelayMs: 100`, send from the browser, and capture the partial thinking.
   Stop during thinking, then repeat and stop during text. Both runs must settle
   as stopped without later appending the rest. The runtime discards the current
   in-flight response on Stop; already completed model responses remain.
   Repeat with `delayMs: 30000` and stop before any output.
4. **Size and Markdown.** Use `mock-large.json`. Scroll from first paragraph to
   last, reload, and check the response is still complete. Confirm 10,000 words
   in the durable text with `./mf thread view <id> --full --json`. Exercise
   `sample: markdown` at `chunkSize: 1`; inspect code, quotes, nested lists,
   Chinese text and the dragon emoji for intact rendering. With `repeat: 2`,
   expect two copies separated by a blank line.
5. **Real tools.** Send `mock-tools.json`, expand the process folds, and inspect
   write, read, ls and search. Open the resulting Scratch document and verify its
   content. The final answer must follow the tool results. Repeat to exercise
   overwrite. Send an invalid `write` command in a separate scoped fixture and
   verify the refusal comes from the real tool validator.
6. **Interrupt.** Queue `mock-interrupt.json` with a unique match, send that
   message in the browser, choose an option, and expect the fixture's final reply.
   Clear any unconsumed script by ID after the check.
7. **Failure and retry.** `mock-recovery.json` must finish with the outline after
   one retry. `mock-provider-error.json` must leave a visible failed reply.
   `mock-truncated.json` must not be shown as an ordinary successful answer.
   A truncated response containing tool calls must not execute those tools.
8. **Validation and isolation.** Try an unknown field, negative timing, zero
   chunk size, an unknown sample, both `sample` and `lorem`, and lorem over the
   limit. Each must be rejected without queueing. Queue two different matches
   in two chats and verify neither consumes the other's steps.
9. **Startup defaults.** Restart the owned stack with
   `MOCK_MODEL_RESPONSE='{"lorem":{"words":123},"chunkSize":32,"chunkDelayMs":5}'`.
   An unscripted message must have 123 words. A per-send fixture must override it;
   the following unscripted message must return to 123 words. Malformed default
   JSON and defaults containing `toolCalls` or `times` must fail configuration.

Capture screenshots of partial thinking, persisted expanded thinking, the long
response, tools, interrupt and failure. Close the browser and stop the stack
when finished. Low-level transport probes should also compare streamed and
non-stream content/usage and cancellation with a slow consumer; the browser
alone cannot measure wire chunk timing or HTTP backpressure.
