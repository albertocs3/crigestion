# Contratos HTTP de Contabilidad

## 1. Primer Corte

El primer corte expone cuentas contables, ejercicios y asientos manuales ya
contabilizados. Incluye el PGC PYMES y la copia del plan al siguiente ejercicio.
No incluye todavia adjuntos, anulaciones, modificacion de asientos ni
reaperturas. La emision de facturas ordinarias y rectificativas crea ya su
asiento automatico. Los cobros manuales crean tambien su asiento; las
devoluciones y cobros de remesas se incorporan en cortes posteriores. El corte
de compras incorpora ya facturas de proveedor, vencimientos, pagos manuales y
rectificaciones totales recibidas del proveedor.

Permisos:

| Permiso | Uso |
|---|---|
| `Accounting.View` | Consultar cuentas y diario. |
| `Accounting.ManageEntries` | Crear cuentas y asientos manuales. |
| `Accounting.ManageExercises` | Crear la primera contabilidad. |
| `Accounting.RequestExerciseClosures` | Solicitar o cancelar el cierre de un ejercicio. |
| `Accounting.ApproveExerciseClosures` | Aprobar y ejecutar el cierre solicitado por otra persona. |
| `Accounting.CloseExercises` | Permiso legado; no habilita el cierre directo. |
| `Suppliers.View` | Consultar el maestro de proveedores. |
| `Suppliers.Manage` | Crear, editar y cambiar el estado de proveedores. |
| `Purchases.View` | Consultar facturas de compra y vencimientos de proveedor. |
| `Purchases.ManageDrafts` | Crear y editar borradores, lineas y vencimientos. |
| `Purchases.Register` | Registrar definitivamente una compra. |
| `Purchases.Rectify` | Registrar una rectificacion total de proveedor. |
| `Treasury.ManageSupplierPayments` | Registrar pagos parciales o totales de proveedor. |
| `Treasury.ViewSupplierPayments` | Consultar vencimientos y pagos de proveedor. |
| `Treasury.ViewSupplierCredits` | Consultar saldos a favor con proveedores. |
| `Treasury.ApplySupplierCredits` | Compensar saldos con compras pendientes. |
| `Treasury.RequestSupplierRefunds` | Solicitar o cancelar reembolsos propios pendientes. |
| `Treasury.ApproveSupplierRefunds` | Aprobar reembolsos solicitados por otra persona. |
| `Treasury.PostSupplierRefunds` | Contabilizar reembolsos aprobados. |

## 1.b Maestro de proveedores

- `GET /api/suppliers`: lista por empresa, estado y busqueda por codigo o nombre.
- `GET /api/suppliers/{supplierId}`: devuelve el detalle operativo.
- `POST /api/suppliers`: crea un proveedor y su subcuenta `400xxxxxx` en cada
  ejercicio abierto. Requiere CSRF e `Idempotency-Key`.
- `PATCH /api/suppliers/{supplierId}`: edita o activa/inactiva. Requiere CSRF,
  `Idempotency-Key` y `expectedVersion` para concurrencia optimista.

El codigo `PROVxxxxx` y la cuenta `400xxxxxx` proceden del mismo consecutivo por
empresa. NIF/VAT, email, telefono, IBAN y BIC se cifran con AES-256-GCM y contexto
autenticado; el NIF usa ademas una huella HMAC para unicidad. Los contratos no
devuelven esos valores completos: exponen mascara o indicadores de presencia.
Una edicion sensible usa `keep`, `clear` o `replace` para no reenviar secretos al
navegador. No existe borrado fisico en este corte.

Errores funcionales principales: `SUPPLIER_NOT_FOUND`,
`SUPPLIER_TAX_ID_ALREADY_USED`, `SUPPLIER_ACCOUNTING_FISCAL_YEAR_NOT_OPEN`,
`SUPPLIER_VERSION_CONFLICT`, `SUPPLIER_ACCOUNTS_INCOMPLETE` e
`IDEMPOTENCY_KEY_REUSED`.

