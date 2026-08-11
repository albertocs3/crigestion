# Contratos HTTP de Suscripciones

## 1. Alcance del primer corte

Este contrato cubre el alta, listado, detalle, edicion de borradores,
activacion manual, cancelacion inmediata y registro o retirada de una baja
futura. Incluye tambien el runner manual de renovaciones: consulta agrupada,
reserva de borrador, confirmacion atomica y liberacion trazable. Incluye la
primera rebanada de cambios programados de cantidad `PER_LICENSE`; todavia no
incluye cambios de plan, conceptos, precios o periodicidad ni edicion de lineas
en la vista previa. La reactivacion inmediata de una suscripcion cancelada si
forma parte del contrato.

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
| `Subscriptions.ScheduleChanges` | Programar o retirar cambios contractuales de cantidad; requiere ademas ManageEconomics y View. |
| `Subscriptions.Cancel` | Cancelar inmediatamente o registrar y retirar una baja futura. |
| `Subscriptions.Reactivate` | Reactivar una suscripcion cancelada sin recuperar periodos omitidos. |
| `Subscriptions.ScheduleReactivations` | Programar, retirar o aplicar reactivaciones futuras; requiere ademas View. |
| `Subscriptions.RunRenewals` | Consultar candidatos, preparar reservas y liberarlas. |
| `Subscriptions.ConfirmRenewals` | Confirmar una reserva de renovacion. |
| `Subscriptions.ManageRenewalExclusions` | Excluir renovaciones y consultar sus motivos. |
| `Subscriptions.WaiveRenewals` | Condonar individualmente un periodo pendiente sin facturarlo. |
| `Subscriptions.ViewRenewalWaivers` | Consultar el historial y los importes teoricos de periodos condonados. |
| `Subscriptions.ExportRenewalWaivers` | Exportar el informe interno de periodos condonados. |
| `Subscriptions.ViewRenewalWaiverFiscalReviews` | Consultar estado, revisor y conclusion de la revision fiscal posterior. |
| `Subscriptions.DecideRenewalWaiverFiscalReviews` | Asumir y clasificar revisiones fiscales de condonaciones ajenas. |
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

## 8.1. `POST /api/subscriptions/{subscriptionId}/reactivate`

Permisos requeridos: `Subscriptions.Reactivate` y `Subscriptions.View`, porque
la respuesta contiene el detalle actualizado de la suscripcion.

```json
{
  "expectedVersion": 6,
  "nextRenewalDate": "2026-09-01",
  "reason": "El cliente solicita reanudar el servicio"
}
```

Solo admite una suscripcion `CANCELLED`, con cliente activo, configuracion
economica coherente y sin reserva u exclusion abierta. La reactivacion es
inmediata según la fecha de negocio de `Europe/Madrid`; una reactivacion futura
requiere otro flujo y no se simula dejando la suscripcion activa antes de
tiempo. `nextRenewalDate` debe ser posterior a la baja, no anterior a la fecha
de negocio, no superar la fecha final contractual y no reutilizar ni solapar un
periodo reservado, facturado o excluido.

La operacion conserva el inicio contractual y archiva en un historial
append-only la cancelacion cerrada, sus versiones y la nueva fecha de
renovacion. No reabre exclusiones, reservas, facturas ni bajas programadas
historicas. Responde `200` con el DTO actualizado, exige idempotencia y limita
el cuerpo a 2 KiB y diez intentos por actor y empresa cada quince minutos. El
evento `SUBSCRIPTION_REACTIVATED` no copia el motivo libre ni la clave de
idempotencia.

## 8.2. `POST /api/subscriptions/{subscriptionId}/reactivation-schedules`

Permisos requeridos: `Subscriptions.ScheduleReactivations` y
`Subscriptions.View`.

```json
{
  "expectedVersion": 7,
  "effectiveDate": "2026-10-01",
  "nextRenewalDate": "2026-10-01",
  "reason": "Reanudacion acordada para el inicio del nuevo trimestre"
}
```

Registra una orden `PENDING` y responde `201` con
`{ "subscriptionVersion": 8, "schedule": { ... } }`. La suscripcion debe
continuar `CANCELLED`; crear la orden no la activa ni modifica por adelantado
su proxima renovacion. La fecha efectiva debe ser estrictamente futura segun
`Europe/Madrid`, posterior a la baja vigente y no superar la fecha final del
contrato. `nextRenewalDate` no puede ser anterior a `effectiveDate` ni
reutilizar o solapar evidencia de renovacion previa.

