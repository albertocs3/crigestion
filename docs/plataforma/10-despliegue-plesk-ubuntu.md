# Despliegue en Plesk y Ubuntu 22.04

## 1. Alcance

Este runbook prepara CriGestion en `https://gestion.crisoft.es` con:

- Plesk para DNS, certificado TLS y proxy nginx.
- Next.js como servicio `systemd` ligado a `127.0.0.1:3100`.
- PostgreSQL 16 sin puerto publico.
- Copias y VeriFactu en procesos separados.

Plesk no soporta oficialmente Next.js mediante su toolkit Node. Por eso la
aplicacion se ejecuta fuera de Passenger y Plesk solo publica el proxy HTTPS.
El Compose actual sigue siendo exclusivamente TEST y no se reutiliza en
produccion.

## 2. Estado inicial seguro

El primer despliegue no envia nada a AEAT PRODUCCION:

```text
VERIFACTU_ENABLED=false
VERIFACTU_ALLOW_PRODUCTION=false
VERIFACTU_WORKER_ALLOW_PRODUCTION=false
VERIFACTU_WORKER_PRODUCTION_CONFIRM=
```

No se habilita `crigestion-verifactu-worker.service` hasta completar la
autorizacion fiscal, el ensayo de migraciones, el restore real y el checklist
de release. La prueba AEAT TEST ya superada no equivale a permiso de produccion.

## 3. Preparar Plesk

1. Crear el subdominio `gestion.crisoft.es` y un registro DNS `A` hacia el VPS.
2. No crear `AAAA` salvo que IPv6 este configurado y filtrado correctamente.
3. En **SSL/TLS Certificates**, emitir Let's Encrypt para el subdominio y
   activar la redireccion permanente de HTTP a HTTPS.
4. Desactivar PHP para el subdominio.
5. En **Apache & nginx Settings**, desactivar **Proxy mode** y pegar
   `deploy/plesk/gestion.crisoft.es.nginx.conf` en **Additional nginx
   directives**.
6. Aplicar y confirmar que nginx acepta la configuracion.

El proxy sobrescribe las cabeceras de reenvio. Solo por eso la aplicacion usa
`TRUST_PROXY_HEADERS=true`; no debe conservarse una cadena enviada por el
cliente.

## 4. Preparar el host por SSH

Se necesita acceso `root` o `sudo`. Instalar Node.js 22, PostgreSQL 16, el
cliente PostgreSQL 16, Git y OpenSSL. Antes de copiar las unidades confirmar:

```bash
node --version
npm --version
command -v node
command -v npm
command -v pg_dump
```

Las plantillas esperan `/usr/bin/node`, `/usr/bin/npm` y `/usr/bin/pg_dump`.
Si Plesk instala Node bajo `/opt/plesk/node/22/bin`, editar `ExecStart` con la
ruta real antes de instalar las unidades. No crear enlaces opacos que cambien
de version sin una release.

Crear usuarios y directorios:

```bash
sudo groupadd --system crigestion-code
sudo useradd --system --home /opt/crigestion --shell /usr/sbin/nologin crigestion
sudo useradd --system --gid crigestion-code --create-home --home-dir /var/lib/crigestion-deploy --shell /usr/sbin/nologin crigestion-deploy
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin crigestion-verifactu
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin crigestion-backup
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin crigestion-migrator
sudo usermod --append --groups crigestion-code crigestion
sudo usermod --append --groups crigestion-code crigestion-verifactu
sudo usermod --append --groups crigestion-code crigestion-backup
sudo usermod --append --groups crigestion-code crigestion-migrator
sudo install -d -o root -g crigestion-code -m 0750 /opt/crigestion/releases
sudo install -d -o root -g root -m 0755 /etc/crigestion
sudo chmod 0700 /var/lib/crigestion-deploy
sudo install -d -o crigestion -g crigestion -m 0750 /var/cache/crigestion
sudo install -d -o crigestion-backup -g crigestion-backup -m 0700 /var/lib/crigestion/backups
```

PostgreSQL debe escuchar solo en socket local o `127.0.0.1`. No publicar 5432.
Crear una base `crigestion_prod` y roles distintos para runtime, migraciones y
copias. El rol migrador aplica una sola vez `npm run prisma:deploy`; el usuario
de la aplicacion no debe tener DDL ni ser superusuario. Verificar previamente
que la extension `btree_gist` esta disponible. El executor de copias usa hoy
una unica conexion tanto para `pg_dump` como para actualizar la cola e insertar
auditoria: `crigestion_backup` necesita lectura del esquema y DML limitado a
`backup_operations` y `audit_events`, pero no DDL, restore ni superusuario.

## 5. Secretos

Copiar las cinco plantillas de `deploy/plesk/environment/` a `/etc/crigestion/`,
sin conservar el sufijo `.example`, y sustituir todos los `CHANGE_ME`:

```bash
sudo chown root:crigestion /etc/crigestion/app.env
sudo chmod 0640 /etc/crigestion/app.env
sudo chown root:crigestion-verifactu /etc/crigestion/verifactu-worker.env
sudo chmod 0640 /etc/crigestion/verifactu-worker.env
sudo chown root:crigestion-backup /etc/crigestion/backup.env
sudo chmod 0640 /etc/crigestion/backup.env
sudo chown root:crigestion-migrator /etc/crigestion/migrator.env
sudo chmod 0640 /etc/crigestion/migrator.env
sudo chown root:crigestion-code /etc/crigestion/build.env
sudo chmod 0640 /etc/crigestion/build.env
```

Generar secretos independientes, por ejemplo con `openssl rand -base64 32`.
Custodiar fuera del VPS la clave de backup y todos los keyrings historicos.
Nunca guardar el PFX, su clave, URLs con contrasena o keyrings en Git, Plesk,
el document root, tickets o logs.

El proceso web no recibe `RESTORE_TARGET_DATABASE_URL`, `PG_RESTORE_BINARY` ni
la clave de backup. La restauracion destructiva se ejecuta solo como operacion
manual y aislada.

## 6. Construir una release

Usar una carpeta nueva identificada por tag o SHA. Ejemplo:

```bash
set -euo pipefail
export RELEASE_ID=REEMPLAZAR_POR_SHA_O_TAG
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$ ]] || { echo "RELEASE_ID invalido" >&2; exit 1; }
sudo install -d -o crigestion-deploy -g crigestion-code -m 0750 "/opt/crigestion/releases/$RELEASE_ID"
sudo -u crigestion-deploy git clone REEMPLAZAR_REPOSITORIO "/opt/crigestion/releases/$RELEASE_ID"
cd "/opt/crigestion/releases/$RELEASE_ID"
sudo -u crigestion-deploy git checkout --detach "$RELEASE_ID"
sudo -u crigestion-deploy npm ci --include=dev
sudo -u crigestion-deploy npm run prisma:generate
sudo -u crigestion-deploy /usr/bin/node --env-file=/etc/crigestion/build.env node_modules/next/dist/bin/next build
sudo -u crigestion-deploy rm -rf .next/cache
sudo -u crigestion-deploy ln -s /var/cache/crigestion .next/cache
```

Antes de migrar: verificar la release, crear una copia recuperable y ensayar
las migraciones sobre una copia representativa. Instalar primero la unidad
`crigestion-migrate@.service` y ejecutar la migracion con el rol migrador. La
URL no se pasa en la linea de comandos ni queda en el historial:

```bash
set -euo pipefail
sudo cp deploy/plesk/systemd/crigestion-migrate@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl stop crigestion-verifactu-worker.service 2>/dev/null || true
sudo systemctl stop crigestion-backup-worker.timer 2>/dev/null || true
sudo systemctl stop crigestion-backup-worker.service 2>/dev/null || true
sudo systemctl stop crigestion-app.service 2>/dev/null || true
sudo systemctl start "crigestion-migrate@$RELEASE_ID.service"
test "$(sudo systemctl show --property=Result --value "crigestion-migrate@$RELEASE_ID.service")" = "success"
sudo systemctl status "crigestion-migrate@$RELEASE_ID.service" --no-pager
sudo -u crigestion-deploy npm prune --omit=dev
sudo chown -R root:crigestion-code "/opt/crigestion/releases/$RELEASE_ID"
sudo chmod -R o-rwx,g-w "/opt/crigestion/releases/$RELEASE_ID"
sudo ln -sfn "/opt/crigestion/releases/$RELEASE_ID" /opt/crigestion/current
```

No ejecutar `prisma migrate dev` ni `db:seed` en produccion. Un rollback de
binario solo es valido si el esquema sigue siendo compatible. En releases
posteriores, activar primero mantenimiento, drenar el worker, comprobar que no
hay claims fiscales activos, completar una copia verificada y comprobar que no
queda ninguna copia `RUNNING`; solo entonces parar servicios. Tras migrar:
arrancar web, validar health/login, reactivar el
timer y, si ya estaba autorizado, una sola instancia del worker; retirar
mantenimiento al final.

## 7. Instalar servicios

```bash
sudo cp deploy/plesk/systemd/crigestion-*.service /etc/systemd/system/
sudo cp deploy/plesk/systemd/crigestion-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/crigestion-app.service \
  /etc/systemd/system/crigestion-backup-worker.service \
  /etc/systemd/system/crigestion-backup-worker.timer \
  /etc/systemd/system/crigestion-verifactu-worker.service \
  /etc/systemd/system/crigestion-migrate@.service
sudo systemctl enable --now crigestion-app.service
sudo systemctl enable --now crigestion-backup-worker.timer
```

No habilitar todavia `crigestion-verifactu-worker.service`.