## 1.c Compras, vencimientos y pagos de proveedor

- `GET /api/purchases`: lista compras por estado, pago, proveedor y busqueda.
- `POST /api/purchases`: crea el encabezado de un borrador.
- `GET /api/purchases/{purchaseId}`: devuelve detalle, lineas, vencimientos y
  referencia al asiento.
- `PATCH /api/purchases/{purchaseId}`: modifica el encabezado del borrador con
  `expectedVersion`.
- `PUT /api/purchases/{purchaseId}/lines`: sustituye las lineas y recalcula
  bases, cuotas, resumen de IVA y total.
- `PUT /api/purchases/{purchaseId}/due-dates`: sustituye vencimientos; su suma
  debe coincidir con el total.
- `POST /api/purchases/{purchaseId}/register`: registra definitivamente la
  compra y genera, en una transaccion, asiento, IVA soportado y entradas de
  stock.
- `POST /api/purchases/{purchaseId}/rectifications`: registra una factura
  rectificativa total del proveedor, enlazada a la compra original.
- `GET /api/treasury/supplier-due-dates`: lista vencimientos y saldos pagados y
  pendientes.
- `POST /api/treasury/supplier-payments`: registra un pago con una o varias
  asignaciones a vencimientos y genera su asiento.

Todas las mutaciones requieren origen permitido, CSRF, JSON e
`Idempotency-Key`. El servidor bloquea la compra o los vencimientos afectados,
revalida el saldo y persiste la respuesta idempotente en la misma transaccion.
No se devuelven NIF, IBAN ni datos de contacto completos del proveedor.

Las compras registradas permanecen inmutables. La rectificativa es un documento
nuevo, tambien inmutable, y nunca reescribe lineas, IVA, asiento o stock del
original. Anulacion/versionado interno, PDF adjunto, gastos sin factura,
anticipos, devoluciones de pagos y remesas de pago quedan para cortes
posteriores. El reembolso de un saldo nacido de una rectificativa pagada sí
forma parte del sublibro de créditos de proveedor descrito en 1.e.
El pago con tarjeta se difiere hasta definir y configurar su subcuenta de
tesoreria; este corte admite transferencia, domiciliacion y caja.

## 1.d Rectificacion total de una compra

Permiso requerido: `Purchases.Rectify`.

```http
POST /api/purchases/{purchaseId}/rectifications
```

Requiere origen permitido, cookie de sesion, CSRF, JSON e `Idempotency-Key`.

```json
{
  "mode": "FULL",
  "expectedVersion": 4,
  "supplierInvoiceNumber": "R-2026-0042",
  "issueDate": "2026-07-22",
  "receivedDate": "2026-07-22",
  "operationDate": "2026-07-22",
  "accountingDate": "2026-07-22",
  "reason": "RETURN",
  "notes": null
}
```

El cliente no envia cantidades, bases, impuestos, cuentas ni articulos. El
servidor invierte exactamente la compra original y ejecuta en una unica
transaccion:

- documento `RECTIFICATION` con cantidades e importes negativos;
- contraasiento `PURCHASE_RECTIFICATION`, enlazado al asiento original;
- registros nuevos y negativos en el libro de IVA soportado;
- movimientos `PURCHASE_RETURN` para productos con stock, sin alterar el coste
  historico ni bloquear stock negativo;
- si no existe actividad de pago, cancelacion de los vencimientos pendientes y
  estado `RECTIFIED/NOT_APPLICABLE` en el original;
- si la compra estaba completamente pagada de forma coherente, conservación de
  sus pagos y vencimientos `PAID`, estado `RECTIFIED/PAID` y creación de un
  `SupplierCredit` por el total;
- evento `PURCHASE_RECTIFICATION_CREATED` sin notas ni datos fiscales
  sensibles.

