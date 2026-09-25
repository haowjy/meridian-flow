# Phone project shell

This is the phone-specific sibling of the persistent desktop project shell. It
reuses route-owned state and project-domain surfaces; only phone chrome and the
active-destination lifecycle belong here.

- Consume typed navigation from `ProjectViewProps`; mobile leaves never parse or
  construct browser addresses.
- Keep document-session ownership in `MobileDocumentHost`; direct editor mounts
  bypass the registry.
- Chat commands from Work or Editor reveal the local chat Sheet and leave the
  destination mounted. Current identity and first-send recovery remain route-owned.
- Phone views may mount and unmount by destination. Do not apply desktop
  persistent-surface rules to this shell.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for routing, session, and
chrome contracts.
