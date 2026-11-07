# TODO — apps/www deferred work

- **Check the address-bar handling on a real iPhone** (`src/features/landing/film.css`,
  `scenery.css`, `film.ts`'s resize handler). The stage and the `--below` strip were
  checked only in Chromium with a faked strip, since Chromium can't collapse an address
  bar. Scroll the whole film in iOS Safari: the ground should reach the screen's bottom
  once the bar collapses, nothing the visitor reads should slide under the bar while it
  shows, and the page should not zoom out.
- **Make `public/llms.txt` match the app on the story bible.** It says agents read the
  knowledge base before they write and update it as the story changes. No built-in
  agent is told to keep it updated: `muse.md` and its helpers in
  `apps/server/server/domains/packages/builtin/launch-agents/agents/` don't mention it,
  and the system instructions only say what `kb://` holds. An agent updates a page
  when the writer asks. Either reword the line to what the app does, or build the
  behaviour first. `llms.txt` describes today's app, not the film's target, because
  answer engines repeat it as fact.
