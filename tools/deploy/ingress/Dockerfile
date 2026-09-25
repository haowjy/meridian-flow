FROM caddy:2.10.2-alpine
COPY tools/deploy/ingress/Caddyfile /etc/caddy/Caddyfile
COPY tools/deploy/ingress/entrypoint.sh /usr/local/bin/meridian-ingress-entrypoint
RUN chmod +x /usr/local/bin/meridian-ingress-entrypoint
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/meridian-ingress-entrypoint"]
