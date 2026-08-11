# Contratos API: Atención al cliente

## Alcance implementado

La rebanada actual permite gestionar incidencias, participantes, comunicaciones telefónicas/WhatsApp con correcciones históricas, adjuntos seguros y notificaciones internas persistentes. Las fusiones quedan fuera del contrato actual.

## Permisos

- `Support.View`: listado y detalle de incidencias y categorías.
- `Support.Create` + `Support.View`: creación de incidencias.
- `Support.AddActions` + `Support.View`: actuaciones del responsable o de un administrador.
- `Support.ManageAssigned` + `Support.View`: estados pendientes, reanudación, resolución y cierre por el responsable o un administrador.
- `Support.Reopen` + `Support.View`: reapertura de incidencias finalizadas por un técnico autorizado.
- `Support.ManageParticipants` + `Support.View`: colaboradores y reasignación por el responsable o un administrador.
- `Support.ViewCommunications`: listado y detalle de comunicaciones.
- `Support.ManageCommunications` + `Support.ViewCommunications`: alta y corrección de comunicaciones.
- `Support.ManageCategories` + `Support.View`: pantalla y creación de categorías.
- `Support.ManageAttachments` + `Support.View`: carga de adjuntos por el responsable, un colaborador activo o Administrador.
- `Support.DownloadAttachments` + `Support.View`: descarga de adjuntos de incidencias visibles.

Los permisos se validan siempre en servidor. El rol técnico de soporte no obtiene por estos permisos acceso a suscripciones, facturación, tesorería ni contabilidad.

## `GET /api/support/incidents`

Consulta autenticada con `Support.View`. Admite `limit` (1..100), `cursor`, `status`, `priority`, `responsibleUserId`, `customerId` y `search`. La búsqueda se aplica a número, título y descripción, pero el listado no devuelve la descripción.

Respuesta `200`: `{ incidents, nextCursor }`. Incluye `Cache-Control: private, no-store, max-age=0`.

## `POST /api/support/incidents`

Mutación autenticada con `Support.Create` y `Support.View`, protección Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de 8 KiB e `Idempotency-Key` obligatoria.

```json
{
  "customerId": "uuid",
  "storeId": null,
  "categoryId": "uuid",
  "responsibleUserId": "uuid",
  "title": "Error al acceder",
  "description": "Descripción interna de la incidencia",
  "priority": "MEDIUM"
}
```

La incidencia se crea con estado `NEW`, versión `1`, responsable obligatorio y número anual `INC-AAAA-00001`. La tienda, si se indica, debe pertenecer al cliente. El responsable debe estar activo y conservar `Support.View` y `Support.AddActions`.

Respuesta `201`; un replay idéntico devuelve `200` sin repetir numeración, evento ni auditoría.

Errores funcionales: `PLATFORM_NOT_INITIALIZED`, `SUPPORT_CUSTOMER_NOT_FOUND`, `SUPPORT_STORE_NOT_FOUND`, `SUPPORT_CATEGORY_NOT_AVAILABLE`, `SUPPORT_RESPONSIBLE_NOT_AVAILABLE`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`, además de los errores comunes 400/401/403/413/415/422/423.

## `GET /api/support/incidents/{incidentId}`

Requiere `Support.View`. Devuelve el detalle y sus eventos o `404 SUPPORT_INCIDENT_NOT_FOUND`. UUID inválido devuelve `422 VALIDATION_ERROR` después de autorizar.

## `POST /api/support/incidents/{incidentId}/actions`

Requiere `Support.AddActions` y `Support.View`, además de ser el responsable vigente, un colaborador activo o Administrador. Aplica Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de 8 KiB e idempotencia.

```json
{
  "expectedVersion": 1,
  "text": "Se revisa la configuración y se restablece el acceso.",
  "performedAt": "2026-08-11T17:00:00.000Z"
}
```

La fecha real no puede preceder a la incidencia ni superar en más de cinco minutos el reloj del servidor. La primera actuación cambia automáticamente `NEW` a `IN_PROGRESS`, fija `firstActionAt` e incrementa la versión. Una incidencia `RESOLVED` o `CLOSED` debe reabrirse antes de admitir actuaciones.

Respuesta `201`; replay idéntico `200`. Errores estables: `SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_ACTION_FORBIDDEN`, `SUPPORT_INCIDENT_VERSION_CONFLICT`, `SUPPORT_INCIDENT_FINALIZED`, `SUPPORT_ACTION_DATE_INVALID`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`.

