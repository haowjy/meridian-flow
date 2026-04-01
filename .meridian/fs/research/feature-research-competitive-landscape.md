---
title: Feature Research — Competitive Landscape for Meridian
created_at: 2026-03-18
author: researcher-agent
purpose: Identify missing features and differentiation opportunities by analyzing writing platforms and AI editing tools
---

# Feature Research: Competitive Landscape

## Research Scope

Platforms surveyed: Scrivener, Ulysses, iA Writer, Obsidian, Notion, Coda, Google Docs, Sudowrite, NovelAI, Cursor, Windsurf, GitHub Copilot Workspace, Figma (collab model), Linear (keyboard-first UX), Hemingway App, ProWritingAid, WorldAnvil, Novelcrafter, Plottr.

Meridian's existing roadmap is used as a baseline — features already planned are noted but not recommended twice. The focus is on gaps and differentiation.

---

## Findings by Category

### 1. Long-Form Document Hierarchy and Outlining

**What Scrivener does well**: The Binder + Corkboard + Outliner triad. Documents are broken into "scenes" or "sections" that can be rearranged by drag-and-drop. Each section carries a synopsis card. Moving cards on the corkboard directly reorders the underlying document tree. Outline view shows custom metadata columns (status, word count, POV, scene goal) across all sections in a flat table.

**What Ulysses does well**: "Sheets" — atomic units smaller than files — that can be merged or split on demand. The sheet model makes it natural to work non-linearly without managing massive single files.

**Why this matters for Meridian**: Meridian's file tree gives folder/file hierarchy, but it treats documents as monolithic. Writers managing 100+ chapter serials often need sub-document structure: scenes within a chapter, beats within a scene. Without it, large chapters become hard to navigate and AI context becomes expensive.

**Gap**: No sub-document outline view. No synopsis/summary metadata per document. No multi-column outline table across documents in a folder.

**Priority**: Must-have for long-form writers. The file tree alone is not enough — Scrivener's users cite the Binder as the single most irreplaceable feature.

---

### 2. Story Bible / Reference Database

**What Sudowrite does well**: Story Bible — a structured wiki that characters, locations, and objects are added to either manually or auto-detected from prose. The AI references this when generating content, preventing hallucinations about established facts (eye color, character names, magic system rules).

**What Novelcrafter does well**: The Codex — same concept but tighter integration with the outline. Each codex entry is attached to specific scenes where it appears.

**What WorldAnvil does well**: Interactive world bible with maps, family trees, timelines, and category-based organization for complex lore systems.

**What Meridian already has**: AI context discovery (search across documents), AI reads character files when asked. This is filesystem-native: a `Characters/Elara.md` file is the story bible entry. The AI finds it via `doc_search`.

**Gap (real)**: No structured schema for character/location/lore entries — these are free-form markdown docs. No auto-detection of new entities and suggestions to create a reference doc. No visualization of which chapters reference which characters. No "stale reference" alerts when a lore doc changes and chapters haven't been updated.

**Priority**: Differentiator. Meridian's filesystem approach is actually more flexible than Sudowrite's fixed schema. The opportunity is to add light structure on top of it: a metadata header convention + an agent that monitors for entity mentions and suggests reference doc creation. This is achievable without building a separate database.

---

### 3. Project-Level Statistics and Writing Goals

**What dedicated trackers do (Trackbear, 4TheWords, Word Keeper)**: Daily word count graphs, streak counters, historical velocity trends, session-based timers, goal deadline projections ("at this pace you finish in 47 days").

**What Scrivener does**: Compile-time word count targets per document, project total targets with progress bars, session word count (words written this session vs. total added).

**What Ulysses does**: Writing Goals — goals can be set for a sheet (e.g., 1,000 words) or at the project level, with visual countdown indicators.

**Gap in Meridian**: The roadmap includes word count in the Explorer sidebar. Missing: session word count (words added since opening), daily writing streak, project deadline projection, per-document target vs. actual word count.

**Priority**: Must-have for writers trying to maintain serial update schedules (web serial authors post weekly chapters, momentum tracking is critical). Low implementation cost, high writer satisfaction impact.

