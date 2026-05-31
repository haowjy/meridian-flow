# Meridian

Agentic writing platform for fiction writers managing 100+ chapter web serials. No real users or user data. No backwards compatibility needed. Schema can change freely.

See `$MERIDIAN_CONTEXT_KB_DIR/wiki/product/high-level/1-overview.md` for product details.

## v3 Full-Stack Rebuild (active)

Ground-up rebuild -- frontend AND backend. TypeScript throughout. Design package lives in the active work item directory (`meridian work current`).

Key decisions: TypeScript backend (canonical Yjs, no hashline port), Milkdown (ProseMirror), Y.XmlFragment, agent definitions replace skills, credits-only billing gate, linear turns, Drizzle ORM.

## Where to Find Things

| Area | Location |
|------|----------|
| v3 Design | Work item dir (`meridian work current`) |
| Plans | `$MERIDIAN_CONTEXT_KB_DIR/plans/` |
| Knowledge base | `$MERIDIAN_CONTEXT_KB_DIR` (`meridian context kb`) |

## Dev Environment

TBD -- scaffolding in progress.

## Build and Test

`pnpm` (not npm). TBD -- scaffolding in progress.

## Git Conventions

Commit after each testable state. Follow repository commit message style.

## Agent Spawning

- `meridian spawn` for delegated work (coding, reviewing, testing, research)
- Harness-native Agent types (`Explore`, `Plan`) for quick lookups
- Harness-native tools (Read, Grep, Glob, Bash, Edit, Write) for quick operations