## `POST /api/support/incidents/{incidentId}/status-transitions`

Mutación con Origin/CSRF, mantenimiento, JSON estricto, máximo de 8 KiB, `Idempotency-Key` y `expectedVersion`. Los cambios ordinarios requieren `Support.ManageAssigned` + `Support.View` y responsable vigente o Administrador. La reapertura requiere `Support.Reopen` + `Support.View` y no depende de la asignación.

Los cuerpos admitidos son estrictos:

- pendiente: `{ "action":"set-pending", "expectedVersion":2, "targetStatus":"PENDING_CUSTOMER", "reason":"..." }`;
- retomar: `{ "action":"resume", "expectedVersion":3, "reason":"..." }`;
- resolver: `{ "action":"resolve", "expectedVersion":4, "solution":"..." }`;
- cerrar: `{ "action":"close", "expectedVersion":4, "closeReason":"DUPLICATE" }`; `OTHER` exige `detail`;
- reabrir: `{ "action":"reopen", "expectedVersion":5, "reason":"..." }`.

Resolver y cerrar son estados finales: no admiten actuaciones hasta reabrir. Cada transición incrementa una sola versión, crea evidencia append-only y un evento enlazado. Respuesta `201`; replay idéntico `200`. Errores estables: `SUPPORT_INCIDENT_TRANSITION_FORBIDDEN`, `SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_VERSION_CONFLICT`, `SUPPORT_INCIDENT_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`.

## `POST /api/support/incidents/{incidentId}/participant-changes`

Requiere `Support.ManageParticipants` + `Support.View` y ser el responsable vigente o Administrador. Usa Origin/CSRF, mantenimiento, JSON estricto, máximo de 4 KiB, `expectedVersion` e idempotencia.

- alta: `{ "action":"add-collaborator", "expectedVersion":2, "userId":"uuid" }`;
- retirada: `{ "action":"remove-collaborator", "expectedVersion":3, "collaboratorId":"uuid", "reason":"..." }`;
- reasignación: `{ "action":"reassign", "expectedVersion":4, "responsibleUserId":"uuid", "reason":"..." }`.

Los participantes deben estar activos y conservar `Support.View` + `Support.AddActions`. Un responsable no puede ser simultáneamente colaborador activo; si se desea reasignar a un colaborador se le retira primero. Los colaboradores activos pueden registrar actuaciones. La retirada no borra su historial y una reasignación no altera las colaboraciones restantes.

Respuesta `201`; replay idéntico `200`. Errores: `SUPPORT_INCIDENT_PARTICIPANT_FORBIDDEN`, `SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_VERSION_CONFLICT`, `SUPPORT_PARTICIPANT_NOT_AVAILABLE`, `SUPPORT_COLLABORATOR_ALREADY_ACTIVE`, `SUPPORT_COLLABORATOR_NOT_ACTIVE`, `SUPPORT_RESPONSIBLE_UNCHANGED`, `SUPPORT_RESPONSIBLE_IS_COLLABORATOR` y los comunes de idempotencia.

## `/api/support/categories`

`GET` requiere `Support.View`. `POST` requiere `Support.ManageCategories`, Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de 2 KiB e idempotencia.

```json
{
  "name": "Conectividad",
  "description": "Incidencias de red",
  "color": "#2563EB"
}
```

El nombre es único por empresa tras normalizar mayúsculas y acentos. No se registran nombre, descripción, título ni texto de incidencia en auditoría.

La migración crea la categoría `General` para empresas ya existentes. En una instalación nueva, el administrador crea al menos una categoría antes de registrar la primera incidencia.

## Adjuntos de incidencia

### `GET /api/support/incidents/{incidentId}/attachments`

Requiere `Support.View`. Devuelve hasta 100 adjuntos disponibles y limpios, ordenados del más reciente al más antiguo, más `nextCursor`; `cursor` permite continuar sin omitir adjuntos antiguos. No expone clave de almacenamiento, hash, resultado interno del antivirus ni ruta física. Incidencia inexistente o de otra empresa devuelve `404 SUPPORT_INCIDENT_NOT_FOUND`.

### `POST /api/support/incidents/{incidentId}/attachments`

