# ADR-0013: Auditoria append-only

## Estado

Aceptada.

## Contexto

CriGestion procesa autenticacion, permisos, datos fiscales, operaciones
economicas, certificados, copias y restauraciones. La investigacion de una
incidencia requiere conservar quien hizo cada accion relevante, cuando la hizo
y cual fue su resultado, sin almacenar secretos ni permitir que el runtime
reescriba el historial.

## Decision

La auditoria se persiste como eventos append-only en PostgreSQL.

- La aplicacion solo crea eventos; no ofrece casos de uso para actualizarlos o
  eliminarlos.
- Cada evento usa un tipo estable, instante UTC, actor cuando existe, empresa y
  metadatos minimizados.
- Los metadatos no contienen contrasenas, tokens, claves, certificados, IBAN
  completos, contenido de adjuntos ni otros secretos.
- Los roles runtime de staging y produccion no reciben `UPDATE` ni `DELETE`
  sobre `audit_events`.
- Las consultas y exportaciones de auditoria requieren permiso server-side y
  quedan sujetas a minimizacion y trazabilidad.
- Los procesos tecnicos sin actor humano usan un actor de sistema identificable
  y conservan correlacion con la operacion de origen.

La retencion o purga legal, si fuera necesaria, se ejecutara mediante un
procedimiento administrativo separado, autorizado y auditable; nunca mediante
el runtime ordinario.

## Consecuencias

- Los errores de escritura de auditoria en operaciones criticas deben tratarse
  segun la atomicidad definida por cada caso de uso.
- Las correcciones se representan con eventos compensatorios, no editando el
  evento original.
- Los backups y drills de restauracion incluyen `audit_events`.
- El crecimiento de la tabla requiere indices de consulta y una politica de
  retencion definida antes de alcanzar volumen operativo significativo.

## Controles relacionados

- ADR-0009 para autenticacion y sesiones.
- ADR-0010 para autorizacion server-side.
- ADR-0017 para copias y restauracion.
- `docs/seguridad/02-owasp-top-10.md`, especialmente A01, A08, A09 y A10.
