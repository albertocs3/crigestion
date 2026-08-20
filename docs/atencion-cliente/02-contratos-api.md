# Contratos API: Atención al cliente

## Alcance implementado

La rebanada actual permite gestionar incidencias, participantes, actuaciones y
comunicaciones telefónicas/WhatsApp con correcciones históricas, adjuntos
seguros, fusiones de duplicadas, notificaciones internas persistentes, un panel
operativo de soporte y el contexto de soporte integrado en la ficha del cliente.

## Permisos

- `Support.View`: listado y detalle de incidencias y categorías.
- `Support.Create` + `Support.View`: creación de incidencias.
- `Support.AddActions` + `Support.View`: actuaciones del responsable o de un administrador.
- `Support.CorrectActions` + `Support.View`: corrección de actuaciones propias por su autor todavía miembro del equipo; Administrador puede intervenir.
- `Support.ManageAssigned` + `Support.View`: estados pendientes, reanudación, resolución, cierre y cambio posterior de prioridad por el responsable o un administrador.
- `Support.MergeIncidents` + `Support.View`: fusión cuando el actor es responsable vigente de ambas incidencias; Administrador puede intervenir.
- `Support.ViewIndicators` + `Support.View`: indicadores propios del técnico.
- `Support.ViewGlobalIndicators` + los anteriores: indicadores globales, desglose y selección de técnico; se concede inicialmente al Administrador.
- `Support.Reopen` + `Support.View`: reapertura de incidencias finalizadas por un técnico autorizado.
- `Support.ManageParticipants` + `Support.View`: colaboradores y reasignación por el responsable o un administrador.
- `Support.ViewCommunications`: listado y detalle de comunicaciones.
- `Support.ManageCommunications` + `Support.ViewCommunications`: alta y corrección de comunicaciones.
- `Support.ManageCategories` + `Support.View`: pantalla, creación y cambios versionados de categorías.
- `Support.ChangeIncidentCustomer` + `Support.View` + `Customers.View`: cambio administrativo del cliente de una incidencia; se concede solo al rol Administrador.
- `Support.ManageAttachments` + `Support.View`: carga de adjuntos por el responsable, un colaborador activo o Administrador.
- `Support.DownloadAttachments` + `Support.View`: descarga de adjuntos de incidencias visibles.

Los permisos se validan siempre en servidor. El rol técnico de soporte no obtiene por estos permisos acceso a suscripciones, facturación, tesorería ni contabilidad.

## `GET /api/support/dashboard`

Foto operativa autenticada y auditada que exige `Support.View`. No admite
parámetros; cualquier query string devuelve `422 VALIDATION_ERROR`. Deriva la
empresa exclusivamente en servidor y ejecuta todos los bloques autorizados en
una transacción `REPEATABLE READ` con un único `asOf`.
La lista general que continúa debajo del panel conserva su contrato paginado y
su auditoría `SUPPORT_INCIDENTS_VIEWED`; no forma parte de ese snapshot.

La respuesta contiene contadores de incidencias canónicas abiertas: nuevas, en
curso, pendientes por cliente y tercero, total pendiente, urgentes y asignadas
al actor. Incluye como máximo sus cinco incidencias abiertas y sus cinco
notificaciones `UNREAD` no expiradas. Las notificaciones se limitan a código
controlado, severidad, fecha y enlace derivado a la incidencia.

`assignedByTechnician` solo está presente con
`Support.ViewGlobalIndicators`; agrupa por responsable vigente y conserva la
carga de usuarios inactivos. `latestCommunications` solo está presente con
`Support.ViewCommunications`; devuelve como máximo cinco filas ordenadas por
`occurredAt DESC, id DESC`, con canal, dirección, fecha, cliente mínimo e
incidencia opcional. Si falta el permiso, la propiedad se omite en vez de
simular una colección vacía.

El DTO no incluye descripción de incidencia, resumen, teléfono, duración,
contacto ni correcciones de comunicación. Cada consulta correcta crea un único
evento `SUPPORT_DASHBOARD_VIEWED` con actor, empresa, instante, secciones
reveladas y tamaños de las vistas previas, sin títulos, clientes, números,
mensajes ni valores agregados. Usa `Cache-Control: private, no-store,
max-age=0`, `Pragma: no-cache`, `Vary: Cookie` y `nosniff`. Al ser GET no usa
CSRF, Origin, mantenimiento ni idempotencia. Respuestas: `200`, `401`, `403`,
`409 PLATFORM_NOT_INITIALIZED`, `422` y `503 SUPPORT_DASHBOARD_BUSY` con
`Retry-After: 3` tras agotar tres intentos de lectura consistente.

## `GET /api/customers/{customerId}/support-context`

Lectura autenticada y auditada para integrar Atención al cliente en la ficha
del cliente. Exige conjuntamente `Customers.View` y `Support.View`; no concede
acceso a la ficha a un usuario que solo tenga permisos de soporte. La sección
`communications` solo está presente si el actor conserva además
`Support.ViewCommunications`.

No admite query string. El identificador de ruta es UUID estricto y la empresa
se deriva exclusivamente de la instalación. Todas las consultas de soporte se
acotan por `companyId` y `customerId` dentro de una transacción
`REPEATABLE READ`. Devuelve una foto con fecha, hasta diez incidencias abiertas
canónicas, hasta diez finalizadas y sus totales. Las duplicadas cerradas se
conservan en el histórico finalizado con `mergedInto` para no ocultar la
trazabilidad.