Requiere `Support.ManageAttachments` + `Support.View` y ser responsable, colaborador activo o Administrador. Aplica Origin, CSRF, mantenimiento, `Idempotency-Key`, multipart estricto y límite de 16 MiB por archivo más 64 KiB de envoltura. Solo admite un campo `file` JPG/JPEG o PDF y `actionId` opcional de la misma incidencia.

El original se mantiene en cuarentena, se analiza, se valida y, para JPG, se recodifica sin metadatos. El artefacto final vuelve a analizarse antes de publicarse con clave opaca. PDF cifrado, activo, incremental o no inspeccionable se rechaza. La autorización se revalida bajo bloqueo al persistir. La respuesta `201` incluye solo metadatos observables. Replay válido devuelve `200`; clave reutilizada con otro archivo devuelve `409`.

Errores específicos: `403 SUPPORT_ATTACHMENT_FORBIDDEN`, `404 SUPPORT_INCIDENT_NOT_FOUND`, `409 IDEMPOTENCY_KEY_REUSED|IDEMPOTENCY_REPLAY_INVALID`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 SUPPORT_ATTACHMENT_*|SUPPORT_ATTACHMENT_FILE_REJECTED`, `429 SUPPORT_ATTACHMENT_RATE_LIMITED` con `Retry-After: 900`, y `503 ANTIVIRUS_UNAVAILABLE|SUPPORT_ATTACHMENT_CAPACITY_UNAVAILABLE|SUPPORT_ATTACHMENT_DATABASE_BUSY` con `Retry-After`.

### `POST /api/support/incidents/{incidentId}/attachments/{attachmentId}/download`

Requiere `Support.DownloadAttachments` + `Support.View`, Origin y CSRF. La relación empresa-incidencia-adjunto se comprueba conjuntamente. Solo descarga `AVAILABLE+CLEAN` y verifica tamaño y SHA-256 antes de responder. Usa `Content-Disposition: attachment`, `Content-Security-Policy: sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin` y `Cache-Control: private, no-store`. Las descargas se auditan sin nombre, contenido, ruta ni hash.

Los adjuntos son append-only: la API no ofrece borrado ni reemplazo. Se permiten en incidencias resueltas o cerradas si la autoridad de participante continúa vigente. El límite funcional por incidencia sigue siendo ilimitado, pero existe un techo operativo de 1,5 GiB por empresa para asegurar que la copia integral permanezca dentro del volumen de recuperación soportado de 2 GiB.

Deuda operativa controlada: el semáforo de cuatro lecturas es por proceso y el validador PDF aplica una política léxica fail-closed. Antes de escalar horizontalmente o ampliar compatibilidad PDF se sustituirán por un límite compartido/streaming y un parser o sanitizador aislado.

## `/api/support/communications`

`GET` requiere `Support.ViewCommunications` y admite cursor, cliente, incidencia y canal. `POST` requiere además `Support.ManageCommunications`, Origin/CSRF, mantenimiento, JSON estricto, 8 KiB e idempotencia. Registra cliente, canal `PHONE|WHATSAPP`, dirección, fecha real, número utilizado, duración telefónica, resumen, resultado e incidencia opcional del mismo cliente. `REQUIRES_FOLLOW_UP` y `REFERRED_TO_INCIDENT` exigen incidencia.

`GET /api/support/communications/{communicationId}` devuelve el detalle y correcciones. `POST .../corrections` exige todos los valores corregidos, `expectedVersion` y motivo. Cada corrección conserva la proyección anterior completa; ninguna comunicación se elimina. `contactId` es opcional para históricos, pero cuando se informa debe pertenecer al cliente, estar activo y contener exactamente el número utilizado para el canal seleccionado. `contactNumber` permanece como instantánea aunque el maestro cambie posteriormente.

Las lecturas de listado y detalle generan auditoría opaca sin resumen, número de contacto ni textos de corrección. Altas y correcciones comparten límites persistentes separados de 20 intentos por actor y empresa en 15 minutos. El replay válido se resuelve antes de consumir cuota. Al superar el límite se devuelve `429 SUPPORT_COMMUNICATION_RATE_LIMITED` con `Retry-After: 900`; tras tres conflictos serializables se devuelve `503 SUPPORT_COMMUNICATION_BUSY` con `Retry-After: 3`.

### `POST /api/support/communications/{communicationId}/incident`

Convierte una comunicación todavía no vinculada en una incidencia. Exige conjuntamente `Support.Create`, `Support.View`, `Support.ManageCommunications` y `Support.ViewCommunications`, además de Origin/CSRF, mantenimiento, JSON estricto, límite de 8 KiB e idempotencia. El cuerpo contiene `expectedCommunicationVersion`, `categoryId`, `responsibleUserId`, `storeId`, `title` y `priority`.

La transacción bloquea la comunicación, copia cliente y resumen, asigna el número anual, crea el evento inicial y enlaza la comunicación mediante una corrección append-only que cambia su resultado a `REFERRED_TO_INCIDENT`. El replay devuelve `200`; la primera ejecución devuelve `201`. Una comunicación vinculada devuelve `409 SUPPORT_COMMUNICATION_ALREADY_LINKED` y una versión obsoleta `409 SUPPORT_COMMUNICATION_VERSION_CONFLICT`. La auditoría registra identificadores y metadatos operativos, nunca resumen, teléfono ni motivo de corrección.

## Integridad y conservación

- PostgreSQL garantiza unicidad del número y de la secuencia por empresa y año.
- Una clave foránea compuesta impide asociar una tienda de otro cliente.
- Una clave foránea compuesta impide usar categorías de otra empresa.
- Los eventos son append-only; `UPDATE` y `DELETE` se rechazan en PostgreSQL.
- Las actuaciones son append-only y cada una exige un evento coincidente. PostgreSQL verifica también `firstActionAt` y que una incidencia con actuaciones ya no permanezca `NEW`.
- Las transiciones son append-only. PostgreSQL exige un único evento por versión resultante y mantiene coherentes estado, solución, motivo de cierre y marcas temporales.
- Los cambios de participación son append-only; las bajas conservan la incorporación original y PostgreSQL exige evidencia enlazada para alta, retirada y reasignación.
- Las comunicaciones no se borran y cada actualización exige una corrección exacta append-only con versión consecutiva.
- No existe borrado físico de incidencias en la API.

## Notificaciones internas

`GET /api/notifications?state=UNREAD|READ|ARCHIVED|ALL&limit&cursor` está disponible para cualquier sesión autenticada y devuelve únicamente la bandeja del usuario activo. Incluye contador de no leídas, cursor opaco y un DTO mínimo sin título, descripción, cliente, contacto ni motivo. El enlace a la incidencia se deriva en servidor y no concede acceso: la página relacionada vuelve a exigir `Support.View`. Todas las respuestas usan `Cache-Control: private, no-store`.

`PUT /api/notifications/{notificationId}/state` recibe JSON estricto `{ state, expectedVersion }`, exige Origin, CSRF, mantenimiento inactivo e `Idempotency-Key`, y limita el cuerpo a 2 KiB. Permite `UNREAD -> READ|ARCHIVED` y `READ -> UNREAD|ARCHIVED`; `ARCHIVED` es terminal. Una versión obsoleta devuelve `409 NOTIFICATION_VERSION_CONFLICT`, una transición inválida `409 NOTIFICATION_STATE_INVALID` y un identificador inexistente, ajeno o de otra empresa `404 NOTIFICATION_NOT_FOUND`. La cuota persistente admite 120 cambios por usuario y 15 minutos; el replay válido no consume cuota y el exceso devuelve `429 NOTIFICATION_STATE_RATE_LIMITED` con `Retry-After`.

El alta de incidencia notifica al responsable. Una incidencia `URGENT` notifica a los usuarios activos con `Support.ReceiveUrgentNotifications`; si el responsable también posee ese permiso recibe una única notificación urgente. Una reasignación notifica solo al nuevo responsable. La creación ocurre en la misma transacción que el evento funcional, con unicidad por destinatario, clase y evento fuente. Los cambios de estado conservan evidencia append-only y control de versión en PostgreSQL.

La entrega inicial se refresca al navegar o recargar, conforme a ADR-0016; abrir una incidencia no marca el aviso como leído. La transición posterior de prioridad a urgente, incorporación de colaboradores, nuevas actuaciones de colaboradores, reaperturas, fusiones, acciones masivas y purga privilegiada tras un año quedan pendientes de sus respectivos casos de uso. `URGENT` no equivale a `CRITICAL` y no abre un modal.

La bandeja y sus rutas son transversales, pero esta primera persistencia solo admite fuentes de Atención al cliente con relación obligatoria a incidencia y evento. Incorporar productores de otros módulos requerirá ampliar el origen tipado y sus invariantes PostgreSQL, sin convertir `href` ni el mensaje en texto arbitrario.
