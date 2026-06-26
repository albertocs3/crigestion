# ADR-0001: Usar monolito modular

## Estado

Aceptada.

## Contexto

CriGestión necesita cubrir varios modulos funcionales con fuerte consistencia entre facturacion, contabilidad, inventario, cobros y auditoria.

## Decision

Se usara un monolito modular.

Cada modulo mantiene limites claros de dominio, aplicacion, infraestructura y presentacion, pero se despliega dentro de la misma solucion Next.js.

## Consecuencias

- Las transacciones economicas pueden mantenerse ACID dentro de PostgreSQL.
- El despliegue inicial es mas simple que con microservicios.
- Los limites entre modulos deben protegerse mediante estructura, revisiones y pruebas.