Las comunicaciones, cuando están autorizadas, se limitan a fecha, canal,
dirección, resultado e incidencia opcional. El DTO nunca incluye descripción
de incidencia, resumen, número utilizado, contacto ni correcciones. Una lectura
correcta crea un único evento `SUPPORT_CUSTOMER_CONTEXT_VIEWED` con actor,
empresa, cliente, secciones reveladas y tamaños de las vistas previas, sin
títulos, textos ni datos económicos.

Usa `Cache-Control: private, no-store, max-age=0`, `Pragma: no-cache`,
`Vary: Cookie` y `nosniff`. Al ser GET no usa CSRF, Origin, mantenimiento ni
idempotencia. Respuestas: `200`, `401`, `403`, `404
SUPPORT_CUSTOMER_NOT_FOUND`, `409 PLATFORM_NOT_INITIALIZED`, `422` y `503
SUPPORT_CUSTOMER_CONTEXT_BUSY` con `Retry-After: 3` tras agotar tres intentos
de lectura consistente.

Los accesos de alta desde la ficha son enlaces a los formularios existentes
con `customerId` preseleccionado. El cliente solo se preselecciona si pertenece
al catálogo autorizado; un valor inválido o desconocido nunca selecciona
silenciosamente otro cliente. Las mutaciones conservan íntegros sus contratos
Origin/CSRF, mantenimiento, validación e idempotencia.

## `GET /api/support/indicators`

Consulta autenticada y auditada de indicadores. Admite exactamente `from` y
`to` en formato `YYYY-MM-DD`, `scope=self|global` (por defecto `self`) y
`technicianId` opcional únicamente con alcance global. No acepta `companyId`,
parámetros desconocidos ni repetidos. El rango es inclusivo en
`Europe/Madrid`, no puede superar 366 días y se convierte internamente a un
intervalo UTC semiabierto.

`self` exige `Support.View` + `Support.ViewIndicators` y fuerza el usuario de
la sesión. `global` exige además `Support.ViewGlobalIndicators`; con
`technicianId` devuelve solo ese técnico y sin él devuelve totales, carga
actual y desglose. Un técnico no puede consultar silenciosamente otro usuario:
se devuelve `403 FORBIDDEN` y queda auditado por el control de acceso. Un técnico objetivo no
disponible devuelve `404 SUPPORT_TECHNICIAN_NOT_FOUND` solo después de
autorizar el alcance global.

La respuesta separa `snapshot` (incidencias canónicas abiertas por estado y
prioridad), `performance` (medias con tamaño de muestra, resoluciones y cierres
ordinarios) y `breakdown`, presente únicamente en el global sin técnico
objetivo. La foto se atribuye al responsable vigente; la primera actuación, al
autor real; y resoluciones/cierres, al responsable capturado en el evento. La
primera actuación se imputa al periodo de su `performedAt`, mientras los
hitos se imputan por `occurredAt`. Cada
resolución posterior a una reapertura es un episodio independiente y descuenta
los intervalos pendientes de ese episodio. Las duplicadas fusionadas y los
cierres `DUPLICATE` se excluyen de productividad.

Las medias usan segundos enteros y `{ value:null, sampleSize:0 }` cuando no hay
muestra. La respuesta no contiene clientes, títulos, descripciones, motivos ni
textos de actuaciones. Usa `Cache-Control: private, no-store, max-age=0`,
`Pragma: no-cache`, `Vary: Cookie` y `nosniff`. Cada lectura correcta crea
`SUPPORT_INDICATORS_VIEWED` con actor, empresa, alcance, periodo y técnico
objetivo opcional, sin persistir valores calculados ni contenido funcional. Al
ser GET no usa CSRF, Origin, mantenimiento ni idempotencia. La cuota persistente
admite 120 consultas por actor y empresa cada 15 minutos; el exceso devuelve
`429 SUPPORT_INDICATORS_RATE_LIMITED` con `Retry-After`. Errores comunes: `401`,
`403`, `404`, `422 VALIDATION_ERROR` y `429`.

El selector administrativo solo ofrece usuarios activos que conservan
`Support.View` y `Support.ViewIndicators`. El desglose histórico puede mantener
usuarios que ya no sean seleccionables para no perder atribución pasada.

## `GET /api/support/incidents`

