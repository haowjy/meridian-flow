# Example architecture

A toy map for the architecture map engine: a writer publishes a post through an `api` service.
Copy this directory's shape for a real project; `tools/architecture-map/README.md` has the config
reference.

## The pages

- [System](system.md): who uses the service and what happens when they publish.

[Dependencies](dependencies.md): the import rules, and the places the code breaks them.
[Journeys](journeys/index.md): what the writer does and sees, one card per step.

## Editing

A change that adds or moves something the map names updates the page in the same commit.
`node tools/architecture-map/check.mjs tools/architecture-map/example/map.config.mjs` fails on a
path that has disappeared, a directory no box covers, a service with no page, or a dependency break
with no row.
