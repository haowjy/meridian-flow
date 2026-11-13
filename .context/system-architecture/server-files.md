# Server: files

The domains that move bytes. An import: the browser uploads the chosen files to `import` (1), which stages their bytes in `storage` (2) and uses `file-intake` to classify them and make image previews (3); a server-owned organizer then writes the whole tree into the documents group and reveals it at once (4). An export runs the other way: `export` reads the document inventory, checks the grant, reads bytes from `storage` and streams a ZIP to the browser. Back to the [server](server.md); the import as calls: [an import](flows/an-import.md).

```mermaid
flowchart LR
  import["import<br/><small>uploads a folder and builds its tree</small>"]:::domain
  export["export<br/><small>streams a project as a ZIP</small>"]:::domain
  file-intake["file-intake<br/><small>classifies files, makes previews</small>"]:::domain
  storage["storage<br/><small>puts and gets bytes</small>"]:::domain
  browser["browser<br/><small>the writer's tab</small>"]:::context
  documents["documents<br/><small>the writer's documents</small>"]:::context
  conversation["conversation<br/><small>the model's image attachments</small>"]:::context
  objectstore["objectstore<br/><small>file bytes</small>"]:::context
  browser -->|"http: 1. uploads the chosen files"| import
  import -->|"port: 2. stages the bytes"| storage
  import -->|"call: 3. classifies and makes previews"| file-intake
  import -->|"port: 4. writes the whole tree at once"| documents
  file-intake -->|"port: stores previews"| storage
  storage -->|"files: puts and gets"| objectstore
  browser -->|"http: asks for the ZIP"| export
  export -->|"port: reads the document inventory"| documents
  export -->|"port: reads file bytes"| storage
  export -->|"http: streams the ZIP"| browser
  conversation -->|"port: loads image previews"| file-intake
```

## import

Upload-first import of a folder or files into a project.

The browser uploads bytes, then a durable server organizer reveals the whole tree at once. Import ids are permanent tombstones.

- Kind: domain
- Paths: `apps/server/server/domains/import`
- Docs: [CONTEXT](../../apps/server/server/domains/import/.context/CONTEXT.md), [AGENTS](../../apps/server/server/domains/import/AGENTS.md)
- Machines: [import](../../apps/server/server/domains/import/.context/state-machines.md)

## export

Streams a project as a ZIP of live documents.

Drafts are not included. The inventory and addresses are captured before any content is read. There is no ZIP64, so it refuses near 4 GiB.

- Kind: domain
- Paths: `apps/server/server/domains/export`
- Docs: [CONTEXT](../../apps/server/server/domains/export/.context/CONTEXT.md), [AGENTS](../../apps/server/server/domains/export/AGENTS.md)
- Drift: `export/AGENTS.md` says to go through Context's public index, but `export` imports `context/adapters/catalog-file-mapper.ts`.

## file-intake

Classifies uploaded files and makes image previews.

HEIC, BMP and TIFF become WebP previews on a small worker pool. `sharp` is native, so build on the target platform.

- Kind: domain
- Paths: `apps/server/server/domains/file-intake`

## storage

`ObjectStorePort`: put, get, stream, copy, sign and list bytes.

Results are tagged ok or error and never throw. It has no domain meaning: which bytes mean what is the callers' business.

- Kind: domain
- Paths: `apps/server/server/domains/storage`
- Docs: [CONTEXT](../../apps/server/server/domains/storage/.context/CONTEXT.md)

## browser

The writer's browser tab.

Holds the HTTP client, the thread socket and the Yjs socket.

- Kind: context
- See: [browser](system.md#browser)

## documents

The writer's documents.

The group of `collab`, `context` and `file-policy`.

- Kind: context
- See: [documents](server.md#documents)

## conversation

Chat turns and the model.

The group of `runtime`, `threads`, `notices` and `packages`.

- Kind: context
- See: [conversation](server.md#conversation)

## objectstore

Where file bytes live.

Behind `ObjectStorePort`.

- Kind: context
- See: [objectstore](system.md#objectstore)
