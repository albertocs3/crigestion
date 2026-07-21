# Checklist de release de Plataforma

## 1. Objetivo

Este checklist define los pasos minimos para preparar y validar una release de CriGestion antes de desplegarla.

Aplica a cambios de Plataforma, seguridad, persistencia, configuracion, auditoria y despliegue.

## 2. Precondiciones

- Rama de release mergeada o lista para mergear en `main`.
- Revision de cambios completada.
- Migraciones Prisma revisadas.
- Variables del entorno destino preparadas fuera del repositorio.
- Backup disponible antes de aplicar migraciones en produccion.

## 3. Variables requeridas

Revisar como minimo:

| Variable | Produccion | Nota |
|---|---|---|
| `DATABASE_URL` | Obligatoria | Base PostgreSQL del entorno destino. |
| `APP_ENV` | `production` | Activa validaciones runtime estrictas. |
| `APP_BASE_URL` | HTTPS obligatorio | Debe ser el origen publico de la aplicacion. |
| `APP_SESSION_SECRET` | Obligatoria | Minimo 32 caracteres, no usar placeholders. |
| `AUTH_COOKIE_NAME` | Opcional | Por defecto `crigestion_session`. |
| `AUTH_COOKIE_SECURE` | No puede ser `false` | Las cookies deben ser seguras en produccion. |
| `AUTH_COOKIE_SAME_SITE` | `lax` o `strict` | Valor por defecto `lax`. |
| `TRUST_PROXY_HEADERS` | Segun despliegue | `true` solo detras de proxy confiable que sobrescribe cabeceras. |
| `BACKUP_DIRECTORY` | Obligatoria si se ejecutan copias | Directorio server-side fuera de `public/`. |
| `BACKUP_ENCRYPTION_KEY` | Obligatoria si se ejecutan copias | Clave hex de 64 caracteres o base64 de 32 bytes. |
| `PG_DUMP_BINARY` | Opcional | Por defecto `pg_dump`. |
| `BACKUP_AUTO_PROCESS` | Opcional | En produccion queda deshabilitado salvo valor `true`; preferir worker gestionado si el despliegue puede cortar tareas en segundo plano. |
| `BACKUP_RUNNING_TIMEOUT_MINUTES` | Opcional | Por defecto 720; marca `RUNNING` antiguos como fallidos. |
| `ATTACHMENT_STORAGE_ROOT` | Obligatoria al habilitar adjuntos | Directorio absoluto privado fuera del repositorio y de `public/`; `0700`, propiedad del usuario web. |
| `ATTACHMENT_CLAMD_SCAN_PATH` | Obligatoria al habilitar adjuntos | Ruta absoluta a `clamdscan`; el daemon y las firmas deben estar activos y actualizados. |
| `RESTORE_VALIDATION_TIMEOUT_MINUTES` | Opcional | Por defecto 720; marca `VALIDATING` antiguos como fallidos. |
| `PG_RESTORE_BINARY` | Opcional | Por defecto `pg_restore`; usado solo por `restore:apply`. |
| `RESTORE_TARGET_DATABASE_URL` | Obligatoria en produccion si se aplica una restauracion real | Base destino explicita para `pg_restore`; en desarrollo puede omitirse para usar `DATABASE_URL`. |
| `VERIFACTU_ENABLED` | `false` hasta autorizacion | Interruptor funcional de la aplicacion y el worker. |
| `VERIFACTU_ENVIRONMENT` | `PRODUCTION` solo en la release autorizada | Selecciona endpoints, QR y registros fiscales productivos. |
| `VERIFACTU_ALLOW_PRODUCTION` | `false` hasta autorizacion | Bloqueo de la aplicacion: impide preparar ALTA, anulacion o subsanacion productivos. |
| `VERIFACTU_PRODUCTION_RELEASE_ID` | Vacia hasta autorizacion | Identificador estable de release o ticket aprobado; obligatorio al abrir la preparacion productiva. |
| `VERIFACTU_WORKER_ENVIRONMENT` | Obligatoria para el worker | Debe coincidir con `VERIFACTU_ENVIRONMENT`; usar `TEST` hasta aprobar PRODUCCION. |
| `VERIFACTU_WORKER_ALLOW_PRODUCTION` | `false` hasta autorizacion | Segundo bloqueo explicito para impedir arranque accidental contra AEAT PRODUCCION. |
| `VERIFACTU_WORKER_PRODUCTION_CONFIRM` | Vacia hasta autorizacion | Tercer bloqueo. Solo usar `AEAT_PRODUCTION_AUTHORIZED` despues de registrar la aprobacion de release. |
| `VERIFACTU_WORKER_EXPECTED_DATABASE` | Obligatoria | En PRODUCCION debe coincidir exactamente con la base real y no puede terminar en `_test` o `-test`. |
| `VERIFACTU_PAYLOAD_ACTIVE_KEY_ID` / `VERIFACTU_PAYLOAD_KEYS` | Obligatorias | Keyring de payloads; conservar claves historicas mientras existan registros retenidos. |
| `VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID` / `VERIFACTU_CREDENTIAL_KEYS` | Obligatorias | Keyring separado para PFX; custodiar fuera del repositorio. |
| `VERIFACTU_RESPONSE_ACTIVE_KEY_ID` / `VERIFACTU_RESPONSE_KEYS` | Obligatorias | Keyring separado para respuestas AEAT cifradas. |
| `VERIFACTU_CREDENTIAL_IDEMPOTENCY_SECRET` | Obligatoria | Secreto estable y distinto del de sesiones; conservar durante la retencion idempotente. |
| `SENSITIVE_DATA_ACTIVE_KEY_ID` / `SENSITIVE_DATA_KEYS` | Obligatorias al habilitar proveedores | Keyring AES-256-GCM de datos personales; conservar claves historicas durante toda la retencion. |
| `SENSITIVE_DATA_LOOKUP_SECRET` | Obligatoria al habilitar proveedores | Secreto HMAC estable, distinto de claves y sesiones, para unicidad sin texto claro. |
| `RECOVERY_BUNDLE_KEY_ID` | Obligatoria en el bundle integral de staging | Identificador no secreto de la clave maestra custodiada externamente. |