Solo puede existir una orden pendiente por suscripcion. Su creacion conserva
motivo, actor, instante y version base, incrementa una vez la version de la
suscripcion y es idempotente. Una orden pendiente bloquea la reactivacion
inmediata: debe aplicarse o retirarse expresamente.

## 8.3. `POST /api/subscriptions/{subscriptionId}/reactivation-schedules/{scheduleId}/cancel`

Permisos requeridos: `Subscriptions.ScheduleReactivations` y
`Subscriptions.View`.

```json
{
  "expectedSubscriptionVersion": 8,
  "expectedScheduleVersion": 1,
  "reason": "El cliente aplaza la reanudacion"
}
```

Realiza `PENDING -> REVOKED`, incrementa las versiones de orden y suscripcion y
responde `200` con `{ "subscriptionVersion": 9, "schedule": { ... } }`. La
suscripcion permanece cancelada. La retirada y su motivo se conservan como
evidencia inmutable; el motivo libre no se copia a auditoria.

## 8.4. `POST /api/subscriptions/{subscriptionId}/reactivation-schedules/{scheduleId}/apply`

Permisos requeridos: `Subscriptions.ScheduleReactivations` y
`Subscriptions.View`.

```json
{
  "expectedSubscriptionVersion": 8,
  "expectedScheduleVersion": 1
}
```

Solo admite una orden `PENDING` cuya fecha efectiva haya llegado y cuya
`nextRenewalDate` no sea anterior al dia de negocio. Si esta ultima fecha quedo
atras, la orden debe retirarse y reprogramarse. Revalida bajo bloqueo la empresa,
versiones, cancelacion vigente, cliente, configuracion, fecha final, reservas,
exclusiones y periodos ya usados. En una unica
transaccion realiza `PENDING -> APPLIED`, crea la evidencia append-only de
reactivacion programada, cambia la suscripcion a `ACTIVE`, limpia la
cancelacion vigente y establece la nueva `nextRenewalDate`.

Responde `200` con `subscriptionVersion`, `status: "ACTIVE"`,
`nextRenewalDate`, `reactivationId` y `schedule`. La aplicacion puede ser
supervisada mediante este endpoint o automatica mediante el worker interno.
Nunca se ejecuta desde un `GET` ni al cargar una pantalla. Una orden bloqueada
permanece pendiente y visible hasta que se corrige la causa o un operador la
retira; si la renovacion quedo atras, la UI solo ofrece retirarla y
reprogramarla.

### 8.1 Ejecutor interno de reactivaciones

`scripts/run-subscription-reactivation-worker.ts` es un proceso one-shot sin
contrato HTTP. Cada ejecucion procesa hasta 25 ordenes `PENDING` vencidas,
ordenadas por fecha e identificador. Dos ejecutores concurrentes convergen a un
solo efecto mediante bloqueos padre-orden, transaccion `Serializable`, reintento
acotado de `P2034` y las invariantes PostgreSQL existentes.

Antes de aplicar se exige que el solicitante siga `ACTIVE` y conserve
`Subscriptions.ScheduleReactivations` y `Subscriptions.View`. Tambien se
revalidan version, baja vigente, cliente, configuracion, reservas, exclusiones,
periodos usados y fechas. Los bloqueos se guardan en
`subscription_reactivation_automation_attempts`; el ledger es append-only y
solo permite una numeracion consecutiva por orden. No se reintenta la misma
orden durante una hora. La auditoria `SYSTEM` registra
`SUBSCRIPTION_REACTIVATION_AUTOMATION_BLOCKED` solo cuando cambia el codigo
estable y nunca incluye motivos libres. Una aplicacion correcta conserva el
evento `SUBSCRIPTION_REACTIVATION_SCHEDULE_APPLIED` con actor `SYSTEM`.

Las tres mutaciones exigen Origin, CSRF, JSON estricto, mantenimiento inactivo,
`Idempotency-Key`, cuerpo acotado, rate limit persistente y auditoria sin
motivos libres ni claves idempotentes.

## 8.5. `POST /api/subscriptions/{subscriptionId}/change-schedules`

