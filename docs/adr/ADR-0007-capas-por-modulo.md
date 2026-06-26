# ADR-0007: Separar cada módulo en Domain, Application, Infrastructure, Contracts y Api

## Estado

Aceptada.

## Contexto

El monolito modular necesita límites internos claros para que los módulos evolucionen sin mezclarse. Plataforma será el primer módulo implementado y debe marcar el patrón para los demás.

## Decisión

Cada módulo se estructurará, cuando su tamaño lo justifique, en:

- `Domain`.
- `Application`.
- `Infrastructure`.
- `Contracts`.
- `Api`.

## Alternativas consideradas

- Un proyecto por módulo: más simple al principio, pero menos control de dependencias.
- Capas globales para toda la solución: facilita compartir código, pero diluye propiedad funcional.
- Arquitectura hexagonal estricta con muchos adaptadores desde el primer día: puede sobredimensionar el inicio.

## Consecuencias

- Las referencias permitidas quedan documentadas y se probarán automáticamente.
- `Domain` no dependerá de tecnología.
- `Contracts` no expondrá entidades internas.
- `Api` será un adaptador HTTP delgado.
- La estructura inicial tendrá más proyectos, pero el coste se compensa con claridad y mantenibilidad.

