# ADR-0016: Notificaciones en tiempo casi real

## Estado

Aceptada.

## Contexto

La aplicacion debe mostrar notificaciones internas, algunas criticas, y mantener registro persistido. La arquitectura vigente es web con Next.js.

El nombre del archivo se conserva por trazabilidad histórica; la decisión aceptada no adopta SignalR.

## Decision

PostgreSQL es la fuente de verdad y la notificacion se crea en la misma transaccion que el hecho funcional. La primera entrega se actualiza al navegar o recargar y no introduce WebSocket, Server-Sent Events ni polling automatico.

Las incidencias de prioridad `URGENT` generan avisos de gravedad `URGENT`, no `CRITICAL`. Por tanto no activan ventana emergente. Las notificaciones `CRITICAL`, su presentacion obligatoria y la entrega casi inmediata quedan reservadas para una ampliacion con outbox transaccional y un canal web evaluado de forma independiente.

## Consecuencias

- La notificacion persistida es la fuente de verdad.
- El estado se refresca al navegar o recargar; la UI no promete tiempo real.
- Abrir el elemento relacionado no marca automaticamente la notificacion.
- Una futura entrega inmediata solo transportara una señal; nunca sustituira la lectura autorizada desde PostgreSQL.
- Las notificaciones criticas no se implementan en esta primera entrega.
