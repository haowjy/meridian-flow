# domains/export FUTURE

## Folder, Work and chat names skip the per-person access check

Export filters documents through `FileAccess.listAccess`, but folder names and the Work
and chat folders built from sources go into the archive unfiltered. That is harmless
while export is owner-only (`requireProjectOwner`) and the only grants are owner grants.
When per-folder grants or non-owner export arrive, filter folders, Works and chats by the
same access check, or their names leak into the archive.
