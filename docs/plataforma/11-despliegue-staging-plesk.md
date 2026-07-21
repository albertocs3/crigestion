# Despliegue staging en Plesk y Ubuntu 22.04

## 1. Alcance y estado actual

Este runbook cubre exclusivamente `https://gestion-test.crisoft.es` en el VPS
Ubuntu 22.04 administrado con Plesk.

Estado verificado el 2026-07-17:

- VPS `93.93.116.238`.
- Node.js `22.23.1` en `/opt/plesk/node/22/bin/node`.
- PostgreSQL 14 en el puerto 5432.
- Base `crigestion_staging`.
- Rol runtime `crigestion_staging_app`.
- Rol migrador `crigestion_staging_migrator`.
- Extension `btree_gist` instalada.
- Release activa `staging-2026.07.17-rc2`.
- Commit `ddfc6ce037b68683755d160d53b79fbadab0a011`.
- Release en `/opt/crigestion-staging/releases/staging-2026.07.17-rc2` y
  enlace `/opt/crigestion-staging/current`.
- 79 migraciones aplicadas y 0 incompletas.
- Aplicacion y worker VeriFactu TEST activos y habilitados.
- Health local y publico en estado `ok` con HTTP 200.
- Backup PostgreSQL diario y health cada cinco minutos activos mediante timers.
- Alertas de fallo entregadas por Postfix/Plesk y verificadas extremo a extremo.

La implantacion inicial ya termino. No repetir inicializacion, migraciones ni
importacion de credenciales como si fuera un entorno vacio. El espacio libre es
un dato volatil; comprobarlo con `df -h /` antes de cada release o restore.

Las contrasenas, claves de cifrado y material de certificado quedan bajo
custodia del usuario. No se copian en este documento, Git, tickets, logs ni
comandos que puedan mostrarlos.

## 2. Invariantes de red, entorno y seguridad

Imunify360 es el unico gestor de reglas del host. **Plesk Firewall debe
permanecer desactivado.** El acceso externo a PostgreSQL se limita a la IP fija
de oficina `88.26.204.241`; no se abre 5432 al resto de Internet. El puerto
interno 3101 escucha solo en `127.0.0.1` y no es publico.

Al principio de `/etc/postgresql/14/main/pg_hba.conf` se conserva:

```text
local all postgres peer
```

Esto permite administrar localmente como el usuario de sistema `postgres`. No
autoriza a la aplicacion a usar ese rol.

Staging se ejecuta con `NODE_ENV=production` y `APP_ENV=staging`. VeriFactu
solo puede usar AEAT TEST:

```text
VERIFACTU_ENVIRONMENT=TEST
VERIFACTU_WORKER_ENVIRONMENT=TEST
VERIFACTU_ALLOW_PRODUCTION=false
VERIFACTU_WORKER_ALLOW_PRODUCTION=false
```

Los cuatro valores son obligatorios y canonicos. El servidor rechaza
credenciales con `allowProduction=true` y asociaciones a instalaciones SIF
productivas.

La URL runtime debe declarar exactamente el rol `crigestion_staging_app`, la
autoridad numerica `127.0.0.1` o `::1`, puerto 5432, base
`crigestion_staging` y un unico parametro `schema=public`. Se rechazan otros
parametros, incluidos `host`, `hostaddr`, `service`, `options`, `user`, `port`
y duplicados. Web, worker, health y migrador comprueban tambien la identidad
efectiva mediante `current_database()`, `current_user`, `inet_server_addr()` e
`inet_server_port()`.

El worker systemd del VPS es el unico procesador VeriFactu TEST. No mantener un
worker local de Windows activo contra esta base.

## 3. Artefactos canonicos y layout

- Proxy nginx: `deploy/plesk/gestion-test.crisoft.es.nginx.conf`.
- Entornos: `deploy/plesk/staging/environment/`.
- Unidades: `deploy/plesk/staging/systemd/`.
- Scripts operativos: `deploy/plesk/staging/scripts/`.
- Migrador controlado: `scripts/deploy-staging-migrations.ts`.

