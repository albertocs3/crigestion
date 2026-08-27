# CriGestión

Aplicación web de gestión empresarial que integra en una única plataforma los
procesos comerciales, administrativos, contables y fiscales de una pequeña o
mediana empresa.

CriGestión centraliza clientes, proveedores, catálogo, facturación, compras,
contabilidad, tesorería, suscripciones y atención al cliente. Las operaciones
relevantes se protegen mediante autenticación, permisos de servidor y
auditoría. La integración con VeriFactu permanece limitada al entorno TEST;
su uso en producción está bloqueado hasta completar la revisión fiscal y
operativa.

La versión disponible debe considerarse un **MVP operativo avanzado**: el
núcleo está integrado y desplegado en staging, aunque existen ampliaciones
funcionales planificadas.

## 1. Descripción general

El proyecto nace para evitar la fragmentación habitual de la información
empresarial entre hojas de cálculo, aplicaciones independientes y procesos
manuales. PostgreSQL actúa como fuente única de verdad y una aplicación Next.js
ofrece la interfaz, la API y los casos de uso.

Los objetivos principales son:

- centralizar la información empresarial;
- conectar el ciclo comercial con contabilidad y tesorería;
- mantener trazabilidad y evidencia auditable;
- aplicar permisos en cada operación sensible;
- automatizar procesos recurrentes de forma controlada e idempotente;
- preparar la facturación para VeriFactu sin habilitar prematuramente
  comunicaciones fiscales de producción.

La solución sigue una arquitectura de **monolito modular**. Este enfoque reduce
la complejidad de despliegue y permite conservar transacciones ACID en procesos
económicos que afectan a varios módulos.

## 2. Stack tecnológico

| Área | Tecnología |
|---|---|
| Framework web | Next.js 15 con App Router |
| Interfaz | React 19, Server Components y Client Components |
| Lenguaje | TypeScript 5 en modo estricto |
| API | Route Handlers de Next.js |
| Base de datos | PostgreSQL 16 |
| ORM y migraciones | Prisma 6 y Prisma Migrate |
| Validación | Zod |
| Autenticación | Sesiones opacas en cookies `HttpOnly` |
| Autorización | RBAC con permisos `Módulo.Acción` comprobados en servidor |
| Pruebas | Vitest y Playwright |
| Calidad | ESLint, TypeScript y `npm audit` |
| Contenedores | Docker Compose para PostgreSQL local |
| Procesos en segundo plano | Workers Node.js supervisados |

La interfaz y la API se despliegan juntas. Los workers procesan tareas como
VeriFactu TEST, reactivaciones de suscripciones, retención de notificaciones,
copias de seguridad y restauraciones.

## 3. Requisitos previos

- Node.js 22 LTS, versión indicada en `.nvmrc`.
- npm.
- PostgreSQL 16 o superior.
- Docker Desktop, recomendado para disponer de PostgreSQL local reproducible.
- PowerShell en Windows para los scripts auxiliares incluidos.

## 4. Instalación y ejecución

### 4.1 Instalación estándar de desarrollo

1. Clonar el repositorio y entrar en su directorio:

   ```powershell
   git clone https://github.com/albertocs3/crigestion.git
   Set-Location crigestion
   ```

2. Instalar las dependencias:

   ```powershell
   npm ci
   ```

3. Preparar PostgreSQL mediante Docker:

   ```powershell
   Copy-Item .env.docker.example .env.docker
   npm run db:up
   ```

4. Crear la configuración local:

   ```powershell
   Copy-Item .env.example .env
   ```

   Para el Compose incluido, `DATABASE_URL` puede conservar el valor local del
   ejemplo. `APP_SESSION_SECRET` debe sustituirse por un valor aleatorio de al
   menos 32 caracteres. Los secretos reales y los archivos `.env` nunca deben
   subirse al repositorio.

5. Generar Prisma y aplicar las migraciones:

   ```powershell
   npm run prisma:generate
   npm run prisma:migrate
   ```

6. Iniciar la aplicación:

   ```powershell
   npm run dev
   ```

7. Abrir `http://localhost:3000`. Si la base todavía no está inicializada, la
   aplicación redirige al asistente de instalación para crear la empresa y el
   primer administrador.

El estado técnico puede comprobarse en `http://localhost:3000/api/health`.

### 4.2 Entorno de demostración reproducible

El repositorio incorpora un entorno separado para evaluación y presentación.
Solo funciona contra una base local llamada `crigestion_demo`, con
`APP_ENV=development` y VeriFactu desactivado.

1. Levantar PostgreSQL e instalar las dependencias, si aún no se ha hecho:

   ```powershell
   npm ci
   Copy-Item .env.docker.example .env.docker
   npm run db:up
   ```

2. Crear una vez la base de demostración:

   ```powershell
   docker exec crigestion-postgres createdb -U crigestion -O crigestion crigestion_demo
   ```

   Si PostgreSQL indica que ya existe, se puede continuar sin recrearla.

