# ADR-0022: Usar jobs Node.js para trabajo de fondo

## Estado

Aceptada.

## Contexto

La arquitectura Next.js necesita procesar tareas diferidas como Outbox, notificaciones, caducidades, limpieza, reintentos y copias.

## Decision

Se usaran jobs Node.js separados del proceso interactivo cuando una tarea no deba ejecutarse dentro de una peticion HTTP.

## Alternativas consideradas

- Ejecutar todo en Route Handlers: simple, pero fragil para tareas largas o reintentos.
- Cron externo sin codigo compartido: operativo, pero dispersa reglas.
- Cola externa desde el inicio: potente, pero anade complejidad antes de necesitarla.

## Consecuencias

- Los jobs comparten modulos server-only con la aplicacion.
- El Outbox se almacena en PostgreSQL.
- Cada job debe ser idempotente y observable.