Mapeo de instalacion:

```text
deploy/plesk/staging/scripts/*
  -> /usr/local/sbin/                         root:root 0750

deploy/plesk/staging/systemd/*.service
deploy/plesk/staging/systemd/*.timer
  -> /etc/systemd/system/                     root:root 0644

deploy/plesk/staging/environment/*.example
  -> /etc/crigestion-staging/*.env            permisos segun cada cabecera
```

Los scripts y unidades operativos se crearon inicialmente en el VPS durante la
implantacion. Las versiones del repositorio son la fuente canonica para futuras
reinstalaciones. Tras cambiar estos artefactos, sincronizarlos con el VPS,
ejecutar `systemd-analyze verify`, `systemctl daemon-reload` y probar cada
oneshot antes de reiniciar sus timers.

Nunca copiar los `CHANGE_ME` ni conservar la extension `.example`. Permisos:

```text
build.env                    root:root                          0600
alert.env                    root:root                          0600
recovery-bundle.env          root:root                          0600
app.env                      root:crigestion-staging            0640
migrator.env                 root:crigestion-staging-migrator   0640
verifactu-worker.env         root:crigestion-staging-verifactu  0640
recovery-bundle.key          root:root                          0400
```

No registrar ni mostrar su contenido durante verificaciones. La clave maestra
del paquete de recuperacion no se guarda en ningun `.env`: se conserva tambien
fuera del VPS y systemd la copia al directorio de credenciales runtime del
oneshot. Ubuntu 22.04 no distribuye `systemd-creds`; por ello el fichero fuente
queda root-only pero no cifrado en reposo. Proteger el disco del VPS y no incluir
este fichero en ninguna copia creada dentro del mismo host.

La unidad resuelve la copia runtime desde el directorio indicado por
`CREDENTIALS_DIRECTORY`: systemd 249 admite `LoadCredential` y esa variable,
pero no el especificador `%d` incorporado en versiones posteriores.

## 4. Validacion e instalacion de unidades operativas

Crear antes los directorios root-only de backups y paquetes de recuperacion:

```bash
install -d -o root -g root -m 0700 /root/crigestion-staging-backups
install -d -o root -g root -m 0700 /root/crigestion-staging-recovery
```

Validar todas las unidades en Ubuntu 22.04:

```bash
systemd-analyze verify \
  deploy/plesk/staging/systemd/crigestion-staging-app.service \
  deploy/plesk/staging/systemd/crigestion-staging-verifactu-worker.service \
  'deploy/plesk/staging/systemd/crigestion-staging-migrate@.service' \
  deploy/plesk/staging/systemd/crigestion-staging-backup.service \
  deploy/plesk/staging/systemd/crigestion-staging-backup.timer \
  deploy/plesk/staging/systemd/crigestion-staging-backup-alert.service \
  deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle.service \
  deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle-alert.service \
  deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle.timer \
  deploy/plesk/staging/systemd/crigestion-staging-health-check.service \
  deploy/plesk/staging/systemd/crigestion-staging-health-check.timer \
  deploy/plesk/staging/systemd/crigestion-staging-health-alert.service
```

Los avisos conocidos de `snapd.service` por `RestartMode` y
`meshcentral.service` por `Enviroment` son ajenos a CriGestion. No aceptar
avisos sobre unidades `crigestion-staging-*`.

Solo se habilitan directamente aplicacion, worker y timers. Migrador, backup,
health y alertadores son oneshots invocados de forma controlada o por timers y
`OnFailure`.

Sincronizar alertas como un conjunto indivisible: primero `alert.env`, despues
script y unidades, luego `systemd-analyze verify`, `daemon-reload`, dry run y
correo `--test`. Solo despues probar health y backup. Copiar solo el script
parametrizado sin su env romperia el aviso instalado.

