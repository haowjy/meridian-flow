# Product

Design-facing summary for Meridian Flow v3. The live code, `AGENTS.md`, `.context/`, and the Meridian knowledge base are the source of truth; this file orients contributors before they enter the implementation details.

## Mission

Help fiction writers produce and maintain long-running serials without drowning in project management. Meridian Flow should feel like a focused writing instrument: fast enough for daily drafting, structured enough for hundreds of chapters, and intelligent enough to help with continuity, revision, and narrative planning.

## Users

The target user is a high-output fiction writer managing one or more web serials across hundreds of chapters. They may write thousands of words per day in genres such as xianxia, progression fantasy, LitRPG, and other continuity-heavy forms.

They need:

- a writing surface that stays responsive at book/serial scale;
- project structure for works, chapters, context, and long-lived threads;
- AI assistance that understands narrative context rather than generic chat;
- low-friction continuity checks, summaries, references, and revision help;
- power-user depth without a steep complexity cliff.

## Product purpose

Meridian Flow combines a serial-writing workbench, collaborative rich-text document runtime, and agentic thread runtime. The app is where a writer drafts, reviews context, asks for help, and returns quickly to the manuscript. The server owns canonical Yjs persistence, thread orchestration, billing gates, package/agent definitions, and provider adapters.

Success looks like a writer who trusts the tool with a large active serial because it keeps their chapters, continuity context, and AI work organized without getting between them and the next scene.

## Brand personality

Calm, editorial, warm, and capable. The surface should read as a long-session writing environment, not a flashy chatbot or sterile enterprise dashboard. Typography, whitespace, and quiet structure carry the experience.

## Anti-references

What this must not become:

- consumer-AI gloss: gradients, novelty effects, emoji-forward interactions, and bubbly chat toy styling;
- developer-console density as the default experience;
- heavy project-management ceremony before writing can start;
- generic document editor cloning without fiction-specific structure;
- hidden infrastructure concepts leaking into ordinary writing flows.

## Design principles

1. **Writing first.** The manuscript and the writer's next action are more important than platform mechanics.
2. **Scale without clutter.** Hundred-chapter projects require structure, but the default screen should stay calm.
3. **Continuity is trust.** AI help earns trust by grounding responses in the project's known works, chapters, context, and thread history.
4. **Fast perceived motion.** Prefer optimistic state, clear live status, and stable layout over blocking waits.
5. **Explicit seams.** Provider choice, database access, document sync, and model calls stay behind ports/adapters so the product can evolve without tangling core behavior.
