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
| Contrato | Route Handlers HTTP | Vitest con `Request`/`Response` |
| E2E web | Flujos de navegador | Playwright |

## 3. Pruebas P0 de inicializacion

| ID | Escenario | Tipo | Prioridad |
|---|---|---|---|
| PLT-TP-001 | Inicializacion valida crea empresa, administrador, instalacion y auditoria | Integracion/Contrato | P0 |
| PLT-TP-002 | Segunda inicializacion devuelve 409 | Contrato | P0 |
| PLT-TP-003 | Fallo intermedio revierte la transaccion | Integracion | P0 |
| PLT-TP-004 | Seed de roles y permisos es idempotente | Integracion | P0 |
| PLT-TP-005 | La contrasena no queda en texto claro | Seguridad | P0 |

## 4. Cobertura implementada

- `tests/platform/installation.test.ts`: inicializacion transaccional, idempotencia, auditoria sin secretos y rechazo de segunda inicializacion.
- `tests/platform/installation-routes.test.ts`: contrato HTTP de estado e inicializacion, errores estables, idempotencia, Origin y rate limit.
- `tests/platform/http.test.ts`: politica compartida de validacion de origen, `APP_BASE_URL` y fallback de URL en produccion.
- `tests/platform/auth-config.test.ts`: configuracion efectiva de cookie de sesion `Secure` y `SameSite`.
- `tests/platform/auth.test.ts`: login, sesion opaca, CSRF, bloqueo, logout, cambio de contrasena sin auditar secretos y limpieza de sesiones expiradas antes de abrir una nueva.
- `tests/platform/auth-routes.test.ts`: contrato HTTP de login, sesion, CSRF, logout, cambio de contrasena y cookie `HttpOnly`.
- `tests/platform/sessions.test.ts`: listado de sesiones activas sin material de token, revocacion remota y bloqueo de revocacion propia.
- `tests/platform/sessions-routes.test.ts`: contrato HTTP de sesiones activas, permisos, CSRF y errores estables de revocacion.
- `tests/platform/users.test.ts`: creacion, listado DTO, nombres reservados, permisos, cambio de estado y cambio de rol.
- `tests/platform/users-roles-routes.test.ts`: contrato HTTP de usuarios y roles, edicion de permisos, permisos, CSRF, validacion, conflictos y DTOs sin secretos.
- `tests/platform/roles.test.ts`: creacion, duplicados, listado, permisos insuficientes y revocacion de sesiones al cambiar permisos de rol.
- `tests/e2e/platform-install-login-logout.spec.ts`: flujo navegador de redireccion por instalacion, login, sesion activa, logout y permisos denegados.

## 5. Verificaciones manuales iniciales

- Revisar que `node` y `npm` estan disponibles.
- Ejecutar `npm install`.
- Ejecutar `npm run prisma:generate`.
- Ejecutar `npm run prisma:migrate`.
- Ejecutar `npm run typecheck`.
- Ejecutar `npm run build`.
- Ejecutar `npm run test:e2e`.

## 6. Criterios de salida

1. TypeScript estricto sin errores.
2. Build correcto.
3. Migracion PostgreSQL desde cero.
4. API de inicializacion cubierta por contrato.
5. Transaccion de inicializacion cubierta contra PostgreSQL real.
6. E2E web del flujo inicial ejecutado con Playwright.
