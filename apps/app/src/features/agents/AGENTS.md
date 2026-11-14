# features/agents — Agent identity, selection and Agent files

- Creation reserves exact catalog-entry and definition-revision IDs, General
  included: it is a real system catalog entry. Existing conversations display
  their retained definition; slugs can change, so looking one up would rewrite
  history.
- The picker only selects. Unavailable Agents are omitted; the Agents tab and an open Agent
  file show them, with Mars's reasons.
- Writer-facing copy spells the levels `.agents/` and `~/.agents/`, never `agents://`.
- Agents are identified by name; avatar imagery is for humans.

Selection, identity and Agent-file surfaces: [`.context/CONTEXT.md`](.context/CONTEXT.md).