Los unicos motivos admitidos en este corte son `RETURN` y
`OPERATION_CANCELLED`, porque ambos revierten tambien la entrada fisica de
producto. La salida de stock queda enlazada uno a uno con el movimiento de
entrada original y se ejecuta aunque la configuracion actual del articulo haya
cambiado.

Solo se admite una rectificacion total por compra ordinaria registrada en uno
de dos estados limpios: completamente impagada y sin actividad, o completamente
pagada con todos los vencimientos `PAID` y asignaciones `POSTED` por el total.
Las compras parcialmente pagadas o incoherentes, las rectificaciones parciales,
incrementales o de varias compras quedan bloqueadas. La correccion interna
de datos mediante versiones es un flujo distinto y no forma parte de este
endpoint. La fecha no puede preceder al original y ambos asientos deben quedar
en el mismo ejercicio abierto.

Errores funcionales principales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `PURCHASE_NOT_FOUND` | No existe en la empresa actual. |
| `409` | `PURCHASE_NOT_RECTIFIABLE` | No es una compra ordinaria registrada. |
| `409` | `PURCHASE_ALREADY_RECTIFIED` | Ya existe una rectificativa. |
| `409` | `PURCHASE_RECTIFICATION_PARTIAL_PAYMENT_UNSUPPORTED` | Existe un pago parcial. |
| `409` | `PURCHASE_RECTIFICATION_PAYMENT_STATE_INVALID` | Pagos y vencimientos no forman un estado limpio. |
| `409` | `PURCHASE_VERSION_CONFLICT` | La version visible quedo obsoleta. |
| `409` | `PURCHASE_FISCAL_YEAR_NOT_OPEN` | La fecha contable no pertenece a un ejercicio abierto. |
| `409` | `PURCHASE_RECTIFICATION_FISCAL_YEAR_MISMATCH` | El original y la rectificativa no pertenecen al mismo ejercicio abierto. |

## 1.e Creditos y reembolsos de proveedor

El libro de creditos es append-only y se crea exclusivamente como efecto de una
rectificacion total de compra pagada. El disponible es el importe original
menos aplicaciones y reembolsos no cancelados.

| Ruta | Permiso |
|---|---|
| `GET /api/treasury/supplier-credits` | `Treasury.ViewSupplierCredits` |
| `POST /api/treasury/supplier-credits/{creditId}/applications` | `Treasury.ApplySupplierCredits` |
| `POST /api/treasury/supplier-credits/{creditId}/refund-requests` | `Treasury.RequestSupplierRefunds` |
| `POST /api/treasury/supplier-credit-refunds/{refundId}/approve` | `Treasury.ApproveSupplierRefunds` |
| `POST /api/treasury/supplier-credit-refunds/{refundId}/post` | `Treasury.PostSupplierRefunds` |
| `POST /api/treasury/supplier-credit-refunds/{refundId}/cancel` | `Treasury.RequestSupplierRefunds` |

Una aplicacion solo admite un vencimiento `PENDING` de una compra ordinaria
registrada de la misma empresa y proveedor. No crea pago ni asiento adicional;
actualiza los estados derivados `PARTIALLY_SETTLED` o `SETTLED`. Pagos y
aplicaciones se suman al calcular el pendiente y se revalidan bajo bloqueo.

Un reembolso admite `BANK_TRANSFER` con cuenta bancaria activa de la empresa o
`CASH` sin cuenta bancaria. Sigue `REQUESTED -> APPROVED -> POSTED`; solo quien
lo solicito puede cancelar mientras esta `REQUESTED`, y no puede aprobar su
propia solicitud. La contabilizacion usa una fecha explicita en ejercicio
abierto y crea Debe 572/Haber 400 para banco o Debe 570/Haber 400 para caja.
Solicitar reserva saldo y cancelar lo libera.

