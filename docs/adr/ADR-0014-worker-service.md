# ADR-0014: Usar un Worker Service para trabajos de fondo

## Estado

Reemplazada por [ADR-0022](ADR-0022-jobs-node.md).

## Contexto

La decision original usaba un .NET Worker Service separado de la API.

## Decision vigente equivalente

Los trabajos de fondo se ejecutan como jobs Node.js separados del trafico interactivo cuando no deban vivir dentro de una peticion HTTP.
