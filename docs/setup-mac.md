# Preparacion del entorno en macOS

Esta guia deja el Mac listo para desarrollar CriGestión con Next.js, TypeScript, PostgreSQL y Prisma.

## 1. Herramientas base

Instala:

- Git.
- Node.js 22 LTS.
- npm, incluido con Node.js.
- PostgreSQL 16 o superior.
- Docker Desktop, recomendable para entornos reproducibles.
- Visual Studio Code o Cursor.
- Codex.

Opcion recomendada con Homebrew:

```bash
brew install git node@22 postgresql@16
brew install --cask docker visual-studio-code
```

Comprueba versiones:

```bash
git --version
node --version
npm --version
psql --version
```

El repositorio incluye `.nvmrc` con Node 22. Si usas `nvm`:

```bash
nvm install
nvm use
```

## 2. Clonar repositorio

```bash
git clone https://github.com/albertocs3/crigestion.git
cd crigestion
```

## 3. Variables de entorno

Copia el ejemplo:

```bash
cp .env.example .env.local
```

Ajusta como minimo:

```bash
DATABASE_URL="postgresql://crigestion:crigestion@localhost:5432/crigestion?schema=public"
APP_BASE_URL="http://localhost:3000"
APP_SESSION_SECRET="valor-local-largo-y-aleatorio"
```

Genera un secreto local:

```bash
openssl rand -base64 32
```

No guardes certificados digitales, contraseñas reales ni secretos productivos en Git.

## 4. PostgreSQL local

Puedes usar PostgreSQL instalado en macOS o Docker. La opcion Docker es la mas reproducible.

### Opcion A: Docker

Copia el ejemplo:

```bash
cp .env.docker.example .env.docker
```

Arranca PostgreSQL:

```bash
npm run db:up
```

Comprueba logs si hace falta:

```bash
npm run db:logs
```

La `DATABASE_URL` de `.env.local` debe coincidir con:

```bash
DATABASE_URL="postgresql://crigestion:crigestion@localhost:5432/crigestion?schema=public"
```

### Opcion B: PostgreSQL con Homebrew

Crea usuario y base de datos:

```bash
createuser crigestion --pwprompt
createdb crigestion --owner=crigestion
```

Si usas Homebrew y PostgreSQL no esta iniciado:

```bash
brew services start postgresql@16
```

## 5. Instalar dependencias

```bash
npm install
```

## 6. Prisma

Genera el cliente:

```bash
npm run prisma:generate
```

Crea la migracion inicial en desarrollo:

```bash
npm run prisma:migrate -- --name initial_platform_security
```

Carga datos base:

```bash
npm run db:seed
```

## 7. Validaciones iniciales

```bash
npm run typecheck
npm run lint
npm run audit
```

## 8. Arranque

```bash
npm run dev
```

Abre:

- `http://localhost:3000`
- `http://localhost:3000/api/health`
- `http://localhost:3000/platform/installation`

## 9. Checklist antes de empezar a programar

- `.env.local` existe y no esta versionado.
- PostgreSQL responde en local.
- `npm install` termina sin errores.
- Prisma genera cliente y aplica migraciones.
- `npm run typecheck` pasa.
- `npm run lint` pasa.
- La app arranca en `localhost:3000`.
- Codex tiene acceso al repositorio clonado.

## 10. Primer bloque de desarrollo recomendado

Empieza por el bootstrap seguro de plataforma:

1. Instalacion inicial.
2. Usuario administrador.
3. Login y logout.
4. Sesiones con cookie `HttpOnly`, `Secure` en produccion y `SameSite`.
5. RBAC server-side.
6. Dashboard privado.
7. Auditoria minima de accesos y acciones criticas.
8. Tests de contrato, integracion y flujo E2E basico.