La clave maestra de recovery no se introduce como variable de entorno. En
Ubuntu 22.04 el oneshot la recibe mediante `LoadCredential` desde un fichero
`root:root 0400`, oculto al proceso tras cargarlo; conservar fuera del host la
clave de 32 bytes y todas las generaciones necesarias durante la retencion.
Este fallback no cifra el fichero fuente en reposo y exige proteger tambien el
disco y los backups del sistema.

## 4. Validacion previa

Ejecutar:

```powershell
npm run verify:release
```

El CI ejecuta este mismo comando contra PostgreSQL con las migraciones aplicadas.

Si el cambio toca flujos de navegador criticos, ejecutar tambien:

```powershell
npm run test:e2e
```

## 5. Migraciones

En produccion, aplicar migraciones como paso controlado y unico:

```powershell
npm run prisma:deploy
```

No ejecutar `prisma migrate dev` en produccion.

Antes de migrar:

- Confirmar backup PostgreSQL.
- Revisar SQL nuevo en `prisma/migrations/`.
- Confirmar que no hay migraciones editadas ya aplicadas.

## 6. Despliegue

Para el VPS Plesk de `gestion.crisoft.es`, aplicar ademas el runbook
`docs/plataforma/10-despliegue-plesk-ubuntu.md`; las unidades separan web,
migraciones, copias y worker fiscal, y mantienen PRODUCCION bloqueada en el
primer arranque.

Orden recomendado:

1. Instalar dependencias con lockfile.
2. Generar Prisma Client.
3. Construir la aplicacion.
4. Aplicar migraciones con `npm run prisma:deploy`.
5. Arrancar la aplicacion con variables runtime definitivas.
6. Verificar health check.
7. Verificar permisos `0700/0600`, escritura exclusiva del proceso web, ClamAV
   activo y carga/descarga de un logo de prueba. Confirmar que el paquete
   integral incluye `uploads/attachments.tar` y excluye `.quarantine`.
