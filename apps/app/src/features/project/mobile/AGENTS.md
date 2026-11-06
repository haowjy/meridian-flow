# Phone project shell

- Mobile leaves consume typed navigation from `ProjectViewProps`; they don't parse or construct browser
  addresses.
- `MobileDocumentHost` owns the document session; a direct editor mount bypasses the registry.
- Chat commands from Work or Editor reveal the local chat Sheet and leave the destination mounted.
- Phone views may mount and unmount by destination, so desktop persistent-surface rules don't apply.

Routing, session and chrome contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
