# ADR-0006: Usar Entity Framework Core con SQL parametrizado cuando sea necesario

## Estado

Reemplazada por [ADR-0021](ADR-0021-prisma.md).

## Contexto

EF Core era el ORM elegido para la arquitectura .NET.

## Decision anterior

Usar Entity Framework Core como ORM principal.

## Motivo del reemplazo

El proyecto se adapta a TypeScript. El ORM vigente es Prisma, segun [ADR-0021](ADR-0021-prisma.md).
