# Despliegue staging en Plesk y Ubuntu 22.04

## 1. Alcance y estado actual

Este runbook cubre exclusivamente `https://gestion-test.crisoft.es` en el VPS
Ubuntu 22.04 administrado con Plesk.

Estado verificado el 2026-08-20:

- VPS `93.93.116.238`.
- Node.js `22.23.2` en `/opt/plesk/node/22/bin/node`.
- PostgreSQL 14 en el puerto 5432.
- Base `crigestion_staging`.
- Rol runtime `crigestion_staging_app`.
- Rol migrador `crigestion_staging_migrator`.
- Extensiones `btree_gist` y `pg_trgm` instaladas.
- Release activa `staging-2026.08.20-rc6`.
- Commit `c19a3b7bb952f55b9899fb050af534bf65624591`.
- Release en `/opt/crigestion-staging/releases/staging-2026.08.20-rc6` y
  enlace `/opt/crigestion-staging/current`.
- 155 migraciones completadas y 0 incompletas activas.
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
  deploy/plesk/staging/systemd/crigestion-staging-subscription-reactivation-worker.service \
  deploy/plesk/staging/systemd/crigestion-staging-subscription-reactivation-worker.timer \
  'deploy/plesk/staging/systemd/crigestion-staging-migrate@.service' \
  deploy/plesk/staging/systemd/crigestion-staging-backup.service \
  deploy/plesk/staging/systemd/crigestion-staging-backup.timer \
  deploy/plesk/staging/systemd/crigestion-staging-backup-alert.service \
  deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle.service \
  deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle-alert.service \
  deploy/plesk/staging/systemd/crigestion-staging-recovery-bundle.timer \
  deploy/plesk/staging/systemd/crigestion-staging-recovery-drill.service \
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
`root:crigestion-staging-release` y modo `0750` tanto la biblioteca
`node_modules/.prisma/client/libquery_engine-*.so.node` como el binario
`node_modules/@esbuild/linux-x64/bin/esbuild`. El runtime necesita ejecutar
ambos artefactos: Prisma sirve a la aplicación y `tsx` usa esbuild en los
workers VeriFactu y de reactivación. Un modo `0640`/`0711` incorrecto provoca
`EACCES` o `PrismaClientInitializationError` y debe corregirse antes de dar por
terminada la promoción.

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
- timer de reactivaciones programadas activo y ultimo oneshot correcto;
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
journalctl -u crigestion-staging-subscription-reactivation-worker.service --since today --no-pager
curl --fail --silent http://127.0.0.1:3101/api/health
curl --fail --silent https://gestion-test.crisoft.es/api/health
```

Este monitor se ejecuta dentro del mismo VPS. No detecta una caida completa del
servidor, del proveedor o del propio timer; eso requiere monitorizacion externa.
El checksum y `pg_restore --list` cada cinco minutos son baratos con el tamano
actual; revisar su frecuencia cuando la base crezca.

### 6.1 Worker de reactivaciones programadas

La unidad `crigestion-staging-subscription-reactivation-worker.service` usa el
rol runtime y `app.env`, no credenciales migradoras. Es one-shot y su timer la
invoca cada cinco minutos. Antes de habilitar el timer tras una release:

```bash
systemctl daemon-reload
systemctl start crigestion-staging-subscription-reactivation-worker.service
systemctl show crigestion-staging-subscription-reactivation-worker.service \
  -p Result -p ExecMainStatus
systemctl enable --now crigestion-staging-subscription-reactivation-worker.timer
```

El health check exige ademas que la ultima ejecucion del worker haya terminado
correctamente en los ultimos 15 minutos. Tras instalar o reiniciar el timer se
debe arrancar una vez el servicio manualmente antes de validar el health.
Si el oneshot esta ejecutandose cuando comienza el health, la comprobacion de
frescura espera su resultado mediante el orden de systemd y acepta
temporalmente `ActiveState=activating`; `TimeoutStartSec` sigue cerrando un
worker bloqueado.

Exigir `Result=success`, `ExecMainStatus=0` y un journal terminado en
`SUBSCRIPTION_REACTIVATION_AUTOMATION_OK`. El log solo contiene contadores. El
restore controlado detiene este timer y su oneshot antes de modificar la base y
los reinicia unicamente tras retirar el sentinel de recuperacion.

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
maestra. El área de trabajo persistente
`/var/lib/crigestion-staging-recovery-work` evita depender del tamano de `/run`;
si un `SIGKILL` deja un directorio con plaintext, el siguiente intento falla
cerrado con `RECOVERY_BUNDLE_STALE_WORKDIR` hasta que un operador lo inspeccione
y elimine.

Instalar tambien `crigestion-staging-recovery-drill` como `root:root 0750`, su
unidad como `0644` y `scripts/extract-recovery-bundle.py` dentro de cada release.
El drill autentica y extrae el bundle en
`/var/lib/crigestion-staging-recovery-drill`, un estado root-only con limite de
memoria y comprobacion previa de espacio libre. Liga cabecera autenticada,
nombre, version y manifiesto, restaura el dump
en una base `crigestion_recovery_drill_*`, verifica cada adjunto del dump por
tamano y SHA-256, comprueba tablas ordinarias sin RLS antes de consultar con el
rol de aplicacion, valida los punteros de logo y elimina base y ficheros al
terminar. No detiene ni modifica staging principal:

```bash
systemd-analyze verify \
  /etc/systemd/system/crigestion-staging-recovery-drill.service