Permisos requeridos: `Subscriptions.ScheduleChanges`,
`Subscriptions.ManageEconomics` y `Subscriptions.View`.

```json
{
  "expectedVersion": 3,
  "reason": "Ampliacion de licencias acordada para el siguiente periodo",
  "lines": [
    { "subscriptionLineId": "00000000-0000-0000-0000-000000000001", "quantity": "15.000" }
  ]
}
```

La primera version solo admite cantidades positivas de lineas existentes en
una suscripcion `ACTIVE` con modalidad `PER_LICENSE`. La fecha efectiva no se
recibe del cliente: es la `nextRenewalDate` bloqueada por el servidor. Todas
las lineas incluidas deben cambiar realmente y no se pueden repetir. No admite
precios, descuentos, impuestos, conceptos, periodicidad ni fechas.

Responde `201` con `{ "subscriptionVersion": 4, "schedule": { ... } }`.
Crear la orden no modifica las cantidades vigentes. Solo puede existir una
orden `PENDING` y no se permite si hay una reserva `RESERVED`, una exclusion
`OPEN`, una baja pendiente o una reactivacion pendiente. La vista previa
proyecta sus cantidades sin mutar datos; la aplicacion real se realiza dentro
de la transaccion serializable que reserva la renovacion.

## 8.6. `POST /api/subscriptions/{subscriptionId}/change-schedules/{scheduleId}/cancel`

Permisos requeridos: `Subscriptions.ScheduleChanges`,
`Subscriptions.ManageEconomics` y `Subscriptions.View`.

```json
{
  "expectedSubscriptionVersion": 4,
  "expectedScheduleVersion": 1,
  "reason": "El cliente aplaza la ampliacion"
}
```

Realiza `PENDING -> REVOKED`, incrementa las versiones de orden y suscripcion
y responde `200`. No elimina ni edita la evidencia. Mientras exista una orden
pendiente, la baja inmediata y la baja programada se rechazan con
`SUBSCRIPTION_PENDING_CHANGE_EXISTS`; primero debe retirarse expresamente.

Ambas mutaciones exigen Origin, CSRF, JSON estricto, cuerpo acotado,
`Idempotency-Key`, cuota persistente por actor y empresa y respuesta
`Cache-Control: private, no-store`. Los replays validos se atienden antes de la
cuota. La auditoria no contiene cantidades, motivo libre, importes ni clave de
idempotencia.

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
`includePending=true|false`, `limit` canónico entre 1 y 100 (25 por defecto) y
un `cursor` opaco. No admite una fecha futura ni parámetros desconocidos,
repetidos o booleanos no canónicos.

Devuelve los grupos elegibles ordenados por cliente, forma de pago y periodo,
con versiones optimistas, accion prevista (`INVOICE` o `CANCEL`), total
estimado y `nextCursor`. El cursor está firmado y ligado a empresa, actor,
fecha de proceso e `includePending`; manipularlo o reutilizarlo con otros
filtros devuelve `422 SUBSCRIPTION_RENEWAL_PREVIEW_CURSOR_INVALID`. La cola es
viva: los cambios entre páginas se revalidan y el operador puede volver a la
primera página para refrescar el corte.

Una suscripcion `RENEWAL_PENDING` solo aparece al solicitarla expresamente.
Las reservas activas no vuelven a aparecer como candidatas y se devuelven en
`reservedInvoices`. La consulta es orientativa, usa `private, no-store` y se
audita solo con conteos y estado de continuidad, nunca con el cursor. Cada
grupo hidrata como maximo 100 miembros; si el total es mayor se muestra como no
seleccionable.

### `POST /api/subscriptions/renewals`

Permiso requerido: `Subscriptions.RunRenewals`.

```json
{
  "subscriptions": [
    {
      "subscriptionId": "uuid",
      "expectedVersion": 2,
      "pendingExclusionId": "uuid opcional",
      "lineDescriptionOverrides": [
        { "subscriptionLineId": "uuid", "description": "Descripcion solo para esta factura" }
      ]
    }
  ],
  "issueDate": "2026-08-06"
}
```

La empresa se deriva de la instalacion y nunca se acepta del navegador. La
peticion admite como maximo 100 suscripciones y 100 descripciones
personalizadas, exige sus versiones observadas, se limita a 64 KiB y revalida
dentro de una transaccion `Serializable` empresa,
estado, periodo frente a la fecha seleccionada, vigencia final, cliente, forma
de pago y baja vencida a esa misma fecha. Responde `201` al crear
una reserva y `200` al reproducir la misma clave idempotente.

