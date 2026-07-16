# Despliegue staging en Plesk y Ubuntu 22.04

## 1. Alcance y estado actual

Este runbook cubre exclusivamente `https://gestion-test.crisoft.es` en el VPS
Ubuntu 22.04 administrado con Plesk.

Estado verificado el 2026-07-16:

- VPS `93.93.116.238`.
- Node.js `22.23.1` en `/opt/plesk/node/22/bin/node`.
- PostgreSQL 14 en el puerto 5432.
- Base `crigestion_staging`.
- Rol runtime `crigestion_staging_app`.
- Rol migrador `crigestion_staging_migrator`.
- Extension `btree_gist` instalada.
- Release activa `staging-2026.07.15-rc2`.
- Commit `2f7dc1a04620fe5815fff9167b43b77a25dda438`.
- Release en `/opt/crigestion-staging/releases/staging-2026.07.15-rc2` y
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
app.env                      root:crigestion-staging            0640
migrator.env                 root:crigestion-staging-migrator   0640
verifactu-worker.env         root:crigestion-staging-verifactu  0640
```

No registrar ni mostrar su contenido durante verificaciones.

## 4. Validacion e instalacion de unidades operativas

Crear antes el directorio de backups:

```bash
install -d -o root -g root -m 0700 /root/crigestion-staging-backups
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
   npm run build
   test -s .next/BUILD_ID
   ```

   Las dependencias de desarrollo son necesarias durante el build; Prisma
   carga `dotenv/config` desde `prisma.config.ts`.

3. Revisar el SQL de todas las migraciones pendientes.
4. Crear y publicar un tag inmutable; verificar tag y SHA remotos y en el VPS.
5. Crear y verificar un backup recuperable antes de migrar.
6. Detener siempre el worker durante migraciones y cambio de release para
   impedir procesamiento AEAT concurrente. Detener la web o activar
   mantenimiento segun compatibilidad y ventana aprobada.
7. Ejecutar una sola unidad
   `crigestion-staging-migrate@<RELEASE_ID>.service`; no usar
   `prisma migrate dev` ni `db:seed`.
8. Confirmar que el migrador efectivo es `crigestion_staging_migrator` y no
   tiene atributos elevados.
9. El post-migrado debe dejar al runtime sin acceso a `_prisma_migrations`, sin
   `UPDATE` en secuencias y sin `UPDATE`, `DELETE` ni `TRUNCATE` sobre
   `audit_events`.
10. Cambiar el enlace `current` y arrancar la web. Antes del worker comprobar
    proceso y journal; con VeriFactu habilitado, un health degradado/503 puede
    ser esperado en este punto.
11. Arrancar el worker y exigir entonces health completo HTTP 200.

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
