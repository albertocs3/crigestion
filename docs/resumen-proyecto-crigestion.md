# Resumen del proyecto CriGestión

CriGestión es un software de gestion empresarial integrado para una unica empresa.

## Stack tecnico vigente

| Area | Decision |
|---|---|
| Aplicacion | Next.js App Router |
| Lenguaje | TypeScript |
| Base de datos | PostgreSQL |
| ORM y migraciones | Prisma |
| UI | React con Server Components por defecto |
| API | Route Handlers bajo `/api` |
| Trabajos de fondo | Jobs Node.js |

## Primera rebanada

`PLT-CU-001 - Inicializar el sistema`

Incluye:

- Modelo Prisma inicial.
- PostgreSQL como base central.
- `GET /api/health`.
- `GET /api/platform/installation`.
- `POST /api/platform/installation/initialize`.
- Pagina `/platform/installation`.
- Auditoria minima.
- Seed de roles y permisos base.

## Estructura inicial

```text
app/
components/
lib/
modules/
prisma/
scripts/
tests/
docs/
```

## Comandos previstos

```powershell
npm install
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
npm run dev
npm run typecheck
npm run build
```

El PDF y HTML de resumen pueden quedar como artefactos historicos hasta regenerarse desde esta version.
