# ADR-0012: Guardar adjuntos en repositorio protegido y metadatos en base de datos

## Estado

Aceptada.

## Contexto

CriGestión debe conservar documentos y adjuntos con permisos, trazabilidad, integridad y posibilidad de copia/restauracion.

## Decision

Los archivos se guardaran en un repositorio protegido fuera de `public/`. PostgreSQL almacenara metadatos, hash, estado, permisos, relacion funcional y trazabilidad.

## Consecuencias

- Las descargas pasan por endpoint autorizado.
- No se exponen rutas fisicas.
- Las copias deben incluir base de datos y repositorio de adjuntos.