## 5. Procedimiento para proximas releases

1. Validar el commit candidato: instalacion, Prisma generate, lint, typecheck,
   tests, auditoria y build.
2. Construir con el `build.env` de staging:

   ```bash
   npm ci --include=dev
   /opt/plesk/node/22/bin/node \
     --env-file=/etc/crigestion-staging/build.env \
     node_modules/prisma/build/index.js generate
   /opt/plesk/node/22/bin/node \
     --env-file=/etc/crigestion-staging/build.env \
     node_modules/next/dist/bin/next build
   test -s .next/BUILD_ID
   ```

   Las dependencias de desarrollo son necesarias durante el build; Prisma
   carga `dotenv/config` desde `prisma.config.ts`.

3. Revisar el SQL de todas las migraciones pendientes.
4. Crear y publicar un tag inmutable; verificar tag y SHA remotos y en el VPS.
   Materializar el commit verificado en la release antes de publicarla:

   ```bash
   git rev-parse HEAD > RELEASE_COMMIT
   chmod 0644 RELEASE_COMMIT
   ```
5. Crear y verificar un backup recuperable antes de migrar.
6. Detener siempre el worker durante migraciones y cambio de release para
   impedir procesamiento AEAT concurrente. Detener la web o activar
   mantenimiento segun compatibilidad y ventana aprobada.
7. Ejecutar una sola unidad
   `crigestion-staging-migrate@<RELEASE_ID>.service`; no usar
   `prisma migrate dev` ni `db:seed`. Antes de iniciarla, el directorio
   `node_modules/@prisma/engines` debe permitir escritura al grupo
   `crigestion-staging-release`; restaurar modo `0750` al terminar.
8. Confirmar que el migrador efectivo es `crigestion_staging_migrator` y no
   tiene atributos elevados.
9. El post-migrado debe dejar al runtime sin acceso a `_prisma_migrations`, sin
   `UPDATE` en secuencias y sin `UPDATE`, `DELETE` ni `TRUNCATE` sobre
   `audit_events`.
10. Cambiar el enlace `current` y arrancar la web. Antes del worker comprobar
    proceso y journal; con VeriFactu habilitado, un health degradado/503 puede
    ser esperado en este punto.
11. Arrancar el worker y exigir entonces health completo HTTP 200.

Tras el migrador y `npm prune --omit=dev`, normalizar a
`root:crigestion-staging-release` y modo `0750` la biblioteca
`node_modules/.prisma/client/libquery_engine-*.so.node`. La unidad runtime
necesita lectura y ejecucion de ese archivo; un modo `0711` provoca
`PrismaClientInitializationError` y exige rollback del enlace.

La unidad migradora tiene un timeout deliberado de 30 minutos. Observar
`systemctl status` y el journal ante bloqueos; no matar arbitrariamente una
migracion sin revisar actividad y locks PostgreSQL.

Si Prisma aplica migraciones pero falla el endurecimiento posterior, no
arrancar web ni worker. Inspeccionar `prisma migrate status`, corregir
privilegios y repetir el migrador idempotente. Un rollback binario solo es
valido si el esquema sigue siendo compatible.

## 6. Health y alertas

La version instalada y probada durante la implantacion comprueba aplicacion,
worker, timer de backup y health local/publico. La version canonica del
repositorio, pendiente de sincronizar como conjunto, amplia la comprobacion a:

- aplicacion y worker activos;
- timer de backup activo;
- copia automatica con antiguedad maxima de 36 horas;
- checksum y catalogo `pg_restore --list` de la ultima copia;
- health local en `127.0.0.1:3101`;
- DNS, TLS, proxy y health publico en `gestion-test.crisoft.es`.