Consulta autenticada con `Support.View`. Admite `limit` (1..100), `cursor`,
`status`, `priority`, `responsibleUserId`, `customerId`, `categoryId`,
`activeCollaboratorUserId`, `createdFrom`, `createdTo` y `search`. Todos los
filtros se combinan con `AND`; la búsqueda, de 3 a 120 caracteres y sin los
comodines reservados `%`, `_` o `\`, aplica `OR`
a número, título, descripción y contenido de actuaciones, pero el listado no
devuelve los textos de descripción o actuación. El colaborador debe conservar
una participación activa.

`createdFrom` y `createdTo` son fechas locales inclusivas `YYYY-MM-DD` en
`Europe/Madrid`, se informan juntas y admiten como máximo 366 días. El cursor
está firmado y ligado al conjunto normalizado de filtros: si se manipula o se
reutiliza con otra consulta devuelve `422 VALIDATION_ERROR`. Parámetros
desconocidos o repetidos también devuelven `422`. La auditoría conserva IDs,
fechas, presencia de búsqueda y conteos, nunca el término ni el cursor.
La búsqueda consume una cuota persistente de 30 intentos por actor y empresa en
15 minutos, dispone de índices trigram sobre los cuatro campos y ejecuta su
lectura con un timeout PostgreSQL local de 3 segundos. Las actuaciones se
preseleccionan por su índice con un máximo de 10.000 incidencias antes de
combinarse con el resto de campos; el límite nunca produce resultados parciales.
Al superar la cuota devuelve `429
SUPPORT_INCIDENT_SEARCH_RATE_LIMITED` con `Retry-After: 900`; si PostgreSQL
cancela la consulta por timeout devuelve `503 SUPPORT_INCIDENT_SEARCH_BUSY` con
`Retry-After: 3`. Una cancelación PostgreSQL recuperable usa el mismo `503`. Si
la preselección supera el máximo seguro devuelve `422
SUPPORT_INCIDENT_SEARCH_TOO_BROAD` sin `Retry-After`. Se audita un evento por
actor y ventana al cruzar el límite de cuota, y cada cancelación recuperable,
sin conservar el término.

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

La prioridad es seleccionable durante el alta y toma `MEDIUM` cuando se omite.

Respuesta `201`; un replay idéntico devuelve `200` sin repetir numeración, evento ni auditoría.

Errores funcionales: `PLATFORM_NOT_INITIALIZED`, `SUPPORT_CUSTOMER_NOT_FOUND`, `SUPPORT_STORE_NOT_FOUND`, `SUPPORT_CATEGORY_NOT_AVAILABLE`, `SUPPORT_RESPONSIBLE_NOT_AVAILABLE`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`, además de los errores comunes 400/401/403/413/415/422/423.

## `GET /api/support/incidents/{incidentId}`

Requiere `Support.View`. Devuelve el detalle y sus eventos o `404 SUPPORT_INCIDENT_NOT_FOUND`. Cuando es principal, las actuaciones de sus duplicadas se agregan en orden estable conservando `sourceIncident`; las comunicaciones se agregan del mismo modo solo si el actor posee además `Support.ViewCommunications`. UUID inválido devuelve `422 VALIDATION_ERROR` después de autorizar.

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

Respuesta `201`; replay idéntico `200`. Antes de devolver incluso un replay se
revalidan los permisos y la pertenencia vigente a la incidencia. Un replay
inválido o una clave reutilizada consume cuota y queda auditado. Errores
estables: `SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_ACTION_FORBIDDEN`,
`SUPPORT_INCIDENT_VERSION_CONFLICT`, `SUPPORT_INCIDENT_FINALIZED`,
`SUPPORT_ACTION_DATE_INVALID`, `IDEMPOTENCY_KEY_REUSED` e
`IDEMPOTENCY_REPLAY_INVALID`.

## `POST /api/support/incidents/{incidentId}/actions/{actionId}/corrections`

Requiere `Support.CorrectActions` y `Support.View`. El actor debe ser el autor
original y continuar como responsable o colaborador activo de la incidencia, o
ser Administrador. La resolución de incidencia, actuación y empresa se realiza
de forma conjunta y los registros ajenos responden con `404` opaco. Una
duplicada fusionada es de solo lectura; una incidencia canónica `RESOLVED` o
`CLOSED` admite esta corrección documental sin cambiar su ciclo.

Aplica Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de 8 KiB,
`Idempotency-Key`, bloqueo en orden incidencia→actuación y control optimista de
ambas versiones:

```json
{
  "expectedIncidentVersion": 3,
  "expectedActionVersion": 1,
  "text": "Se revisa la configuración correcta y se restablece el acceso.",
  "reason": "Se corrige la descripción tras contrastarla con el técnico."
}
```

La operación no admite `performedAt`, autor, incidencia ni campos adicionales.
Conserva la actuación original inmutable, añade una evidencia append-only con
la cadena OLD→NEW, incrementa una versión lógica de la actuación y una versión
de la incidencia, y crea un evento `ACTION_CORRECTED`. El detalle muestra el
texto vigente y hasta las 100 correcciones más recientes; la evidencia anterior
permanece en PostgreSQL y su consulta paginada queda como ampliación posterior.
La búsqueda usa únicamente el texto vigente, manteniendo un índice trigram
separado para las correcciones. La
auditoría contiene identificadores, versiones y booleanos, nunca texto ni
motivo.

Respuesta inicial `201`; replay idéntico `200` tras revalidar la autorización.
La cuota persistente admite 20 intentos por actor y empresa en 15 minutos y
devuelve `429` con `Retry-After`; tres conflictos serializables devuelven `503`
con `Retry-After: 3`. Errores estables:
`SUPPORT_ACTION_CORRECTION_FORBIDDEN`, `SUPPORT_INCIDENT_NOT_FOUND`,
`SUPPORT_ACTION_NOT_FOUND`, `SUPPORT_INCIDENT_VERSION_CONFLICT`,
`SUPPORT_ACTION_VERSION_CONFLICT`, `SUPPORT_ACTION_CORRECTION_UNCHANGED`,
`SUPPORT_INCIDENT_MERGED_READ_ONLY`,
`SUPPORT_ACTION_CORRECTION_RATE_LIMITED`,
`SUPPORT_ACTION_CORRECTION_BUSY`, `IDEMPOTENCY_KEY_REUSED` e
`IDEMPOTENCY_REPLAY_INVALID`.

