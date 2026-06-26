---
name: postgresql-best-practices
description: PostgreSQL guidance for CriGestión. Use when designing indexes, EXPLAIN ANALYZE reviews, JSONB usage, full text search, UUID strategies, partitions, backups, query optimization, database constraints, migrations SQL, or production PostgreSQL operations.
---

# PostgreSQL Best Practices

Use this skill when database behavior matters beyond Prisma syntax.

## Constraints First

- Enforce core invariants in PostgreSQL when possible.
- Use unique constraints for business uniqueness.
- Use check constraints for bounded status, positive amounts, and singleton keys when Prisma cannot fully express the invariant.
- Use partial unique indexes for conditional uniqueness, such as one active session per user.

## Indexes

- Index columns used in joins, filters, sorting, and queue polling.
- Prefer composite indexes that match real query predicates.
- Avoid indexing every column.
- Revisit indexes after real query plans exist.

## EXPLAIN ANALYZE

Use `EXPLAIN (ANALYZE, BUFFERS)` for slow queries.

Check:

- Sequential scans on large tables.
- Sorts spilling to disk.
- Bad row estimates.
- Missing composite indexes.
- N+1 query patterns from the application.

## JSONB

- Use JSONB for flexible payloads, audit metadata, external responses, and versioned integration data.
- Do not hide core relational fields in JSONB.
- Add GIN indexes only for real JSONB query patterns.

## Full Text Search

- Use PostgreSQL FTS for names, descriptions, incidents, and notes when simple `ILIKE` becomes insufficient.
- Keep normalized search fields for common exact or prefix searches.

## UUID

- UUIDs are the default id type for CriGestión.
- Avoid exposing sequential internals as public identifiers.

## Partitions

Consider partitioning only for large append-only or time-series tables:

- Audit events.
- Outbox/inbox history.
- Login attempts.
- Notifications.

Do not partition early without expected volume.

## Backups

- Production requires tested PostgreSQL backups and restore drills.
- Backups must include database, uploaded files, certificate metadata, encrypted secrets, and key material needed for recovery.
- A backup that has not been restored is not proven.

## Optimization

- Optimize after measuring.
- Prefer schema/index fixes over application-side filtering.
- Keep long external calls outside transactions.
