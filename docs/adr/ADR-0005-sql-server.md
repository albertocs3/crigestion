# ADR-0005: Usar SQL Server como base de datos central

## Estado

Reemplazada por [ADR-0020](ADR-0020-postgresql.md).

## Contexto

SQL Server era la base elegida para la arquitectura .NET/WPF inicial.

## Decision anterior

Usar SQL Server como base de datos central.

## Motivo del reemplazo

El stack vigente usa Next.js, TypeScript y Prisma. La base central pasa a ser PostgreSQL, segun [ADR-0020](ADR-0020-postgresql.md).