El timer se ejecuta cada cinco minutos. Ante fallo, la version canonica de
`crigestion-staging-health-alert.service` envia un correo minimo mediante el
wrapper sendmail de Plesk/Postfix. No incluye respuestas HTTP, variables,
journal ni secretos. El cooldown limita los avisos repetidos a uno por hora.
El backup tiene ademas un `OnFailure` inmediato independiente, mientras la
frescura actua como defensa secundaria.

Comandos de diagnostico:

```bash
systemctl list-timers --all --no-pager | grep crigestion-staging
systemctl show crigestion-staging-health-check.service \
  -p Result -p ExecMainStatus -p OnFailure
journalctl -u crigestion-staging-health-check.service --since today --no-pager
journalctl -u crigestion-staging-health-alert.service --since today --no-pager
curl --fail --silent http://127.0.0.1:3101/api/health
curl --fail --silent https://gestion-test.crisoft.es/api/health
```

Este monitor se ejecuta dentro del mismo VPS. No detecta una caida completa del
servidor, del proveedor o del propio timer; eso requiere monitorizacion externa.
El checksum y `pg_restore --list` cada cinco minutos son baratos con el tamano
actual; revisar su frecuencia cuando la base crezca.

## 7. Backups y restore drill

`crigestion-staging-backup.timer` ejecuta un dump custom diario a las 02:15 con
un retraso aleatorio maximo de 15 minutos. La version canonica de cada copia:

- usa socket PostgreSQL local, puerto 5432 y usuario de sistema `postgres`;
- fija `psql`, `pg_dump` y `pg_restore` a PostgreSQL 14 bajo
  `/usr/lib/postgresql/14/bin`, evitando mezclar formatos de distintas versiones;
- verifica `current_database()` y `current_user` antes del dump;
- usa `--no-owner` y `--no-privileges`;
- valida el catalogo con `pg_restore --list`;
- guarda SHA-256 y permisos `0600`;
- mantiene un lock para impedir ejecuciones simultaneas;
- elimina solo copias automaticas con mas de 14 periodos completos de 24 horas
  segun la semantica `find -mtime +14`;
- nunca poda backups manuales.

El dump custom **no cifra el archivo completo**. Las columnas que la aplicacion
cifra permanecen cifradas, pero otros datos empresariales y fiscales pueden ser
legibles; tratar el dump como dato sensible. Tampoco incluye archivos
`/etc/crigestion-staging/*.env`, claves externas, uploads fuera de PostgreSQL ni
configuracion del VPS. No es por si solo una recuperacion completa.

`BACKUP_DIRECTORY=/var/lib/crigestion-staging/backups` y
`BACKUP_AUTO_PROCESS=false` pertenecen al subsistema interno de backups de la
aplicacion. No controlan este timer PostgreSQL ni su directorio `/root`.

Ejecutar el restore drill bajo demanda mediante una unidad transitoria. El
script acepta una copia automatica concreta bajo el directorio permitido o, sin
argumento, selecciona la mas reciente:

```bash
systemd-run \
  --unit="crigestion-staging-restore-drill-$(date -u +%Y%m%dt%H%M%Sz)" \
  --property=Type=oneshot \
  --property=RemainAfterExit=yes \
  --property=TimeoutStartSec=15min \
  --property=Nice=10 \
  /usr/local/sbin/crigestion-staging-restore-drill
```

El drill canonico crea una base con nombre estrictamente temporal, revoca `CONNECT` a
`PUBLIC`, restaura en una sola transaccion, exige migraciones completas,
`btree_gist` y ausencia de `CONNECT` para roles runtime/migrador. La base
temporal se intenta eliminar ante error y un fallo de limpieza queda marcado
como `RESTORE_DRILL_CLEANUP_FAILED`. No imprime filas ni conteos de negocio.
`RESTORE_DRILL_OK` demuestra restaurabilidad estructural basica, no completitud
semantica de todos los datos de negocio.

Tras el drill, detener la unidad transitoria y confirmar que no queda ninguna
base temporal:

```bash
systemctl stop <unidad-restore-drill>.service
runuser -u postgres -- psql -X -d postgres -Atqc \
  "SELECT datname FROM pg_database
   WHERE datname LIKE 'crigestion_restore_drill_%';"
```

### 7.1 Paquete integral cifrado de recuperacion

`crigestion-staging-recovery-bundle.timer` se ejecuta despues del backup diario
y genera un artefacto `CRIGESTION-RECOVERY-BUNDLE-v1`. El contenido se cifra y
autentica completo con AES-256-GCM; cada paquete usa una clave derivada mediante
HKDF-SHA256 a partir de una clave maestra de 32 bytes y una sal aleatoria. La
clave maestra es distinta de las claves de backup de la aplicacion, sesiones y
VeriFactu, nunca se incluye en el paquete y debe conservarse historicamente en
una custodia externa al VPS.

El paquete incluye:

- el ultimo dump automatico verificado y su checksum;
- `app.env`, worker, migrador, alertas y configuracion publica del bundle, que
  contienen los keyrings historicos necesarios para descifrar PFX, payloads y
  respuestas fiscales;
- roles PostgreSQL permitidos sin contrasenas y con instruccion de rotacion;
- release ejecutable completa (incluidos build y dependencias runtime, sin
  caches, `.git` ni ficheros `.env`), commit, lockfile, esquema Prisma,
  `BUILD_ID`, scripts y unidades operativas instaladas;
- manifiesto, inventario de modo/propietario/tamano y SHA-256 de cada fichero.

Antes de empaquetar, el verificador consulta la base activa y falla si cualquier
`encryptionKeyId` historico referenciado no esta presente en el keyring que le
corresponde. Ademas autentica y descifra, sin registrar el contenido, un envelope
real por cada clave historica: credenciales, payloads y respuestas; en estos dos
ultimos casos contrasta tambien el SHA-256 del texto claro. Tambien exige que
aplicacion y worker sigan en AEAT `TEST`. Esta comprobacion protege la
configuracion actual; la prueba de recuperacion del artefacto concreto sigue
siendo necesaria para acreditar su restaurabilidad.

Crear primero `recovery-bundle.env` desde el ejemplo y registrar un identificador
de clave no secreto. Partiendo de una clave aleatoria de 32 bytes ya depositada
en la custodia externa, crear el fichero fuente sin mostrarla en terminal:

```bash
umask 077
KEY_FINAL=/etc/crigestion-staging/recovery-bundle.key
KEY_TEMP="$(mktemp /etc/crigestion-staging/.recovery-bundle.key.XXXXXX)"
trap 'rm -f -- "$KEY_TEMP"' EXIT

test ! -e "$KEY_FINAL"
systemd-ask-password --no-tty 'Clave maestra de recovery (hex o base64)' \
  > "$KEY_TEMP"
chown root:root "$KEY_TEMP"
chmod 0400 "$KEY_TEMP"

RECOVERY_BUNDLE_KEY_FILE="$KEY_TEMP" \
  /opt/plesk/node/22/bin/node --conditions=react-server --import tsx \
  /opt/crigestion-staging/current/scripts/recovery-bundle-crypto.ts check-key

sync -f "$KEY_TEMP"
ln -- "$KEY_TEMP" "$KEY_FINAL"
rm -f -- "$KEY_TEMP"
sync -f /etc/crigestion-staging
trap - EXIT
```

Antes de activar el servicio, comprobar sin leer el contenido que la fuente es
regular, no symlink, `root:root 0400`, y que `/etc/crigestion-staging` no permite
escritura a grupo u otros. Excluir expresamente `recovery-bundle.key` de snapshots
y backups Plesk que puedan contener tambien base, configuracion o bundles.

Instalar conjuntamente script, servicio, timer y fichero de entorno. Validar
las unidades, recargar systemd y ejecutar el oneshot manualmente antes de
activar el timer y el health check:

