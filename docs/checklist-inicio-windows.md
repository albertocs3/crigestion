# Checklist de inicio en Windows 11

Esta checklist resume lo necesario para preparar Windows 11 y empezar a trabajar en CriGestion.

## 1. Herramientas instaladas

- Windows 11 actualizado.
- PowerShell 7 instalado.
- Git instalado.
- Node.js 22 LTS instalado.
- npm disponible.
- Docker Desktop instalado.
- Docker Desktop arrancado con backend WSL2.
- Visual Studio Code o Cursor instalado.

Comprobacion:

```powershell
git --version
node --version
npm --version
docker --version
```

## 2. Repositorio

- Repositorio clonado fuera de carpetas sincronizadas.
- Ruta recomendada: `C:\dev\crigestion`.
- No desarrollar de forma diaria dentro de iCloud Drive, OneDrive o Dropbox.

Clonado recomendado:

```powershell
mkdir C:\dev
cd C:\dev
git clone https://github.com/albertocs3/crigestion.git
cd crigestion
```

## 3. Git configurado

```powershell
git config --global core.autocrlf true
git config --global pull.rebase false
git config --global init.defaultBranch main
```

## 4. Variables de entorno

```powershell
Copy-Item .env.example .env.local
Copy-Item .env.docker.example .env.docker
```

En `.env.local`, comprobar:

```env
DATABASE_URL="postgresql://crigestion:crigestion@localhost:5432/crigestion?schema=public"
APP_BASE_URL="http://localhost:3000"
APP_SESSION_SECRET="valor-local-largo-y-aleatorio"
AUTH_COOKIE_SECURE="false"
```

Generar secreto local:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

## 5. PostgreSQL con Docker

```powershell
npm run db:up
```

Si necesitas revisar logs:

```powershell
npm run db:logs
```

## 6. Dependencias

```powershell
npm install
```

## 7. Prisma y datos

```powershell
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
```

## 8. Validacion

```powershell
npm run typecheck
npm run lint
npm run audit
npm run build
```

## 9. Arranque

```powershell
npm run dev
```

Abrir:

```text
http://localhost:3000
http://localhost:3000/api/health
http://localhost:3000/platform/installation
```

## 10. Checklist final

- Repo en `C:\dev\crigestion`.
- `.env.local` creado y no versionado.
- `.env.docker` creado y no versionado.
- PostgreSQL levantado con Docker.
- `npm install` completado.
- Prisma generado.
- Migraciones aplicadas.
- Seed ejecutado.
- `npm run typecheck` pasa.
- `npm run lint` pasa.
- `npm run build` pasa.
- La app abre en `http://localhost:3000`.

La guia completa esta en `docs/setup-windows.md`.