8. Verificar que el proceso que ejecuta copias, automatico o `npm run backup:run`, tiene acceso a `pg_dump`, `DATABASE_URL`, `BACKUP_DIRECTORY` y `BACKUP_ENCRYPTION_KEY`.
9. Verificar que el proceso que ejecuta `npm run restore:validate` tiene acceso a `BACKUP_DIRECTORY` y `BACKUP_ENCRYPTION_KEY`.
10. Si se habilita aplicacion real, verificar que el proceso que ejecuta `npm run restore:apply` o `POST /api/platform/restores/apply` tiene acceso a `pg_restore`, `RESTORE_TARGET_DATABASE_URL`, `BACKUP_DIRECTORY` y `BACKUP_ENCRYPTION_KEY`.
11. Ejecutar VeriFactu como job Node separado y supervisado. En Windows TEST,
    preparar `.env.test.local` con la conexion a `crigestion_test`; el instalador
    genera `.env.worker.local` por allowlist y ACL restringida, tomando solo los
    keyrings necesarios de `.env.local`. Instalar con
    `npm run verifactu:service:install` y comprobar
    `npm run verifactu:service:status`; en otros destinos usar el supervisor
    equivalente con una unica instancia por empresa y entorno.
    El worker de PRODUCCION exige simultaneamente `APP_ENV=production`, ambos
    entornos VeriFactu en `PRODUCTION`, `VERIFACTU_WORKER_ALLOW_PRODUCTION=true`,
    `VERIFACTU_WORKER_PRODUCTION_CONFIRM=AEAT_PRODUCTION_AUTHORIZED` y la base
    real coincidente con `VERIFACTU_WORKER_EXPECTED_DATABASE`. Mantener los dos
    ultimos bloqueos desactivados hasta completar este checklist.
12. Para Docker TEST, preparar el fichero ignorado `.env.worker.local`, confirmar
    `VERIFACTU_WORKER_EXPECTED_DATABASE`, `VERIFACTU_MIGRATION_DATABASE_URL` y
    `VERIFACTU_MIGRATION_EXPECTED_DATABASE`; ambos nombres deben terminar en
    `_test`. Detener la tarea Windows y arrancar
    explicitamente `docker compose --profile verifactu-test up -d
    verifactu-worker-test`; Compose exige que el servicio one-shot
    `verifactu-migrate-test` complete `prisma migrate deploy` antes del worker.
    Confirmar despues el estado `healthy` del contenedor. Desde el host,
    `npm run verifactu:health` solo valida el despliegue indicado por
    `VERIFACTU_WORKER_DEPLOYMENT_ID` y su fichero de estado local.
13. En staging, ejecutar manualmente el paquete integral cifrado, exigir
    `RECOVERY_BUNDLE_OK`, verificar su checksum y solo despues habilitar
    `crigestion-staging-recovery-bundle.timer`. Confirmar que la copia externa no
    contiene la clave maestra y que permanece recuperable desde su custodia.
    Ejecutar despues `crigestion-staging-recovery-drill.service`, exigir
    `RECOVERY_DRILL_OK` y confirmar que no quedan bases ni workdirs temporales.

## 7. Verificacion post-despliegue

Comprobar:

```powershell
$health = Invoke-RestMethod https://TU-DOMINIO/api/health
if ($health.status -ne "ok" -or $health.database -ne "ok" -or
    $health.verifactu -ne "ok" -or $health.worker -ne "ok") {
  throw "La release no esta lista para recibir trafico."
}
```

No basta con recibir HTTP 200: un estado `degraded` bloquea la release. La
respuesta no debe exponer secretos ni topologia interna.

Validar ademas:

- Login de administrador.
- Logout.
- Acceso denegado con usuario sin permiso.
- Visor de auditoria.
- Configuracion de plataforma.
- Si se usa restauracion, comprobar que `GET/PATCH /api/platform/maintenance` permite activar y desactivar mantenimiento con una restauracion `VALIDATED`.

## 8. Smoke VeriFactu AEAT TEST

Este smoke es externo, opt-in y no forma parte del CI. Requiere una factura de
prueba cuyo `ALTA` y `ANULACION` hayan sido aceptados sin errores por AEAT TEST.
Solo se ejecuta con `APP_ENV=test`, sobre una base cuyo nombre termine en
`_test` y contra una instalacion SIF `TEST` identificada expresamente.

Configurar temporalmente, fuera del repositorio:

```powershell
$env:VERIFACTU_AEAT_TEST_CYCLE_ENABLED="true"
$env:VERIFACTU_AEAT_TEST_CYCLE_CONFIRM="AEAT_TEST_ONLY"
$env:APP_ENV="test"
$env:VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_DATABASE="NOMBRE_EXACTO_DB_test"
$env:VERIFACTU_AEAT_TEST_CYCLE_INVOICE_ID="UUID_FACTURA_TEST"
$env:VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_INVOICE_NUMBER="NUMERO_FACTURA_TEST"
$env:VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_COMPANY_ID="UUID_EMPRESA_TEST"
$env:VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_SIF_INSTALLATION_ID="UUID_INSTALACION_TEST"
$env:VERIFACTU_AEAT_TEST_CYCLE_EXPECTED_CANCELLATION_ID="UUID_ANULACION_TEST"
$env:VERIFACTU_AEAT_TEST_CYCLE_OPERATOR_ID="OPERADOR_DECLARADO"
$env:VERIFACTU_AEAT_TEST_CYCLE_RELEASE_ID="RELEASE_O_TICKET"
npm run verifactu:verify-aeat-test-cycle
```

El comando falla cerrado si el entorno o la base no coinciden, si falta la
evidencia local terminal, si la cadena ALTA/ANULACION es incoherente o si la
consulta AEAT no confirma `Anulado`. El resultado esperado es:

```text
AEAT TEST cycle verified: ALTA ACCEPTED -> ANULACION ACCEPTED -> QUERY ANULADO
```

Registrar en la release la fecha, version desplegada y correlation/request id
de auditoria. No copiar NIF, XML, certificado, claves ni respuestas SOAP al
ticket de release. La respuesta SOAP queda cifrada en el intento fiscal; la
auditoria `SYSTEM` conserva el operador declarado, host del runner,
identificadores tecnicos, resultado y hashes SHA-256 de los bytes SOAP.

## 9. Rollback

Si falla el despliegue:

1. Detener trafico o activar mantenimiento si existe.
2. Revisar logs con correlation id.
3. Restaurar version anterior de la aplicacion.
4. Si una migracion dejo la base incompatible, seguir el procedimiento de restauracion desde backup.
5. Registrar la incidencia y el resultado de recuperacion.

No revertir migraciones de produccion manualmente sin plan de datos revisado.

## 10. Notas operativas

- `TRUST_PROXY_HEADERS=true` solo debe usarse si el proxy elimina o sobrescribe `X-Forwarded-For` y `X-Real-IP`.
- HSTS se emite en builds de produccion.
- La validacion de entorno se ejecuta al iniciar runtime Node.js.
- El rate limit de login por IP depende de una IP cliente confiable.
- Las copias manuales se solicitan por API y se procesan fuera del request HTTP con `npm run backup:run`.
- El worker de copias pasa a `pg_dump` un entorno minimo y no propaga secretos de aplicacion salvo la contrasena PostgreSQL como `PGPASSWORD`.
- Las restauraciones se validan primero de forma no destructiva con `npm run restore:validate`; este comando no ejecuta `pg_restore` ni modifica datos de negocio.
- Antes de una restauracion real debe activarse modo mantenimiento; las mutaciones normales quedan bloqueadas, pero login/logout/sesion/CSRF y el endpoint de mantenimiento siguen disponibles para evitar lockout.
- La aplicacion real de una restauracion debe crear antes una copia previa verificada y conservar su identificador en `preRestoreBackupOperationId`.
- Tras una restauracion correcta, comprobar `revokedSessionCount`,
  `versionedUserCount` y `restartRequired: true`; reiniciar aplicacion, workers y
  schedulers antes de desactivar el mantenimiento.
- En staging, una recuperacion desde el dump PostgreSQL diario debe usar
  `crigestion-staging-restore`: nunca ejecutar `pg_restore` manualmente sobre la
  base activa ni retirar un sentinel `RECOVERY_REQUIRED` sin diagnostico.
- El paquete integral de staging incluye configuracion y keyrings historicos,
  pero no es recuperacion ante perdida total mientras solo exista en el mismo
  VPS. Replicarlo cifrado a una custodia externa e inmutable y ejecutar drills.
  El drill actual acredita coherencia de PostgreSQL, keyrings y adjuntos; queda
  pendiente un runner controlado que reinstale tambien release y configuracion.
- El paso destructivo de restauracion solo debe activarse con mantenimiento en modo `RESTORE`.
- El perfil `verifactu-test` es opt-in, no publica puertos y no sustituye el
  paso controlado de migraciones. Nunca debe coexistir con otro worker para la
  misma empresa y entorno.
- En produccion, `npm run restore:apply` y `POST /api/platform/restores/apply` exigen `RESTORE_TARGET_DATABASE_URL` para evitar aplicar por accidente sobre `DATABASE_URL`.