## `POST /api/support/incidents/{incidentId}/status-transitions`

Mutación con Origin/CSRF, mantenimiento, JSON estricto, máximo de 8 KiB, `Idempotency-Key` y `expectedVersion`. Los cambios ordinarios requieren `Support.ManageAssigned` + `Support.View` y responsable vigente o Administrador. La reapertura requiere `Support.Reopen` + `Support.View` y no depende de la asignación.

Los cuerpos admitidos son estrictos:

- pendiente: `{ "action":"set-pending", "expectedVersion":2, "targetStatus":"PENDING_CUSTOMER", "reason":"..." }`;
- retomar: `{ "action":"resume", "expectedVersion":3, "reason":"..." }`;
- resolver: `{ "action":"resolve", "expectedVersion":4, "solution":"..." }`;
- cerrar: `{ "action":"close", "expectedVersion":4, "closeReason":"NOT_APPLICABLE" }`; `OTHER` exige `detail`; `DUPLICATE` queda reservado al contrato de fusión;
- reabrir: `{ "action":"reopen", "expectedVersion":5, "reason":"..." }`.

Resolver y cerrar son estados finales: no admiten actuaciones hasta reabrir. Cada transición incrementa una sola versión, crea evidencia append-only y un evento enlazado. Respuesta `201`; replay idéntico `200`. Errores estables: `SUPPORT_INCIDENT_TRANSITION_FORBIDDEN`, `SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_VERSION_CONFLICT`, `SUPPORT_INCIDENT_TRANSITION_INVALID`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`.

## `POST /api/support/incident-merges`

Fusión top-level autenticada con `Support.MergeIncidents` + `Support.View`. Salvo Administrador, el actor debe ser responsable vigente de ambas incidencias. Aplica Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de 4 KiB, `Idempotency-Key`, cuota persistente de 10 intentos por actor y empresa en 15 minutos, y control optimista de las dos versiones.

```json
{
  "primaryIncidentId": "uuid",
  "duplicateIncidentId": "uuid",
  "expectedPrimaryVersion": 3,
  "expectedDuplicateVersion": 2,
  "reason": "Ambos registros describen el mismo problema.",
  "confirmation": "MERGE_DUPLICATE_INCIDENT"
}
```

Las incidencias deben ser distintas, activas, pertenecer a la misma empresa y cliente, y la principal no puede estar fusionada a otra. La duplicada no puede estar fusionada ni ser una principal que ya agrupa duplicadas. La operación bloquea ambos registros en orden estable, cierra la duplicada con motivo `DUPLICATE`, enlaza la principal, incrementa ambas versiones y crea evidencia append-only y eventos `INCIDENT_MERGED` en los dos historiales. Comunicaciones, actuaciones y adjuntos conservan su incidencia original y se agregan solo al consultar la principal. La duplicada es terminal y no admite reapertura ni nuevas mutaciones.

Respuesta `201`; un replay idéntico devuelve `200` sin repetir relación, versiones, eventos, notificaciones ni auditoría. Errores estables: `SUPPORT_INCIDENT_MERGE_FORBIDDEN`, `SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_MERGE_SAME_INCIDENT`, `SUPPORT_INCIDENT_MERGE_CUSTOMER_MISMATCH`, `SUPPORT_INCIDENT_MERGE_VERSION_CONFLICT`, `SUPPORT_INCIDENT_MERGE_PRIMARY_ALREADY_MERGED`, `SUPPORT_INCIDENT_MERGE_DUPLICATE_ALREADY_MERGED`, `SUPPORT_INCIDENT_MERGE_FINALIZED`, `SUPPORT_INCIDENT_MERGE_RATE_LIMITED`, `SUPPORT_INCIDENT_MERGE_BUSY`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`, además de los errores comunes de validación, autenticación, formato, CSRF y mantenimiento. La cuota devuelve `429` con `Retry-After`; el agotamiento de reintentos serializables devuelve `503` con `Retry-After: 3`.

## `POST /api/support/incidents/{incidentId}/priority-changes`

Requiere `Support.ManageAssigned` + `Support.View` y ser el responsable vigente o Administrador. Aplica Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de 4 KiB, `Idempotency-Key` y control de versión.

```json
{
  "expectedVersion": 3,
  "priority": "URGENT",
  "reason": "El impacto operativo afecta a todos los puestos."
}
```

La prioridad debe ser distinta de la vigente y el motivo contiene entre 3 y 500 caracteres. Una incidencia `RESOLVED` o `CLOSED` debe reabrirse antes del cambio. La operación incrementa una sola versión y conserva evidencia append-only con prioridad anterior, nueva, motivo, actor y fecha, además del evento `PRIORITY_CHANGED`. Respuesta `201`; un replay idéntico devuelve `200` sin repetir versión, evidencia, notificación ni auditoría.

El paso de cualquier prioridad no urgente a `URGENT` crea, dentro de la misma transacción, una notificación `SUPPORT_INCIDENT_URGENT` para cada usuario activo con `Support.ReceiveUrgentNotifications`. Salir de urgente no notifica; volver posteriormente a urgente genera un nuevo aviso porque procede de otro evento. Un destinatario recibe como máximo un aviso por evento fuente. `URGENT` no equivale a `CRITICAL` y no abre un modal.

