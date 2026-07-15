# Despliegue staging en Plesk y Ubuntu 22.04

## 1. Estado y limite operativo

Este runbook cubre exclusivamente `https://gestion-test.crisoft.es` en el VPS
Ubuntu 22.04 administrado con Plesk.

Estado verificado a 2026-07-15:

- VPS `93.93.116.238`.
- Node.js `22.23.1` en `/opt/plesk/node/22/bin/node`.
- PostgreSQL 14 en el puerto 5432.
- Base `crigestion_staging`.
- Rol runtime `crigestion_staging_app`.
- Rol migrador `crigestion_staging_migrator`.
- Extension `btree_gist` instalada.
- Permisos y privilegios por defecto preparados.
- Aproximadamente 103 GB libres tras el saneado del disco.

**No ejecutar todavia migraciones ni activar las unidades.** La autorizacion
para preparar una release, aplicar migraciones o cambiar el VPS es un paso
posterior y explicito.

Las contrasenas ya fueron generadas y quedan bajo custodia del usuario. No se
copian en este documento, Git, tickets, logs ni comandos de shell.

## 2. Red y PostgreSQL

Imunify360 es el unico gestor de reglas del host. **Plesk Firewall debe
permanecer desactivado.** El acceso externo a PostgreSQL se limita a la IP fija
de oficina `88.26.204.241`; no se abre 5432 al resto de Internet.

Al principio de `/etc/postgresql/14/main/pg_hba.conf` se conserva:

```text
local all postgres peer
```

Esto permite administrar localmente como el usuario de sistema `postgres`. No
autoriza a la aplicacion a usar ese rol. Tras cualquier cambio de red, verificar
desde una IP no autorizada que 5432 sigue cerrado y desde el VPS que las
conexiones runtime/migrador usan loopback.

## 3. Contrato de entorno cerrado

Staging se ejecuta con `NODE_ENV=production` y `APP_ENV=staging`. Se trata como
un despliegue seguro: HTTPS, cookie `Secure`, secretos fuertes, CSRF y validacion
de origen. VeriFactu solo puede usar AEAT TEST:

```text
VERIFACTU_ENVIRONMENT=TEST
VERIFACTU_WORKER_ENVIRONMENT=TEST
VERIFACTU_ALLOW_PRODUCTION=false
VERIFACTU_WORKER_ALLOW_PRODUCTION=false
```

Los cuatro valores son obligatorios y canonicos incluso con
`VERIFACTU_ENABLED=false`. El servidor rechaza credenciales con
`allowProduction=true` y asociaciones a instalaciones SIF productivas.

La URL runtime debe declarar exactamente el rol `crigestion_staging_app`, la
autoridad numerica `127.0.0.1` o `::1`, puerto 5432, base
`crigestion_staging` y un unico parametro `schema=public`. Se rechazan otros
parametros, incluidos `host`, `hostaddr`, `service`, `options`, `user`, `port`
y duplicados. Web, worker, health y migrador comprueban tambien la identidad
efectiva mediante `current_database()`, `current_user`, `inet_server_addr()` e
`inet_server_port()`.

## 4. Artefactos

- Proxy nginx: `deploy/plesk/gestion-test.crisoft.es.nginx.conf`, destino
  interno `127.0.0.1:3101`.
- Entornos: `deploy/plesk/staging/environment/`.
- Unidades: `deploy/plesk/staging/systemd/`.
- Migrador controlado: `scripts/deploy-staging-migrations.ts`.

Instalar los `.env` como archivos `root:<grupo>` con modo `0640`. Sustituir
todos los `CHANGE_ME`; no imprimir los archivos para verificarlos. El worker
usa un estado separado por `APP_ENV` y `VERIFACTU_WORKER_DEPLOYMENT_ID` bajo su
`StateDirectory`.

Antes de copiar unidades al VPS, validarlas en Ubuntu:

```bash
systemd-analyze verify \
  deploy/plesk/staging/systemd/crigestion-staging-app.service \
  deploy/plesk/staging/systemd/crigestion-staging-verifactu-worker.service \
  'deploy/plesk/staging/systemd/crigestion-staging-migrate@.service'
```

## 5. Puerta de release futura

Solo tras cerrar validaciones locales y recibir autorizacion explicita:

1. Identificar una release inmutable por tag o SHA y construirla con el
   `build.env` de staging.
2. Ejecutar lint, typecheck, tests, build, auditoria y revisar el SQL de todas
   las migraciones pendientes.
3. Crear y verificar una copia recuperable antes de migrar.
   El preflight bloquea la migracion si existen vencimientos historicos ligados
   a facturas rectificativas; deben revisarse y remediarse manualmente, nunca
   borrarse de forma automatica.
4. Mantener web y worker parados durante la migracion inicial.
5. Ejecutar una sola unidad
   `crigestion-staging-migrate@<RELEASE_ID>.service`; no ejecutar
   `prisma migrate dev` ni `db:seed`.
6. Confirmar que el migrador conectado es exactamente
   `crigestion_staging_migrator` y que no tiene atributos elevados.
7. El post-migrado debe dejar al runtime sin acceso a `_prisma_migrations`, sin
   `UPDATE` en secuencias y sin `UPDATE`, `DELETE` ni `TRUNCATE` sobre
   `audit_events`. La unidad falla si esos privilegios siguen siendo efectivos
   por propiedad, `PUBLIC` o roles heredados.
8. Podar dependencias de desarrollo, cambiar el enlace `current`, arrancar solo
   la web y comprobar `/api/health` antes de considerar el worker.

Si Prisma aplica migraciones pero falla el endurecimiento posterior, no arrancar
web ni worker. Mantener la ventana, inspeccionar `prisma migrate status`,
corregir privilegios y repetir el migrador idempotente. Un rollback binario solo
es valido si el esquema sigue siendo compatible.

## 6. Verificacion posterior futura

Desde el VPS:

```bash
curl --fail --silent http://127.0.0.1:3101/api/health
```

Desde la oficina:

```bash
curl --fail --silent https://gestion-test.crisoft.es/api/health
curl --head http://gestion-test.crisoft.es
```

El health no expone URL, usuario, IP interna ni secretos. Devuelve 503 ante
configuracion invalida, base/rol/destino incorrectos, VeriFactu incoherente o
worker degradado. Comprobar ademas login/logout, cookie segura, CSP/HSTS,
rechazo CSRF/origin, reinicio limpio y que el puerto 3101 no sea publico.

El worker TEST se activa solo despues de inicializar la aplicacion, importar y
probar la credencial TEST y verificar el health. Nunca se configuran flags ni
endpoints AEAT de produccion en staging.
