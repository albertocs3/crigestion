# Plan de creacion fisica de la solucion Next.js

## 1. Proposito

Este plan sustituye el plan .NET anterior y describe como crear y validar fisicamente CriGestión con Next.js, TypeScript, PostgreSQL y Prisma.

## 2. Precondiciones

- Node.js 22 LTS o superior.
- npm.
- PostgreSQL 16 o superior.
- Acceso a npm o cache corporativa.

## 3. Archivos iniciales

Ya existen en la raiz:

- `package.json`.
- `tsconfig.json`.
- `next.config.mjs`.
- `.env.example`.
- `.gitignore`.
- `app/`.
- `lib/prisma.ts`.
- `prisma/schema.prisma`.
- `prisma/seed.ts`.

## 4. Configuracion local

1. Copiar `.env.example` a `.env`.
2. Ajustar `DATABASE_URL`.
3. Crear la base PostgreSQL vacia.

Ejemplo:

```env
DATABASE_URL="postgresql://crigestion:crigestion@localhost:5432/crigestion?schema=public"
```

## 5. Instalacion

```powershell
npm install
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
npm run dev
```

## 6. Validacion

```powershell
npm run typecheck
npm run build
```

Endpoints a comprobar:

- `GET http://localhost:3000/api/health`.
- `GET http://localhost:3000/api/platform/installation`.
- `POST http://localhost:3000/api/platform/installation/initialize`.

## 7. Datos iniciales

El seed crea permisos base y el rol `Administrador`. La inicializacion real crea:

- Empresa minima.
- Primer administrador.
- Registro de instalacion.
- Evento de auditoria.

## 8. Migraciones

Desarrollo:

```powershell
npm run prisma:migrate
```

Produccion:

```powershell
npm run prisma:deploy
```

Reglas:

- No editar migraciones ya aplicadas.
- No incluir secretos en migraciones ni seed.
- Revisar indices y restricciones antes de produccion.

## 9. Criterios de salida

1. Dependencias instaladas.
2. Prisma Client generado.
3. Base PostgreSQL migrada.
4. App arrancando en `localhost:3000`.
5. Health endpoint responde.
6. TypeScript estricto sin errores.
7. Build Next.js correcto.