---

### 4. Snapshots / Lightweight Version History

**What Scrivener does**: Per-document snapshots — a named point-in-time copy you can compare against the current draft using a visual diff. Unlike git, snapshots are intentional checkpoints the writer creates at meaningful points (before a major rewrite, before sharing with a beta reader).

**What Google Docs does**: Automatic version history with named versions, visual diff showing insertions and deletions with author attribution.

**Why this differs from git**: Git is too technical for most writers. Named snapshots ("Before beta reader edits", "Original ending") map to how writers actually work. The Scrivener snapshot model — compare two versions of a section with highlighted differences, restore with one click — is the right interaction model.

**Gap in Meridian**: No snapshot system. The collab/AI hunk system provides undo for AI edits, but there is no "save a checkpoint of this chapter before I ask AI to rewrite it" workflow.

**Priority**: Differentiator. The AI hunk workflow creates risk — writers may accept edits then regret them. A lightweight snapshot (name + content hash + timestamp, stored per document) before major AI operations would dramatically reduce anxiety. This complements, not duplicates, the undo system.

---

### 5. Split Editor / Research Side-by-Side

**What Scrivener does**: The editor splits horizontally or vertically. One pane shows the manuscript, the other shows research material (PDFs, images, web archives, another chapter). Both panes are independent — different documents, different scroll positions.

**What Ulysses lacks**: No built-in split for research alongside writing. Writers have to use OS window management.

**Why this matters**: When writing Chapter 47, a writer often needs to reference Chapter 12 (for continuity), their character note, and maybe a map. Switching tabs breaks flow.

**Gap in Meridian**: Multi-tab is planned but not split-pane. Tabs require context switching. Split view allows true side-by-side without leaving the editor context.

**Priority**: Nice-to-have for MVP, must-have at scale. The current multi-tab system is a workable stopgap. Split view is a natural next step once tabs ship.

---

### 6. Typewriter Scrolling and Sentence-Level Focus Mode

**What iA Writer does**: Typewriter scroll keeps the active line vertically centered on screen. Focus mode fades everything except the current sentence or paragraph. These work independently or together.

**What Calmly Writer does**: Paragraph-only highlight — everything outside the current paragraph is dimmed.

**Why this matters**: Writers working on long chapters lose their place when scrolling. Typewriter scroll eliminates this. Focus mode reduces cognitive load from surrounding text — useful for revision passes where you want to evaluate each sentence in isolation.

**Gap in Meridian**: Focus mode is in the roadmap, but typewriter scroll is not explicitly called out. They are separate UX features worth distinguishing.

**Priority**: Must-have for focus mode (already planned). Typewriter scroll is a nice-to-have but frequently cited as the single feature writers miss when switching editors.

---

### 7. Prose Analysis Feedback (Readability, Pacing, Style)

**What Hemingway App does**: Color-coded highlights for: complex sentences (yellow), very complex sentences (red), passive voice (green), adverbs (blue), weak phrases (purple). Shows Flesch-Kincaid grade level, word count, reading time.

**What ProWritingAid does**: 20+ report types including: pacing report (identifies slow-moving paragraphs), style report (weasel words, repeated sentence starters), consistency report, transitions report, dialogue balance, overused words, sticky sentences.

**Why this matters for Meridian's AI model**: Instead of manually requesting feedback, these analyses can run inline or be surfaced by an agent. Passive voice count, average sentence length per paragraph, and dialogue/prose ratio are computable without LLM calls.

**Gap in Meridian**: No prose analysis layer. AI can provide this on request via the thread, but there's no structural analysis panel or inline annotation that fires without LLM cost (unlike a simple text parser).

**Priority**: Differentiator. A lightweight rule-based analysis layer (sentence length variance, passive voice detection, repeated word frequency) running client-side is low-cost and would make Meridian meaningfully more useful for editing passes than its current state. The AI layer handles nuanced feedback; the rule-based layer handles structural patterns.

---

### 8. @-Mention / Cross-Document References with Autocomplete

**What Notion does**: @-mention any page from anywhere. The mention creates a live backlink. You can @-mention a person, date, or document inline. Viewing a mentioned page shows all pages that mention it.

