# Drain Apply settlement

`DRAIN_APPLY_SETTLEMENT=1` is the operator's cutover switch: the server stops staging new
Applies, answers a retry of a known command id from its record, and lets a staged Apply finish
in recovery. Off by default. `pnpm dev` forwards it to the server process
(`tools/dev/dev-app-env-passthrough.ts`).

Run it in the browser on a fresh stack with `MODEL_PROVIDER=mock`, from a detached checkout of
the commit under test. Set up with `./mf`: a named Work, a thread bound to it, a queued
`write_mode: draft` reply that edits one document and creates two others.

1. With the switch off, Apply the edited document. PASS: it leaves Changes to review and
   live shows the new text. Keep its Apply request's `commandId` (agent-browser network log).
2. Restart with the switch on: `DRAIN_APPLY_SETTLEMENT=1 pnpm dev:restart`. Confirm it reached
   the server: `tr '\0' '\n' < /proc/<server pid>/environ | grep DRAIN`.
3. Click Apply on a created document. PASS: the request answers 503 ("Apply is paused while
   the server finishes pending work. Try again in a moment."), the change stays in Changes to
   review, and `./mf doc read` on its live URI is still missing. The writer sees only the
   generic "Couldn't apply this draft. Try again."; that is accepted for a cutover.
4. Resend step 1's request with its known `commandId`. PASS: it replays the recorded answer
   (not 503), and live is unchanged.
5. Restart with the switch off. PASS: recovery completes any staged Apply, and Apply on the
   remaining change now succeeds.

Not covered: Apply all under drain. Record the commit, date, stack and outcome after each run.
