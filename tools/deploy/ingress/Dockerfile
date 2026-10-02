FROM caddy:2.10.2-alpine
COPY tools/deploy/ingress/Caddyfile /etc/caddy/Caddyfile
ARG MERIDIAN_VERSION=unknown
ARG MERIDIAN_RELEASE_SHA=unknown
ENV MERIDIAN_VERSION=${MERIDIAN_VERSION} MERIDIAN_RELEASE_SHA=${MERIDIAN_RELEASE_SHA}
LABEL org.opencontainers.image.source="https://github.com/haowjy/meridian-flow" \
      org.opencontainers.image.version=${MERIDIAN_VERSION} \
      org.opencontainers.image.revision=${MERIDIAN_RELEASE_SHA}
EXPOSE 8080