Todas las mutaciones requieren origen permitido, CSRF, JSON, cuerpo maximo de
16 KiB e `Idempotency-Key`. Se ejecutan en transaccion serializable y auditan
solo identificadores internos, importes, fechas, estados y correlacion; nunca
notas, referencias completas, NIF, IBAN ni datos de contacto. La pantalla
operativa es `/app/treasury/supplier-credits`.
| `409` | `PURCHASE_ACCOUNT_NOT_AVAILABLE` | Falta una subcuenta activa en el ejercicio destino. |
| `409` | `IDEMPOTENCY_KEY_REUSED` | La clave se reutilizo con otro cuerpo. |

## 1.a Ejercicios contables

- `GET /api/accounting/fiscal-years`: requiere `Accounting.View`.
- `POST /api/accounting/fiscal-years`: crea la primera contabilidad con PGC
  PYMES; requiere `Accounting.ManageExercises`, CSRF e `Idempotency-Key`.
- `POST /api/accounting/fiscal-years/{fiscalYearId}/close-requests`: ejecuta el
  preflight y crea una solicitud pendiente. Requiere
  `Accounting.RequestExerciseClosures`, CSRF e `Idempotency-Key`.
- `POST /api/accounting/fiscal-year-close-requests/{requestId}/approve`: exige
  `Accounting.ApproveExerciseClosures` y que el aprobador sea distinto del
  solicitante. Repite el preflight y, en la misma transaccion, regulariza grupos
  6 y 7, genera el cierre patrimonial, crea el siguiente ejercicio, copia sus
  cuentas y genera la apertura. Requiere CSRF e `Idempotency-Key`.
- `POST /api/accounting/fiscal-year-close-requests/{requestId}/cancel`: permite
  cancelar una solicitud pendiente solo a quien la creo. Requiere
  `Accounting.RequestExerciseClosures`, CSRF e `Idempotency-Key`.
- `POST /api/accounting/fiscal-years/{fiscalYearId}/close`: compatibilidad
  segura. No ejecuta ninguna mutacion y devuelve
  `FISCAL_YEAR_CLOSE_APPROVAL_REQUIRED`.
- `POST /api/accounting/fiscal-year-close-requests/{closeRequestId}/reopen-requests`:
  ejecuta el preflight y solicita anular un cierre completado. Requiere
  `Accounting.RequestExerciseReopenings`, JSON, CSRF e `Idempotency-Key`. Body:

  ```json
  {
    "reasonCode": "OMITTED_TRANSACTION",
    "reason": "Falta registrar una operacion del ejercicio cerrado."
  }
  ```

  `reasonCode` admite `CLOSE_ERROR`, `OMITTED_TRANSACTION`,
  `PREMATURE_CLOSE`, `ACCOUNTING_CORRECTION` y `OTHER`; `reason` admite de 10 a
  500 caracteres.
- `POST /api/accounting/fiscal-year-reopen-requests/{requestId}/approve`:
  requiere `Accounting.ApproveExerciseReopenings`, un aprobador diferente y
  vuelve a ejecutar el preflight. Crea contraasientos enlazados, reabre el
  origen y marca el sucesor `REVERSED` en una transaccion. Requiere CSRF e
  `Idempotency-Key`.
- `POST /api/accounting/fiscal-year-reopen-requests/{requestId}/cancel`:
  cancela una solicitud pendiente solo para quien la creo. Requiere
  `Accounting.RequestExerciseReopenings`, CSRF e `Idempotency-Key`.
- `POST /api/accounting/fiscal-year-reopen-requests/{requestId}/reject`:
  rechaza una solicitud pendiente sin modificar ejercicios ni asientos. Requiere
  `Accounting.ApproveExerciseReopenings`, checker distinto del solicitante, JSON,
  CSRF e `Idempotency-Key`. Body: `{ "reason": "Motivo entre 10 y 500 caracteres" }`.

Cada solicitud caduca siete dias despues de `requestedAt`. La primera lectura o
mutacion posterior materializa `EXPIRED` transaccionalmente, la audita como
`SYSTEM` y permite registrar otra solicitud para el mismo cierre. El panel de
historial consulta todos los ciclos de los ejercicios visibles y no depende del
limite de 50 elementos de la lista global.

