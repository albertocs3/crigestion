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
| `RESTORE_VALIDATION_TIMEOUT_MINUTES` | Opcional | Por defecto 720; marca `VALIDATING` antiguos como fallidos. |
| `PG_RESTORE_BINARY` | Opcional | Por defecto `pg_restore`; usado solo por `restore:apply`. |
| `RESTORE_TARGET_DATABASE_URL` | Obligatoria en produccion si se aplica una restauracion real | Base destino explicita para `pg_restore`; en desarrollo puede omitirse para usar `DATABASE_URL`. |

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

Orden recomendado:

1. Instalar dependencias con lockfile.
2. Generar Prisma Client.
3. Construir la aplicacion.
4. Aplicar migraciones con `npm run prisma:deploy`.
5. Arrancar la aplicacion con variables runtime definitivas.
6. Verificar health check.
7. Verificar que el proceso que ejecuta copias, automatico o `npm run backup:run`, tiene acceso a `pg_dump`, `DATABASE_URL`, `BACKUP_DIRECTORY` y `BACKUP_ENCRYPTION_KEY`.
8. Verificar que el proceso que ejecuta `npm run restore:validate` tiene acceso a `BACKUP_DIRECTORY` y `BACKUP_ENCRYPTION_KEY`.
9. Si se habilita aplicacion real, verificar que el proceso que ejecuta `npm run restore:apply` o `POST /api/platform/restores/apply` tiene acceso a `pg_restore`, `RESTORE_TARGET_DATABASE_URL`, `BACKUP_DIRECTORY` y `BACKUP_ENCRYPTION_KEY`.

## 7. Verificacion post-despliegue

Comprobar:

```powershell
Invoke-WebRequest https://TU-DOMINIO/api/health
```

La respuesta no debe exponer secretos ni topologia interna.

Validar ademas:

- Login de administrador.
- Logout.
- Acceso denegado con usuario sin permiso.
- Visor de auditoria.
- Configuracion de plataforma.
- Si se usa restauracion, comprobar que `GET/PATCH /api/platform/maintenance` permite activar y desactivar mantenimiento con una restauracion `VALIDATED`.

## 8. Rollback

Si falla el despliegue:

1. Detener trafico o activar mantenimiento si existe.
2. Revisar logs con correlation id.
3. Restaurar version anterior de la aplicacion.
4. Si una migracion dejo la base incompatible, seguir el procedimiento de restauracion desde backup.
5. Registrar la incidencia y el resultado de recuperacion.

No revertir migraciones de produccion manualmente sin plan de datos revisado.

## 9. Notas operativas

- `TRUST_PROXY_HEADERS=true` solo debe usarse si el proxy elimina o sobrescribe `X-Forwarded-For` y `X-Real-IP`.
- HSTS se emite en builds de produccion.
- La validacion de entorno se ejecuta al iniciar runtime Node.js.
- El rate limit de login por IP depende de una IP cliente confiable.
- Las copias manuales se solicitan por API y se procesan fuera del request HTTP con `npm run backup:run`.
- El worker de copias pasa a `pg_dump` un entorno minimo y no propaga secretos de aplicacion salvo la contrasena PostgreSQL como `PGPASSWORD`.
- Las restauraciones se validan primero de forma no destructiva con `npm run restore:validate`; este comando no ejecuta `pg_restore` ni modifica datos de negocio.
- Antes de una restauracion real debe activarse modo mantenimiento; las mutaciones normales quedan bloqueadas, pero login/logout/sesion/CSRF y el endpoint de mantenimiento siguen disponibles para evitar lockout.
- La aplicacion real de una restauracion debe crear antes una copia previa verificada y conservar su identificador en `preRestoreBackupOperationId`.
- El paso destructivo de restauracion solo debe activarse con mantenimiento en modo `RESTORE`.
- En produccion, `npm run restore:apply` y `POST /api/platform/restores/apply` exigen `RESTORE_TARGET_DATABASE_URL` para evitar aplicar por accidente sobre `DATABASE_URL`.
