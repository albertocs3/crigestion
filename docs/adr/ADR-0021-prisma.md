# ADR-0021: Usar Prisma como ORM y herramienta de migracion

## Estado

Aceptada.

## Contexto

El proyecto necesita acceso a datos tipado en TypeScript, migraciones versionadas y una forma clara de mantener el modelo fisico inicial.

## Decision

Se usara Prisma para:

- Definir el modelo en `prisma/schema.prisma`.
- Generar Prisma Client.
- Crear y aplicar migraciones.
- Ejecutar seed controlado.

## Alternativas consideradas

- SQL manual exclusivamente: maximo control, pero mas coste y menos tipado.
- Drizzle: buena alternativa TypeScript, pero Prisma encaja mejor con el arranque rapido y schema centralizado.
- TypeORM: menos alineado con el stack Next.js moderno.

## Consecuencias

- No se exponen modelos Prisma como contrato publico.
- Las migraciones aplicadas no se editan.
- Las consultas criticas se revisan con explain/indices y pueden usar SQL parametrizado desde Prisma si es necesario.
