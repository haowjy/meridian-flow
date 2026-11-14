# A command that may have landed

The writer does something, the app shows it at once, and the request that tells the server can
end three ways: accepted, refused, or unanswered. The third is the one that shapes the machine.
A timeout, a dropped connection, a 5xx or an unreadable body says nothing about whether the
server acted.

```mermaid
stateDiagram-v2
  [*] --> local: the writer acts, and sees the result
  local --> sent: identity saved, then the request goes out
  sent --> confirmed: the server accepts
  sent --> refused: the server answers no, in a form it defines
  sent --> uncertain: no usable answer
  uncertain --> sent: replay with the same identity, or look the identity up
  refused --> local: the writer retries, as a new command
  confirmed --> [*]
  refused --> [*]: dismissed
```

The rules, and why:

- **The command's id is made on the client and saved before the first send.** A replay then
  carries the same id, and the server recognises it and does not act twice. A command that is sent before it is saved
  can be lost by a reload while the server keeps its effect.
- **Only a structured refusal counts as refused.** Anything else is `uncertain`. Calling an
  unanswered request a failure lets the writer redo something the server already did: a
  duplicate message, a second project, a change applied twice.
- **`uncertain` is resolved by asking again**, by replaying the same request or by looking the
  identity up, never by guessing. Until it resolves, the command stays and whatever is queued
  behind it waits.
- **A retry of an unanswered command keeps its id**, so the server does not act twice.
- **The server stores the answer** so a replay gets the same one.

## Where the instances differ

No instance follows every rule. Before copying one, check what it does:

| Instance | Survives a reload | Retries by itself | Retry after a refusal |
|---|---|---|---|
| Chat submission | Yes, in the account's journal | Yes, the driver replays | New submission id |
| Creation record | No, memory only | No; one lookup, then `failed` | Same id |
| Import creation | No, memory only | No | Same import id |
| Apply click command | No, memory only | Yes: 1, 2, 4 seconds, then `stalled` | None: a final refusal settles it |
| Queued control | No, memory only | No | Same id; a refusal and no answer are both `failed` |
| Hand-back and Stop | Yes, in the host's command store | No; Retry or resume | None: a refusal drops the command |
| Server hold | Yes, in the replica | Yes, by the namespace runner | Same id after a refused create; a new id once `spent` |

Four keep the command in memory only, so a reload forgets it while the server may keep its
effect. Two also break the second rule. A creation record that gets no answer and whose one
lookup finds nothing becomes `failed`, although the create may still land. A queued control
does not tell a refusal from no answer; both are `failed`, and Retry resends under the same
id.

## Instances

| Machine | Where | What it calls the unanswered state |
|---|---|---|
| [Chat submission](../../apps/app/src/client/chat-submissions/.context/state-machines.md) | App | `posted`, with no answer |
| [Creation record](../../apps/app/src/client/creation/.context/state-machines.md) | App | resolved inside the request by `createWithRecovery` |
| [Import creation](../../apps/app/src/features/import/.context/state-machines.md) | App | `uncertain` |
| [Apply click command](../../apps/app/src/features/draft-review/.context/state-machines.md) | App | `retrying`, then `stalled` |
| [Queued control](../../apps/app/src/features/chat/.context/state-machines.md) | App | `failed`, retried under the same id |
| [Hand-back and Stop](../../packages/thread-client/.context/state-machines.md) | thread-client | `ambiguous` |
| [User-turn admission](../../apps/server/server/domains/runtime/.context/state-machines.md) | Server | the server half: `pending` until the turn commits |
| [Branch command](../../apps/server/server/domains/collab/.context/state-machines.md) | Server | the server half: `pending` until the effect commits |
