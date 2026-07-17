# domains/context — required follow-up

## Adopt shared context-entry validation on remaining mutations

The move route validates and normalizes names and paths through
`@meridian/contracts/context-entry-validation`. Migrate the context create,
create-untitled, rename, and upload route boundaries to the same reason-coded
schema so every mutation rejects padded, empty, reserved, and invalid segments
consistently. This was explicitly outside the move-route slice.