systemctl daemon-reload
systemctl start crigestion-staging-recovery-drill.service
systemctl status crigestion-staging-recovery-drill.service --no-pager
journalctl -u crigestion-staging-recovery-drill.service -n 100 --no-pager
```

El resultado exigido es `RECOVERY_DRILL_OK`. Un checksum, inventario, ruta,
entrada TAR, dump, referencia, hash, falta de espacio o base residual de un
ensayo anterior hace fallar cerrado el ensayo. La base temporal comparte el
cluster PostgreSQL de staging, pero usa un nombre aislado, roles sin privilegios
elevados y no recibe trafico de la aplicacion principal.

El almacenamiento privado de adjuntos reside en
`/var/lib/crigestion-staging/attachments`, propiedad
`crigestion-staging:crigestion-staging` y modo `0700`. Antes de desplegar esta
rebanada, instalar ClamAV daemon, confirmar `clamdscan` y crear el directorio:

```bash
install -d -o crigestion-staging -g crigestion-staging -m 0700 \
  /var/lib/crigestion-staging/attachments
systemctl is-active clamav-daemon.service
/usr/bin/clamdscan --version
```

La aplicacion usa `clamdscan --stream`, no `--fdpass`. El streaming mantiene
el escaneo funcional dentro del espacio de nombres creado por
`ProtectSystem=strict`; `--fdpass` puede hacer que `clamd` rechace el descriptor
como no regular al cruzar ese limite. La validacion previa a una release debe
ejecutar un archivo inocuo como `crigestion-staging` con el mismo aislamiento
systemd de la unidad web y exigir codigo de salida `0`. No relajar
`ProtectSystem` ni convertir un resultado inconcluso en aceptacion.

Configurar `ATTACHMENT_STORAGE_ROOT` y `ATTACHMENT_CLAMD_SCAN_PATH` en
`app.env`. El paquete integral copia solo claves definitivas
`company-logo/<empresa>/<adjunto>.(png|jpg)` dentro de
`uploads/attachments.tar`, verifica propietario/modos y excluye `.quarantine`.
El manifiesto registra recuento y SHA-256 del archivo. El artefacto sigue
residiendo en el mismo VPS: para cerrar
la recuperacion integral debe copiarse a almacenamiento externo, cifrado e
inmutable. El drill local acredita la coherencia del artefacto, pero el RPO/RTO
ante perdida total del servidor solo queda cerrado al repetirlo desde la copia
externa y con la clave recuperada desde su custodia independiente.

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

### 8.3 Despliegue acumulativo del 2026-08-08

La release `staging-2026.08.08-rc3` promovio el entorno desde 96 hasta 133
migraciones. Antes de cada cambio persistente se creo un dump custom, se
verifico su SHA-256 y se valido su catalogo con `pg_restore --list`; se
preservaron ademas copias identificadas con `rc1`, el estado intermedio de
`rc2` y `rc3`.

El primer intento detecto eventos de constraint triggers diferidos pendientes
entre el backfill y el endurecimiento de identidades documentales. El segundo
confirmo el mismo patron en el backfill del modo de rectificacion. Ambos
intentos se revirtieron transaccionalmente, se inventariaron sus objetos
fisicos antes de usar `prisma migrate resolve --rolled-back`, y se corrigieron
en tags posteriores sin mover los tags ya publicados. Las migraciones finales
se separaron por limites de commit y la unidad controlada de `rc3` termino con
`Result=success` y endurecimiento de privilegios aplicado.

La conmutacion del enlace fue atomica. Web y worker se arrancaron en ese orden;
los health local y publico devolvieron HTTP 200 con aplicacion, PostgreSQL,
VeriFactu TEST y worker en `ok`, y el monitor canonico registro
`CRIGESTION_STAGING_HEALTH_OK`. Produccion no se modifico. La UAT funcional de
las devoluciones parciales queda documentada por separado cuando finalice.

### 8.4 Despliegue de categorias de Soporte del 2026-08-20

La release inmutable `staging-2026.08.20-rc7`, commit
`55f5399131443a8984858ab1d8e70e2ef0e77bc0`, se materializo desde el tag
publicado mediante un archivo de 1.512.723 bytes y SHA-256
`7a8637412a36b68cf7ec1f3359db3bd41869fbfb0cc2f1d353fdf8fe1d4c36c5`.
El build de staging produjo el identificador `KJp61ASjsqvq5vwJwWE3o`.

Antes de migrar se creo el dump custom
`crigestion_staging-auto-20260820T121739Z.dump`, de 1.519.061 bytes y SHA-256
`f6450b03e3be55954a1e25883b9b15031e750d504c8a84f2ae3af85d66bb8e7a`;
su checksum y su catalogo `pg_restore --list` se verificaron correctamente. Se
detuvieron web, worker VeriFactu y el timer de reactivacion. La unidad
`crigestion-staging-migrate@staging-2026.08.20-rc7.service` aplico solo
`20260820050000_add_support_category_changes` y termino con
`Result=success`. PostgreSQL quedo con 156 migraciones completas, cero
incompletas, `unaccent` instalado, cero colisiones de nombres canonicos y los
cinco triggers esperados de integridad.

Tras podar dependencias y normalizar permisos, `current` se conmutó
atomicamente a `rc7`. Web y worker se arrancaron en ese orden; VeriFactu se
confirmo en `TEST`, los timers operativos quedaron activos, no habia unidades
fallidas, el health canonico termino con `Result=success` y los health local y
publico devolvieron HTTP 200 con todos los componentes en `ok`. Un smoke
autenticado con el rol Tecnico confirmo el `403` de administracion de
categorias sin `Support.ManageCategories`; no se modificaron datos. La UAT
funcional de cambio de datos y estado queda pendiente de una sesion
Administrador. Produccion no se consulto ni modifico y el acceso SSH temporal
permanece activo.

La UAT Administrador posterior cerro ese pendiente con la categoria sintetica
`UAT Categorias RC7 20260820 VALIDADA`
(`cce2c110-c0ca-4f69-9667-17e4baa3e34e`). La interfaz creo la categoria,
edito sus datos, la desactivo, la reactivo y la dejo finalmente inactiva. La
proyeccion termino en version 5 y PostgreSQL verifico cuatro evidencias
append-only, versiones 2 a 5, cadena OLD→NEW continua y cuatro auditorias de
cambio sin nombre, descripcion, color ni motivos. La fila inactiva permanece
visible para filtros historicos, pero fuera del catalogo activo de nuevas
altas. El health siguio completo en `ok` y VeriFactu en TEST durante toda la
prueba.

### 8.5 Cambio administrativo de cliente de Soporte del 2026-08-20

La release inmutable `staging-2026.08.20-rc8`, commit
`c6590fd5e15e7dc155bda1d401bf5c6076968502`, se materializó desde el tag
publicado mediante un archivo de 1.523.767 bytes y SHA-256
`d85b423a86618cf643a5224f362baac04201b61ccdfb8f7ee1556c7c9054596b`.
El build de staging produjo el identificador `_Z4bsvZCigAT8knQkuZlW`.

Antes de migrar se creó el dump custom
`crigestion_staging-auto-20260820T131052Z.dump`, de 1.540.326 bytes y SHA-256
`e99e4153be6e42f4fb77b4167e48df53b55419ad7e21fccf90066f0fadd3fd4b`;
su checksum y su catálogo `pg_restore --list` se verificaron correctamente. La
unidad controlada
`crigestion-staging-migrate@staging-2026.08.20-rc8.service` aplicó solo
`20260820060000_add_support_incident_customer_changes`, terminó con
`Result=success` y dejó 157 migraciones finalizadas y ninguna migración activa
incompleta.

Después de podar dependencias y normalizar permisos, `current` se conmutó
atómicamente a `rc8`. La aplicación y el worker VeriFactu quedaron activos;
los timers de reactivación, health, backup y recovery bundle quedaron en
espera activa. VeriFactu se confirmó en `TEST`, no quedaron unidades fallidas,
el health canónico terminó con `Result=success` y el health público devolvió
HTTP 200 con aplicación, PostgreSQL, VeriFactu y worker en `ok`.

La UAT Administrador cambió la incidencia sintética `INC-2026-00003` del
cliente 3 al cliente de pruebas 2. La pantalla confirmó la operación y mostró
la evidencia y el evento. PostgreSQL verificó la proyección en versión 5,
exactamente una evidencia append-only, un evento `CUSTOMER_CHANGED` y una
auditoría sin motivo, título ni descripción. El permiso
`Support.ChangeIncidentCustomer` quedó asignado únicamente a Administrador. La
FK de comunicaciones dejó de incluir `customerId`, pasó a referenciar solo la
incidencia y empresa con `ON UPDATE RESTRICT`, y el trigger mantiene la
igualdad de cliente en enlaces nuevos o modificados. Así no existe cascada
sobre el cliente histórico. Producción no se consultó ni modificó y el acceso
SSH temporal permanece activo.

### 8.6 Historial paginado de correcciones de comunicaciones del 2026-08-20

La release inmutable `staging-2026.08.20-rc9`, commit
`7c60f148dd20f1054182f0094dff4add2e0b7206`, se materializó desde el tag
publicado mediante un archivo de 1.531.118 bytes y SHA-256
`d93fccbde46435b99aac50733e0b8184cc458eece45b2d465471ebd69bdf6c70`.
El build aislado de staging produjo el identificador
`4MyWWii4rPPVYcap2g2U5`.

Antes del corte se creó el dump custom
`crigestion_staging-auto-20260820T203738Z.dump`, de 1.562.833 bytes y SHA-256
`eed227dd50096be083c7d39c432be3e155c582c17c302e6f432f08001b3cd214`;
su catálogo se verificó con `pg_restore --list`. La release no contiene
migraciones nuevas, por lo que no se ejecutó una unidad migradora. Tras podar
dependencias y normalizar permisos, se detuvieron aplicación, worker y timers
de health/reactivación, se conmutó `current` atómicamente desde `rc8` a `rc9` y
se restauraron los cuatro servicios.

La aplicación, el worker VeriFactu TEST y los timers quedaron activos; no hubo
unidades fallidas. El health canónico terminó con `Result=success` y el health
público devolvió HTTP 200 con aplicación, PostgreSQL, VeriFactu y worker en
`ok`. La comprobación visual autenticada queda pendiente porque la sesión del
navegador incrustado había expirado y mostró el login. No se introdujeron datos
de prueba durante el smoke. Producción no se consultó ni modificó y el acceso
SSH temporal permanece activo.

### 8.7 Hotfix de vínculo histórico de comunicaciones del 2026-08-21

La UAT de `rc9` detectó antes de enviar datos que el formulario mostraba “Sin
incidencia” aunque la comunicación conservaba un vínculo histórico válido con
una incidencia cuyo cliente había cambiado. No se ejecutó la corrección en ese
estado. El hotfix inmutable `staging-2026.08.21-rc10`, commit
`4f801521e1fb034caa3a554171d1f7784a5056cc`, añadió únicamente la opción del
vínculo vigente ausente del catálogo y mantuvo la autoridad server-side.

La release se materializó con 1.532.053 bytes y SHA-256
`146a0f8cd1c9f903056754023cb8d4844877cd6d79d910667ad1a760cfdd5918`;
el build aislado produjo `AWXlSVvkEJMQjZWYJzuJG`. No hubo migraciones ni
cambios de dependencias. Se reutilizó el backup verificado inmediatamente antes
de `rc9`, se podaron dependencias, se normalizaron permisos y se conmutó
`current` atómicamente desde `rc9`.

La UAT Administrador confirmó que `INC-2026-00002` aparecía seleccionada y
marcada como vínculo histórico. Se corrigió únicamente el resumen de la
comunicación sintética `d30bbe43-81b2-4854-a432-977cd0afc434`; la proyección
terminó en versión 2, conservó la incidencia, mostró la diferencia OLD→NEW y
PostgreSQL verificó una evidencia de versión 2 y una auditoría cuyo payload no
contenía resumen, motivo ni teléfono. El health canónico y público permaneció
en `ok`, VeriFactu siguió en TEST y no hubo unidades fallidas. Producción no se
consultó ni modificó; el acceso SSH temporal permanece activo.

### 8.8 Marcado múltiple de notificaciones del 2026-08-21

La release inmutable `staging-2026.08.21-rc11`, commit
`adb54ff5fee6125a9dd91ef063bcc1cd0aab6e6b`, se materializó desde el tag
publicado mediante un paquete fuente de 9.011.200 bytes y SHA-256
`cd24fef4f520dba4a2275f4f94ef1b7b301e99bea473fd0fbbfd75365b9f112e`.
El build aislado produjo el identificador `ifRQdqThGs5NVkA7ZT7oj`.

Antes de migrar se creó el dump custom
`crigestion_staging-auto-20260821T063848Z.dump`, de 1.564.376 bytes y SHA-256
`c8f2cd0d2a1130e17bbac9ef6e426000ea443c0c67adfd455748f47326f5a30f`;
su catálogo se verificó con `pg_restore --list`. El primer arranque de la
unidad migradora falló antes de ejecutar cambios porque el binario
`schema-engine` del paquete tenía modo `0640`. La release activa continuó
siendo `rc10`. Se corrigió únicamente el permiso de ejecución dentro de la
nueva release a `0750` y se repitió la unidad controlada. Esta aplicó solo
`20260821000000_harden_notification_state_timestamps` y terminó con
`Result=success` y `ExecMainStatus=0`.

Después se conmutó `current` atómicamente a `rc11`. Aplicación, worker
VeriFactu TEST y timers de reactivación, health, backup y bundle de recuperación
quedaron activos, sin unidades fallidas. La UAT autenticada de marcado múltiple
se cerró con tres notificaciones y la evidencia detallada en el acta. El health
público devolvió HTTP 200 con todos los componentes en `ok`. Producción no se
consultó ni modificó y el acceso SSH temporal permanece activo.

### 8.9 Retención automática de notificaciones del 2026-08-21

La release final `staging-2026.08.21-rc13`, commit
`cfb5add4a730788bfc7ecbc206952b130036890f`, incorpora
`crigestion-staging-notification-purge.service` y su timer diario a las 04:15
`Europe/Madrid`, con retraso aleatorio de hasta quince minutos. La unidad es
`oneshot`, usa el usuario de aplicación, falla cerrada durante una restauración
y limita cada ejecución a diez lotes de 500 por defecto. El health exige timer
activo, último resultado correcto y un sello de éxito persistente no más antiguo
de 36 horas; no se usa el timestamp efímero del proceso `oneshot`, porque
algunas versiones de systemd lo reinician a cero después de finalizar;
el bundle de recuperación conserva las dos unidades y el restore las detiene y
reanuda junto con el resto de procesos mutadores.

Antes de migrar se creó el dump
`crigestion_staging-auto-20260821T084003Z.dump`, de 1.565.478 bytes y SHA-256
`ba0a83ccefed34084eefa352eeabeae9d81c507fd2fbe6869a19c472e3af28fb`;
su catálogo se verificó con `pg_restore --list`. La unidad migradora aplicó
únicamente `20260821010000_add_notification_retention_purge` y terminó con
`Result=success`.

La primera ejecución sobre `rc12` terminó correctamente con cero lotes y cero
filas, pero la comprobación posterior detectó que este systemd no conserva
`ExecMainExitTimestampMonotonic` para el nuevo `oneshot`. No se aceptó ese
health fallido. El hotfix `rc13` sustituyó esa fuente efímera por un sello de
éxito creado mediante `StateDirectory`; su paquete fuente medía 1.549.897 bytes
y tenía SHA-256
`358b4ce7fca6cd5ca2599614e9a54f8206df9c0b518a7e25a29542c996d25cc4`.
El build aislado produjo `ssuEobydaIbb9yz44LZHr`.

La ejecución final registró
`NOTIFICATION_PURGE_AUTOMATION_OK` con cero notificaciones, cambios de estado e
idempotencias; el timer quedó activo para las 04:15 `Europe/Madrid` y el health
canónico terminó con `Result=success`. El bundle cifrado
`crigestion-staging-20260821T084752Z.cgrb` se verificó con SHA-256
`c5e931ff7519b173dab6df5d83f9c4b410d11d5da1e420c38fdac234daa6b4e7`.

La unidad usa el `DATABASE_URL` ordinario, pero el migrador revoca a ese rol el
`DELETE` sobre notificaciones y evidencias y solo concede `EXECUTE` sobre
`purge_expired_notifications(integer,integer,text)`. El despliegue debe
verificó ambas negaciones con `has_table_privilege`, el `EXECUTE`, el atributo
`SECURITY DEFINER`, el propietario migrador y
`search_path=pg_catalog, public` con UTC. Un resultado
`NOTIFICATION_PURGE_BACKLOG_REMAINS` es fallo operativo y debe mantener la
alerta activa; no se acepta como ejecución correcta. Aplicación, worker
VeriFactu TEST y timers operativos quedaron activos, el health local y público
respondió `ok` y no hubo unidades CriGestión fallidas. Producción no se
consultó ni modificó; el acceso SSH temporal permanece activo.

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
