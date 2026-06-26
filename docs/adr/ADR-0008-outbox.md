# ADR-0008: Usar Outbox transaccional para trabajo diferido e integraciones

## Estado

Aceptada.

## Contexto

Algunas operaciones deben confirmar cambios funcionales y despues ejecutar acciones externas como correo, VeriFactu, notificaciones o integraciones bancarias.

## Decision

Los mensajes diferidos se guardaran en PostgreSQL dentro de la misma transaccion que el cambio funcional.

Un job Node.js procesara la Outbox con reintentos, trazabilidad e idempotencia.

## Consecuencias

- No se mantiene una transaccion abierta durante llamadas externas.
- Los consumidores deben ser idempotentes.
- Los mensajes pendientes y fallidos son observables.
