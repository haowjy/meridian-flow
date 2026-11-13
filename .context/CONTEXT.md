# Meridian Flow repo — architecture

Cross-cutting design lives in the [KB](https://github.com/haowjy/meridian-flow-docs/tree/main/kb).
Server composition and transport: [apps/server](../apps/server/.context/CONTEXT.md).
Every state machine, with its diagram: [state-machines](state-machines/index.md).
The product's words, for a reader new to it: [glossary](glossary.md).

- **Domains are acyclic.** Threads reference project and Work ownership, never
  the reverse; the only projects↔threads imports are test fixtures.
  `apps/server/server/lib/` is the composition root and may wire every domain;
  domains do not import `lib/`.
- **Ports.** JSON-natural shared DTOs live in `@meridian/contracts`; behavioral
  ports live in the domain that owns them. Provider-specific types stay inside
  adapters.
- **"Harness" is a concept, not a package:** the runtime, threads, packages,
  projects, context and collab domains together.
- **Billing.** Credits are user-scoped in the schema, but the runtime's billing
  port still takes project-shaped inputs in places; the Drizzle adapter ignores
  the project id.