```bash
systemd-analyze verify \
  /etc/systemd/system/crigestion-staging-recovery-bundle.service \
  /etc/systemd/system/crigestion-staging-recovery-bundle.timer
systemctl daemon-reload
systemctl start crigestion-staging-recovery-bundle.service
systemctl status crigestion-staging-recovery-bundle.service --no-pager
cd /root/crigestion-staging-recovery
sha256sum -c "$(find . -maxdepth 1 -type f -name '*.cgrb.sha256' \
  -printf '%T@ %f\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
systemctl enable --now crigestion-staging-recovery-bundle.timer
```

El resultado esperado del servicio es `RECOVERY_BUNDLE_OK`. El propio proceso
vuelve a autenticar el artefacto con la credencial antes de publicarlo. El health
check solo comprueba frescura y SHA-256, pues deliberadamente no recibe la clave
maestra.

Actualmente no existe almacenamiento de uploads fuera de PostgreSQL en el
producto; el manifiesto lo declara como `not_implemented` en vez de afirmar una
cobertura inexistente. El artefacto sigue residiendo en el mismo VPS: para cerrar
la recuperacion integral debe copiarse a almacenamiento externo, cifrado e
inmutable, y ensayarse su descifrado/restauracion aislada con la clave custodiada.
Hasta entonces no acredita por si solo el RPO/RTO ante perdida total del servidor.

### 7.2 Restauracion destructiva aislada de PostgreSQL

`crigestion-staging-restore` es el runner exclusivo para recuperar la base
`crigestion_staging` desde uno de los dumps automaticos root-only. No sustituye
una copia integral: estos dumps siguen sin incluir uploads, ficheros de entorno
ni keyrings. No usar este runner en produccion ni contra otra base.

Antes de habilitarlo, sincronizar los scripts de restore, drill, backup y health,
y las unidades de aplicacion y worker como un conjunto. Los scripts se instalan
`root:root 0750`, las unidades `root:root 0644`; despues ejecutar
`systemctl daemon-reload` y `systemd-analyze verify`.

El runner exige una ruta canonica, no symlink, `root:root 0600`, checksum valido,
catalogo legible, espacio libre y confirmacion literal del destino. Primero
ejecuta el drill aislado, después crea una copia pre-restore y solo entonces
detiene conexiones y comienza el paso destructivo:

```bash
BACKUP=/root/crigestion-staging-backups/crigestion_staging-auto-AAAAMMDDTHHMMSSZ.dump
systemd-run \
  --unit="crigestion-staging-restore-$(date -u +%Y%m%dt%H%M%Sz)" \
  --property=Type=oneshot \
  --property=RemainAfterExit=yes \
  --property=TimeoutStartSec=60min \
  /usr/local/sbin/crigestion-staging-restore \
  "$BACKUP" \
  --confirm=crigestion_staging
```

Fases relevantes:

1. Crea lock, sentinel y diario externos bajo
   `/var/lib/crigestion-staging-restore`, con permisos root-only.
2. Verifica identidad `crigestion_staging|postgres|5432`, checksum y drill.
3. Detiene health/backup, VeriFactu y web, y comprueba que no quedan conexiones.
4. Crea y verifica `crigestion_staging-pre-restore-*.dump`.
5. Restaura en una transaccion con ownership del migrador.
6. Ejecuta migraciones forward y reaplica el hardening del runtime.
7. Incrementa `securityVersion`, revoca todas las sesiones y verifica estructura.
8. Retira el sentinel, reinicia solo los servicios que estaban activos y exige
   health local y publico antes de devolver `RESTORE_OK`.

Si falla antes del paso destructivo, el runner retira el sentinel y recupera el
estado previo de servicios. Desde `DESTRUCTIVE_STEP_STARTED`, cualquier fallo
deja `phase=RECOVERY_REQUIRED`, aplicacion y worker detenidos, y termina con
`RESTORE_RECOVERY_REQUIRED`. En ese caso no volver a ejecutar el runner ni
borrar manualmente el sentinel: preservar el diario indicado, verificar la base
y decidir de forma explicita si se completa la recuperacion o se usa la copia
`pre-restore`. El health, el backup, la web y VeriFactu rechazan arrancar mientras
permanezca el sentinel.