Si la suscripcion esta `RENEWAL_PENDING`, `pendingExclusionId` es obligatorio y
debe identificar el expediente `OPEN` de la empresa, suscripcion y periodo
observados. Una suscripcion activa no admite ese campo. De este modo,
`includePending=true` solo permite consultar la cola: nunca autoriza una
preparacion masiva o implicita de pendientes.

`lineDescriptionOverrides` es opcional y solo admite lineas de la suscripcion
seleccionada. El texto se recorta y debe contener entre 1 y 500 caracteres. La
descripcion se copia exclusivamente a la linea del borrador reservado: no
modifica la suscripcion, el catalogo ni renovaciones futuras. La huella
idempotente incluye las personalizaciones. La auditoria conserva solamente el
numero de descripciones cambiadas, nunca su contenido.

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
Guarda ademas la identidad operativa del cliente (codigo y razon social, sin
NIF ni domicilio) y un desglose teorico inmutable por codigo y porcentaje de
IVA. Ambos nacen en la misma transaccion y nunca se aceptan desde la API.
La respuesta devuelve esa valoracion para que la confirmacion operativa muestre
el importe exacto que se esta condonando.

PostgreSQL exige bilateralmente que la condonacion y el avance coincidan y que
no exista factura activa para ese periodo. La auditoria
`SUBSCRIPTION_RENEWAL_PERIOD_WAIVED` conserva codigo, total, moneda, version de
calculo e identificadores seguros, pero nunca copia el motivo libre ni la clave
idempotente. Triggers diferidos exigen al menos un tipo y que sus bases, cuotas
y totales sumen exactamente la cabecera. La evidencia terminal, el snapshot de
cliente y los desgloses son inmutables.

### `GET /api/subscriptions/renewal-waivers`

Permiso requerido: `Subscriptions.ViewRenewalWaivers`. Devuelve solo expedientes
`RESOLVED/WAIVED` de la empresa instalada, ordenados por `resolvedAt DESC, id
DESC`, con cursor HMAC ligado a filtros y a una secuencia de corte monotónica.
El resumen de
conteo, subtotal, descuento, base, IVA y total corresponde a todo el filtro y
se calcula sobre el snapshot persistido, nunca sobre las lineas actuales.

Admite `reasonCode`, `customerId`, `search` sobre número o nombre contractual,
`periodFrom`, `periodTo`,
`waivedFrom` y `waivedTo`, ademas de `limit` 1-100 y cursor. Rechaza parametros
desconocidos, repetidos, rangos inversos y cursores manipulados o reutilizados
con otros filtros. Para nuevas condonaciones, codigo y nombre proceden del
snapshot capturado al resolver. Un historico recuperado durante migracion se
marca expresamente `BACKFILLED_CURRENT_MASTER` y nunca se presenta como dato
capturado en la fecha original. El detalle libre solo se selecciona
y devuelve si el actor posee tambien `Subscriptions.ManageRenewalExclusions`.
Cada pagina se audita como `SUBSCRIPTION_RENEWAL_WAIVERS_VIEWED`, sin texto de
busqueda, cursor ni motivos libres, y usa cache `private, no-store`.
La búsqueda exige además un rango de condonación máximo de 366 días para acotar
el coste; los límites diarios se interpretan en `Europe/Madrid`.

### `POST /api/subscriptions/renewal-waivers/export`

Permiso requerido: `Subscriptions.ExportRenewalWaivers`. Aunque genera un
archivo de lectura, se usa `POST` para exigir origen permitido y CSRF ante una
exfiltracion masiva. Recibe los mismos filtros en JSON estricto, con
`waivedFrom` y `waivedTo` obligatorios y un rango maximo de 366 dias.