**What Obsidian does with Dataview**: Notes have YAML frontmatter metadata. The Dataview plugin queries notes like a database — "show all scenes where character = Elara and status = draft". This turns the file system into a queryable project database.

**What Meridian already has**: Backend supports document references. Frontend @-mention autocomplete is in the "current limitations" list (not yet built).

**Gap (real but known)**: @-autocomplete UI. The backlink discovery direction (what else references this character?) is not mentioned in the roadmap.

**Priority**: Must-have. This is already on the known gap list. Backlink visualization (even a simple sidebar panel) would be a meaningful addition once @-mention ships.

---

### 9. Multi-Document Batch Edit Review UX

**What Cursor does**: When an agent edits multiple files, each file gets a diff view. You can accept/reject per file. Edits to related files show together in a grouped review. The "accept all" vs. "selective application" workflow is the key interaction pattern.

**What Meridian already has planned**: Multi-document batch editing is in the vision doc with the "like git commits for creative work" model.

**Gap (UX detail)**: The vision describes the concept but not the review UX. Cursor's model: a review sidebar lists all pending changes grouped by file, each file is expandable to show the diff, and you accept/reject at the file level or hunk level. Google Docs suggestions mode shows all pending suggestions in a right sidebar panel, color-coded, with accept/reject buttons inline.

**Priority**: Must-have for multi-document batch editing. The interaction pattern needs to be designed before the feature ships. The Google Docs + Cursor hybrid (sidebar list of changes + inline diff decorations) is the proven model.

---

### 10. Persistent Agent Planning / Task Tracking

**What Cursor Plan Mode does**: Before executing a complex multi-file task, the agent creates a markdown plan file listing steps with checkboxes. The developer can edit the plan before execution begins. As the agent works, checkboxes update. The plan serves as both pre-execution approval and real-time progress tracking.

**What Windsurf (Cascade) does**: The agent generates a structured plan as an artifact, then executes step-by-step, showing which step it's on. If a step fails, it self-corrects and notes the deviation.

**Why this matters for Meridian**: When a writer asks "rewrite Elara's arc across all 30 chapters to make her more cynical," this is a multi-step, multi-document operation. Showing a plan ("I will edit these 30 chapters in this order for these reasons") before execution lets the writer approve scope and catch unintended consequences. It also provides a recovery point if the writer wants to stop mid-way.

**Gap in Meridian**: No pre-execution planning artifact. The agent currently begins immediately. For high-impact operations (multi-document edits, consistency passes), a plan-before-execute mode would be critical for writer trust.

**Priority**: Differentiator. This is not duplicated in any writing tool today. It is the "agentic writing" version of Cursor's plan mode — and directly maps to Meridian's thesis of bringing coding tool sophistication to writing.

---

### 11. Conversation Compaction / Long Session Management

**What the problem is**: Long AI conversations fill the context window. Models lose coherence on early turns. Session history becomes expensive to pass.

**What Meridian already has planned**: Compaction is in the vision doc — summary turns, AI context from most recent compaction, old turns searchable via tool, configurable summarization model.

**Gap (detail not in roadmap)**: No mention of the UX for compaction. Users need to know compaction has happened and what was summarized. A collapsed "Compaction summary" turn (like how Cursor shows "Context was compacted") with a preview of what was retained and what was dropped lets writers verify nothing important was lost.

**Priority**: Must-have when conversation length becomes a real user problem. The UX of compaction visibility matters as much as the technical mechanism.

---

### 12. Proactive Consistency Monitoring

**What the gap is**: No writing tool currently does live, background consistency checking. Sudowrite's Story Bible is passive (you look things up). ProWritingAid's reports are on-demand.

**What Meridian's vision already describes**: "Consistency monitoring — Her eyes were blue in Ch 1, green in Ch 5." This is in the vision as a future direction.

**What's missing from the roadmap**: The trigger model. Three options:
1. On-save: check just the saved document against known entities (cheap)
2. Periodic background agent: scan entire project for contradictions (expensive, async)
3. On-open: when opening a chapter, surface known inconsistencies for that chapter (targeted)

