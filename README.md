# CriGestión

Aplicacion de gestion empresarial construida con Next.js, TypeScript, PostgreSQL y Prisma.

## Requisitos

- Node.js 22 LTS o superior.
- PostgreSQL 16 o superior.
- npm.

## Puesta en marcha

1. Copia `.env.example` a `.env` y ajusta `DATABASE_URL`.
2. Instala dependencias con `npm install`.
3. Genera Prisma con `npm run prisma:generate`.
4. Crea la base con `npm run prisma:migrate`.
5. Arranca en desarrollo con `npm run dev`.

Endpoints iniciales:

- `GET /api/health`
- `GET /api/platform/installation`
- `POST /api/platform/installation/initialize`

La documentacion tecnica principal esta en `docs/05-arquitectura-tecnica.md`.
