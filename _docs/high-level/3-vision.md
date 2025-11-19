---
title: Vision Document
description: Core Principles and Potential Directions
created_at: 2025-10-30
updated_at: 2025-10-30
author: Jimmy Yao
category: high-level
tracked: true
---

# Meridian: Vision Document

## The Core Insight

**"Agentic coding" (like Claude Code, Cursor) revolutionized software development. The same patterns can transform creative writing.**

### Agentic Writing: The Concept

**Agentic Coding:**
- AI explores codebase autonomously
- AI suggests edits across multiple files
- Developer reviews and approves
- Iterative refinement until code works

**Agentic Writing (Our Vision):**
- AI explores creative project autonomously
- AI suggests edits across multiple documents (lore + chapters)
- Writer reviews and approves
- Iterative refinement until story works

**The pattern:** AI handles structure, consistency, and drafting. Human provides creative vision and final approval.

**We're building this infrastructure for creative writing. The market will tell us where it's most valuable.**

---

## Starting Hypothesis: Fiction Writers

**Why test with fiction first:**
- We have direct access (Royal Road audience)
- We understand the pain personally
- Clear use case to validate
- Can reach them and get feedback fast

**But this is a hypothesis, not a commitment.**

If fiction writers don't convert but game developers do → pivot to game dev
If neither works but technical writers love it → pivot to docs
If enterprise product teams want it → pivot to B2B

**We're optimizing for learning, not a specific market.**

The technology (file system, AI context discovery, persistent streaming) works for any domain. We're figuring out where it provides the most value.

---

## Core Principles (What Doesn't Change)

These principles guide every decision, regardless of which market we serve:

### 1. Documents, Not Files

**Clean, natural document names. No extensions.**

```
✓ Elara
✓ Chapter 1
✓ Combat System
✓ API Authentication

✗ elara.md
✗ chapter_01.txt
✗ combat_system.doc
```

**Why:** People think in documents, not files. Keep it natural.

### 2. References Are Mostly Implicit

**Write naturally. AI figures it out.**

```
Writer types:
"Elara walked through the capital to find Marcus"

AI automatically:
- Detects: Elara, capital, Marcus
- Searches: All documents
- Finds: Characters/Elara, Locations/The Capital, Characters/Marcus
- Loads: Those documents into context
- Understands: The full context for this prose
```

**No special syntax needed. Just write.**

**Optional @-references for explicit control:**
- When you want to be clear: `@[Characters/Elara]`
- When AI needs help: `@[that old tavern scene]`
- For efficiency: AI sees @ and directly loads that document tree
- But 90% of the time? Natural writing, AI discovers context

**Why this matters:**
- Writers write naturally
- No cognitive overhead
- AI does the work
- Explicit references when you need them
- Best of both worlds

### 3. Context Is Both Automatic and Manual

**Automatic:** AI discovers mentions → searches → loads documents
**Manual:** Add specific documents or folders when needed
**Together:** Smart AI + full control

**Why:** Convenience for common cases, power for complex ones.

### 4. AI Assists, Humans Decide

AI suggests, users approve. Always visible, always controllable, always overrideable.

**Why:** Amplify creativity, don't replace it.

### 5. Privacy and Ownership First

BYOK option. Easy export. Encrypted keys. No lock-in.

**Why:** Trust is essential for adoption, especially for creators with unpublished work.

### 6. Multi-Provider by Default

Support multiple AI providers. Make adding new ones easy. Let users choose.

**Why:** Avoid dependency on single company, enable cost optimization, respect user preferences.

### 7. Performance Matters

Zero lag. Instant switching. Smooth streaming. Fast search.

**Why:** Slow tools break flow state. Creators need speed.

### 8. Persistent Streaming

AI continues working server-side even if user disconnects.

**Why:** Respects user workflow, feels magical, differentiates from web-only tools.

---

## How the Reference System Actually Works

### The Magic: AI Discovery

**User workflow:**
1. Write naturally in any document
2. AI reads what you write
3. AI identifies entities (names, places, concepts)
4. AI searches across all documents
5. AI finds relevant documents
6. AI loads them into context automatically

**Example:**
```
Document: "Chapter 15"

User writes:
"Elara entered the throne room where King Aldric 
 was meeting with the Council of Seven. She remembered 
 her training with Master Chen and knew this was the 
 moment everything would change."

AI automatically detects and searches for:
- Elara → finds Characters/Elara
- King Aldric → finds Characters/King Aldric
- throne room → finds Locations/Throne Room
- Council of Seven → finds Factions/Council of Seven
- Master Chen → finds Characters/Master Chen
- training → finds Events/Training Arc

AI loads all into context without user doing anything.
```

**This is the core value: Write naturally, AI understands everything.**

### Optional Explicit References

**Sometimes you want to be explicit:**