Genera CSV UTF-8 con BOM, separador punto y coma, fechas ISO y decimales con
punto. Conserva una fila por condonacion y serializa el desglose teorico en una
columna no ambigua para no duplicar totales. No incluye motivos libres ni
identificadores fiscales y neutraliza formulas de hoja de calculo antes del
escape CSV. El limite sincrono es 5.000
filas y 5 MiB; si se supera devuelve
`SUBSCRIPTION_RENEWAL_WAIVER_EXPORT_TOO_LARGE` sin truncar. Aplica cinco
exportaciones cada quince minutos por empresa y usuario, con `Retry-After: 900`.
La generacion y auditoria `SUBSCRIPTION_RENEWAL_WAIVERS_EXPORTED` se confirman
antes de entregar el archivo; la auditoria conserva filas, bytes y filtros
seguros, nunca el contenido. El CSV se identifica expresamente como informe
interno no fiscal y sus importes como valoraciones teoricas.

### Revision fiscal posterior

Cada nueva condonacion crea atomicamente una revision `PENDING` y un evento
append-only `OPENED`. La migracion 115 abre tambien una revision pendiente para
cada condonacion historica completa, marcada como
`BACKFILLED_EXISTING_WAIVER`; no inventa conclusiones ni revisores.

La revision no aprueba, revierte ni reabre la condonacion. Tampoco crea factura,
asiento, libro de IVA, outbox o registro VeriFactu. Un segundo usuario con
`Subscriptions.DecideRenewalWaiverFiscalReviews` debe asumirla y decidirla. La
persona que condono el periodo no puede iniciar ni resolver su propia revision,
incluso si es administradora.

#### `POST /api/subscriptions/renewal-waiver-fiscal-reviews/{reviewId}/start`

Exige Origin, CSRF, JSON estricto, `Idempotency-Key`, mantenimiento inactivo y
el permiso de decision. Recibe `{ "expectedVersion": 1 }` y realiza
`PENDING -> IN_REVIEW`, fijando revisor, hora PostgreSQL, version 2, auditoria y
evento `STARTED` en la misma transaccion serializable.

#### `POST /api/subscriptions/renewal-waiver-fiscal-reviews/{reviewId}/decide`

Solo puede decidir el usuario que asumio la revision. Recibe version 2, detalle
de 10-500 caracteres y una conclusion estable:

- `NO_ADDITIONAL_ACTION`: cierra la revision sin vencimiento.
- `MANUAL_ACCOUNTING_ACTION_REQUIRED`.
- `BILLING_REGULARIZATION_REQUIRED`.
- `EXTERNAL_FISCAL_ACTION_REQUIRED`.
- `EXTERNAL_ADVICE_REQUIRED`.

Las cuatro ultimas exigen `actionDueDate`; las tres actuaciones pasan a
`ACTION_REQUIRED` y el asesoramiento a `ESCALATED`. El detalle libre se guarda en la revision,
pero no aparece en el informe general, CSV, ledger ni auditoria. Cada actor
dispone de 20 mutaciones por 15 minutos y recibe `Retry-After: 900` al superar
el limite.

#### Cierre acreditado de una actuación contable

El primer flujo de acreditación cubre exclusivamente
`MANUAL_ACCOUNTING_ACTION_REQUIRED`. Desde la revisión se abre Contabilidad con
el identificador causal; `POST /api/accounting/journal-entries` acepta
`waiverReviewId` y crea un asiento `WAIVER_REGULARIZATION` único. El caso de uso
contable determina cuentas, fecha e importe bajo el permiso
`Accounting.ManageEntries`. La revisión nunca genera ni propone apuntes a
partir de la valoración teórica.

`POST /api/subscriptions/renewal-waiver-fiscal-reviews/{reviewId}/complete`
exige `Subscriptions.CompleteRenewalWaiverFiscalReviews`, Origin, CSRF,
`Idempotency-Key`, JSON estricto y `{ "expectedVersion": 3, "detail": "..." }`.
Solo el revisor asignado puede ejecutarlo. Localiza el asiento causal ya
contabilizado, comprueba empresa, origen, estado `POSTED`, cuadre, importe
positivo y ausencia de reversión, y confirma atómicamente evidencia append-only,
`ACTION_REQUIRED v3 -> CLOSED v4`, evento `COMPLETED`, auditoría y replay.
El detalle de comprobación es confidencial; el informe general solo muestra
recuento de evidencias y actor de cierre. El límite es 10 intentos por actor y
empresa cada 15 minutos.

Las decisiones de facturación, actuación fiscal externa o asesoramiento siguen
abiertas: no pueden cerrarse enlazando facturas manuales por coincidencia ni
referencias de texto. Requieren futuros flujos causales propios.

#### Reversión controlada de evidencia contable

