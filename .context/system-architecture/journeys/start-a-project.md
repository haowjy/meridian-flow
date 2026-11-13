# Start a project

A new writer signs in, creates a project, imports a manuscript, opens a chapter and writes.

## Sign in

Does: goes to the app and signs in. A visitor starts on the landing site or the app's `/login`.

Sees: WorkOS's hosted sign-in, then the app.

- Map: [www](../system.md#www), [app](../system.md#app), [workos](../system.md#workos)

## Arrive in a new account

Does: nothing; the server does this on the first request.

Sees: the project library, with a default project that holds a first `Chapter 1`.

- Map: [server](../system.md#server), [projects](../server.md#projects), [home](../app.md#home)
- Machines: [Work archive and delete](../../../apps/server/server/domains/projects/.context/state-machines.md)

## Create a project

Does: presses "Create a project" ("Create a project for your first book, series, or story world.") and then "Create project".

Sees: the new project opens at once, before the server has answered. A pending note, a failure, Retry and Discard appear on the new project.

- Map: [creation](../app.md#creation), [client](../app.md#client), [projects](../server.md#projects)
- Machines: [Creation record](../../../apps/app/src/client/creation/.context/state-machines.md)

## Open the import menu

Does: opens the sidebar, which has Chats, Manuscript and Knowledge, and chooses "Import…" then "Folder…" or "Files…".

Sees: the operating system's picker opens at once.

- Map: [project](../app.md#project), [import](../app.md#import)

## Watch the import run

Does: waits, or keeps working. Navigating away does not stop it.

Sees: upload progress. The server converts the files out of sight, and then every imported folder and document appears in the project's tree at once. The ends are "Import another" and "Import didn't finish".

- Map: [import (app)](../app.md#import), [import (server)](../server.md#import), [context](../server.md#context), [objectstore](../system.md#objectstore)
- Machines: [Import and import entry](../../../apps/server/server/domains/import/.context/state-machines.md), [Import creation and upload phase](../../../apps/app/src/features/import/.context/state-machines.md)

## Open a chapter

Does: clicks a chapter in the Manuscript tree.

Sees: it opens in a tab in the main area.

- Map: [project](../app.md#project), [core-resources](../app.md#core-resources), [context](../server.md#context)
- Machines: [Live document binding](../../../apps/app/src/features/project/context/.context/state-machines.md), [Resource lifecycle](../../../packages/resource-replica/.context/state-machines.md)

## Write

Does: types.

Sees: the text, and a status pill that reads "Offline" when the connection drops. Text typed offline shows "Saved locally (offline)" and is sent when the connection returns ("Back online (all changes saved)"). The writer's edits and the model's edits to the same page both land.

- Map: [browser](../system.md#browser), [core-editor](../app.md#core-editor), [core-transport](../app.md#core-transport), [collab](../server.md#collab)
- Machines: [Document session status](../../../apps/app/src/core/editor/.context/state-machines.md), [Sync pill outage phase](../../../apps/app/src/features/editor/.context/state-machines.md)