**Priority**: Differentiator. No competitor does this automatically. Option 1 (on-save, single document check against story bible) is low-cost and high-value. Option 2 (full project scan) needs the subagent framework first.

---

### 13. Publish-to-Platform Integration

**What the vision already has**: Royal Road, Wattpad, Webnovel, Scribble Hub integration with one-click publishing, sync, and version control.

**What competitors lack entirely**: No writing tool (Scrivener, Ulysses, Sudowrite, Novelcrafter) has native publish-to-Royal-Road. This is a genuine gap in the market.

**Additional detail from research**: Royal Road's author dashboard exposes stats: followers, favorites, chapter views, ratings. Pulling these stats into Meridian (reader engagement per chapter, view counts, ratings over time) would let writers see which chapters performed best and inform future writing decisions.

**Priority**: Differentiator (publishing integration itself) and must-have-for-serials (publishing stats dashboard). The stats integration turns Meridian into not just a writing tool but a serial author analytics platform.

---

### 14. Ambient Focus Environment

**What tools like OmmWriter and ZenWriter do**: Customizable backgrounds (nature scenes, abstract art), ambient soundscapes (rain, cafe noise, lo-fi music), and full-screen modes that replace the OS desktop entirely during writing sessions.

**What iA Writer does**: Minimalist typography and margin design derived from typewriter aesthetics. The visual environment is calming by design, not just by hiding UI.

**Gap in Meridian**: Focus mode is planned, but the ambient layer (sound, custom backgrounds, typography-centric layout) is not mentioned.

**Priority**: Nice-to-have. This is a strong differentiator for writers who are particular about their writing environment, but it's not a core workflow feature. The focus mode and typewriter scrolling are higher ROI investments. Ambient sound can be added later with relatively low effort.

---

### 15. EPUB / Print-Ready Export

**What Reedsy Studio does**: One-click conversion from structured manuscript to EPUB and print-ready PDF with professionally designed templates. Chapter breaks, front matter, and table of contents are generated automatically.

**What Scrivener does**: The Compile feature is the most powerful export system in any writing tool — it handles manuscript format (Shunn standard), Kindle KDP, EPUB, PDF, and custom styles with per-section formatting rules.

**What Meridian already has**: Import/export via ZIP archives.

**Gap**: No structured EPUB or PDF export. ZIP export is raw markdown files, not publication-ready.

**Priority**: Must-have for the publishing vision. Before integrating with Royal Road, writers need to be able to export finished chapters as formatted documents. EPUB generation from ordered markdown files (with front matter, chapter numbering, cover art) is achievable and would significantly increase Meridian's value for finishing a project.

---

## Summary Table

| Feature | Priority | Existing Roadmap Coverage | Source Platform |
|---|---|---|---|
| Sub-document outline (scenes within chapters) | Must-have | Not covered | Scrivener |
| Synopsis/summary metadata per document | Must-have | Not covered | Scrivener |
| Story bible entity auto-detection | Differentiator | Partially (proactive AI alerts) | Sudowrite / Novelcrafter |
| Backlink visualization (what references this doc) | Must-have | Not covered | Obsidian / Notion |
| Writing streaks + session word count + deadline projection | Must-have | Partial (word count only) | Scrivener / Ulysses |
| Named document snapshots | Differentiator | Not covered | Scrivener |
| Split editor / dual pane | Nice-to-have | Not covered | Scrivener |
| Typewriter scroll | Nice-to-have | Not covered (focus mode is) | iA Writer |
| Prose analysis panel (rule-based) | Differentiator | Not covered | Hemingway / ProWritingAid |
| @-mention autocomplete | Must-have | Known gap, in limitations | Notion / Obsidian |
| Multi-doc batch edit review UX | Must-have | Concept in vision, no UX spec | Cursor / Google Docs |
| Agent pre-execution plan approval | Differentiator | Not covered | Cursor Plan Mode / Windsurf |
| Compaction visibility UX | Must-have | Concept in vision, no UX spec | Cursor |
| Proactive consistency monitoring (on-save) | Differentiator | In vision, no trigger model | Meridian vision |
| Publishing stats dashboard (Royal Road views/ratings) | Differentiator | Not covered | Royal Road API |
| EPUB / print-ready PDF export | Must-have | Partial (ZIP only) | Reedsy / Scrivener Compile |
| Ambient sound / focus environment | Nice-to-have | Not covered | OmmWriter / ZenWriter |

