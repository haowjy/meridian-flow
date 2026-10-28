# Meridian Flow Postgres: postgres:16 plus pg_bigm (btree_gin and pg_trgm ship with contrib).
# Writer project search needs all three. Dev (tools/dev/docker-compose.yml) builds this
# image; the release pipeline builds the same file and promotes it by digest
# (kb/decisions/platform/hosting/release-promotion.md). The image tag in docker-compose.yml
# carries the pg_bigm version, so bumping the pin in install-pg-bigm.sh means bumping that tag.
FROM postgres:16

COPY install-pg-bigm.sh /tmp/install-pg-bigm.sh
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential postgresql-server-dev-16 libicu-dev ca-certificates curl \
    && /tmp/install-pg-bigm.sh \
    && apt-get purge -y --auto-remove build-essential postgresql-server-dev-16 libicu-dev ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* /tmp/install-pg-bigm.sh

# On the command line, not postgresql.conf: a data volume created before this image
# keeps its old postgresql.conf. A command override must repeat this flag.
CMD ["postgres", "-c", "shared_preload_libraries=pg_bigm"]
