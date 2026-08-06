# Contratos HTTP de Suscripciones

## 1. Alcance del primer corte

Este contrato cubre el alta, listado, detalle, edicion de borradores,
activacion manual, cancelacion inmediata y registro o retirada de una baja
futura. Incluye tambien el runner manual de renovaciones: consulta agrupada,
reserva de borrador, confirmacion atomica y liberacion trazable. Todavia no
incluye planes, cambios contractuales programados, edicion de lineas en la
vista previa, gestion avanzada de exclusiones ni reactivacion.

Las suscripciones consumen clientes y conceptos del catalogo comunes. Al crear
una suscripcion se congelan codigo, tipo, descripcion, precio e impuesto de cada
linea para que cambios posteriores del catalogo no alteren el contrato creado.

## 2. Convenciones y permisos

- Base: `/api/subscriptions`.
- Autenticacion obligatoria con sesion web.
- Las mutaciones validan `Origin`, token CSRF, `Idempotency-Key` y modo
  mantenimiento.
- Las respuestas son DTOs y no exponen modelos Prisma.
- La numeracion anual `SUS-AAAA-NNNNN` se asigna de forma transaccional.

| Permiso | Uso |
|---|---|
| `Subscriptions.View` | Listar y consultar suscripciones. |
| `Subscriptions.Manage` | Crear y activar suscripciones. |
| `Subscriptions.ManageEconomics` | Informar precios o descuentos distintos de los valores del catalogo. |
| `Subscriptions.Cancel` | Cancelar inmediatamente o registrar y retirar una baja futura. |
| `Subscriptions.RunRenewals` | Consultar candidatos, preparar reservas y liberarlas. |
| `Subscriptions.ConfirmRenewals` | Confirmar una reserva de renovacion. |
| `Subscriptions.ManageRenewalExclusions` | Excluir renovaciones y consultar sus motivos. |
| `Subscriptions.WaiveRenewals` | Condonar individualmente un periodo pendiente sin facturarlo. |
| `Billing.Issue` | Requisito adicional para emitir la factura durante la confirmacion. |

## 3. `GET /api/subscriptions`

Permiso requerido: `Subscriptions.View`.

| Parametro | Tipo | Uso |
|---|---|---|
| `limit` | entero 1-100 | Tamano de pagina; por defecto 25. |
| `cursor` | UUID | Cursor opaco devuelto por la pagina anterior. |
| `status` | `DRAFT`, `ACTIVE`, `RENEWAL_PENDING` o `CANCELLED` | Filtro de estado. |
| `periodicity` | `MONTHLY`, `QUARTERLY`, `SEMIANNUAL` o `ANNUAL` | Filtro de periodicidad. |
| `pricingMode` | `FIXED` o `PER_LICENSE` | Filtro de modalidad. |
| `customerId` | UUID | Filtro de cliente. |
| `search` | texto 1-120 | Busca por numero, nombre o razon social. |

Respuesta `200`:

