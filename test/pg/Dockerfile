# Test-only PostgreSQL image for schema-flow's Vitest suite.
#
# Stock postgres:16 plus the two third-party extensions schema-flow's
# partitioned-table support drives: pg_partman (declarative rolling partition
# maintenance) and pg_cron (the maintenance schedule). Both come from the PGDG
# apt repo that the official image already configures. They are NOT in the base
# image because they are not contrib extensions.
#
# pg_cron must be in shared_preload_libraries to load — the container is started
# with `-c shared_preload_libraries=pg_cron` in vitest.global-setup.ts.
FROM postgres:16
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-partman postgresql-16-cron \
 && rm -rf /var/lib/apt/lists/*
