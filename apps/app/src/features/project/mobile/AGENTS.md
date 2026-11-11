# Phone project shell

- Mobile leaves consume typed navigation from `ProjectViewProps`; they don't parse or construct browser
  addresses.
- The phone's document renders through `DocumentHost` (`context/DocumentHost.tsx`), which owns the document session; a direct editor mount bypasses the registry.
- The Sheet is the side: it shows the side's item (a document or a chat) with the side's header,
  is closed on arrival, and any navigation closes it.
- Phone views may mount and unmount by destination, so desktop persistent-surface rules don't apply.
- A move or delete of the open document follows the replica's placement through
  `useFollowOpenDocumentPlacement`, the same effect as the desktop Editor. Don't add a second
  phone-only follow.

Routing, session and chrome contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
