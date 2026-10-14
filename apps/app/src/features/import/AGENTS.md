# features/import

Upload first. The browser lists paths, sizes and modified times, uploads bytes,
then a durable server job organizes and reveals everything atomically. Nothing
but one pending folder root exists in the tree before reveal. Loose files and
routed exports have no pending rows. Documents are born complete.

`ImportsProvider` at the authenticated root owns one account-lifetime coordinator;
project `ImportProvider` owns only pick/drop doors. Navigation never stops an
upload. File handles are private and ephemeral. The open list is server truth;
BroadcastChannel only nudges refresh. Continue reads fresh detail, matches only
awaiting entries by root/path and size/modified time, and explicitly asks before
skipping missing files. The browser never hashes or sniffs file contents.

`ImportToasts` owns the writer-facing state and inline confirmation. Stop in any
phase before reveal discards everything; a reveal winning the race reports that
it finished. Failed organize offers Try again or Stop, never partial import.
A clean completion acknowledges only after six visible seconds. Local refusals
close locally; durable terminal acknowledgements apply across tabs.

`pending-roots.ts` is the five-rule projection. Catalog identity wins; historical
`root.created` is not liveness. The coordinator remembers observed roots across
phone navigation. Pending roots have no URI or document capabilities: activating
one reveals its toast, never opens an editor. No import state enters the replica.

Copy goes through Lingui and `reason-copy.ts`; server codes are not sentences.
See [deferred browser coverage](.context/TODO.md) and the [runtime recipe](../../../../../docs/qa/README.md).