## 8. Registro de implantacion inicial

El 2026-07-16 se verifico:

- login, logout y auditoria;
- HTTPS, proxy loopback y health HTTP 200;
- credencial y SIF exclusivamente TEST;
- ciclo VeriFactu `ALTA -> rechazo controlado -> subsanacion aceptada ->
  anulacion aceptada`;
- backup automatico, checksum y catalogo;
- restore real con 55 tablas, 4 secuencias, 251 indices, 261 restricciones,
  79 migraciones, 0 incompletas y `btree_gist` presente;
- roles runtime/migrador sin `CONNECT` a la base temporal;
- eliminacion de la base temporal y continuidad de web, worker y health;
- entrega real de alertas por correo bajo el hardening systemd definitivo.

No se documentan PFX, contrasenas, sujetos de certificado, identificadores
fiscales de prueba, numeros de factura ni payloads AEAT.

### 8.1 UAT de autenticacion, permisos y auditoria

El 2026-07-17 se completo en staging la aceptacion funcional desde navegador:

- logout con redireccion a `/login` e invalidacion real de la sesion;
- nuevo login administrativo y acceso autorizado a `/app/audit`;
- correlacion de login/logout, emision, operaciones VeriFactu, subsanacion y
  anulacion sin contrasenas, certificados, claves, XML completos ni secretos;
- rol UAT personalizado con un unico permiso `Billing.View`;
- denegacion server-side y auditoria `ACCESS_DENIED` para gestion de roles,
  usuarios, configuracion, auditoria y credenciales VeriFactu;
- ausencia de sesion UAT tras logout y proteccion de autocambios del
  administrador actual;
- bloqueo tras cinco intentos fallidos, manteniendo la respuesta publica
  `401 INVALID_CREDENTIALS` indistinguible tambien durante el bloqueo;
- conservacion interna de `ACCOUNT_LOCKED` en intentos y auditoria sin guardar
  la contrasena enviada;
- reactivacion manual del usuario UAT, inicialmente `ACTIVE` y sin fecha de
  bloqueo para continuar las pruebas;
- vencimiento del bloqueo automatico validado en `staging-2026.07.17-rc2` con
  una cuenta temporal restringida: el login correcto posterior creo la sesion,
  reinicio el contador y genero exactamente un `ACCOUNT_UNLOCKED` con motivo
  `LOCK_EXPIRED`;
- cinco fallos previos conservados como cuatro `INVALID_CREDENTIALS` y un
  `ACCOUNT_LOCKED`, sin distinguir el estado en la respuesta publica;
- cierre de la sesion temporal, cero sesiones activas y cuenta de prueba final
  `INACTIVE` tras la limpieza UAT;
- revocacion remota validada con una segunda cuenta restringida: la sesion
  aparecio en `/app/sessions`, desaparecio al pulsar `Revocar` y la misma cookie
  devolvio inmediatamente `{ "authenticated": false }`;
- auditoria `SESSION_REVOKED` con motivo `ADMIN_SESSION_REVOKED`, identificadores
  de usuario, sesion y actor, sin token ni secreto; cuenta temporal final
  `INACTIVE` y solo la sesion administradora activa;
- cabeceras publicas verificadas con CSP y `frame-ancestors 'none'`, HSTS,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, politica de
  referencia estricta y permisos de navegador restringidos;
- redireccion de una pagina privada anonima a `/login`, respuesta anonima
  estable de sesion y rechazo `401 UNAUTHENTICATED` en la API administrativa;
- rechazo de un login con origen no permitido mediante respuesta
  `403 ORIGIN_NOT_ALLOWED`;