```json
{
  "subscriptions": [
    {
      "id": "uuid",
      "number": "SUS-2026-00001",
      "name": "Soporte mensual",
      "status": "DRAFT",
      "periodicity": "MONTHLY",
      "pricingMode": "FIXED",
      "paymentMethod": "BANK_TRANSFER",
      "startDate": "2026-09-01",
      "nextRenewalDate": "2026-09-01",
      "endDate": null,
      "version": 1,
      "customer": { "id": "uuid", "code": "1", "legalName": "Cliente SL" },
      "estimatedTotal": "121.00",
      "lineCount": 1,
      "activatedAt": null,
      "createdAt": "2026-08-05T18:00:00.000Z",
      "updatedAt": "2026-08-05T18:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## 4. `POST /api/subscriptions`

Permiso requerido: `Subscriptions.Manage`. Informar `unitPrice`, un descuento
porcentual distinto de cero o un descuento fijo distinto de cero requiere
ademas `Subscriptions.ManageEconomics`.

```json
{
  "customerId": "uuid",
  "name": "Soporte mensual",
  "periodicity": "MONTHLY",
  "pricingMode": "FIXED",
  "startDate": "2026-09-01",
  "endDate": null,
  "notes": null,
  "lines": [
    {
      "catalogItemId": "uuid",
      "quantity": "1.000",
      "discountPercent": "0.00",
      "discountAmount": "0.00"
    }
  ]
}
```

Respuesta `201`: DTO de detalle. El cliente, los conceptos y sus impuestos
deben estar activos. Solo se admiten conceptos `SERVICE`, `SOFTWARE` o
`LICENSE`. En modalidad `FIXED` todas las cantidades deben ser uno. No se puede
repetir el mismo concepto.

## 5. `GET /api/subscriptions/{subscriptionId}`

Permiso requerido: `Subscriptions.View`.

Respuesta `200`: DTO completo con notas y lineas. Cada linea incluye los
snapshots de catalogo e impuesto y el total estimado calculado. La consulta se
audita como `SUBSCRIPTION_VIEWED`.

Tras la activacion, PostgreSQL impide insertar, modificar o eliminar lineas del
contrato. Los cambios futuros deberan usar el flujo versionado de cambios
programados, que todavia no forma parte de este corte.

## 6. `PUT /api/subscriptions/{subscriptionId}`

Permiso requerido: `Subscriptions.Manage`. El cuerpo representa el borrador
completo y exige `expectedVersion`. Solo se puede editar `DRAFT`.

```json
{
  "expectedVersion": 1,
  "customerId": "uuid",
  "name": "Soporte premium",
  "periodicity": "MONTHLY",
  "pricingMode": "FIXED",
  "startDate": "2026-09-01",
  "endDate": null,
  "notes": null,
  "lines": [
    { "catalogItemId": "uuid", "quantity": "1.000" }
  ]
}
```

Las lineas se sustituyen atomicamente cuando cambian. Modificar conceptos,
cantidades, precios o descuentos requiere `Subscriptions.ManageEconomics`.
Una edicion solo de cabecera conserva los snapshots economicos. El ano de la
fecha inicial no puede cambiar porque forma parte de la numeracion asignada.

Respuesta `200`: DTO actualizado con la version incrementada. Audita
`SUBSCRIPTION_UPDATED` sin copiar notas ni importes.

## 7. `POST /api/subscriptions/{subscriptionId}/activate`

Permiso requerido: `Subscriptions.Manage`.

```json
{ "version": 1 }
```

Respuesta `200`: DTO de detalle en estado `ACTIVE` y con la version
incrementada. Solo se activa un borrador con cliente activo y al menos una
linea. La version implementa concurrencia optimista. La activacion se audita
como `SUBSCRIPTION_ACTIVATED`.

## 8. `POST /api/subscriptions/{subscriptionId}/cancel`

Permiso requerido: `Subscriptions.Cancel`.

```json
{ "expectedVersion": 2, "reason": "Baja solicitada por el cliente" }
```

Solo admite una suscripcion `ACTIVE` o `RENEWAL_PENDING`. La fecha efectiva es
la fecha de negocio actual en `Europe/Madrid` y no la decide el navegador. Conserva la fecha final
contractual prevista, las lineas y la evidencia de activacion. Guarda motivo,
actor e instante de registro, incrementa la version y audita
`SUBSCRIPTION_CANCELLED` sin copiar el motivo completo.

La operacion es inmediata. Una fecha programada o retroactiva requiere el
futuro flujo versionado de cancelaciones y no se simula cambiando antes el
estado a `CANCELLED`.

## 9. `POST /api/subscriptions/{subscriptionId}/cancellation-schedules`

Permiso requerido: `Subscriptions.Cancel`.

```json
{
  "expectedVersion": 3,
  "effectiveDate": "2026-09-01",
  "reason": "Baja solicitada al finalizar el periodo"
}
```

Registra una orden histórica `PENDING` y responde con `subscriptionVersion` y
el objeto `schedule`. La fecha prevista debe ser futura según `Europe/Madrid` y coincidir exactamente con
`nextRenewalDate`; este corte no admite bajas a mitad de periodo. Solo puede
existir una orden pendiente por suscripción, reforzada mediante índice parcial
PostgreSQL. La orden conserva motivo, actor, versión base e instante, pero el
motivo no se copia al listado ni a auditoría.

Esta operación no cambia el estado de la suscripción ni adelanta la baja. La UI
la identifica como pendiente hasta que el futuro proceso de renovación invoque
la barrera interna en su fecha de negocio.

## 10. `POST /api/subscriptions/{subscriptionId}/cancellation-schedules/{scheduleId}/cancel`

Permiso requerido: `Subscriptions.Cancel`.

```json
{
  "expectedSubscriptionVersion": 4,
  "expectedScheduleVersion": 1,
  "reason": "El cliente mantiene el servicio"
}
```

Cambia `PENDING` a `REVOKED`, responde con la nueva `subscriptionVersion` y la
orden, incrementa ambas versiones y conserva toda la evidencia. No usa
`DELETE`. Mientras no exista el aplicador automático, una
orden vencida puede retirarse para evitar dejarla bloqueada indefinidamente.
La cancelación inmediata de la suscripción revoca atómicamente cualquier orden
pendiente antes de cambiar el estado contractual.

## 11. Barrera interna previa a renovacion

`resolveScheduledCancellationBeforeRenewal` es un caso de uso `server-only` y
no tiene Route Handler. Recibe un `Prisma.TransactionClient` propiedad del
futuro orquestador, `companyId`, `subscriptionId` y metadatos seguros de
correlacion. El instante procede de `clock_timestamp()` de PostgreSQL despues
de adquirir los bloqueos y la fecha de negocio se deriva para
`Europe/Madrid`; no se acepta desde navegador.

El caso de uso bloquea primero la suscripcion y despues su orden pendiente. Si
la proxima renovacion aun no ha vencido responde `NOT_DUE`. Si no existe una
baja vencida responde `NO_DUE_CANCELLATION`. Este resultado solo supera la
barrera de cancelacion: no declara elegibilidad, no reserva un periodo y no
crea una factura. Una suscripcion `RENEWAL_PENDING` sigue necesitando seleccion
explicita. Si la orden ha vencido, la cambia de `PENDING` a `APPLIED`, cancela
la suscripcion con modo `SCHEDULED`, incrementa ambas versiones y responde
`CANCELLED`.

La ejecucion conserva como autorizante al usuario que solicito la baja y se
audita como `SYSTEM`, sin copiar el motivo libre. Restricciones y triggers
diferidos exigen al confirmar que la orden `APPLIED` y la suscripcion
`CANCELLED/SCHEDULED` sean coherentes en empresa, fecha, actor, motivo y version.

La barrera es reentrante: una segunda llamada sobre una suscripcion ya
cancelada responde `CANCELLED` sin duplicar la transicion ni la auditoria.

## 12. Runner manual de renovaciones

### `GET /api/subscriptions/renewals`

Permiso requerido: `Subscriptions.RunRenewals`. Acepta `processDate` en formato
`AAAA-MM-DD` (por defecto, fecha de negocio de PostgreSQL en `Europe/Madrid`) e
`includePending=true|false`. No admite una fecha futura.

Devuelve hasta 25 grupos elegibles ordenados por cliente, forma de pago y
periodo, con versiones optimistas, accion prevista (`INVOICE` o `CANCEL`) y
total estimado. Una suscripcion `RENEWAL_PENDING` solo aparece al solicitarla
expresamente. Las reservas activas no vuelven a aparecer como candidatas y se
devuelven en `reservedInvoices`. La consulta es orientativa y se audita solo
con conteos e identificadores seguros. Cada grupo hidrata como maximo 100
miembros; si el total es mayor se muestra como no seleccionable.

### `POST /api/subscriptions/renewals`

Permiso requerido: `Subscriptions.RunRenewals`.

```json
{
  "subscriptions": [
    { "subscriptionId": "uuid", "expectedVersion": 2, "pendingExclusionId": "uuid opcional" }
  ],
  "issueDate": "2026-08-06"
}
```

La empresa se deriva de la instalacion y nunca se acepta del navegador. La
peticion admite como maximo 100 suscripciones, exige sus versiones observadas,
se limita a 16 KiB y revalida dentro de una transaccion `Serializable` empresa,
estado, periodo frente a la fecha seleccionada, vigencia final, cliente, forma
de pago y baja vencida a esa misma fecha. Responde `201` al crear
una reserva y `200` al reproducir la misma clave idempotente.

Si la suscripcion esta `RENEWAL_PENDING`, `pendingExclusionId` es obligatorio y
debe identificar el expediente `OPEN` de la empresa, suscripcion y periodo
observados. Una suscripcion activa no admite ese campo. De este modo,
`includePending=true` solo permite consultar la cola: nunca autoriza una
preparacion masiva o implicita de pendientes.

### `POST /api/subscriptions/{subscriptionId}/renewal-exclusions`

Permiso requerido: `Subscriptions.ManageRenewalExclusions`.

```json
{
  "expectedVersion": 2,
  "periodStart": "2026-08-06",
  "processDate": "2026-08-06",
  "reason": "Pendiente de validacion comercial"
}
```

La accion es individual y explicita; desmarcar una casilla no excluye. Exige
origen, CSRF, JSON estricto, mantenimiento inactivo, clave idempotente, cuerpo
maximo de 4 KiB y limite persistente de 20 intentos por usuario y empresa cada
15 minutos. Empresa y fecha de negocio se derivan y validan en servidor.

Dentro de una transaccion `Serializable` bloquea la suscripcion y sus bajas,
revalida version, periodo vencido, vigencia, cliente, lineas y ausencia de una
reserva activa. Una baja ya vencida no puede posponerse con una exclusion.
Responde `201`, crea un expediente durable `OPEN`, conserva el periodo, cambia
`ACTIVE -> RENEWAL_PENDING` e incrementa la version una vez.

El motivo libre se conserva en el expediente pero no se copia a auditoria. El
GET solo lo devuelve a quien tenga el permiso de exclusion; los demas reciben
codigo, fecha, actor, contador e indicador de que existe detalle. PostgreSQL
impide un pendiente sin expediente coincidente, dos expedientes abiertos para
la misma suscripcion y la reapertura o borrado de evidencia terminal.

### `GET /api/subscriptions/renewal-exclusions`

Permiso requerido: `Subscriptions.RunRenewals`. Devuelve exclusivamente
expedientes `OPEN` de la empresa instalada, ordenados por periodo e
identificador. Acepta `limit` entre 1 y 100, cursor opaco firmado y ligado a
los filtros, `reasonCode`,
`workState=READY|RESERVED|BLOCKED`, `customerId`, busqueda por suscripcion o
cliente y rango `periodFrom`/`periodTo`. Rechaza parametros desconocidos,
repetidos, limites no canonicos y cursores reutilizados con otros filtros.

Cada elemento incluye suscripcion, cliente, periodo, evidencia resumida y una
situacion operativa derivada. `READY` aporta la seleccion exacta para el POST
ya existente; `RESERVED` enlaza el borrador y no ofrece otro reintento;
`BLOCKED` devuelve solo codigos funcionales estables. La cola es viva: un
expediente cerrado puede desaparecer entre paginas y los nuevos anteriores al
cursor aparecen al refrescar.

El motivo libre solo se selecciona y devuelve con
`Subscriptions.ManageRenewalExclusions`; en otro caso se conserva unicamente
`hasReason`. La respuesta usa `Cache-Control: private, no-store`. Consulta y
auditoria `SUBSCRIPTION_RENEWAL_PENDING_VIEWED` se confirman juntas, sin
guardar motivo, cursor, busqueda libre ni datos fiscales.

### `POST /api/subscriptions/{subscriptionId}/renewal-exclusions/{exclusionId}/waive`

Permiso requerido: `Subscriptions.WaiveRenewals`, asignado inicialmente solo
al administrador protegido. Esta accion no elimina un bloqueo: condona de
forma irreversible el periodo completo y avanza la suscripcion exactamente a
`periodEndExclusive` sin crear factura, asiento, reserva `BILLED` ni evidencia
VeriFactu. No debe usarse como aplazamiento de facturacion ni cuando la politica
fiscal o contable exija documentar una prestacion gratuita o una condonacion.

```json
{
  "expectedVersion": 3,
  "reasonCode": "COMMERCIAL_WAIVER",
  "reasonDetail": "Bonificacion excepcional autorizada por direccion"
}
```

Acepta `COMMERCIAL_WAIVER`, `SERVICE_FAILURE` u `OTHER`; el detalle requiere
entre 10 y 500 caracteres. Exige origen, CSRF, sesion y rol vigentes,
mantenimiento inactivo, JSON estricto de hasta 4 KiB, clave idempotente y
limite persistente de 10 acciones cada 15 minutos.

La transaccion `Serializable` bloquea suscripcion, bajas, expediente y reservas.
Revalida empresa, estado `RENEWAL_PENDING`, version, periodo y expediente
`OPEN`. Rechaza cualquier baja `PENDING` y cualquier reserva `RESERVED` o
`BILLED`; una reserva debe liberarse de forma explicita antes. Al confirmar,
cierra el expediente como `WAIVED`, conserva motivo, actor, instante y versiones
anterior/posterior, cambia a `ACTIVE` y avanza un solo periodo. Tambien fija un
snapshot economico en EUR (`subtotal`, descuento, base imponible, IVA y total)
calculado desde las lineas contractuales con la version `invoice-lines-v1`.
La respuesta devuelve esa valoracion para que la confirmacion operativa muestre
el importe exacto que se esta condonando.

PostgreSQL exige bilateralmente que la condonacion y el avance coincidan y que
no exista factura activa para ese periodo. La auditoria
`SUBSCRIPTION_RENEWAL_PERIOD_WAIVED` conserva codigo, total, moneda, version de
calculo e identificadores seguros, pero nunca copia el motivo libre ni la clave
idempotente. La evidencia terminal y su valoracion son inmutables.

### Implementacion de la reserva

`createSubscriptionRenewalDraft` no es un endpoint publico. Recibe empresa,
suscripciones seleccionadas y fecha de emision, y exige clave y huella
idempotentes. Ordena y bloquea las suscripciones dentro de una transaccion
`Serializable`, aplica primero cualquier baja vencida y agrupa solo contratos
del mismo cliente, forma de pago y fecha de renovacion.

Facturacion calcula todas las lineas desde snapshots de `SubscriptionLine`,
crea una factura `SUBSCRIPTION/STANDARD/DRAFT` con resumenes fiscales y un
vencimiento, y registra una reserva `RESERVED` por suscripcion con el detalle de
origen de cada linea. La clave parcial empresa-suscripcion-periodo y los
triggers diferidos impiden duplicados, lineas sin origen, mezcla de estados y
edicion economica fuera del caso de uso.

Cada preparacion que alcanza la frontera de Facturacion registra una cabecera
`SubscriptionRenewalAttempt` y un miembro append-only por suscripcion. El
ledger conserva fase, resultado, actor, instante PostgreSQL, correlacion,
factura/reserva cuando existen y un codigo de error estable. La clave de
deduplicacion es una huella no reversible; no se guardan cuerpos, motivos
libres, datos fiscales, importes, XML, certificados ni claves idempotentes.
La composicion completa del grupo se valida al commit y queda sellada en esa
misma transaccion: no se pueden actualizar, borrar ni agregar miembros despues.
El contador resumido del expediente cuenta ejecuciones de preparacion; los
intentos de confirmacion permanecen en el ledger detallado.

Si una seleccion completamente revalidada queda bloqueada porque el cliente
esta inactivo o no existe ejercicio contable abierto, la transaccion de
preparacion termina primero sin factura ni reserva. Una segunda transaccion
`Serializable` vuelve a bloquear y revalidar todo el grupo y, solo si nada ha
cambiado, abre todos sus expedientes `PREPARATION_FAILED` y proyecta
`RENEWAL_PENDING`, o no abre ninguno. El fallo y su replay se almacenan junto
con el ledger para no incrementar intentos al repetir la misma clave.

Nunca se materializa un pendiente por autenticacion, permiso, CSRF, origen,
JSON, validacion HTTP, rate limit, fecha futura, recurso inexistente, version,
periodo, seleccion pendiente obsoleta, baja vencida, reserva competidora,
grupo mal compuesto, contencion o error interno inesperado.

La reserva es una vista previa persistida: no equivale a facturacion y no
avanza `nextRenewalDate`. `issueInvoice` sigue rechazando el origen
`SUBSCRIPTION`.

### `POST /api/subscriptions/renewals/{invoiceId}/confirm`

Requiere simultaneamente `Subscriptions.ConfirmRenewals` y `Billing.Issue`.
El cuerpo debe ser `{}` y se limita a 2 KiB.

`confirmSubscriptionRenewal` recibe solo empresa e identificador de factura,
con clave y huella idempotentes. La fecha, reservas, importes y periodos se
derivan de la evidencia persistida. Bloquea las suscripciones ordenadas, la
factura y el grupo completo de reservas; revalida versiones y periodos y delega
la emision en el nucleo interno de Facturacion usando el mismo
`TransactionClient`.

El commit unico incluye numero fiscal, asiento, preparacion VeriFactu/outbox,
factura `ISSUED`, reservas `BILLED`, avance canonico de `nextRenewalDate`, una
version adicional por suscripcion y, si procedia de una exclusion, cierre
`RESOLVED/BILLED` del expediente, auditoria y replay. Un fallo contable,
fiscal, de integridad o de concurrencia revierte el conjunto. La comunicacion
HTTP con AEAT sigue siendo posterior mediante el worker.

Los fallos reales de emision contable o preparacion VeriFactu registran un
intento `CONFIRM/FAILED`, pero conservan factura `DRAFT`, reservas `RESERVED`,
estado, version y periodo. No abren automaticamente otro expediente: la
reserva ya constituye la evidencia operativa y permite confirmar de nuevo o
liberar. Un conflicto de version/estado, rate limit o carrera terminal no se
registra como intento de emision.

Al commit, PostgreSQL exige de forma bilateral factura, asiento cuadrado hasta
sus lineas, evidencia
fiscal aplicable, auditorias de emision y renovacion y replay idempotente. Una
vez `BILLED`, el asiento, sus lineas y las identidades de esas evidencias
fiscales y de proceso no se pueden alterar ni eliminar; el outbox conserva
editables solo sus campos operativos de entrega.

### `POST /api/subscriptions/renewals/{invoiceId}/release`

Permiso requerido: `Subscriptions.RunRenewals`. Recibe un motivo de 3 a 500
caracteres. Cambia el grupo completo de `RESERVED` a `RELEASED`, conserva la
factura borrador y su evidencia como historial inmutable y vuelve a ofrecer
las suscripciones como candidatas. La liberacion y la confirmacion toman los
mismos bloqueos en el mismo orden: si compiten, solo una puede alcanzar su
estado terminal. El motivo se conserva en la reserva, pero no se copia al
evento de auditoria.

Las tres mutaciones del runner validan origen, CSRF, JSON, mantenimiento,
idempotencia y un limite persistente de 10 intentos por usuario, empresa y
accion cada 15 minutos. Los replays completados se sirven antes de consumir
cuota adicional.

## 13. Errores

| Estado | Codigo | Uso |
|---|---|---|
| `400` | `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID` o JSON invalido | Peticion HTTP incompleta o mal formada. |
| `401` | `UNAUTHENTICATED` | No hay sesion valida. |
| `403` | `FORBIDDEN`, `CSRF_TOKEN_INVALID`, `ORIGIN_NOT_ALLOWED` o `SUBSCRIPTION_ECONOMICS_PERMISSION_REQUIRED` | Falta autorizacion o una defensa de mutacion. |
| `404` | `SUBSCRIPTION_NOT_FOUND` o `CUSTOMER_NOT_FOUND` | El recurso no existe. |
| `409` | `IDEMPOTENCY_KEY_REUSED`, `SUBSCRIPTION_VERSION_CONFLICT`, `SUBSCRIPTION_NOT_EDITABLE`, `SUBSCRIPTION_NOT_ACTIVATABLE` o `SUBSCRIPTION_NOT_CANCELLABLE` | Conflicto idempotente, concurrente o de estado. |
| `409` | `SUBSCRIPTION_PENDING_CANCELLATION_EXISTS` o `SUBSCRIPTION_CANCELLATION_SCHEDULE_NOT_PENDING` | Conflicto del ciclo de una baja futura. |
| `409` | `SUBSCRIPTION_RENEWAL_ALREADY_RESERVED`, `SUBSCRIPTION_RENEWAL_RESERVED` o `INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN` | El periodo ya esta reservado, la reserva bloquea otra mutacion o falta ejercicio abierto. |
| `409` | `SUBSCRIPTION_RENEWAL_INVOICE_NOT_CONFIRMABLE` o `SUBSCRIPTION_RENEWAL_RESERVATION_STALE` | El borrador ya no puede confirmarse o la suscripcion cambio desde la reserva. |
| `409` | `SUBSCRIPTION_RENEWAL_NOT_EXCLUDABLE`, `SUBSCRIPTION_RENEWAL_ALREADY_EXCLUDED`, `SUBSCRIPTION_RENEWAL_PENDING_SELECTION_REQUIRED` o `SUBSCRIPTION_RENEWAL_EXCLUSION_STALE` | La exclusion o seleccion pendiente no coincide con el estado, periodo o expediente vigente. |
| `422` | `SUBSCRIPTION_RENEWAL_NOT_DUE` o `SUBSCRIPTION_RENEWAL_GROUP_INVALID` | La seleccion aun no vence o no puede formar una factura agrupada. |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | El cuerpo no es JSON. |
| `413` | `PAYLOAD_TOO_LARGE` | El cuerpo supera 16 KiB al preparar, 4 KiB al excluir o 2 KiB al confirmar/liberar. |
| `422` | `VALIDATION_ERROR` y errores de referencias no activas | El contrato o una invariante funcional no se cumple. |
| `423` | `MAINTENANCE_MODE_ACTIVE` | La plataforma esta en mantenimiento. |
| `429` | `SUBSCRIPTION_RENEWAL_RATE_LIMITED` o `SUBSCRIPTION_RENEWAL_EXCLUSION_RATE_LIMITED` | Se supero el limite persistente; incluye `Retry-After: 900`. |
| `503` | `INVOICE_VERIFACTU_PREPARATION_UNAVAILABLE` o `SUBSCRIPTION_RENEWAL_BUSY` | Fallo fiscal o contencion transaccional reintentable. |

## 14. Limites deliberados

- La activacion es manual; no se activa un borrador por fecha.
- El runner es manual y supervisado; no hay ejecucion automatica desatendida.
- La vista previa permite seleccionar suscripciones y excluir explicitamente
  una renovacion con motivo, pero no editar sus lineas economicas.
- La apertura automatica se limita a bloqueos estables de preparacion ya
  aceptada (`CUSTOMER_NOT_ACTIVE` y ejercicio contable no abierto). Otros
  fallos conservan el estado contractual y solo usan la evidencia que les
  corresponda.
- No se admite reactivacion.
- `nextRenewalDate` se inicializa con la fecha de inicio, identifica la reserva
  y solo avanza durante la confirmacion atomica correctamente facturada.
- Suscripciones no escribe directamente en tablas de facturacion: delega la
  construccion completa del borrador en el caso de uso interno de Facturacion.