```
In brainstorming notes:
"What if @[Characters/Elara] discovers she's related 
 to @[Characters/King Aldric]? This would change 
 everything about @[Plot/The Succession Crisis]."
```

**Why use @:**
- Forces AI to load specific document
- When AI might miss the connection
- For documents with common names
- For faster AI context loading (direct tree pull)
- Personal preference for being explicit

**But it's optional, not required.**

### Manual Context Addition

**When automatic isn't enough:**

```
Chat: "Compare this chapter to all previous chapters 
      about Elara"

User: [manually adds Chapters 1, 5, 8, 12, 15 to context]

AI: Now has current + those specific chapters
```

**Or:** "Analyze the entire magic system across all documents"
**User:** [manually adds Worldbuilding/ folder]

**Three layers working together:**
1. Implicit discovery (AI finds mentions)
2. Explicit @ (when you want to be clear)
3. Manual additions (when you need specific context)

### How AI Discovers Context

**Natural Language Processing:**
- Named entity recognition
- Coreference resolution
- Semantic search across documents
- Pattern matching
- Learning from document structure

**Example processing:**
```
Input: "She walked through the capital"

AI analysis:
- "She" → resolves to "Elara" (from context)
- "capital" → searches for "capital" mentions
- Finds: Locations/The Capital (high confidence)
- Loads: Characters/Elara, Locations/The Capital
```

**Smart enough to understand:**
- Pronouns and references
- Synonyms and variations
- Context clues
- Document relationships

**This is what makes it magical.**

---

## Potential Markets (Ordered by Validation Speed)

### 1. Fiction Writers (Fastest to Validate)

**The problem:**
- 100+ chapters, lose track of details
- "What color were her eyes again?"
- Manual search through old chapters
- ChatGPT forgets everything

**How Meridian helps:**
```
Writer: "Is this dialogue consistent with Marcus's character?"

AI automatically:
- Detects: Marcus mentioned
- Loads: Characters/Marcus document
- Loads: All previous chapters mentioning Marcus
- Analyzes: Dialogue patterns
- Responds: With full context
```

**Why test first:** Direct access, personal pain, fast feedback

**Success looks like:** 10 writers say "I can't write without this"

### 2. Game Developers (High Potential)

**The problem:**
- Hundreds of NPCs, items, mechanics
- "Did I already give this weapon to another quest?"
- Spreadsheets everywhere
- No good documentation tools

**How Meridian helps:**
```
Writer: "Design a quest in the Frozen Peaks"

AI automatically:
- Detects: Frozen Peaks
- Loads: Locations/Frozen Peaks
- Loads: Related quests, NPCs, items
- Suggests: Contextually appropriate quest
```

### 3. Technical Writers (B2B Potential)

**The problem:**
- API docs across multiple products
- "Did we document this endpoint consistently?"
- Manual cross-referencing
- Version confusion

**How Meridian helps:**
```
Writer: "Document the new authentication flow"

AI automatically:
- Detects: authentication
- Loads: Existing auth docs
- Loads: Related security docs
- Suggests: Consistent patterns
```

**And more markets to discover...**

---

## AI Intelligence Is The Product

**Not manual tagging. Not explicit linking. AI that understands.**

**The vision:**
```
Writer writes naturally
↓
AI reads in real-time
↓
AI identifies entities and concepts
↓
AI searches across all documents
↓
AI loads relevant context
↓
AI provides informed assistance
↓
Writer never leaves flow state
```

**This requires:**
- Fast search (< 100ms)
- Smart entity recognition
- Semantic understanding
- Context ranking (most relevant first)
- Efficient document loading

**This is technically hard. This is the moat.**

---

## Optional @-References: When and Why

**Use @ when:**
1. **Disambiguation needed:** `@[Characters/Marcus]` not `@[Locations/Marcus Street]`
2. **Forcing inclusion:** AI might miss it, you know it matters
3. **Efficiency:** Direct tree loading, faster than search
4. **Personal preference:** You like being explicit

**Don't need @ when:**
1. **Writing prose:** Natural mentions work fine
2. **Common entities:** AI will find "Elara" easily
3. **Trust AI:** It's usually smart enough

**Example when @ helps:**
```
"She thought about the incident"

AI might not know which incident.

"She thought about @[Events/The Betrayal]"

Now AI definitely loads that document.
```

**But most of the time, natural writing works.**

---

## The Agentic Vision: Full Roadmap

**AI doesn't just respond when asked. It actively collaborates on your creative project.**

### Multi-Document Batch Editing

**The capability:**

```
Writer: "Make Elara more cynical"

AI updates in one batch:
├─ Characters/Elara.md (update personality)
├─ Chapter 1 (rewrite dialogue)
├─ Chapter 5 (adjust inner monologue)
├─ Chapter 12 (change reaction to betrayal)
└─ Characters/Marcus.md (update relationship notes)

Writer: Reviews all 5 changes
├─ Accept all → atomic commit
├─ Accept some → selective application
└─ Refine → AI iterates on feedback
```