La cuota persistente admite 20 intentos por actor y empresa en 15 minutos; un replay válido no consume cuota. Errores estables: `SUPPORT_INCIDENT_PRIORITY_FORBIDDEN`, `SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_VERSION_CONFLICT`, `SUPPORT_INCIDENT_PRIORITY_UNCHANGED`, `SUPPORT_INCIDENT_PRIORITY_FINALIZED`, `SUPPORT_INCIDENT_PRIORITY_RATE_LIMITED`, `SUPPORT_INCIDENT_PRIORITY_BUSY`, `IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`, además de los errores HTTP comunes de validación, autenticación, CSRF, formato y mantenimiento. La cuota devuelve `429` con `Retry-After`; el agotamiento de reintentos serializables devuelve `503` con `Retry-After: 3`.

## `POST /api/support/incidents/{incidentId}/detail-changes`

Requiere `Support.ManageAssigned` + `Support.View` y ser el responsable vigente
o Administrador. Aplica Origin/CSRF, mantenimiento, `application/json`, cuerpo
estricto máximo de 8 KiB, `Idempotency-Key` y control optimista de versión. El
comando reemplaza la proyección editable completa para evitar ambigüedad entre
campos omitidos y valores nulos:

```json
{
  "expectedVersion": 3,
  "title": "Fallo de conectividad confirmado",
  "description": "La conexión se interrumpe en la tienda indicada.",
  "categoryId": "uuid",
  "storeId": "uuid-o-null",
  "reason": "Información contrastada con el cliente."
}
```

Título y descripción conservan los límites de la incidencia; el motivo contiene
entre 3 y 500 caracteres. Una categoría distinta debe estar activa y pertenecer
a la empresa. Una tienda distinta debe estar activa y pertenecer al cliente de
la incidencia. Se permite conservar una categoría o tienda histórica que haya
quedado inactiva. La operación no admite `customerId`: el cambio administrativo
usa el contrato específico siguiente y preserva las comunicaciones históricas.

La incidencia duplicada fusionada es de solo lectura. Una incidencia canónica
`RESOLVED` o `CLOSED` sí puede corregir estos datos sin alterar su ciclo. El
cambio incrementa exactamente una versión, crea evidencia append-only OLD→NEW,
un evento `DETAILS_CHANGED` y auditoría opaca. El historial funcional conserva
los textos, el motivo y snapshots de las etiquetas de categoría y tienda; un
renombrado posterior del maestro no reescribe la presentación histórica. El
detalle carga como máximo los 100 cambios más recientes y avisa si existe
evidencia anterior, que permanece íntegra en PostgreSQL; una consulta paginada
del histórico completo queda como ampliación posterior. La auditoría solo
registra identificadores, campos cambiados y versiones, nunca título,
descripción ni motivo.

Respuesta inicial `201`; replay idéntico `200` sin repetir versión, evidencia,
evento ni auditoría. Errores estables: `SUPPORT_INCIDENT_DETAILS_FORBIDDEN`,
`SUPPORT_INCIDENT_NOT_FOUND`, `SUPPORT_INCIDENT_VERSION_CONFLICT`,
`SUPPORT_INCIDENT_MERGED_READ_ONLY`, `SUPPORT_INCIDENT_DETAILS_UNCHANGED`,
`SUPPORT_CATEGORY_NOT_AVAILABLE`, `SUPPORT_STORE_NOT_FOUND`,
`SUPPORT_INCIDENT_DETAILS_RATE_LIMITED`, `SUPPORT_INCIDENT_DETAILS_BUSY`,
`IDEMPOTENCY_KEY_REUSED` e `IDEMPOTENCY_REPLAY_INVALID`, además de los comunes.
La cuota persistente admite 20 intentos por actor y empresa en 15 minutos y
devuelve `429` con el tiempo restante en `Retry-After`; el agotamiento de tres
intentos serializables devuelve `503` con `Retry-After: 3`.

## `POST /api/support/incidents/{incidentId}/customer-changes`

Requiere simultáneamente `Support.View`, `Support.ChangeIncidentCustomer`,
`Customers.View` y el rol `Administrador`. La ruta valida los tres permisos y
la aplicación vuelve a validarlos, exige el rol y audita su denegación. Aplica
Origin/CSRF, mantenimiento, `application/json`, cuerpo
estricto máximo de 4 KiB, `Idempotency-Key`, cuota persistente y control
optimista. El cuerpo es:

```json
{
  "expectedVersion": 3,
  "expectedCustomerId": "uuid-cliente-vigente",
  "customerId": "uuid-cliente-corregido",
  "reason": "Se contrasta la titularidad correcta del expediente.",
  "confirmation": "CHANGE_INCIDENT_CUSTOMER"
}
```

El cliente corregido puede estar activo o inactivo. La incidencia debe ser
canónica, no puede ser una duplicada ni una principal con duplicadas y debe
tener `storeId = null`; si conserva tienda, el Administrador la retira primero
con `detail-changes`. Se admiten incidencias abiertas, resueltas o cerradas. La
operación incrementa exactamente una versión, crea una evidencia append-only
OLD→NEW, un evento `CUSTOMER_CHANGED` y auditoría opaca. El detalle muestra como
máximo los 100 cambios más recientes y conserva el resto en PostgreSQL.
La pantalla ofrece búsqueda acotada por código o razón social y no carga el
directorio completo de clientes en el HTML.

