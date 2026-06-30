# CriGestión

Aplicacion de gestion empresarial construida con Next.js, TypeScript, PostgreSQL y Prisma.

## Requisitos

- Node.js 22 LTS o superior.
- PostgreSQL 16 o superior.
- npm.
- Docker Desktop, opcional para PostgreSQL local reproducible.

## Puesta en marcha

1. Copia `.env.example` a `.env.local` y ajusta `DATABASE_URL`.
2. Instala dependencias con `npm install`.
3. Genera Prisma con `npm run prisma:generate`.
4. Crea la base con `npm run prisma:migrate`.
5. Arranca en desarrollo con `npm run dev`.

Endpoints iniciales:

- `GET /api/health`
- `GET /api/platform/installation`
- `POST /api/platform/installation/initialize`

La documentacion tecnica principal esta en `docs/05-arquitectura-tecnica.md`.

Para preparar el entorno de desarrollo principal en Windows 11, sigue `docs/setup-windows.md`.

Checklist rapida para Windows 11: `docs/checklist-inicio-windows.md`.

La guia historica de macOS queda disponible en `docs/setup-mac.md`.

## Validacion continua

El repositorio incluye GitHub Actions en `.github/workflows/ci.yml` para validar cada push y pull request contra `main`.

Tambien incluye plantillas de pull request e issues para mantener trazabilidad funcional, tecnica y de seguridad.

Consulta `CONTRIBUTING.md` para el flujo de trabajo y `SECURITY.md` para reportar o tratar vulnerabilidades.
