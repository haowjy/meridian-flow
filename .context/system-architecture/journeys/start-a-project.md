# Start a project

A new writer signs in, creates a project, imports a manuscript, opens a chapter and writes.

## Sign in

Does: goes to the app and signs in. A visitor starts on the landing site or the app's `/login`.

Sees: WorkOS's hosted sign-in, then the app.

- Map: [www](../system.md#www), [app](../system.md#app), [workos](../system.md#workos)

## Arrive in a new account

Does: nothing; the server does this on the first request.

Sees: the project library, with a default project that holds a first `Chapter 1`.

- Map: [server](../system.md#server), [projects](../server-workspace.md#projects), [home](../app-library.md#home)
- Machines: [Work archive and delete](../../../apps/server/server/domains/projects/.context/state-machines.md)

## Create a project

Does: presses "Create a project" ("Create a project for your first book, series, or story world.") and then "Create project".

Sees: the new project opens at once, before the server has answered. A pending note, a failure, Retry and Discard appear on the new project.

- Map: [creation](../app-library.md#creation), [client](../app.md#client), [projects](../server-workspace.md#projects)
- Machines: [Creation record](../../../apps/app/src/client/creation/.context/state-machines.md)

## Open the import menu

Does: opens the Manuscript tab in the sidebar (its strip also has Chats and Knowledge) and chooses "Import…" then "Folder…" or "Files…".

Sees: the operating system's picker opens at once.

- Map: [project](../app.md#project), [import](../app-library.md#import)

## Watch the import run

Does: waits, or keeps working. Navigating away does not stop it.

Sees: upload progress. The server converts the files out of sight, and then every imported folder and document appears in the project's tree at once. The ends are "Import another" and "Import didn't finish".

- Map: [import (app)](../app-library.md#import), [import (server)](../server-files.md#import), [context](../server-documents.md#context), [objectstore](../system.md#objectstore), [An import](../flows/an-import.md)
- Machines: [Import and import entry](../../../apps/server/server/domains/import/.context/state-machines.md), [Import creation and upload phase](../../../apps/app/src/features/import/.context/state-machines.md)

## Open a chapter

Does: clicks a chapter in the Manuscript tree.

Sees: it opens in a tab in the main area, with a chat beside it in the side pane.

- Map: [project](../app.md#project), [core-tree-list](../app-core.md#core-tree-list), [context](../server-documents.md#context), [Opening a document](../flows/opening-a-document.md)
- Machines: [Live document binding](../../../apps/app/src/features/project/context/.context/state-machines.md), [List connection](../../../apps/app/src/core/tree-list/.context/state-machines.md)

## Write

Does: types.

Sees: the text. When the connection drops the chat composer reads "Offline", and text typed offline shows "Saved locally (offline)" and is sent when the connection returns ("Back online (all changes saved)"). The writer's edits and the model's edits to the same page both land.

- Map: [browser](../system.md#browser), [core-editor](../app-core.md#core-editor), [core-transport](../app-core.md#core-transport), [collab](../server-documents.md#collab)
- Machines: [Document session status](../../../apps/app/src/core/editor/.context/state-machines.md), [Sync pill outage phase](../../../apps/app/src/features/editor/.context/state-machines.md)
