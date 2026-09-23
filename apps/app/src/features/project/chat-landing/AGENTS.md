# Project Chat landing

The project Chat landing is the composer and Continue, Favorite, and Recent feed
at `/p/{projectSlug}`. Its first Send navigates to `/p/{projectSlug}/chat/{uuid}`
before persisting in the background. It owns the landing composition and feed
presentation; route ownership remains in the parent project feature.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing the landing,
feed behavior, Home-backed query semantics, or row geometry.
