# ADR-0019: Usar Next.js y TypeScript como plataforma

## Estado

Aceptada.

## Contexto

CriGestión pasa de una aplicacion de escritorio con API separada a una aplicacion web. Se necesita una base que permita UI, endpoints HTTP, renderizado server-side, validacion tipada y despliegue sencillo.

## Decision

La plataforma principal sera Next.js con TypeScript estricto.

Se usara:

- App Router para rutas, layouts y paginas.
- Route Handlers para API.
- React Server Components por defecto.
- Client Components solo para interaccion de UI.
- TypeScript estricto para reducir errores de contrato.

## Alternativas consideradas

- Mantener .NET/WPF: queda descartado por el cambio de objetivo tecnologico.
- React SPA + API separada: aumenta despliegues y duplicacion de contratos al inicio.
- Framework backend separado: util mas adelante, pero innecesario para la primera version.

## Consecuencias

- El cliente ya no se instala en cada puesto.
- La autorizacion se valida siempre en servidor.
- Prisma y secretos solo pueden usarse en codigo server-only.
- Las pruebas E2E se orientan a navegador.
