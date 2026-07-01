# Backlog tecnico: primera rebanada vertical

## 1. Proposito

Este documento convierte la primera rebanada vertical de Plataforma en trabajo tecnico planificable para Next.js, TypeScript, PostgreSQL y Prisma.

La rebanada inicial implementa:

`PLT-CU-001 - Inicializar el sistema`

## 2. Objetivo

Al terminar esta rebanada:

1. La app Next.js compila.
2. Prisma crea la base PostgreSQL.
3. `GET /api/platform/installation` informa si el sistema requiere inicializacion.
4. `POST /api/platform/installation/initialize` inicializa una instalacion nueva.
5. La pagina `/platform/installation` muestra el estado.
6. La inicializacion crea empresa, primer administrador, roles/permisos base y auditoria minima.
7. La contrasena inicial nunca queda en texto legible.
8. La operacion es transaccional e idempotente.
9. Una segunda inicializacion se rechaza.

## 3. Decisiones aplicadas

| ADR | Impacto |
|---|---|
| [ADR-0019](adr/ADR-0019-nextjs-typescript.md) | La rebanada se implementa en Next.js y TypeScript. |
| [ADR-0020](adr/ADR-0020-postgresql.md) | La persistencia usa PostgreSQL. |
| [ADR-0021](adr/ADR-0021-prisma.md) | El modelo y las migraciones usan Prisma. |
| [ADR-0022](adr/ADR-0022-jobs-node.md) | La Outbox queda preparada para jobs Node.js. |

## 4. Backlog

### EPIC-PVS-001 - Base ejecutable

| ID | Tarea | Resultado | Verificacion |
|---|---|---|---|
| PVS-001 | Crear `package.json` y configuracion raiz | Scripts npm, TypeScript y Next.js | `npm install` |
| PVS-002 | Crear estructura App Router | `app/`, layout, pagina inicial y estilos | `npm run dev` |
| PVS-003 | Configurar Prisma | `prisma/schema.prisma` y `lib/prisma.ts` | `npm run prisma:generate` |
| PVS-004 | Configurar PostgreSQL local | `.env` con `DATABASE_URL` | `npm run prisma:migrate` |

### EPIC-PVS-002 - Persistencia inicial

| ID | Tarea | Resultado | Verificacion |
|---|---|---|---|
| PVS-005 | Modelar instalacion | `Installation` en Prisma | Migracion creada |
| PVS-006 | Modelar empresa | `Company` con NIF unico | Restriccion en PostgreSQL |
| PVS-007 | Modelar usuario administrador | `User` con `passwordHash` | No hay texto claro |
| PVS-008 | Modelar reserva de nombres | `ReservedUserName` evita reutilizacion | Nombre normalizado unico |
| PVS-009 | Modelar roles y permisos | `Role`, `Permission`, `RolePermission` | Seed idempotente |
| PVS-010 | Modelar sesiones e intentos | `Session`, `LoginAttempt` | Base preparada para login seguro |
| PVS-011 | Modelar auditoria | `AuditEvent` append-only a nivel de aplicacion | Evento de inicializacion |

### EPIC-PVS-003 - API de inicializacion

| ID | Tarea | Resultado | Verificacion |
|---|---|---|---|
| PVS-012 | Implementar health | `GET /api/health` | Responde con BD ok |
| PVS-013 | Implementar estado | `GET /api/platform/installation` | Devuelve inicializado/no inicializado |
| PVS-014 | Implementar inicializacion | `POST /api/platform/installation/initialize` | Crea datos minimos |
| PVS-015 | Validar entrada | Zod en el Route Handler | Errores 422 |
| PVS-016 | Rechazar segunda inicializacion | Error funcional 409 | Prueba de contrato |
| PVS-017 | Registrar auditoria | `PLATFORM_INITIALIZED` | Sin secretos |
| PVS-018 | Preparar seguridad de acceso | Admin con rol, nombre reservado y modelo de sesiones | Revision de esquema |

### EPIC-PVS-004 - UI web inicial

| ID | Tarea | Resultado | Verificacion |
|---|---|---|---|
| PVS-019 | Crear pagina inicial | Estado visible de la plataforma | Render server-side |
| PVS-020 | Crear pagina de instalacion | `/platform/installation` | Muestra empresa/admin si existen |
| PVS-021 | Crear formulario web | Formulario cliente para inicializar | Client Component con estados de envio |

### EPIC-PVS-005 - Calidad

| ID | Tarea | Resultado | Verificacion |
|---|---|---|---|
| PVS-022 | Typecheck | TypeScript estricto | `npm run typecheck` |
| PVS-023 | Build | Build productivo | `npm run build` |
| PVS-024 | Pruebas contrato | Endpoints criticos cubiertos | Suite HTTP |
| PVS-025 | Pruebas integracion | Transaccion e idempotencia | PostgreSQL real |

## 5. Criterios de salida

1. `npm run typecheck` finaliza correctamente.
2. `npm run build` finaliza correctamente.
3. Prisma migra una base vacia.
4. Health endpoint responde con conexion a PostgreSQL.
5. La inicializacion valida termina con 201.
6. La segunda inicializacion devuelve 409.
7. Auditoria no contiene contrasenas ni secretos.
8. La documentacion y ADRs no apuntan a .NET/WPF/SQL Server como decisiones vigentes.
