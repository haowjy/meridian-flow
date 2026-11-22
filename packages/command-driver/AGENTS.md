# @meridian/command-driver

The one client driver for every command the server may or may not have received. It keeps the
writer's intent in a journal and delivers it until the server's stored outcome is known. It
owns no UI, query cache, CRDT or server state: what the screen shows of a command stays with
each domain, which projects the account's unsettled records over its own data.

- Framework-free. The browser's journal (IndexedDB), delivery lock (Web Locks), channel
  (BroadcastChannel) and transport (`fetch`) come in as ports from `apps/app/src/client/commands`.
- The server holds the outcome; the browser holds the intent. Only a stored outcome (`done` or
  `never`) settles a record. A status code alone never does: any 4xx other than the account fault is
  settled by `resolve`.
- Every change to a record is one journal transaction that checks what it needs inside it.
- A sent record's request is saved with `sent` and repeated byte for byte; nothing migrates it.
- A kind is a table entry (`CommandKind`), never a branch in the driver.

Rules and the machine: [.context/state-machines.md](.context/state-machines.md).
