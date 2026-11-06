# @meridian/www

The public, unauthenticated marketing site.

`@meridian/design-tokens` is the only runtime package import. A route that needs
domain or runtime packages belongs in `@meridian/app`, as does anything
authenticated.
