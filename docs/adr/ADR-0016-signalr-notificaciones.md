# ADR-0016: Notificaciones en tiempo casi real

## Estado

Pendiente de revision.

## Contexto

La aplicacion debe mostrar notificaciones internas, algunas criticas, y mantener registro persistido. La arquitectura vigente es web con Next.js.

## Decision provisional

Las notificaciones se persistiran en PostgreSQL. La entrega inmediata se revisara entre WebSocket, Server-Sent Events, servicio gestionado o consulta periodica.

## Consecuencias

- La notificacion persistida es la fuente de verdad.
- La entrega en tiempo real mejora experiencia, pero no define el estado funcional.
- Se requiere ADR final antes de implementar notificaciones criticas.