Las comunicaciones existentes no cambian de cliente ni de contacto y pueden
seguir corrigiéndose conservando su enlace histórico. Después del cambio, una
comunicación nueva o relinkada solo puede apuntar a la incidencia si pertenece
al cliente vigente. La incidencia deja el contexto del cliente anterior y pasa
al nuevo; las comunicaciones históricas continúan en el contexto de su cliente
original. PostgreSQL usa una FK por incidencia/empresa con `ON UPDATE RESTRICT`
y triggers de enlace para evitar cascadas o vínculos cruzados nuevos.

La primera respuesta es `201`; el replay idéntico devuelve `200` sin duplicar
versión, evidencia, evento ni auditoría. La cuota admite 10 intentos por actor y
empresa cada 15 minutos; el replay válido queda exento. Errores estables:
`SUPPORT_INCIDENT_CUSTOMER_CHANGE_FORBIDDEN`, `SUPPORT_INCIDENT_NOT_FOUND`,
`SUPPORT_CUSTOMER_NOT_FOUND`, `SUPPORT_INCIDENT_VERSION_CONFLICT`,
`SUPPORT_INCIDENT_CUSTOMER_EXPECTATION_CONFLICT`,
`SUPPORT_INCIDENT_CUSTOMER_UNCHANGED`,
`SUPPORT_INCIDENT_CUSTOMER_CHANGE_STORE_ATTACHED`,
`SUPPORT_INCIDENT_CUSTOMER_CHANGE_MERGED`,
`SUPPORT_INCIDENT_CUSTOMER_CHANGE_RATE_LIMITED`,
`SUPPORT_INCIDENT_CUSTOMER_CHANGE_BUSY`, `IDEMPOTENCY_KEY_REUSED` e
`IDEMPOTENCY_REPLAY_INVALID`, además de los errores HTTP comunes. `429` incluye
el tiempo restante en `Retry-After`; tras tres conflictos serializables se
devuelve `503` con `Retry-After: 3`.

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

### `POST /api/support/categories/{categoryId}/changes`

Requiere `Support.View` + `Support.ManageCategories` tanto en la ruta como en
la aplicación. Usa Origin/CSRF, mantenimiento, JSON estricto, cuerpo máximo de
4 KiB, `Idempotency-Key`, cuota persistente de 20 intentos por 15 minutos y
`Cache-Control: private, no-store`. El UUID se resuelve siempre dentro de la
empresa instalada.

La edición de datos reemplaza el conjunto editable completo:

```json
{
  "action": "update",
  "expectedVersion": 1,
  "name": "Conectividad crítica",
  "description": "Incidencias de red y enlaces",
  "color": "#DC2626",
  "reason": "Revisión de la clasificación operativa"
}
```

El cambio de estado es una acción separada y exige confirmación ligada al
destino:

```json
{
  "action": "set-status",
  "expectedVersion": 2,
  "isActive": false,
  "confirmation": "DEACTIVATE_SUPPORT_CATEGORY",
  "reason": "Categoría sustituida"
}
```

Para activar se usa `ACTIVATE_SUPPORT_CATEGORY`. La primera respuesta es
`201`; un replay idéntico, `200`. PostgreSQL conserva la cadena OLD→NEW,
impide modificar o borrar su evidencia, rechaza cambios directos de la
proyección y mantiene la unicidad del nombre normalizado también entre
categorías inactivas. La categoría inactiva desaparece de las referencias de
alta o reclasificación, pero permanece en listados y detalles históricos. La
última categoría activa no puede desactivarse.

Errores funcionales: `SUPPORT_CATEGORY_CHANGE_FORBIDDEN`,
`SUPPORT_CATEGORY_NOT_FOUND`, `SUPPORT_CATEGORY_VERSION_CONFLICT`,
`SUPPORT_CATEGORY_UNCHANGED`, `SUPPORT_CATEGORY_ALREADY_EXISTS`,
`SUPPORT_CATEGORY_LAST_ACTIVE`, `SUPPORT_CATEGORY_RATE_LIMITED`,
`SUPPORT_CATEGORY_BUSY` y los comunes de idempotencia. `429` y `503` incluyen
`Retry-After`. La auditoría registra identificadores, versiones, campos
cambiados y estado anterior/nuevo, nunca nombre normalizado, nombre,
descripción, color ni motivo.

## Adjuntos de incidencia

### `GET /api/support/incidents/{incidentId}/attachments`

Requiere `Support.View`. Devuelve hasta 100 adjuntos disponibles y limpios, ordenados del más reciente al más antiguo, más `nextCursor`; `cursor` permite continuar sin omitir adjuntos antiguos. Al consultar una principal incluye los adjuntos de sus duplicadas, conserva `sourceIncident` y genera la descarga contra el registro de origen. No expone clave de almacenamiento, hash, resultado interno del antivirus ni ruta física. Incidencia inexistente o de otra empresa devuelve `404 SUPPORT_INCIDENT_NOT_FOUND`.

### `POST /api/support/incidents/{incidentId}/attachments`