Consultar estado y logs sin imprimir ficheros de entorno:

```bash
sudo systemctl status crigestion-app.service --no-pager
sudo journalctl -u crigestion-app.service -n 100 --no-pager
sudo systemctl list-timers crigestion-backup-worker.timer
```

El timer procesa solicitudes de copia ya encoladas; no sustituye una politica
de copia diaria ni la replica off-site. Definir retencion, RPO/RTO y copiar los
artefactos cifrados a almacenamiento independiente con versionado/inmutabilidad.

## 8. Verificacion antes de abrir

Desde el VPS:

```bash
curl --fail --silent http://127.0.0.1:3100/api/health
```

Desde otro equipo:

```bash
curl --fail --silent https://gestion.crisoft.es/api/health
curl --head http://gestion.crisoft.es
```

No basta HTTP 200. Con VeriFactu desactivado se espera:

```json
{"status":"ok","database":"ok","verifactu":"disabled","worker":"not_required"}
```

Comprobar tambien:

- login y logout;
- cookie `Secure`, `HttpOnly` y `SameSite`;
- CSP, HSTS, `nosniff` y ausencia de `X-Powered-By`;
- rechazo CSRF/origin desde un host distinto;
- que una cabecera `X-Forwarded-For` falsa no suplanta la IP real;
- que 3100 y 5432 no son accesibles desde Internet;
- reinicio limpio de la aplicacion y arranque tras reiniciar el VPS;
- solicitud, cifrado, replica off-site y restauracion real en un entorno aislado.

## 9. Activacion posterior de VeriFactu

La activacion productiva es otra release y otra ventana. Requiere completar
`docs/plataforma/09-release-checklist.md`, conservar evidencia del ciclo AEAT
TEST y registrar la autorizacion. Entonces se configuran conjuntamente los
tres bloqueos de produccion:

```text
# app.env y verifactu-worker.env
VERIFACTU_ENABLED=true
VERIFACTU_ENVIRONMENT=PRODUCTION
VERIFACTU_ALLOW_PRODUCTION=true
VERIFACTU_PRODUCTION_RELEASE_ID=RELEASE_O_TICKET_APROBADO

# verifactu-worker.env
VERIFACTU_WORKER_ENVIRONMENT=PRODUCTION
VERIFACTU_WORKER_ALLOW_PRODUCTION=true
VERIFACTU_WORKER_PRODUCTION_CONFIRM=AEAT_PRODUCTION_AUTHORIZED
VERIFACTU_WORKER_EXPECTED_DATABASE=crigestion_prod
```

Verificar antes empresa, NIF, instalacion SIF PRODUCCION, credencial activa con
permiso de produccion, keyrings historicos, base exacta y release ID. Reiniciar
primero la aplicacion y comprobar que el health falla cerrado mientras no haya
worker. Despues habilitar una sola instancia:

```bash
sudo systemctl enable --now crigestion-verifactu-worker.service
```

Si cualquier identidad de entorno, base o confirmacion no coincide, el worker
falla cerrado. Confirmar el JSON completo de `/api/health`, el heartbeat del
panel y una operacion controlada antes de considerar la release operativa.

## 10. Operacion del VPS

- Restringir SSH y Plesk 8443 a IP administrativa o VPN.
- Exponer publicamente solo 80/443 y los servicios Plesk realmente usados.
- Usar un unico gestor de firewall para evitar reglas contradictorias.
- Aplicar parches Plesk/Ubuntu/PostgreSQL en ventana y ejecutar smoke despues.
- Alertar por disco, memoria, TLS, health, worker y antiguedad de la ultima
  copia off-site verificada.
- Planificar la migracion de Ubuntu 22.04 antes de que termine su mantenimiento
  estandar en mayo de 2027.

## 11. Referencias operativas

- [Plesk: Next.js no esta soportado directamente por el toolkit Node](https://support.plesk.com/hc/en-us/articles/12376965359511-Does-Plesk-support-Next-JS).
- [Plesk: proxy nginx manual hacia una aplicacion Node en loopback](https://support.plesk.com/hc/en-us/articles/12377017564567-How-to-create-Nginx-reverse-proxy-for-Node-js-application-and-let-Nginx-handle-SSL-on-Plesk-server).
- [Plesk: configuracion Apache y nginx por dominio](https://docs.plesk.com/en-US/obsidian/customer-guide/websites-and-domains/hosting-settings/web-server-settings/apache-and-nginx-settings.72320/).
- [Plesk: gestion automatica de certificados Let's Encrypt](https://docs.plesk.com/en-US/obsidian/administrator-guide/plesk-administration/managing-let%E2%80%99s-encrypt-settings.78586/).
- [PostgreSQL: instalacion en Ubuntu](https://www.postgresql.org/download/linux/ubuntu/).
- [Ubuntu: ciclo de vida de releases](https://ubuntu.com/about/release-cycle).
