# ADR-0020: Usar PostgreSQL como base de datos central

## Estado

Aceptada.

## Contexto

La aplicacion necesita consistencia transaccional, consultas fiables, indices expresivos, datos JSON controlados y un motor compatible con despliegues web modernos.

## Decision

Se usara PostgreSQL como base de datos central.

## Alternativas consideradas

- SQL Server: solido, pero asociado a la arquitectura anterior .NET/WPF y con mayor friccion para el nuevo despliegue web.
- SQLite: adecuado para prototipos, insuficiente para concurrencia y operacion central.
- Base documental: no encaja con transacciones contables, facturacion e integridad relacional.

## Consecuencias

- Las migraciones se validan contra PostgreSQL real.
- Se usaran `uuid`, `jsonb`, `timestamptz`, indices y restricciones de PostgreSQL.
- Las copias y restauraciones se disenan para PostgreSQL.
