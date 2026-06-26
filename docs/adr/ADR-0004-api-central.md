# ADR-0004: Obligar al escritorio a operar siempre mediante API central

## Estado

Reemplazada por [ADR-0019](ADR-0019-nextjs-typescript.md).

## Contexto

La decision original protegia la base de datos de accesos directos desde un cliente WPF.

## Decision vigente equivalente

La UI web no accede directamente a la base de datos desde el navegador. Todo acceso a PostgreSQL ocurre en codigo server-only de Next.js mediante Prisma.

## Consecuencias

- Los componentes cliente no importan Prisma.
- Las acciones y endpoints validan autorizacion en servidor.