La solicitud conserva el preflight inicial como evidencia. La aprobacion vuelve
a ejecutar el preflight dentro de la transaccion de cierre y bajo bloqueo; el
snapshot inicial nunca autoriza por si solo la operacion.
Rechaza asientos descuadrados o incoherentes, lineas invalidas o cruzadas entre
ejercicios, documentos en borrador o sin asiento, facturas con VeriFactu no
resuelto, devoluciones pendientes, saldos no soportados de grupos 0/8/9 y la
ausencia de una cuenta `129000000` activa e imputable cuando sea necesaria.
Los productores de borradores y devoluciones pendientes usan la misma barrera
del ejercicio, evitando inserciones concurrentes que pudieran escapar al
preflight.

Respuestas de conflicto especificas:

| Estado | Codigo | Significado |
|---|---|---|
| `409` | `FISCAL_YEAR_CLOSE_PRECONDITIONS_FAILED` | El cuerpo incluye el informe `preflight` con los bloqueos detectados. |
| `409` | `FISCAL_YEAR_CLOSE_ACTIVE_REQUEST_EXISTS` | Ya existe una solicitud pendiente para el ejercicio. |
| `404` | `FISCAL_YEAR_CLOSE_REQUEST_NOT_FOUND` | La solicitud no existe en la empresa activa. |
| `409` | `FISCAL_YEAR_CLOSE_REQUEST_NOT_PENDING` | La solicitud ya fue completada o cancelada. |
| `409` | `FISCAL_YEAR_CLOSE_SELF_APPROVAL_FORBIDDEN` | Solicitante y aprobador son la misma persona. |
| `409` | `FISCAL_YEAR_CLOSE_REQUEST_NOT_CANCELLABLE` | No esta pendiente o quien cancela no es el solicitante. |
| `409` | `FISCAL_YEAR_CLOSE_APPROVAL_REQUIRED` | El endpoint directo esta deshabilitado. |
| `409` | `NEXT_FISCAL_YEAR_ALREADY_EXISTS` | El siguiente ejercicio ya existe y no se modifica. |
| `409` | `FISCAL_YEAR_NOT_OPEN` | El ejercicio ya no esta abierto. |
| `409` | `IDEMPOTENCY_KEY_REUSED` | La clave pertenece a otra solicitud o su respuesta ya no es recuperable. |

Conflictos especificos de reapertura:

| Estado | Codigo | Significado |
|---|---|---|
| `404` | `FISCAL_YEAR_CLOSE_REQUEST_NOT_FOUND` | El cierre no existe en la empresa activa. |
| `409` | `FISCAL_YEAR_CLOSE_REQUEST_NOT_COMPLETED` | El cierre no esta completado o carece de evidencia relacional. |
| `409` | `FISCAL_YEAR_CLOSE_ALREADY_REOPENED` | La solicitud de cierre ya fue reabierta. |
| `409` | `FISCAL_YEAR_REOPEN_ACTIVE_REQUEST_EXISTS` | Ya existe una reapertura pendiente para ese cierre. |
| `404` | `FISCAL_YEAR_REOPEN_REQUEST_NOT_FOUND` | La solicitud de reapertura no existe. |
| `409` | `FISCAL_YEAR_REOPEN_REQUEST_NOT_PENDING` | La solicitud ya alcanzo un estado terminal. |
| `409` | `FISCAL_YEAR_REOPEN_SELF_APPROVAL_FORBIDDEN` | Solicitante y aprobador son la misma persona. |
| `409` | `FISCAL_YEAR_REOPEN_SELF_REJECTION_FORBIDDEN` | Solicitante y rechazador son la misma persona. |
| `409` | `FISCAL_YEAR_REOPEN_REQUEST_EXPIRED` | La solicitud caduco y debe registrarse una nueva. |
| `409` | `FISCAL_YEAR_REOPEN_REQUEST_NOT_CANCELLABLE` | No esta pendiente o quien cancela no es el solicitante. |
| `409` | `FISCAL_YEAR_REOPEN_PRECONDITIONS_FAILED` | El cuerpo incluye el `preflight` y no se modifica la contabilidad. |

