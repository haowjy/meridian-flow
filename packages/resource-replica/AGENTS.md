# Resource replica

Pure resource metadata policy belongs here; browser storage, HTTP, Yjs session
objects, React and navigation belong in app adapters. Consumers use the package
public export rather than reaching into its implementation.

Catalog replay installs whole commits. Its cursor and entries describe one
checkpoint; a scope entry disappearing does not prove that a document was
deleted globally. Resource content has its own Yjs persistence authority.