Una evidencia `CLOSED v4` puede corregirse sin reescribirla mediante
`POST /api/subscriptions/renewal-waiver-fiscal-reviews/{reviewId}/accounting-reversals`.
Exige `Accounting.RequestWaiverEvidenceReversals`, versión esperada 4, fecha
contable, código de motivo y detalle de 10-500 caracteres. El solicitante debe
ser distinto de quien condonó y de quien cerró la revisión.

La solicitud queda `REQUESTED v1`. Otro usuario con
`Accounting.ApproveWaiverEvidenceReversals` puede aprobarla en
`POST /api/accounting/waiver-evidence-reversals/{requestId}/approve`, o
rechazarla con fundamento mediante `/reject`; el solicitante puede retirarla
mediante `/cancel`. Todos exigen Origin, CSRF, JSON estricto,
`Idempotency-Key`, mantenimiento inactivo y limitan 10 intentos por 15 minutos.

La aprobación solo es válida si su actor difiere de solicitante, autor de la
condonación y revisor de cierre. En una única transacción crea un asiento
`WAIVER_REGULARIZATION_REVERSAL` `POSTED` que refleja línea a línea cuentas,
conceptos, posiciones y debe/haber del asiento acreditado, completa solicitud y
ledger y audita referencias seguras. El ejercicio original debe seguir abierto;
si ya se cerró, debe usarse antes el flujo formal de reapertura. No se admiten
ajustes cruzados entre ejercicios en este corte.

La revisión continúa `CLOSED v4`, y tanto evidencia como asiento originales
siguen inmutables. El informe deriva el estado "evidencia histórica revertida;
seguimiento requerido". La reversión no crea ni modifica facturas, IVA,
registros u outbox VeriFactu. PostgreSQL impide comprometer un asiento con una
solicitud pendiente/rechazada/cancelada y exige un único asiento `POSTED` con
espejo exacto cuando la solicitud está completada.