**Why this matters:**
- Consistency across entire project
- One creative direction → many document updates
- Like git commits for creative work
- Review all changes before applying

**Technical requirements:**
- Multi-document version management
- Atomic batch commits
- Bulk accept/reject UI
- Cross-document consistency analysis

### Skills System: Different AI Behaviors

**The concept:** Different "skills" for different creative tasks, each with specialized behavior.

**Potential skills:**

**cw-brainstorming:**
- Captures messy creative notes
- Minimal structure, maximum freedom
- Identifies entities and themes
- Suggests lore document creation

**cw-lore-builder:**
- Transforms brainstorm into structured wikis
- Creates character profiles, world docs, faction pages
- Maintains consistent formatting
- Links related lore documents

**cw-prose-writing:**
- Drafts chapters based on lore
- Follows established character voices
- Incorporates world-building details
- Maintains tone and style consistency

**cw-editor:**
- Suggests prose improvements
- Focuses on style, pacing, clarity
- Preserves author voice
- Iterative refinement workflow

**cw-consistency-checker:**
- Analyzes project for contradictions
- Flags timeline issues
- Detects character inconsistencies
- Suggests fixes across multiple documents

**How it works:**
- User selects skill when starting chat
- Skill provides specialized system prompt
- AI behavior adapts to task
- Same underlying model, different expertise

### Ideas → Lore → Story Pipeline

**The three-phase workflow automated:**

**Phase 1: Brain Dump**
```
Skill: cw-brainstorming
Input: Stream-of-consciousness creative ideas
Output: Structured brainstorming doc + entity list
```

**Phase 2: Lore Generation**
```
Skill: cw-lore-builder
Input: Brainstorming doc + entity list
Process:
  - Create Characters/[name].md for each character
  - Create World/[concept].md for world elements
  - Create Factions/[group].md for organizations
  - Link related documents
Output: Structured wiki of project lore
```

**Phase 3: Story Drafting**
```
Skill: cw-prose-writing
Input: Lore docs + plot outline
Process:
  - Load relevant lore into context
  - Draft chapter incorporating world details
  - Maintain character voices
  - Follow established canon
Output: Chapter draft referencing lore
```

**The vision:** Type creative ideas → AI structures → AI drafts → You refine.

### Proactive AI Behaviors (Future Exploration)

**Potential autonomous actions:**

**Consistency Monitoring:**
- AI notices: "You said her eyes were blue in Ch 1, green in Ch 5"
- Suggests: Fix in one chapter or update both
- User: Approves or dismisses

**Missing Documentation Detection:**
- AI notices: "You mention 'The Council' in 3 chapters but have no lore doc"
- Suggests: Create Factions/The-Council.md
- User: Accepts → AI drafts initial version

**Context Optimization:**
- AI suggests: "Add Characters/Elara as reference to this chapter"
- User: Accepts with one click
- Better AI responses without manual work

**Stale Content Alerts:**
- AI notices: "This chapter contradicts updated character wiki"
- Suggests: Review or update chapter
- Prevents drift between lore and prose

**All suggestions require user approval** - AI never modifies without permission.

**For detailed implementation ideas**, see: [`_docs/future/ideas/ai-behaviors/proactive-assistance.md`](../../future/ideas/ai-behaviors/proactive-assistance.md)

---

## Discovery Strategy

**Phase 1: Fiction Writers (8 weeks)**
- Build MVP with implicit reference discovery
- Test with 10 writers
- Measure: Does AI context actually help?

**Key questions:**
- Does implicit discovery work well enough?
- Do writers trust AI to find relevant documents?
- Or do they want more explicit control?
- Is @-reference feature used? How often?

**Phase 2: Learn and Adapt (Week 9)**

**If discovery works great:** Double down on AI intelligence
**If discovery is spotty:** Add more explicit control options
**If fiction doesn't work:** Pivot to different market

**Stay flexible. Follow the data.**

---

## Why Go Despite Python Experience

**Persistent streaming is valuable across all markets.**

User starts analysis → closes browser → AI continues → returns to completed work.

**Only practical in Go:**
- Lightweight goroutines
- Natural concurrency
- Low resource usage

**Worth the learning curve.**

---

## Success Metrics (Discovering What Matters)

**For fiction:**
- Do they use it regularly?
- Does implicit discovery work?
- Do they value the AI context?
- Will they pay?

**For other markets:**
- Different metrics
- Different value props
- Test and learn

---

## Core Thesis

**AI that automatically understands your entire project by reading what you write is valuable.**

**Where it's most valuable is what we're discovering.**

**Fiction writers are the hypothesis, not the answer.**

**Stay flexible. Follow the strongest signal. Build what people will pay for.**