Requiere `Support.ManageAttachments` + `Support.View` y ser responsable, colaborador activo o Administrador. Aplica Origin, CSRF, mantenimiento, `Idempotency-Key`, multipart estricto y límite de 16 MiB por archivo más 64 KiB de envoltura. Solo admite un campo `file` JPG/JPEG o PDF y `actionId` opcional de la misma incidencia.

El original se mantiene en cuarentena, se analiza, se valida y, para JPG, se recodifica sin metadatos. El artefacto final vuelve a analizarse antes de publicarse con clave opaca. PDF cifrado, activo, incremental o no inspeccionable se rechaza. La autorización se revalida bajo bloqueo al persistir. La respuesta `201` incluye solo metadatos observables. Replay válido devuelve `200`; clave reutilizada con otro archivo devuelve `409`.

Errores específicos: `403 SUPPORT_ATTACHMENT_FORBIDDEN`, `404 SUPPORT_INCIDENT_NOT_FOUND`, `409 IDEMPOTENCY_KEY_REUSED|IDEMPOTENCY_REPLAY_INVALID`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 SUPPORT_ATTACHMENT_*|SUPPORT_ATTACHMENT_FILE_REJECTED`, `429 SUPPORT_ATTACHMENT_RATE_LIMITED` con `Retry-After: 900`, y `503 ANTIVIRUS_UNAVAILABLE|SUPPORT_ATTACHMENT_CAPACITY_UNAVAILABLE|SUPPORT_ATTACHMENT_DATABASE_BUSY` con `Retry-After`.

Una duplicada fusionada es de solo lectura y rechaza nuevas cargas con `409 SUPPORT_INCIDENT_MERGED_READ_ONLY` aunque el actor conserve autoridad histórica.

### `POST /api/support/incidents/{incidentId}/attachments/{attachmentId}/download`

Requiere `Support.DownloadAttachments` + `Support.View`, Origin y CSRF. La relación empresa-incidencia-adjunto se comprueba conjuntamente. Solo descarga `AVAILABLE+CLEAN` y verifica tamaño y SHA-256 antes de responder. Usa `Content-Disposition: attachment`, `Content-Security-Policy: sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin` y `Cache-Control: private, no-store`. Las descargas se auditan sin nombre, contenido, ruta ni hash.

Los adjuntos son append-only: la API no ofrece borrado ni reemplazo. Se permiten en incidencias resueltas o cerradas si la autoridad de participante continúa vigente. El límite funcional por incidencia sigue siendo ilimitado, pero existe un techo operativo de 1,5 GiB por empresa para asegurar que la copia integral permanezca dentro del volumen de recuperación soportado de 2 GiB.

Deuda operativa controlada: el semáforo de cuatro lecturas es por proceso y el validador PDF aplica una política léxica fail-closed. Antes de escalar horizontalmente o ampliar compatibilidad PDF se sustituirán por un límite compartido/streaming y un parser o sanitizador aislado.

## `/api/support/communications`

`GET` requiere `Support.ViewCommunications` y admite `limit`, cursor,
`customerId`, `contactId`, `incidentId`, `channel`, `direction`, `result`,
`occurredFrom` y `occurredTo`. Todos se combinan con `AND`. Las fechas siguen
la misma convención inclusiva de Madrid y el máximo de 366 días. El cursor está
firmado y ligado a los filtros; parámetros desconocidos, repetidos, rangos
incompletos o un cursor reutilizado con otra consulta devuelven `422`. Un UUID
válido inexistente o ajeno produce una colección vacía y no permite enumerar
recursos. `POST` requiere además `Support.ManageCommunications`, Origin/CSRF, mantenimiento, JSON estricto, 8 KiB e idempotencia. Registra cliente, canal `PHONE|WHATSAPP`, dirección, fecha real, número utilizado, duración telefónica, resumen, resultado e incidencia opcional del mismo cliente. `REQUIRES_FOLLOW_UP` y `REFERRED_TO_INCIDENT` exigen incidencia. No se admite crear ni relinkar una comunicación hacia una duplicada fusionada o hacia una incidencia cuyo cliente vigente sea distinto; una corrección puede conservar el enlace histórico que ya existía antes de la fusión o antes de un cambio administrativo de cliente.

El listado devuelve una proyección resumida y no incluye `corrections`,
`correctionsHasMore` ni `correctionsNextCursor`; esos campos pertenecen solo al
detalle y a la respuesta acotada de una mutación.

`GET /api/support/communications/{communicationId}` devuelve el detalle y las
cien correcciones más recientes en orden de versión, además de
`correctionsHasMore` y `correctionsNextCursor`. Cada corrección incluye su versión resultante, la
proyección anterior y corregida y referencias mínimas `{id,number}` para las
incidencias históricas que todavía pertenecen a la empresa. Una referencia
histórica no encontrada permanece opaca y no permite enumerar otro tenant. El
enlace a una incidencia vuelve a exigir `Support.View` en su destino.
Cuando `correctionsHasMore=true`, una petición posterior puede enviar el
`correctionsCursor` opaco devuelto como query param para recuperar el bloque
anterior. El cursor está firmado y ligado a la comunicación; manipularlo,
reutilizarlo con otra comunicación, repetir parámetros o enviar claves
desconocidas devuelve `422 VALIDATION_ERROR`.

`POST .../corrections` exige todos los valores corregidos, `expectedVersion` y motivo. Cada corrección conserva la proyección anterior completa; ninguna comunicación se elimina. `contactId` es opcional para históricos, pero cuando se informa debe pertenecer al cliente, estar activo y contener exactamente el número utilizado para el canal seleccionado. `contactNumber` permanece como instantánea aunque el maestro cambie posteriormente.

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
- Los cambios de prioridad son append-only. PostgreSQL exige un único evento `PRIORITY_CHANGED` por versión resultante, correspondencia exacta entre prioridad anterior y nueva, y la notificación obligatoria a los receptores autorizados cuando el destino es `URGENT`.
- Las fusiones son append-only y únicas por incidencia duplicada. PostgreSQL exige el enlace, cierre `DUPLICATE`, versiones consecutivas y eventos coincidentes en principal y duplicada; una fusionada no puede reabrirse, recibir nuevos enlaces de comunicaciones ni convertirse en principal de otra cadena.
- Los cambios de participación son append-only; las bajas conservan la incorporación original y PostgreSQL exige evidencia enlazada para alta, retirada y reasignación.
- Las comunicaciones no se borran y cada actualización exige una corrección exacta append-only con versión consecutiva.
- Los cambios administrativos de cliente son append-only, incrementan una sola versión y exigen un evento `CUSTOMER_CHANGED` coincidente. PostgreSQL impide aplicarlos con tienda o sobre familias fusionadas y no permite que la FK de comunicaciones traslade el cliente histórico por cascada.
- No existe borrado físico de incidencias en la API.

## Notificaciones internas

`GET /api/notifications?state=UNREAD|READ|ARCHIVED|ALL&limit&cursor` está disponible para cualquier sesión autenticada y devuelve únicamente la bandeja del usuario activo. Incluye contador de no leídas, cursor opaco y un DTO mínimo sin título, descripción, cliente, contacto ni motivo. El enlace a la incidencia se deriva en servidor y no concede acceso: la página relacionada vuelve a exigir `Support.View`. Todas las respuestas usan `Cache-Control: private, no-store`.

`PUT /api/notifications/{notificationId}/state` recibe JSON estricto `{ state, expectedVersion }`, exige Origin, CSRF, mantenimiento inactivo e `Idempotency-Key`, y limita el cuerpo a 2 KiB. Permite `UNREAD -> READ|ARCHIVED` y `READ -> UNREAD|ARCHIVED`; `ARCHIVED` es terminal. Una versión obsoleta devuelve `409 NOTIFICATION_VERSION_CONFLICT`, una transición inválida `409 NOTIFICATION_STATE_INVALID` y un identificador inexistente, ajeno o de otra empresa `404 NOTIFICATION_NOT_FOUND`. La cuota persistente admite 120 cambios por usuario y 15 minutos; el replay válido no consume cuota y el exceso devuelve `429 NOTIFICATION_STATE_RATE_LIMITED` con `Retry-After`.

El alta de incidencia notifica al responsable. Una incidencia creada como `URGENT`, o cambiada posteriormente desde una prioridad no urgente a `URGENT`, notifica a los usuarios activos con `Support.ReceiveUrgentNotifications`; si el responsable también posee ese permiso recibe una única notificación urgente por evento. Una reasignación notifica solo al nuevo responsable. La incorporación de un colaborador le notifica exclusivamente a él; una actuación registrada por un colaborador activo notifica al responsable vigente en ese evento; y una reapertura notifica al responsable vigente, incluso cuando él mismo la ejecuta. La creación ocurre en la misma transacción que el evento funcional, con unicidad por destinatario y evento fuente. Los cambios de estado y prioridad conservan evidencia append-only y control de versión en PostgreSQL.

La fusión notifica a los responsables vigentes de la principal y la duplicada, deduplicados si coinciden. El aviso utiliza un código controlado, enlaza con la principal y no contiene motivo, títulos, cliente ni nombres de actores.

La entrega inicial se refresca al navegar o recargar, conforme a ADR-0016; abrir una incidencia no marca el aviso como leído. Las acciones masivas y purga privilegiada tras un año quedan pendientes de sus respectivos casos de uso. `URGENT` no equivale a `CRITICAL` y no abre un modal.

Las clases adicionales son `SUPPORT_INCIDENT_COLLABORATOR_ADDED`, `SUPPORT_INCIDENT_COLLABORATOR_ACTION` y `SUPPORT_INCIDENT_REOPENED`, todas de severidad `INFO`. Sus mensajes se derivan de códigos controlados y del número de incidencia; nunca contienen texto de actuación, motivo de reapertura, cliente ni nombre del actor. Las actuaciones están limitadas a 30 intentos por actor y empresa cada 15 minutos; el replay válido queda exento y el exceso devuelve `429 SUPPORT_ACTION_RATE_LIMITED` con `Retry-After`. Tras agotar tres reintentos serializables se devuelve `503 SUPPORT_ACTION_BUSY` con `Retry-After: 3`.

La bandeja y sus rutas son transversales, pero esta primera persistencia solo admite fuentes de Atención al cliente con relación obligatoria a incidencia y evento. Incorporar productores de otros módulos requerirá ampliar el origen tipado y sus invariantes PostgreSQL, sin convertir `href` ni el mensaje en texto arbitrario.