El historial solo selecciona y devuelve la revision si el actor posee
`Subscriptions.ViewRenewalWaiverFiscalReviews`. Muestra estado, actores,
conclusion y vencimiento, pero no el detalle. PostgreSQL exige una revision por
condonacion, un evento por version, maker/checker distintos, transiciones
canonicas e inmutabilidad de la clasificación; solo la actuación contable
admite el cierre acreditado v4 descrito, sin reescribir su decisión.

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
| `409` | `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_REPLAY_INVALID`, `SUBSCRIPTION_VERSION_CONFLICT`, `SUBSCRIPTION_NOT_EDITABLE`, `SUBSCRIPTION_NOT_ACTIVATABLE`, `SUBSCRIPTION_NOT_CANCELLABLE` o `SUBSCRIPTION_NOT_REACTIVATABLE` | Conflicto idempotente, concurrente o de estado. |
| `409` | `SUBSCRIPTION_RENEWAL_RESERVED` o `SUBSCRIPTION_RENEWAL_EXCLUSION_OPEN` | Una evidencia abierta impide reactivar. |
| `409` | `SUBSCRIPTION_PENDING_CANCELLATION_EXISTS` o `SUBSCRIPTION_CANCELLATION_SCHEDULE_NOT_PENDING` | Conflicto del ciclo de una baja futura. |
| `409` | `SUBSCRIPTION_NOT_SCHEDULABLE_FOR_REACTIVATION`, `SUBSCRIPTION_PENDING_REACTIVATION_EXISTS`, `SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_PENDING`, `SUBSCRIPTION_REACTIVATION_SCHEDULE_VERSION_CONFLICT` o `SUBSCRIPTION_REACTIVATION_SCHEDULE_STALE` | Conflicto del ciclo, estado o evidencia de una reactivacion programada. |
| `404` | `SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_FOUND` | La orden, la suscripcion o su pertenencia a empresa no son visibles para el actor. |
| `409` | `SUBSCRIPTION_RENEWAL_ALREADY_RESERVED`, `SUBSCRIPTION_RENEWAL_RESERVED` o `INVOICE_ACCOUNTING_FISCAL_YEAR_NOT_OPEN` | El periodo ya esta reservado, la reserva bloquea otra mutacion o falta ejercicio abierto. |
| `409` | `SUBSCRIPTION_RENEWAL_INVOICE_NOT_CONFIRMABLE` o `SUBSCRIPTION_RENEWAL_RESERVATION_STALE` | El borrador ya no puede confirmarse o la suscripcion cambio desde la reserva. |
| `409` | `SUBSCRIPTION_RENEWAL_NOT_EXCLUDABLE`, `SUBSCRIPTION_RENEWAL_ALREADY_EXCLUDED`, `SUBSCRIPTION_RENEWAL_PENDING_SELECTION_REQUIRED` o `SUBSCRIPTION_RENEWAL_EXCLUSION_STALE` | La exclusion o seleccion pendiente no coincide con el estado, periodo o expediente vigente. |
| `422` | `SUBSCRIPTION_RENEWAL_NOT_DUE`, `SUBSCRIPTION_RENEWAL_GROUP_INVALID` o `SUBSCRIPTION_RENEWAL_LINE_OVERRIDE_INVALID` | La seleccion aun no vence, no puede formar una factura agrupada o una descripcion apunta a una linea ajena. |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | El cuerpo no es JSON. |
| `413` | `PAYLOAD_TOO_LARGE` | El cuerpo supera 64 KiB al preparar, 4 KiB al excluir o 2 KiB al confirmar, liberar o reactivar. |
| `422` | `VALIDATION_ERROR`, `SUBSCRIPTION_REACTIVATION_DATE_INVALID`, `SUBSCRIPTION_REACTIVATION_AFTER_END`, `SUBSCRIPTION_REACTIVATION_PERIOD_OVERLAP` y errores de referencias no activas | El contrato o una invariante funcional no se cumple. |
| `422` | `SUBSCRIPTION_REACTIVATION_SCHEDULE_DATE_NOT_FUTURE`, `SUBSCRIPTION_REACTIVATION_SCHEDULE_NOT_DUE`, `SUBSCRIPTION_REACTIVATION_SCHEDULE_RENEWAL_DATE_PASSED`, `SUBSCRIPTION_REACTIVATION_SCHEDULE_NEXT_RENEWAL_DATE_INVALID`, `SUBSCRIPTION_REACTIVATION_SCHEDULE_AFTER_END` o `SUBSCRIPTION_REACTIVATION_SCHEDULE_PERIOD_OVERLAP` | La programacion o su aplicacion no cumplen las reglas temporales. |
| `423` | `MAINTENANCE_MODE_ACTIVE` | La plataforma esta en mantenimiento. |
| `429` | `SUBSCRIPTION_RENEWAL_RATE_LIMITED`, `SUBSCRIPTION_RENEWAL_EXCLUSION_RATE_LIMITED`, `SUBSCRIPTION_REACTIVATION_RATE_LIMITED` o `SUBSCRIPTION_REACTIVATION_SCHEDULE_RATE_LIMITED` | Se supero el limite persistente; incluye `Retry-After: 900`. |
| `503` | `INVOICE_VERIFACTU_PREPARATION_UNAVAILABLE`, `SUBSCRIPTION_RENEWAL_BUSY` o `SUBSCRIPTION_REACTIVATION_SCHEDULE_BUSY` | Fallo fiscal o contencion transaccional reintentable. |

## 14. Limites deliberados

- La activacion es manual; no se activa un borrador por fecha.
- El runner es manual y supervisado; no hay ejecucion automatica desatendida.
- La vista previa permite seleccionar suscripciones, excluir explicitamente
  una renovacion con motivo y personalizar descripciones solo para el borrador.
  No permite editar cantidades, precios, descuentos, impuestos ni recargos.
- La apertura automatica se limita a bloqueos estables de preparacion ya
  aceptada (`CUSTOMER_NOT_ACTIVE` y ejercicio contable no abierto). Otros
  fallos conservan el estado contractual y solo usan la evidencia que les
  corresponda.
- La reactivacion inmediata exige una nueva fecha de proxima renovacion. La
  programada es supervisada: una orden vencida no se aplica hasta que un
  operador lo confirma. No existe recuperacion automatica de periodos omitidos
  ni un ejecutor desatendido de reactivaciones.
- `nextRenewalDate` se inicializa con la fecha de inicio, identifica la reserva
  y solo avanza durante la confirmacion atomica correctamente facturada.
- Suscripciones no escribe directamente en tablas de facturacion: delega la
  construccion completa del borrador en el caso de uso interno de Facturacion.
