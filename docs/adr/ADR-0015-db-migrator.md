# ADR-0015: Aplicar migraciones mediante herramienta dedicada

## Estado

Reemplazada por [ADR-0021](ADR-0021-prisma.md).

## Contexto

La decision original definia un migrador .NET dedicado.

## Decision vigente equivalente

Las migraciones se gestionan con Prisma Migrate:

- Desarrollo: `npm run prisma:migrate`.
- Produccion: `npm run prisma:deploy`.

Las migraciones no se ejecutan desde el navegador ni contienen secretos.