---

## Top Recommendations (Ordered by Impact vs. Effort)

### Highest impact, lowest effort

1. **Typewriter scroll + sentence-level focus mode** — CSS + CodeMirror configuration. Writers cite these as the features they miss most from dedicated writing apps. Already partially in roadmap (focus mode).

2. **Session word count + writing streak + deadline projection** — Client-side computation from document diffs. No backend changes needed. Extremely high satisfaction impact for serial authors on update schedules.

3. **Named document snapshots** — Store a named JSON blob (content + timestamp) per document in the project. Compare via the existing diff infrastructure. Low backend cost, high writer confidence for AI-heavy workflows.

4. **Rule-based prose analysis** — Sentence length histogram, passive voice regex, adverb density, repeated word frequency — all computable client-side in milliseconds. No LLM cost. Surface as a panel next to the editor.

### Medium impact, medium effort

5. **Sub-document outline view** — Requires a document structure model (H2/H3 as "scenes"), a sidebar outline panel, and drag-to-reorder that reorders sections within the markdown file. High value for 100+ chapter writers.

6. **Backlink visualization sidebar** — After @-mention ships: a panel on any document showing "referenced by" documents. Requires indexing @-mentions at save time.

7. **Agent pre-execution planning mode** — A "plan first" toggle that makes the agent output a structured task plan before executing any edits. Writer approves, then execution begins. Maps directly to Meridian's "Claude Code for writers" thesis.

8. **EPUB export** — Convert ordered folder of markdown files to EPUB with TOC, chapter breaks, front matter. Several Node.js/Go libraries handle the conversion. Essential for finishing and publishing workflows.

### Higher effort, strong differentiator

9. **Proactive on-save consistency check** — On each save, run a lightweight agent call that checks the saved document against known story bible entries for contradictions. Requires story bible entry indexing to be in place first.

10. **Publishing stats dashboard (Royal Road API)** — Pull reader stats (views, favorites, ratings by chapter) into a Meridian dashboard. Gives serial authors in-context analytics. Requires OAuth integration with Royal Road. Strong retention driver.

---

## Features That Are Traps (Do Not Build)

**Graph/network view (Obsidian-style)**: Visually compelling but writers report low actual utility. The visual graph is interesting to look at but rarely useful for writing decisions. The backlink list (which documents reference this one) provides the same information in a format writers actually act on.

**AI image generation (NovelAI)**: NovelAI's anime-style image generation is a niche feature for a niche audience. It competes directly with dedicated image tools (Midjourney, DALL-E) where Meridian has no advantage. Avoid.

**Full grammar checker (Grammarly-style)**: ProWritingAid and Grammarly are mature, deeply integrated products. Building a competitive grammar checker is months of work for a feature writers already have in existing tools. Focus on prose structure analysis (pacing, sentence variety) which these tools do worse.

**Kanban/task boards for writing projects**: Some writers want to manage their writing like projects (Notion databases, Coda tables). But this is not the writing-IDE thesis. Adding kanban dilutes the product identity without serving the core workflow.

---

## What Meridian Does That No Competitor Does

For calibration — these are genuine moats worth protecting:

1. **Agentic tool calling over the filesystem** — AI autonomously searches, reads, and edits across documents without prompting. No writing tool competitor has this.
2. **Inline diff accept/reject with full undo** — Google Docs has suggestions mode; no writing tool has Cursor-style hunk-level accept/reject with CodeMirror decoration layers.
3. **Multi-document batch editing (planned)** — No competitor has a "change Elara across all 30 chapters" workflow with grouped diff review.
4. **Persistent streaming with reconnection** — AI keeps working when the browser disconnects. No writing tool has this.
5. **Skills system** — User-extensible AI behaviors with editor UI. Unique in this market.

These are the features to highlight in positioning and to protect in roadmap prioritization.
