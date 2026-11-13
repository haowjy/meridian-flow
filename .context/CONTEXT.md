# Meridian Flow repo — architecture

Cross-cutting design lives in the [KB](https://github.com/haowjy/meridian-flow-docs/tree/main/kb).
Server composition and transport: [apps/server](../apps/server/.context/CONTEXT.md).
Every state machine, with its diagram: [state-machines](state-machines/index.md).
The product's words, for a reader new to it: [glossary](glossary.md).
The running system, the code's boxes and their dependencies, and the writer journeys:
[architecture map](system-architecture/README.md).

- **Domains are meant to be acyclic, and today are not.** Threads reference
  project and Work ownership, never the reverse. But runtime, threads, projects,
  file-policy, context and collab import each other in a cycle, and
  `runtime/gateway/config` imports `lib/`; the [dependencies page](system-architecture/dependencies.md)
  lists each such import, and `pnpm check:architecture` fails on a cycle import or a domain import
  of `lib/` that has no row there.
  `apps/server/server/lib/` is the composition root and may wire every domain;
  a new domain import of `lib/` or a new cycle edge is a regression.
- **Ports.** JSON-natural shared DTOs live in `@meridian/contracts`; behavioral
  ports live in the domain that owns them. Provider-specific types stay inside
  adapters.
- **"Harness" is a concept, not a package:** the runtime, threads, packages,
  projects, context and collab domains together.
- **Billing.** Credits are user-scoped in the schema, but the runtime's billing
  port still takes project-shaped inputs in places; the Drizzle adapter ignores
  the project id.
