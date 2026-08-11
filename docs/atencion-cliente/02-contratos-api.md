# Contratos API: Atención al cliente

## Alcance implementado

La primera rebanada permite consultar y crear incidencias y consultar o crear categorías. Las actuaciones, cambios de estado, colaboradores, comunicaciones, adjuntos, fusiones y notificaciones quedan fuera de este contrato inicial.

## Permisos

- `Support.View`: listado y detalle de incidencias y categorías.
- `Support.Create` + `Support.View`: creación de incidencias.
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

La incidencia se crea con estado `NEW`, versión `1`, responsable obligatorio y número anual `INC-AAAA-00001`. La tienda, si se indica, debe pertenecer al cliente. El responsable debe estar activo y conservar `Support.View`.

Respuesta `201`; un replay idéntico devuelve `200` sin repetir numeración, evento ni auditoría.

Errores funcionales: `PLATFORM_NOT_INITIALIZED`, `SUPPORT_CUSTOMER_NOT_FOUND`, `SUPPORT_STORE_NOT_FOUND`, `SUPPORT_CATEGORY_NOT_AVAILABLE`, `SUPPORT_RESPONSIBLE_NOT_AVAILABLE`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`, además de los errores comunes 400/401/403/413/415/422/423.

## `GET /api/support/incidents/{incidentId}`

Requiere `Support.View`. Devuelve el detalle y sus eventos o `404 SUPPORT_INCIDENT_NOT_FOUND`. UUID inválido devuelve `422 VALIDATION_ERROR` después de autorizar.

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
- No existe borrado físico de incidencias en la API.