- rechazo de una mutacion autenticada con origen permitido pero sin token CSRF
  mediante `403 CSRF_TOKEN_INVALID`, antes de procesar el cuerpo y sin crear
  datos; la cuenta temporal termino `INACTIVE`, su sesion quedo revocada y solo
  permanecio activa la sesion administradora;
- invalidacion inmediata de una sesion restringida al cambiar el rol del
  usuario, comprobada con la misma cookie mediante
  `{ "authenticated": false }`; el rol se restauro a `UAT_RESTRICTED`, la
  cuenta termino `INACTIVE` y solo permanecio activa la sesion administradora;
- auditoria de la asignacion y restauracion mediante dos eventos
  `USER_ROLE_CHANGED` con identificadores de usuario y actor y codigos de rol,
  sin contrasena, cookie, token ni otro secreto;
- invalidacion inmediata de las sesiones del rol al sustituir temporalmente
  `Billing.View` por `Catalog.View`, comprobada con la cookie previamente
  valida mediante `{ "authenticated": false }`;
- restauracion exacta de `Billing.View` como unico permiso, cuenta temporal
  final `INACTIVE` y solo la sesion administradora activa;
- auditoria de la sustitucion y restauracion mediante dos eventos
  `ROLE_PERMISSIONS_CHANGED` con identificadores y codigos de permisos, sin
  contrasena, cookie, token ni otro secreto.

La correccion del contrato de login se publico como
`staging-2026.07.17-rc1`. Antes del cambio se creo y verifico un backup; el
migrador controlado termino correctamente, y web, PostgreSQL, worker y
VeriFactu quedaron en estado `ok`. La autorizacion SSH temporal usada durante
el despliegue se retiro al finalizar. Produccion no se modifico.

La release `staging-2026.07.17-rc2` se desplego despues de un backup verificado
y una unidad migradora terminada con resultado `success`. Dos intentos de corte
activaron el rollback automatico a `rc1` mientras se corrigieron exclusivamente
permisos de escritura/lectura de los motores Prisma. El corte final dejo web,
PostgreSQL, worker y VeriFactu en estado `ok`; no hubo cambios de esquema ni de
produccion.

### 8.2 Cierre de la aceptacion

Tras completar las pruebas se desactivaron las tres cuentas UAT, se confirmo
que solo permanecia activa la sesion administradora y se verifico el evento
`USER_DEACTIVATED` sin secretos. La decision, los riesgos aceptados y el
siguiente ciclo funcional se registran en
`docs/plataforma/12-acta-uat-staging-2026-07-17.md`.

## 9. Rollback y recuperacion

Antes de una release conservar tag, SHA, backup previo y ruta de la release
anterior. Un rollback de enlace solo es valido si la version anterior soporta
el esquema ya migrado. Si no existe compatibilidad demostrada, mantener los
servicios parados y restaurar mediante un procedimiento aprobado.

Para recuperar desde backup:

1. verificar SHA-256 y `pg_restore --list`;
2. restaurar primero en una base aislada;
3. validar migraciones, extensiones y permisos;
4. no realizar llamadas externas durante la restauracion;
5. no sobrescribir `crigestion_staging` sin una autorizacion explicita y una
   copia previa adicional.

## 10. Riesgos aceptados y pendientes

- Las copias siguen en el mismo VPS; la copia externa cifrada se aplazo.
- Los dumps custom tienen permisos `0600` y comprobacion SHA-256 de consistencia
  frente a corrupcion accidental, pero no firma/autenticidad ni cifrado
  adicional del archivo completo.
- Falta custodiar fuera del VPS el material necesario para una recuperacion
  completa, incluidas claves y configuracion protegida.
- No existe monitor externo que detecte la caida total del VPS.
- Tras modificar los artefactos operativos versionados, queda sincronizarlos y
  revalidarlos en el VPS antes de declarar paridad exacta repositorio-servidor.
