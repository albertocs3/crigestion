# ADR-0010: Autorizar mediante permisos y políticas validadas en servidor

## Estado

Aceptada.

## Contexto

CriGestión tendrá roles base y roles personalizados. Algunos datos económicos, costes, márgenes, configuración, contabilidad y acciones críticas solo estarán disponibles para determinados roles.

## Decisión

La autorización se implementará mediante permisos con formato `Modulo.Accion` y políticas evaluadas en servidor.

La interfaz podrá ocultar acciones no permitidas, pero la API será siempre la autoridad final.

## Alternativas consideradas

- Roles fijos en código: insuficiente para roles personalizados.
- Permisos solo en cliente: inseguro.
- Autorización ad hoc por endpoint: difícil de auditar y mantener.

## Consecuencias

- Los permisos se podrán versionar e invalidar al cambiar un rol.
- Las reglas contextuales se aplicarán en Application.
- Las pruebas de contrato deberán cubrir denegaciones.
- El modelo evita conceder acceso por accidente a datos sensibles solo porque una pantalla esté visible.
