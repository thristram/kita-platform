# KitaCon

KitaCon is a production-shaped fandom and real-world event intelligence platform. This milestone contains the P0 operator Console, a P1 consumer discovery surface, shared contracts, the external auth boundary, deterministic canonical/media resolution logic, and the PostgreSQL foundation migration.

## Product surfaces

- `/` — KitaCon Console: operational overview, events, media, sources, jobs/workers, and candidate review.
- `/discover` — KitaCon consumer discovery: personalized event recommendations and saved state.

The product follows three hard data boundaries:

```text
raw source evidence -> reviewed canonical truth -> disposable public projections
```

AI results enter Candidates and never mutate canonical records directly. Manual `PINNED`/`PREFERRED` decisions survive later crawls. Crawled media defaults to `INTERNAL_ONLY`; only `PUBLIC_READY` media can enter consumer projections.

See `docs/architecture.md` and `infra/sql/0001_kita_foundation.sql` for the implementation boundary and canonical data foundation.
