# Registro de decisiones arquitectonicas

## Proposito

Este directorio contiene las decisiones arquitectonicas relevantes de CriGestión.

## Estados

- `Propuesta`: decision pendiente de validar.
- `Aceptada`: decision vigente.
- `Reemplazada`: decision sustituida por otra posterior.
- `Obsoleta`: decision ya no aplica.

## Indice

| ADR | Estado | Decision |
|---|---|---|
| [ADR-0001](ADR-0001-monolito-modular.md) | Aceptada | Usar monolito modular |
| [ADR-0002](ADR-0002-dotnet-8.md) | Reemplazada | Sustituida por ADR-0019 |
| [ADR-0003](ADR-0003-wpf-desktop.md) | Reemplazada | Sustituida por ADR-0019 |
| [ADR-0004](ADR-0004-api-central.md) | Reemplazada | Sustituida por aplicacion web Next.js |
| [ADR-0005](ADR-0005-sql-server.md) | Reemplazada | Sustituida por ADR-0020 |
| [ADR-0006](ADR-0006-ef-core.md) | Reemplazada | Sustituida por ADR-0021 |
| [ADR-0007](ADR-0007-capas-por-modulo.md) | Aceptada | Separar cada modulo por dominio, aplicacion, infraestructura y presentacion |
| [ADR-0008](ADR-0008-outbox.md) | Aceptada | Usar Outbox transaccional para trabajo diferido e integraciones |
| [ADR-0009](ADR-0009-autenticacion-sesiones.md) | Aceptada | Usar sesiones web con cookie segura y token opaco |
| [ADR-0010](ADR-0010-autorizacion-permisos.md) | Aceptada | Autorizar mediante permisos y politicas validadas en servidor |
| [ADR-0011](ADR-0011-utc-europe-madrid.md) | Aceptada | Persistir instantes en UTC y presentar fechas en Europe/Madrid |
| [ADR-0012](ADR-0012-adjuntos-ficheros.md) | Aceptada | Guardar adjuntos en repositorio protegido y metadatos en base de datos |
| [ADR-0013](ADR-0013-auditoria-append-only.md) | Aceptada | Mantener auditoria append-only |
| [ADR-0014](ADR-0014-worker-service.md) | Reemplazada | Sustituida por ADR-0022 |
| [ADR-0015](ADR-0015-db-migrator.md) | Reemplazada | Migraciones gestionadas con Prisma Migrate |
| [ADR-0016](ADR-0016-signalr-notificaciones.md) | Pendiente de revision | Adaptar a WebSocket/SSE o polling web |
| [ADR-0017](ADR-0017-copias-restauracion.md) | Aceptada | Gestionar copias completas y restauracion en modo controlado |
| [ADR-0018](ADR-0018-verifactu-adaptador.md) | Aceptada | Aislar VeriFactu detras de un adaptador versionado |
| [ADR-0019](ADR-0019-nextjs-typescript.md) | Aceptada | Usar Next.js y TypeScript como plataforma |
| [ADR-0020](ADR-0020-postgresql.md) | Aceptada | Usar PostgreSQL como base de datos central |
| [ADR-0021](ADR-0021-prisma.md) | Aceptada | Usar Prisma como ORM y herramienta de migracion |
| [ADR-0022](ADR-0022-jobs-node.md) | Aceptada | Usar jobs Node.js para trabajo de fondo |
| [ADR-0023](ADR-0023-verifactu-modalidad-y-contrato-v1.md) | Aceptada | Adoptar modalidad VERI*FACTU y contrato fiscal V1 |

## Reglas de mantenimiento

1. Una decision aceptada no se edita para cambiar su sentido; se crea un ADR nuevo que la reemplace.
2. Las correcciones de redaccion o enlaces si pueden hacerse sobre el ADR existente.
3. Si una decision afecta a reglas funcionales, debe actualizarse tambien la documentacion funcional correspondiente.
4. Si una decision afecta a estructura de codigo, debe actualizarse [Estructura inicial de la solucion Next.js](../06-estructura-solucion-dotnet.md).
5. Si una decision afecta al despliegue u operacion, debe actualizarse [Arquitectura tecnica general](../05-arquitectura-tecnica.md).
