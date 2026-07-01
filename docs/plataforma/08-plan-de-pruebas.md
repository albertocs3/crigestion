# Plan de pruebas de Plataforma

## 1. Proposito

Define las pruebas iniciales de Plataforma para Next.js, TypeScript, PostgreSQL y Prisma.

## 2. Suites

| Suite | Alcance | Herramienta prevista |
|---|---|---|
| Typecheck | Tipos TypeScript | `npm run typecheck` |
| Build | Build productivo | `npm run build` |
| Unitarias | Dominio y casos de uso | Vitest |
| Integracion | Prisma + PostgreSQL real | Vitest/Jest + base de prueba |
| Contrato | Route Handlers HTTP | Cliente HTTP de prueba |
| E2E web | Flujos de navegador | Playwright, pendiente |

## 3. Pruebas P0 de inicializacion

| ID | Escenario | Tipo | Prioridad |
|---|---|---|---|
| PLT-TP-001 | Inicializacion valida crea empresa, administrador, instalacion y auditoria | Integracion/Contrato | P0 |
| PLT-TP-002 | Segunda inicializacion devuelve 409 | Contrato | P0 |
| PLT-TP-003 | Fallo intermedio revierte la transaccion | Integracion | P0 |
| PLT-TP-004 | Seed de roles y permisos es idempotente | Integracion | P0 |
| PLT-TP-005 | La contrasena no queda en texto claro | Seguridad | P0 |

## 4. Verificaciones manuales iniciales

Hasta instalar Node/npm y definir runner:

- Revisar que `node` y `npm` estan disponibles.
- Ejecutar `npm install`.
- Ejecutar `npm run prisma:generate`.
- Ejecutar `npm run prisma:migrate`.
- Ejecutar `npm run typecheck`.
- Ejecutar `npm run build`.
- Arrancar `npm run dev`.
- Consultar `/api/health`.

## 5. Criterios de salida

1. TypeScript estricto sin errores.
2. Build correcto.
3. Migracion PostgreSQL desde cero.
4. API de inicializacion cubierta por contrato.
5. Transaccion de inicializacion cubierta contra PostgreSQL real.
6. E2E web definido antes de cerrar la primera rebanada.