## 2. `GET /api/accounting/accounts`

Permiso requerido: `Accounting.View`.

Query params:

| Parametro | Uso |
|---|---|
| `limit` | Maximo `100`. Por defecto `50`. |
| `cursor` | UUID de la ultima cuenta recibida. |
| `status` | `ACTIVE` o `INACTIVE`. |
| `search` | Busqueda por codigo o nombre. |

Respuesta `200`: listado paginado de cuentas.

## 3. `POST /api/accounting/accounts`

Permiso requerido: `Accounting.ManageEntries`.

Requiere CSRF e `Idempotency-Key`.

Body:

```json
{
  "code": "572000001",
  "name": "Banco operativo",
  "type": "Activo corriente",
  "level": 9,
  "isPostable": true
}
```

Reglas:

- El codigo es unico.
- Las cuentas imputables deben tener nueve digitos.
- Las cuentas no imputables pueden representar niveles superiores.

Audita `ACCOUNTING_ACCOUNT_CREATED`.

## 4. `GET /api/accounting/journal-entries`

Permiso requerido: `Accounting.View`.

Query params:

| Parametro | Uso |
|---|---|
| `limit` | Maximo `100`. Por defecto `25`. |
| `cursor` | UUID del ultimo asiento recibido. |
| `year` | Ejercicio opcional. |

Respuesta `200`: diario paginado de asientos vigentes.

Audita `ACCOUNTING_JOURNAL_VIEWED`.

## 5. `POST /api/accounting/journal-entries`

Permiso requerido: `Accounting.ManageEntries`.

Requiere CSRF e `Idempotency-Key`.

Body:

```json
{
  "accountingDate": "2026-07-10",
  "concept": "Ingreso manual",
  "lines": [
    {
      "accountId": "uuid",
      "concept": "Banco",
      "debit": "121.00",
      "credit": "0.00"
    },
    {
      "accountId": "uuid",
      "concept": "Ingreso",
      "debit": "0.00",
      "credit": "121.00"
    }
  ]
}
```

Reglas:

- Debe existir al menos una linea al debe y una al haber.
- Cada linea usa solo debe o haber.
- La suma del debe debe coincidir con la suma del haber.
- Todas las cuentas deben estar activas y ser imputables.
- La numeracion sigue `{AAAA}/{correlativo}` por ejercicio.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `409` | `ACCOUNT_CODE_ALREADY_EXISTS` | Codigo de cuenta duplicado. |
| `409` | `ACCOUNT_NOT_POSTABLE_CODE` | Cuenta imputable sin nueve digitos. |
| `409` | `ACCOUNT_NOT_POSTABLE` | Linea con cuenta no imputable o inactiva. |
| `409` | `JOURNAL_ENTRY_NOT_BALANCED` | Asiento descuadrado o linea invalida. |

Audita `ACCOUNTING_JOURNAL_ENTRY_CREATED` sin copiar conceptos de linea.

## 6. `GET /api/accounting/journal-entries/export`

Permiso requerido: `Accounting.View`.

Query params:

| Parametro | Uso |
|---|---|
| `limit` | Maximo `1000`. Por defecto `1000`. |
| `year` | Ejercicio opcional. |

Respuesta `200`: CSV `text/csv; charset=utf-8` con BOM, una fila por linea
contable, cabeceras estables y descarga privada sin cache.

Columnas:

- `numero`
- `ejercicio`
- `fecha_contable`
- `estado`
- `concepto_asiento`
- `linea`
- `cuenta`
- `nombre_cuenta`
- `concepto_linea`
- `debe`
- `haber`

Audita `ACCOUNTING_JOURNAL_EXPORTED`.
