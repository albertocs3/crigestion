---
name: prisma-guidelines
description: Prisma and database modeling guidance for CriGestión. Use when editing schema.prisma, designing relations, indexes, migrations, transactions, seeds, audit tables, soft delete behavior, efficient queries, Prisma Client usage, or PostgreSQL-backed persistence patterns.
---

# Prisma Guidelines

Use this skill when changing persistence through Prisma.

## Schema Rules

- Model business identifiers as `String @db.Uuid` with `@default(uuid())` unless a natural key is explicitly required.
- Use `@db.Timestamptz(3)` for instants.
- Use `Decimal` for money, never floating-point numbers.
- Add normalized unique fields for user-entered identifiers that must be case-insensitive.
- Keep Prisma model names PascalCase and mapped table names snake_case with `@@map`.
- Prefer explicit join models when the relationship has audit, protection, order, or metadata.

## Relations

- Use `onDelete: Restrict` for users, roles, audit, invoices, sessions, certificates, attachments, and fiscal records.
- Use cascade only for true child records without independent audit value.
- Never expose Prisma models directly as public API contracts.

## Indexes

- Add indexes for lookup fields, foreign keys used in filters, status queues, date ranges, and pagination cursors.
- Document indexes that Prisma cannot express directly, such as partial indexes, in the migration SQL and model docs.

## Migrations

- Do not edit migrations already applied outside a disposable local database.
- Use staged migrations for destructive changes.
- Do not place secrets, real certificates, real IBANs, or real credentials in migrations or seeds.
- Review generated SQL before production deployment.

## Transactions

- Use `prisma.$transaction` for operations that must commit atomically.
- Keep external calls outside database transactions.
- For critical numbering, invoicing, accounting, and session uniqueness, verify PostgreSQL constraints support the application rule.

## Soft Delete

- Prefer status fields for business entities that must remain historically visible.
- Use soft delete only when the deleted state is genuinely part of the lifecycle.
- Do not soft-delete audit records.

## Audit

- Write audit entries without secrets.
- Store stable event types.
- Include actor, entity, correlation id, and safe payload.

## Seeds

- Seeds must be idempotent.
- Seed only stable catalog data and development-safe records.
- Do not seed real passwords unless explicitly generated for local development and clearly documented.

## Efficient Queries

- Select only fields needed by the use case.
- Use pagination for lists.
- Avoid `include` trees that accidentally load sensitive or large data.
- Prefer projections/DTOs for read models.
