# Start a project

A new writer signs in, creates a project, imports a manuscript, opens a chapter and writes. The
steps follow the `ux-v1` interface. **Code** means the message catalog or code on `origin/ux-v1` or
`main`; **PR body** means the description of #1304 only, which this page did not check against the code.

## Sign in

Does: goes to the app and signs in. A visitor starts on the landing site or the app's `/login`.

Sees: WorkOS's hosted sign-in. After it, the app's `/api/auth/callback` sets the sealed `wos-session` cookie and the writer is in.

Source: code (the callback and the cookie, on `main`).

- Map: [www](../system.md#www), [app](../system.md#app), [workos](../system.md#workos)

## Arrive in a new account

Does: nothing; the server does this on the first request.

Sees: the project library. The server creates the writer's user row, then a default project with a locked No Work and a first `Chapter 1`, and flags it ready.

Source: code (`projects` bootstrap).

- Map: [server](../system.md#server), [projects](../server.md#projects), [home](../app.md#home)
- Machines: [Work archive and delete](../../../apps/server/server/domains/projects/.context/state-machines.md)

## Create a project

Does: presses "Create a project" ("Create a project for your first book, series, or story world.") and then "Create project".

Sees: the new project opens at once. The browser mints the project id and keeps a creation record in memory, so the app navigates before the server has answered; a pending note, a failure, Retry and Discard appear on the new project. A reload before the server answers forgets the record.

Source: code (the catalog strings and the creation record).

- Map: [creation](../app.md#creation), [client](../app.md#client), [projects](../server.md#projects)
- Machines: [Creation record](../../../apps/app/src/client/creation/.context/state-machines.md)

## Open the import menu

Does: opens the sidebar, which has Chats, Manuscript and Knowledge, and chooses "Import…" then "Folder…" or "Files…".

Sees: the operating system's picker opens at once.

Source: code for "Import…", "Folder…" and "Files…"; PR body for the sidebar's layout.

- Map: [project](../app.md#project), [import](../app.md#import)

## Watch the import run

Does: waits, or keeps working. Navigating away does not stop it.

Sees: upload progress. The server then reveals the whole tree at once. The ends are "Import another" and "Import didn't finish".

Source: code (the strings and the import coordinator).

- Map: [import (app)](../app.md#import), [import (server)](../server.md#import), [context](../server.md#context), [objectstore](../system.md#objectstore)
- Machines: [Import and import entry](../../../apps/server/server/domains/import/.context/state-machines.md), [Import creation and upload phase](../../../apps/app/src/features/import/.context/state-machines.md)

## Open a chapter

Does: clicks a chapter in the Manuscript tree.

Sees: it opens in a tab in the main area.

Source: PR body for the tab; code for the tree.

- Map: [project](../app.md#project), [core-resources](../app.md#core-resources), [context](../server.md#context)
- Machines: [Live document binding](../../../apps/app/src/features/project/context/.context/state-machines.md), [Resource lifecycle](../../../packages/resource-replica/.context/state-machines.md)

## Write

Does: types.

Sees: the text, and a status pill that reads "Offline" when the connection drops. Text typed offline shows "Saved locally (offline)" and is sent when the connection returns ("Back online (all changes saved)"). The writer's edits and the model's edits to the same page both land.

Source: code (the strings; Yjs sync over `/ws/yjs`).

- Map: [browser](../system.md#browser), [core-editor](../app.md#core-editor), [core-transport](../app.md#core-transport), [collab](../server.md#collab)
- Machines: [Document session status](../../../apps/app/src/core/editor/.context/state-machines.md), [Sync pill outage phase](../../../apps/app/src/features/editor/.context/state-machines.md)
