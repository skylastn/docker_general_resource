# Upgraded data dir now at 9.7 (immediately preceding LTS) — 26.7 accepts this hop.
# mysql:9.7 stays as the LTS fallback (revert after 26.7 = restore dump, no downgrade).
FROM mysql:latest

# Config in one layer (COPY --chmod replaces a separate chmod RUN layer)
COPY --chmod=0644 my.cnf /etc/mysql/conf.d/my.cnf

# Start MySQL
CMD ["mysqld"]
