# Estructura inicial de la solucion Next.js

> El nombre historico del archivo se conserva para no romper enlaces existentes. La estructura vigente ya no es .NET.

## 1. Proposito

Define la estructura fisica para construir CriGestión con Next.js, TypeScript, PostgreSQL y Prisma.

## 2. Arbol inicial

```text
CriGestion/
  app/
    api/
      health/
      platform/
    platform/
      installation/
    globals.css
    layout.tsx
    page.tsx
  components/
  lib/
    prisma.ts
  modules/
    platform/
      domain/
      application/
      infrastructure/
      presentation/
  prisma/
    schema.prisma
    seed.ts
    migrations/
  scripts/
  tests/
  docs/
  package.json
  tsconfig.json
  next.config.mjs
  .env.example
```

## 3. Responsabilidades

| Carpeta | Responsabilidad |
|---|---|
| `app/` | Rutas, layouts, paginas y Route Handlers de Next.js |
| `components/` | Componentes UI reutilizables sin reglas de negocio |
| `lib/` | Utilidades transversales server-only o universales |
| `modules/<modulo>/domain` | Entidades, objetos de valor, invariantes y errores de dominio |
| `modules/<modulo>/application` | Casos de uso, DTO internos, autorizacion y validacion de aplicacion |
| `modules/<modulo>/infrastructure` | Prisma, repositorios, integraciones y adaptadores |
| `modules/<modulo>/presentation` | Adaptadores de UI y contratos de pantalla |
| `prisma/` | Modelo, migraciones y seed |
| `tests/` | Pruebas unitarias, integracion, contrato y E2E |

## 4. Reglas de dependencias

- `domain` no importa React, Next.js, Prisma ni variables de entorno.
- `application` puede usar `domain` y puertos, pero no Prisma directamente salvo decision explicita y localizada.
- `infrastructure` implementa puertos y puede usar Prisma.
- `app/api` llama casos de uso o servicios server-only.
- `app` de UI no importa `infrastructure` en Client Components.
- `components` no importa Prisma.

## 5. Archivos raiz

| Archivo | Uso |
|---|---|
| `package.json` | Scripts y dependencias npm |
| `tsconfig.json` | TypeScript estricto |
| `next.config.mjs` | Configuracion Next.js |
| `.env.example` | Variables requeridas sin secretos reales |
| `.gitignore` | Exclusiones de dependencias, builds, secretos y temporales |

## 6. Prisma

`prisma/schema.prisma` contiene el modelo inicial de Plataforma:

- `Installation`.
- `Company`.
- `User`.
- `Role`.
- `Permission`.
- `RolePermission`.
- `AuditEvent`.

Las migraciones se crean con:

```powershell
npm run prisma:migrate
```

En produccion se aplican con:

```powershell
npm run prisma:deploy
```

## 7. Primera rebanada vertical

La primera rebanada sigue siendo `PLT-CU-001 - Inicializar el sistema`, pero se implementa asi:

1. Modelo Prisma inicial.
2. Route Handler `GET /api/platform/installation`.
3. Route Handler `POST /api/platform/installation/initialize`.
4. Pagina `/platform/installation`.
5. Auditoria minima en `audit_events`.
6. Validacion Zod.
7. Pruebas de contrato y transaccion.

## 8. Criterios de aceptacion

1. `npm run typecheck` finaliza sin errores.
2. `npm run build` finaliza sin errores.
3. `npm run prisma:migrate` crea la base desde cero.
4. `GET /api/health` verifica la conexion.
5. No hay secretos versionados.
6. La estructura permite anadir modulos sin mover Plataforma.
