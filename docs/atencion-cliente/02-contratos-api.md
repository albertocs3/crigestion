# Contratos API: Atención al cliente

## Alcance implementado

La rebanada actual permite consultar y crear incidencias y categorías, registrar actuaciones y recorrer el ciclo de estados con evidencia histórica. Colaboradores, comunicaciones, adjuntos, fusiones y notificaciones quedan fuera del contrato actual.

## Permisos

- `Support.View`: listado y detalle de incidencias y categorías.
- `Support.Create` + `Support.View`: creación de incidencias.
- `Support.AddActions` + `Support.View`: actuaciones del responsable o de un administrador.
- `Support.ManageAssigned` + `Support.View`: estados pendientes, reanudación, resolución y cierre por el responsable o un administrador.
- `Support.Reopen` + `Support.View`: reapertura de incidencias finalizadas por un técnico autorizado.
- `Support.ManageCategories` + `Support.View`: pantalla y creación de categorías.

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

Requiere `Support.AddActions` y `Support.View`, además de ser el responsable vigente o Administrador. Aplica Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de 8 KiB e idempotencia.

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

## Integridad y conservación

- PostgreSQL garantiza unicidad del número y de la secuencia por empresa y año.
- Una clave foránea compuesta impide asociar una tienda de otro cliente.
- Una clave foránea compuesta impide usar categorías de otra empresa.
- Los eventos son append-only; `UPDATE` y `DELETE` se rechazan en PostgreSQL.
- Las actuaciones son append-only y cada una exige un evento coincidente. PostgreSQL verifica también `firstActionAt` y que una incidencia con actuaciones ya no permanezca `NEW`.
- Las transiciones son append-only. PostgreSQL exige un único evento por versión resultante y mantiene coherentes estado, solución, motivo de cierre y marcas temporales.
- No existe borrado físico de incidencias en la API.
