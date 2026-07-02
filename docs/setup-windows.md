# Preparacion del entorno en Windows 11

Esta guia deja Windows 11 listo para desarrollar CriGestion con Next.js, TypeScript, PostgreSQL y Prisma.

## 1. Decision de entorno

Entorno recomendado:

- Windows 11 como sistema principal.
- PowerShell 7 como terminal.
- Node.js 22 LTS y npm en Windows nativo.
- PostgreSQL 16 en Docker Desktop con backend WSL2.
- Visual Studio Code o Cursor como editor.
- Repositorio en una carpeta corta y no sincronizada, por ejemplo `C:\dev\crigestion`.

Evita trabajar de forma diaria dentro de iCloud Drive, OneDrive, Dropbox u otra carpeta sincronizada. Tambien evita rutas largas, con muchos espacios o caracteres especiales para reducir problemas con `node_modules`, `.next`, Prisma y Docker.

## 2. Herramientas base

Instala desde PowerShell:

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Docker.DockerDesktop
winget install Microsoft.PowerShell
winget install Microsoft.VisualStudioCode
```

Si prefieres Cursor:

```powershell
winget install Anysphere.Cursor
```

Reinicia la terminal despues de instalar Node.js o Git.

Comprueba versiones:

```powershell
git --version
node --version
npm --version
docker --version
```

El proyecto usa Node.js 22 LTS o superior.

## 3. Docker Desktop

En Docker Desktop:

- Activa el backend WSL2.
- Deja Docker arrancado antes de iniciar PostgreSQL.
- No es necesario ejecutar la aplicacion dentro de WSL para este proyecto.

CriGestion ejecuta PostgreSQL con Docker y la aplicacion Next.js con Node/npm en Windows nativo.

## 4. Configuracion de Git

Configuracion recomendada en Windows:

```powershell
git config --global core.autocrlf true
git config --global pull.rebase false
git config --global init.defaultBranch main
```

## 5. Clonar repositorio

Usa una carpeta local no sincronizada:

```powershell
mkdir C:\dev
cd C:\dev
git clone https://github.com/albertocs3/crigestion.git
cd crigestion
```

Si ya tienes una copia en iCloud Drive, mantenla como referencia o backup, pero usa `C:\dev\crigestion` para desarrollar.

## 6. Variables de entorno

Copia los ejemplos:

```powershell
Copy-Item .env.example .env.local
Copy-Item .env.docker.example .env.docker
```

En `.env.local`, revisa como minimo:

```env
DATABASE_URL="postgresql://crigestion:crigestion@localhost:5432/crigestion?schema=public"
APP_BASE_URL="http://localhost:3000"
APP_ENV="development"
APP_SESSION_SECRET="valor-local-largo-y-aleatorio"
AUTH_COOKIE_SECURE="false"
TRUST_PROXY_HEADERS="false"
```

Genera un secreto local con PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

No guardes certificados digitales, contrasenas reales, tokens ni secretos productivos en Git.

Activa `TRUST_PROXY_HEADERS="true"` solo cuando la aplicacion este detras de un proxy confiable que sobrescriba cabeceras como `X-Forwarded-For`. El rate limit por IP de login depende de esa IP confiable en produccion.

## 7. PostgreSQL local con Docker

Arranca PostgreSQL:

```powershell
npm run db:up
```

Consulta logs si hace falta:

```powershell
npm run db:logs
```

La base de datos local queda disponible en:

```text
localhost:5432
```

La configuracion de `.env.docker` debe coincidir con la `DATABASE_URL` de `.env.local`.

## 8. Instalar dependencias

```powershell
npm install
```

## 9. Prisma y datos iniciales

Genera el cliente:

```powershell
npm run prisma:generate
```

Aplica migraciones en desarrollo:

```powershell
npm run prisma:migrate
```

Carga datos base:

```powershell
npm run db:seed
```

Si creas una migracion nueva, usa un nombre descriptivo:

```powershell
npm run prisma:migrate -- --name nombre_descriptivo
```

No edites migraciones ya aplicadas salvo que estes trabajando contra una base local desechable.

## 10. Validaciones iniciales

Ejecuta:

```powershell
npm run typecheck
npm run lint
npm run audit
npm run build
```

## 11. Arranque de la aplicacion

```powershell
npm run dev
```

Abre:

```text
http://localhost:3000
http://localhost:3000/api/health
http://localhost:3000/platform/installation
```

## 12. Flujo diario recomendado

Antes de empezar:

```powershell
git status
git pull
npm run db:up
npm run prisma:generate
npm run typecheck
npm run dev
```

Antes de cerrar una tarea:

```powershell
npm run typecheck
npm run lint
npm run build
npm run audit
```

Si se toca Prisma:

```powershell
npm run prisma:migrate
npm run prisma:generate
```

## 13. Primer bloque de desarrollo recomendado

Empieza por el bootstrap seguro de plataforma:

1. Instalacion inicial.
2. Usuario administrador.
3. Login y logout.
4. Sesiones con cookie `HttpOnly`, `Secure` en produccion y `SameSite`.
5. RBAC server-side.
6. Dashboard privado.
7. Auditoria minima de accesos y acciones criticas.
8. Tests de contrato, integracion y flujo E2E basico.

## 14. Problemas frecuentes en Windows

- Si Docker no responde, abre Docker Desktop y espera a que el motor este iniciado.
- Si el puerto `5432` esta ocupado, cambia `POSTGRES_PORT` en `.env.docker` y ajusta `DATABASE_URL`.
- Si Next.js o Prisma van lentos, comprueba que el repo no este en una carpeta sincronizada.
- Si aparecen errores raros de rutas, clona el repo en `C:\dev\crigestion`.
- Si npm no reconoce Node tras instalarlo, cierra y vuelve a abrir PowerShell.

## 15. Seguridad local

- `.env.local` y `.env.docker` no deben versionarse.
- No uses certificados VeriFactu reales en fixtures, seeds o repositorios.
- No registres contrasenas, tokens, IBAN completo, certificados ni secretos.
- Mantén `AUTH_COOKIE_SECURE="false"` solo en desarrollo local sin HTTPS.
- En produccion, las cookies deben ser `HttpOnly`, `Secure` y `SameSite`.