3. Crear el archivo local de configuración:

   ```powershell
   Copy-Item .env.demo.example .env.demo.local
   ```

4. Generar un secreto de sesión local:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

5. Editar `.env.demo.local`, pegar el valor generado en
   `APP_SESSION_SECRET` y establecer la contraseña de prueba indicada en el
   [apartado 7](#7-usuario-y-contraseña-de-prueba):

   ```dotenv
   APP_SESSION_SECRET=PEGA_AQUI_EL_SECRETO_ALEATORIO_GENERADO
   DEMO_ADMIN_PASSWORD=Presentacion-CriGestion-2026!
   ```

6. Aplicar migraciones, preparar los datos sintéticos e iniciar la demo:

   ```powershell
   $env:DATABASE_URL="postgresql://crigestion:crigestion@localhost:5432/crigestion_demo?schema=public"
   npm run prisma:deploy
   Remove-Item Env:DATABASE_URL
   npm run demo:prepare
   npm run demo:start
   ```

`demo:prepare` es idempotente: puede repetirse sin duplicar el conjunto de
datos. Crea una empresa ficticia, un administrador, un ejercicio contable, un
cliente, una categoría, un servicio y una factura emitida.

> Las credenciales anteriores son exclusivamente para la base local
> `crigestion_demo`. No son válidas en staging o producción y no deben
> reutilizarse en ningún entorno real.

### 4.3 Ejecución optimizada

Para comprobar el artefacto que se utilizaría en un despliegue:

```powershell
npm run build
npm run start
```

En staging o producción las migraciones se ejecutan como un paso controlado de
la release mediante `npm run prisma:deploy`. La aplicación no debe ejecutar
migraciones ni seeds automáticamente al arrancar.

## 5. Estructura del proyecto

```text
crigestion/
├── app/                  # App Router: páginas, layouts y Route Handlers
│   ├── api/              # API HTTP organizada por área funcional
│   ├── app/              # Backoffice autenticado
│   ├── login/            # Acceso a la aplicación
│   └── platform/         # Inicialización de la plataforma
├── modules/              # Dominios y casos de uso del monolito modular
│   ├── accounting/       # Contabilidad y ejercicios
│   ├── billing/          # Facturación
│   ├── catalog/          # Artículos, categorías, impuestos y stock
│   ├── customers/        # Clientes
│   ├── platform/         # Instalación, seguridad, auditoría y operación
│   ├── purchases/        # Compras
│   ├── subscriptions/    # Suscripciones y renovaciones
│   ├── suppliers/        # Proveedores
│   ├── support/          # Atención al cliente
│   └── treasury/         # Tesorería, bancos y conciliación
├── lib/                  # Utilidades e infraestructura compartida server-side
├── prisma/               # Esquema, migraciones y seed técnico
├── scripts/              # Workers, demo, migración, backup y restauración
├── tests/                # Pruebas unitarias, integración, contrato y E2E
├── deploy/               # Artefactos y configuración de despliegue
├── docs/                 # Arquitectura, ADR y especificaciones funcionales
├── middleware.ts         # Correlación y controles transversales de petición
├── next.config.mjs       # Configuración y cabeceras de seguridad
└── package.json          # Dependencias y comandos del proyecto
```

Los componentes son Server Components por defecto. Las reglas de negocio viven
en `modules/<módulo>/application`; Prisma, certificados y secretos permanecen
en código de servidor. Las rutas HTTP validan la entrada y delegan en esos casos
de uso.

## 6. Funcionalidades principales

| Módulo | Funcionalidad disponible |
|---|---|
| Plataforma y seguridad | Inicialización, login/logout, cambio de contraseña, sesiones revocables, usuarios, roles, permisos, CSRF, auditoría y mantenimiento. |
| Clientes | Maestro fiscal, contactos, direcciones, tiendas y condiciones comerciales. |
| Proveedores | Maestro fiscal, datos de pago protegidos, subcuenta contable y baja lógica. |
| Catálogo | Categorías, artículos o servicios, impuestos y movimientos de stock. |
| Facturación | Borradores, líneas, emisión, numeración, PDF, vencimientos, cobros, impagos, devoluciones y rectificativas. |
| Compras | Facturas recibidas, vencimientos, IVA soportado, registro contable, pagos, rectificaciones y devoluciones. |
| Contabilidad | PGC PYMES, cuentas, asientos, ejercicios y procesos controlados de cierre y reapertura. |
| Tesorería | Previsiones, cuentas y movimientos bancarios, Norma 43, conciliación, créditos, reembolsos, remesas y SEPA. |
| Suscripciones | Ciclo contractual, cambios programados, reactivación y renovaciones supervisadas con trazabilidad. |
| Atención al cliente | Incidencias, comunicaciones, actuaciones, adjuntos seguros, participantes, indicadores y correcciones versionadas. |
| Notificaciones | Bandeja persistente, marcado individual o múltiple y retención automática. |
| VeriFactu TEST | Instalación SIF, credenciales PFX cifradas, registros fiscales, outbox, reintentos y worker monitorizado. Producción permanece bloqueada. |
| Operación | Health checks, copias de seguridad, validación de restauraciones y bundles cifrados de recuperación. |

Funcionalidades previstas para etapas posteriores:

- presupuestos y conversión a factura;
- informes contables avanzados;
- ampliaciones económicas de suscripciones;
- perfiles bancarios adicionales;
- configuración operativa completa de correo;
- revisión y autorización independiente para producción fiscal.

## 7. Usuario y contraseña de prueba

Para evaluar el despliegue publicado:

| Campo | Valor |
|---|---|
| URL | <https://gestion-test.crisoft.es/login> |
| Usuario | `tribunal-tfm-2026` |
| Contraseña | `Tribunal-CriGestion-2026!` |
| Rol | `Tribunal TFM - solo lectura` |

La cuenta permite consultar los módulos funcionales, pero no puede crear,
editar, aprobar, emitir ni exportar información, y no dispone del permiso de
descarga de adjuntos de soporte. Tampoco tiene acceso a usuarios, roles,
sesiones, configuración, auditoría, copias de seguridad o administración de
VeriFactu. Todos los datos de staging utilizados para la evaluación son
sintéticos.

Para la demostración local preparada con `npm run demo:prepare`:

| Campo | Valor |
|---|---|
| URL | `http://localhost:3000/login` |
| Usuario | `admin-demo` |
| Contraseña | `Presentacion-CriGestion-2026!` |
| Entorno permitido | Base local `crigestion_demo` |

El usuario local tiene perfil de administrador únicamente dentro de la base
sintética, para poder recorrer todos los módulos durante el desarrollo. Ambas
contraseñas son públicas e intencionadamente exclusivas de los entornos de
demostración: no protegen datos reales y no son válidas en producción.

## 8. Comandos de desarrollo y validación

| Comando | Finalidad |
|---|---|
| `npm run dev` | Servidor de desarrollo. |
| `npm run build` | Generación Prisma y build optimizado de Next.js. |
| `npm run typecheck` | Comprobación estática de TypeScript. |
| `npm run lint` | Reglas ESLint. |
| `npm test` | Suite Vitest. |
| `npm run test:e2e` | Flujos E2E con Playwright. |
| `npm run prisma:generate` | Generar Prisma Client. |
| `npm run prisma:migrate` | Crear/aplicar migraciones en desarrollo. |
| `npm run prisma:deploy` | Aplicar migraciones existentes. |
| `npm run prisma:studio` | Explorar la base local. |
| `npm run audit` | Auditoría de dependencias de severidad alta. |
| `npm run demo:prepare` | Preparar el dataset local de presentación. |
| `npm run demo:start` | Iniciar la aplicación con el entorno de demo. |

La integración continua se encuentra en `.github/workflows/ci.yml` y ejecuta
controles sobre los cambios enviados al repositorio.

## 9. Seguridad y datos de prueba

- No se guardan tokens de sesión en `localStorage`.
- Las sesiones usan cookies `HttpOnly`; en HTTPS también son `Secure`.
- Las mutaciones autenticadas incluyen protección CSRF y validación de origen.
- Los permisos se validan siempre en servidor.
- Prisma parametriza el acceso ordinario a PostgreSQL.
- Las cabeceras CSP, HSTS, `nosniff`, Referrer Policy y Permissions Policy se
  configuran en Next.js.
- Certificados, contraseñas, tokens, IBAN completos y claves de cifrado no deben
  aparecer en commits o logs.
- VeriFactu está deshabilitado en la demo local y limitado a TEST en staging.

## 10. Documentación relacionada

- [Arquitectura técnica](docs/05-arquitectura-tecnica.md)
- [Estado de implementación](docs/09-estado-implementacion.md)
- [Guion de presentación](docs/10-guion-presentacion.md)
- [Preparación de Windows](docs/setup-windows.md)
- [ADR y decisiones técnicas](docs/adr/README.md)
- [Política de seguridad](SECURITY.md)
- [Guía de contribución](CONTRIBUTING.md)

## 11. Enlaces de entrega

| Recurso | Acceso |
|---|---|
| Código fuente | <https://github.com/albertocs3/crigestion> |
| Proyecto desplegado | <https://gestion-test.crisoft.es/login> |
| Estado del servicio | <https://gestion-test.crisoft.es/api/health> |
| Slides | Pendiente de publicar |
| Vídeo de presentación | Pendiente de publicar |

El despliegue publicado es un entorno de demostración con VeriFactu limitado a
TEST. No contiene credenciales de producción. La cuenta dedicada de evaluación
y la demo local están documentadas por separado en el apartado 7.
