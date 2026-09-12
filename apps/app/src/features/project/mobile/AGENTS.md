# Phone project shell

This is the phone-specific sibling of the persistent desktop project shell. It
reuses route-owned state and project-domain surfaces; only phone chrome and the
single-active-view lifecycle belong here.

- Consume typed navigation from `ProjectViewProps`; mobile leaves never parse or
  construct browser addresses.
- Keep document-session ownership in `MobileDocumentHost`; direct editor mounts
  bypass the registry.
- Phone views may mount and unmount by destination. Do not apply desktop
  persistent-surface rules to this shell.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for routing, session, and
chrome contracts.
