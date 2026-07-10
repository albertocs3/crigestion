# Contratos HTTP de Tesoreria

## 1. Primer Corte

El primer corte de Tesoreria implementa registro manual de cobros de clientes,
devoluciones manuales sobre cobros registrados de facturas emitidas y el ciclo
basico de remesas de cobro.

Incluye:

- Registrar cobros parciales o completos.
- Registrar devoluciones parciales o completas de cobros.
- Actualizar el estado del vencimiento.
- Recalcular el estado de cobro de la factura.
- Crear borradores de remesa, generar XML SEPA CORE basico y descargarlo.
- Procesar manualmente remesas para registrar cobros `SEPA_REMITTANCE`.
- Auditar la operacion sin datos sensibles.

Fuera del primer corte:

- Envio bancario, importacion de respuestas bancarias y conciliacion de remesas.
- Conciliacion bancaria.
- Asientos contables automaticos.
- Previsiones de tesoreria.

## 2. Convenciones

- Base inicial de cobros: `/api/invoices/{invoiceId}/payments`.
- Base inicial de devoluciones: `/api/invoices/{invoiceId}/payment-returns`.
- Base inicial de vencimientos: `/api/treasury/customer-due-dates`.
- Exportacion de vencimientos: `/api/treasury/customer-due-dates/export`.
- Prevision mensual de cobros: `/api/treasury/customer-collection-forecast`.
- Exportacion de prevision: `/api/treasury/customer-collection-forecast/export`.
- Base inicial de remesas: `/api/treasury/customer-remittances`.
- Exportacion de remesas: `/api/treasury/customer-remittances/export`.
- Generacion XML SEPA: `/api/treasury/customer-remittances/{remittanceId}/generate-sepa`.
- Marcado de remesa enviada: `/api/treasury/customer-remittances/{remittanceId}/mark-sent`.
- Rechazo manual de remesa enviada: `/api/treasury/customer-remittances/{remittanceId}/reject`.
- Respuesta bancaria manual por lineas: `/api/treasury/customer-remittances/{remittanceId}/settle-bank-response`.
- Importacion CSV controlada de respuesta bancaria: `/api/treasury/customer-remittances/{remittanceId}/import-bank-response-csv`.
- Descarga XML SEPA: `/api/treasury/customer-remittances/{remittanceId}/sepa-file`.
- Autenticacion obligatoria con sesion web.
- Las mutaciones validan `Origin`, token CSRF y modo mantenimiento.
- Las mutaciones requieren `Idempotency-Key`.
- Las respuestas son DTOs; no se exponen modelos Prisma.
- La auditoria no incluye NIF, IBAN, notas completas ni referencias bancarias
  sensibles.

## 3. Permisos

| Permiso | Uso |
|---|---|
| `Treasury.ManagePayments` | Consultar vencimientos y registrar cobros/devoluciones manuales de clientes. |

El administrador protegido recibe este permiso en el seed inicial.

## 4. `GET /api/treasury/customer-due-dates`

Permiso requerido: `Treasury.ManagePayments`.

Query params:

| Parametro | Uso |
|---|---|
| `limit` | Tamano de pagina. Maximo 100. Por defecto 25. |
| `cursor` | UUID del ultimo vencimiento recibido. |
| `scope` | `OPEN`, `ALL`, `PENDING`, `PAID`, `RETURNED` o `UNPAID`. Por defecto `OPEN`. |
| `customerId` | Filtro por cliente. |
| `dueFrom`, `dueTo` | Rango de fecha de vencimiento, formato `AAAA-MM-DD`. |
| `search` | Busqueda por numero de factura, codigo o nombre de cliente. |

Reglas:

- Solo muestra vencimientos de facturas emitidas.
- `OPEN` excluye vencimientos `PAID`.
- Los importes se devuelven como cadenas decimales con dos posiciones.
- `paidAmount` es neto: cobros menos devoluciones.
- `pendingAmount` es el importe del vencimiento menos el cobro neto.

Respuesta `200`:

```json
{
  "dueDates": [
    {
      "id": "uuid",
      "invoiceId": "uuid",
      "invoiceNumber": "F2600001",
      "invoiceSeries": "F",
      "invoiceYear": 2026,
      "customer": {
        "id": "uuid",
        "code": "C-0001",
        "legalName": "Cliente SL"
      },
      "issueDate": "2026-07-07",
      "dueDate": "2026-08-06",
      "amount": "121.00",
      "paidAmount": "100.00",
      "returnedAmount": "21.00",
      "pendingAmount": "21.00",
      "paymentMethod": "BANK_TRANSFER",
      "status": "PENDING",
      "paymentStatus": "PARTIALLY_PAID"
    }
  ],
  "summary": {
    "count": 1,
    "totalAmount": "121.00",
    "paidAmount": "100.00",
    "returnedAmount": "21.00",
    "pendingAmount": "21.00"
  },
  "nextCursor": null
}
```

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `401` | `UNAUTHENTICATED` | No hay sesion valida. |
| `403` | `FORBIDDEN` | La sesion no tiene permiso. |
| `422` | `VALIDATION_ERROR` | Filtros invalidos. |

Audita `CUSTOMER_DUE_DATES_VIEWED` con filtros, paginacion,
`resultCount` y `actorUserId`.

## 5. `GET /api/treasury/customer-due-dates/export`

Permiso requerido: `Treasury.ManagePayments`.

Query params:

| Parametro | Uso |
|---|---|
| `limit` | Maximo 1000. Por defecto 1000. |
| `scope` | `OPEN`, `ALL`, `PENDING`, `PAID`, `RETURNED` o `UNPAID`. Por defecto `OPEN`. |
| `customerId` | Filtro por cliente. |
| `dueFrom`, `dueTo` | Rango de fecha de vencimiento, formato `AAAA-MM-DD`. |
| `search` | Busqueda por numero de factura, codigo o nombre de cliente. |

Respuesta `200`: `text/csv; charset=utf-8` con `Content-Disposition`
`attachment`.

Columnas:

- `vencimiento`.
- `fecha_emision`.
- `factura`.
- `serie`.
- `ejercicio`.
- `cliente_codigo`.
- `cliente_nombre`.
- `metodo`.
- `estado_vencimiento`.
- `estado_factura`.
- `importe`.
- `cobrado_neto`.
- `devuelto`.
- `pendiente`.

Reglas:

- Respeta los mismos filtros que la consulta de vencimientos.
- No exporta notas internas, NIF, IBAN ni datos bancarios completos.
- Protege celdas de texto que podrian interpretarse como formulas al abrir el
  CSV en una hoja de calculo.
- Devuelve `Cache-Control: private, no-store`.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `401` | `UNAUTHENTICATED` | No hay sesion valida. |
| `403` | `FORBIDDEN` | La sesion no tiene permiso. |
| `422` | `VALIDATION_ERROR` | Filtros invalidos. |

Audita `CUSTOMER_DUE_DATES_EXPORTED` con filtros, limite, `resultCount` y
`actorUserId`.

## 6. `GET /api/treasury/customer-collection-forecast`

Permiso requerido: `Treasury.ManagePayments`.

Query params:

| Parametro | Uso |
|---|---|
| `year` | Ejercicio a proyectar. Por defecto, ejercicio actual. |
| `asOf` | Fecha de referencia en formato `AAAA-MM-DD`. Por defecto, hoy. |
| `customerId` | Filtro opcional por cliente. |
| `search` | Busqueda por factura, codigo o nombre de cliente. |
| `limit` | Maximo de vencimientos considerados. Por defecto y maximo `500`. |

Reglas:

- Considera vencimientos de facturas emitidas con saldo pendiente.
- Excluye vencimientos pagados completamente.
- Los vencimientos anteriores a `asOf` se agrupan en el mes de `asOf` como
  atrasados.
- No modifica vencimientos, facturas ni cobros.
- No devuelve notas internas, NIF, IBAN ni datos bancarios completos.

Respuesta `200`:

```json
{
  "year": 2026,
  "asOf": "2026-07-10",
  "summary": {
    "itemCount": 2,
    "expectedAmount": "222.00",
    "overdueAmount": "101.00"
  },
  "months": [
    {
      "month": 7,
      "itemCount": 1,
      "expectedAmount": "101.00",
      "overdueAmount": "101.00"
    }
  ],
  "items": [
    {
      "dueDateId": "uuid",
      "invoiceId": "uuid",
      "invoiceNumber": "F2600001",
      "forecastMonth": 7,
      "pendingAmount": "101.00",
      "overdue": true
    }
  ]
}
```

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `401` | `UNAUTHENTICATED` | No hay sesion valida. |
| `403` | `FORBIDDEN` | La sesion no tiene permiso. |
| `422` | `VALIDATION_ERROR` | Filtros invalidos. |

Audita `CUSTOMER_COLLECTION_FORECAST_VIEWED` con ejercicio, fecha de
referencia, filtros, limite, `resultCount` y `actorUserId`.

## 7. `GET /api/treasury/customer-collection-forecast/export`

Permiso requerido: `Treasury.ManagePayments`.

Acepta los mismos filtros que
`GET /api/treasury/customer-collection-forecast`.

Respuesta `200`: CSV con cabecera:

```csv
"ejercicio","referencia","mes_previsto","vencimiento","factura","cliente_codigo","cliente_nombre","estado_vencimiento","estado_factura","importe","cobrado_neto","pendiente","atrasado"
```

Reglas:

- Respeta los mismos filtros que la consulta.
- Aplica neutralizacion CSV para valores que puedan interpretarse como formula.
- No exporta notas internas, NIF, IBAN ni datos bancarios completos.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `401` | `UNAUTHENTICATED` | No hay sesion valida. |
| `403` | `FORBIDDEN` | La sesion no tiene permiso. |
| `422` | `VALIDATION_ERROR` | Filtros invalidos. |

Audita `CUSTOMER_COLLECTION_FORECAST_EXPORTED` con ejercicio, fecha de
referencia, filtros, limite, `resultCount` y `actorUserId`.

## 8. `GET /api/treasury/customer-remittances`

Permiso requerido: `Treasury.ManagePayments`.

Query params:

| Parametro | Uso |
|---|---|
| `limit` | Maximo `100`. Por defecto `25`. |
| `cursor` | UUID de la ultima remesa recibida. |
| `status` | Estado opcional de remesa. |
| `year` | Ejercicio opcional. |

Respuesta `200`: listado paginado de remesas de cobro con sus lineas, sin IBAN
ni datos bancarios completos.

Audita `CUSTOMER_REMITTANCES_VIEWED`.

## 9. `GET /api/treasury/customer-remittances/export`

Permiso requerido: `Treasury.ManagePayments`.

Query params:

| Parametro | Uso |
|---|---|
| `limit` | Maximo `1000`. Por defecto `1000`. |
| `status` | Estado opcional de remesa. |
| `year` | Ejercicio opcional. |

Respuesta `200`: `text/csv; charset=utf-8` con `Content-Disposition`
`attachment`.

Columnas:

- `remesa`.
- `ejercicio`.
- `secuencia`.
- `estado`.
- `fecha_cargo`.
- `concepto_remesa`.
- `total_remesa`.
- `lineas_remesa`.
- `linea`.
- `factura`.
- `cliente_codigo`.
- `cliente_nombre`.
- `vencimiento`.
- `importe_linea`.
- `cobrado_linea`.
- `devuelto_linea`.
- `neto_linea`.
- `concepto_linea`.
- `mandato`.

Reglas:

- Respeta filtros por estado y ejercicio.
- No exporta IBAN ni datos bancarios completos.
- Los importes cobrados, devueltos y netos se calculan desde cobros de origen
  `SEPA_REMITTANCE` vinculados a la referencia de la remesa.
- Protege celdas de texto que podrian interpretarse como formulas al abrir el
  CSV en una hoja de calculo.
- Devuelve `Cache-Control: private, no-store`.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `401` | `UNAUTHENTICATED` | No hay sesion valida. |
| `403` | `FORBIDDEN` | La sesion no tiene permiso. |
| `422` | `VALIDATION_ERROR` | Filtros invalidos. |

Audita `CUSTOMER_REMITTANCES_EXPORTED` con filtros, limite, `resultCount`,
`lineCount` y `actorUserId`.

## 10. `POST /api/treasury/customer-remittances`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Body:

```json
{
  "chargeDate": "2026-07-15",
  "concept": "Remesa julio",
  "dueDateIds": ["uuid"]
}
```

Reglas:

- Crea una remesa en estado `DRAFT`.
- Solo admite vencimientos de facturas emitidas.
- Solo admite vencimientos `PENDING`, con saldo pendiente y forma de pago
  `DIRECT_DEBIT`.
- El cliente debe estar activo, tener IBAN y mandato SEPA activo.
- Un vencimiento no puede pertenecer a otra linea activa de remesa.
- No genera XML, no marca enviada y no registra cobros en este corte.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `409` | `REMITTANCE_DUE_DATE_NOT_ELIGIBLE` | Vencimiento no remesable. |
| `409` | `REMITTANCE_DUE_DATE_ALREADY_INCLUDED` | Vencimiento ya incluido en remesa activa. |

Audita `CUSTOMER_REMITTANCE_DRAFT_CREATED`.

## 11. `POST /api/treasury/customer-remittances/{remittanceId}/cancel`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Reglas:

- Solo cancela remesas en estado `DRAFT`.
- La remesa queda `CANCELLED`.
- Sus lineas activas quedan `CANCELLED`, liberando los vencimientos para otra
  remesa.
- No registra cobros ni modifica vencimientos o facturas.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_NOT_CANCELLABLE` | Remesa fuera de borrador. |

Audita `CUSTOMER_REMITTANCE_DRAFT_CANCELLED`.

## 12. `POST /api/treasury/customer-remittances/{remittanceId}/generate-sepa`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Reglas:

- Solo genera desde remesas `DRAFT`.
- Requiere lineas activas completas, IBAN deudor y mandato SEPA por linea.
- Requiere IBAN de cobro de empresa e identificador acreedor SEPA en Configuracion.
- Genera XML SEPA CORE basico `pain.008.001.02`.
- Guarda `sepaMessageId`, `sepaFileName`, `sepaFileSha256`, `sepaFormat`,
  `generatedAt` y el XML.
- La remesa queda `GENERATED`.
- La auditoria no incluye IBAN completo.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_NOT_GENERATABLE` | Remesa o configuracion incompleta. |

Audita `CUSTOMER_REMITTANCE_SEPA_GENERATED`.

## 13. `GET /api/treasury/customer-remittances/{remittanceId}/sepa-file`

Permiso requerido: `Treasury.ManagePayments`.

Reglas:

- Devuelve `application/xml; charset=utf-8`.
- Usa `Content-Disposition: attachment`.
- Incluye `Cache-Control: private, no-store`.
- Incluye `X-Content-Type-Options: nosniff`.
- Incluye `X-Remittance-SEPA-SHA256` con el hash guardado.
- No permite descargar remesas sin fichero generado.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_SEPA_FILE_NOT_FOUND` | Remesa sin fichero SEPA generado. |

Audita `CUSTOMER_REMITTANCE_SEPA_DOWNLOADED`.

## 14. `POST /api/treasury/customer-remittances/{remittanceId}/mark-sent`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Reglas:

- Solo marca como enviadas remesas `GENERATED` con fichero SEPA.
- La remesa queda `SENT`.
- Guarda `sentAt`.
- No crea cobros ni cambia vencimientos.
- La auditoria no incluye IBAN completo.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_NOT_SENDABLE` | Remesa sin fichero generado o fuera de estado. |

Audita `CUSTOMER_REMITTANCE_SENT`.

## 15. `POST /api/treasury/customer-remittances/{remittanceId}/reject`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Body:

```json
{
  "reason": "Banco rechaza el fichero por fecha de cargo"
}
```

Reglas:

- Solo rechaza remesas `SENT`.
- La remesa queda `REJECTED`.
- Guarda `rejectedAt` y `rejectionReason`.
- Cancela sus lineas activas para liberar los vencimientos pendientes.
- No crea cobros, devoluciones ni asientos.
- Conserva XML, nombre de fichero y hash.
- La auditoria no incluye el texto completo del motivo.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_NOT_REJECTABLE` | Remesa fuera de estado rechazable. |

Audita `CUSTOMER_REMITTANCE_REJECTED`.

## 16. `POST /api/treasury/customer-remittances/{remittanceId}/settle-bank-response`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Body:

```json
{
  "paymentDate": "2026-07-16",
  "paidLineIds": ["uuid-linea-cobrada"],
  "rejectedLineIds": ["uuid-linea-rechazada"],
  "rejectionReason": "Banco rechaza una linea"
}
```

Reglas:

- Solo liquida remesas `SENT`.
- La respuesta debe cubrir todas las lineas activas.
- Una linea no puede estar a la vez cobrada y rechazada.
- Las lineas cobradas crean cobros `SEPA_REMITTANCE`.
- Las lineas rechazadas se cancelan para liberar los vencimientos pendientes.
- Si todas las lineas cobran, la remesa queda `PROCESSED`.
- Si todas las lineas se rechazan, la remesa queda `REJECTED`.
- Si hay mezcla, la remesa queda `PARTIALLY_PROCESSED`.
- Las lineas rechazadas requieren `rejectionReason`.
- La auditoria no incluye el texto completo del motivo.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_BANK_RESPONSE_NOT_SETTLEABLE` | Respuesta fuera de estado o no cubre lineas activas. |

Audita `CUSTOMER_REMITTANCE_BANK_RESPONSE_SETTLED`.

## 17. `POST /api/treasury/customer-remittances/{remittanceId}/import-bank-response-csv`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Body:

```json
{
  "paymentDate": "2026-07-16",
  "csv": "linea,resultado,motivo\n1,COBRADA,\n2,RECHAZADA,Banco rechaza una linea"
}
```

Reglas:

- Solo importa respuestas para remesas `SENT`.
- Es un formato CSV controlado, no una importacion Norma 19 ni Norma 43.
- La cabecera debe incluir `linea` y `resultado`; `motivo` es opcional.
- `resultado` admite `COBRADA` o `RECHAZADA`.
- El CSV debe cubrir todas las lineas activas de la remesa.
- Las lineas rechazadas requieren `motivo`.
- La importacion delega en la misma liquidacion que la respuesta manual por lineas.
- La auditoria no incluye el texto completo de motivos.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_BANK_RESPONSE_NOT_SETTLEABLE` | Respuesta fuera de estado o no cubre lineas activas. |
| `422` | `REMITTANCE_BANK_RESPONSE_CSV_INVALID` | CSV sin cabecera valida, incompleto, duplicado o con resultados no admitidos. |

Audita `CUSTOMER_REMITTANCE_BANK_RESPONSE_SETTLED`.

## 18. `POST /api/treasury/customer-remittances/{remittanceId}/process`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Body:

```json
{
  "paymentDate": "2026-07-16"
}
```

Reglas:

- Procesa remesas en estado `DRAFT`, `GENERATED` o `SENT`.
- Registra un cobro `SEPA_REMITTANCE` por cada linea activa.
- Actualiza los estados del vencimiento y de la factura.
- La remesa queda `PROCESSED`.
- Si algun vencimiento ya no esta pendiente, la factura no esta emitida o el
  saldo pendiente no cubre la linea, la operacion se rechaza completa.
- No genera asientos contables automaticos en este corte.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_NOT_PROCESSABLE` | Remesa o vencimientos no procesables. |

Audita `CUSTOMER_REMITTANCE_PROCESSED`.

## 19. `POST /api/treasury/customer-remittances/{remittanceId}/close`

Permiso requerido: `Treasury.ManagePayments`.

Requiere CSRF e `Idempotency-Key`.

Reglas:

- Solo cierra remesas `PROCESSED`, `PARTIALLY_PROCESSED` o `PARTIALLY_RETURNED`.
- La remesa queda `CLOSED`.
- No crea, elimina ni modifica cobros, vencimientos o facturas.

Errores funcionales:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `REMITTANCE_NOT_FOUND` | Remesa inexistente. |
| `409` | `REMITTANCE_NOT_CLOSABLE` | Remesa fuera de estado cerrable. |

Audita `CUSTOMER_REMITTANCE_CLOSED`.

## 20. `POST /api/invoices/{invoiceId}/payments`

Permiso requerido: `Treasury.ManagePayments`.

Requiere `Idempotency-Key`.

Body:

```json
{
  "dueDateId": "uuid",
  "paymentDate": "2026-07-10",
  "amount": "60.00",
  "reference": "Transferencia 001",
  "notes": "Observaciones internas opcionales"
}
```

Reglas:

- La factura debe existir y estar `ISSUED`.
- El vencimiento debe pertenecer a la factura.
- El vencimiento no puede estar `PAID`, `RETURNED` ni `UNPAID`.
- El importe debe ser mayor que cero.
- El importe no puede superar el saldo pendiente del vencimiento.
- Un cobro parcial deja el vencimiento `PENDING` y la factura
  `PARTIALLY_PAID`.
- Al completar el vencimiento, queda `PAID`.
- Si la suma de cobros alcanza el total de la factura, la factura queda `PAID`.

Respuesta `201`: DTO de detalle de factura actualizado.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `INVOICE_NOT_FOUND` | La factura no existe. |
| `404` | `INVOICE_DUE_DATE_NOT_FOUND` | El vencimiento no existe para la factura. |
| `409` | `INVOICE_NOT_PAYABLE` | La factura no esta emitida. |
| `409` | `INVOICE_DUE_DATE_NOT_PAYABLE` | El vencimiento no admite nuevos cobros. |
| `409` | `PAYMENT_AMOUNT_EXCEEDS_PENDING` | El importe supera el saldo pendiente. |

Audita `CUSTOMER_PAYMENT_REGISTERED` con `paymentId`, `invoiceId`,
`dueDateId`, `customerId`, `amount`, `paymentDate`,
`resultingPaymentStatus`, `actorUserId` y `correlationId`.

## 21. `POST /api/invoices/{invoiceId}/payment-returns`

Permiso requerido: `Treasury.ManagePayments`.

Requiere `Idempotency-Key`.

Body:

```json
{
  "paymentId": "uuid",
  "returnDate": "2026-07-12",
  "amount": "21.00",
  "reasonCode": "BANK_RETURN",
  "notes": "Observaciones internas opcionales"
}
```

Reglas:

- La factura debe existir y estar `ISSUED`.
- El cobro debe pertenecer a la factura.
- El importe debe ser mayor que cero.
- El importe devuelto acumulado no puede superar el importe del cobro.
- Los saldos de vencimiento y factura se recalculan como cobros menos
  devoluciones.
- Una devolucion parcial deja el vencimiento `PENDING`.
- Una devolucion completa de todo el saldo cobrado deja el vencimiento
  `RETURNED` y la factura vuelve a `PENDING` si no queda importe neto cobrado.
- Si el cobro devuelto procede de una remesa SEPA, la remesa relacionada queda
  `PARTIALLY_RETURNED`. Si ya estaba parcialmente devuelta, conserva ese estado.

Respuesta `201`: DTO de detalle de factura actualizado.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `INVOICE_NOT_FOUND` | La factura no existe. |
| `404` | `CUSTOMER_PAYMENT_NOT_FOUND` | El cobro no existe para la factura. |
| `409` | `INVOICE_NOT_PAYABLE` | La factura no esta emitida. |
| `409` | `PAYMENT_RETURN_AMOUNT_EXCEEDS_PAYMENT` | La devolucion supera el importe no devuelto del cobro. |

Audita `CUSTOMER_PAYMENT_RETURNED` con `paymentReturnId`, `paymentId`,
`invoiceId`, `dueDateId`, `customerId`, `amount`, `returnDate`,
`resultingPaymentStatus`, `actorUserId` y `correlationId`. Cuando aplica a una
remesa SEPA, incluye `remittanceId`, `remittanceNumber` y
`previousRemittanceStatus`, y audita el cambio de remesa con
`CUSTOMER_REMITTANCE_PARTIALLY_RETURNED`.

## 22. `POST /api/invoices/{invoiceId}/unpaid-due-dates`

Permiso requerido: `Treasury.ManagePayments`.

Requiere `Idempotency-Key`.

Body:

```json
{
  "dueDateId": "uuid",
  "unpaidDate": "2026-07-20",
  "reasonCode": "BANK_DEFAULT",
  "notes": "Observaciones internas opcionales"
}
```

Reglas:

- La factura debe existir y estar `ISSUED`.
- El vencimiento debe pertenecer a la factura.
- El vencimiento debe estar `PENDING` y tener saldo pendiente.
- El vencimiento queda `UNPAID`.
- La factura queda con estado de cobro `UNPAID`.
- No se eliminan cobros ni devoluciones previas.
- Un vencimiento `UNPAID` no admite nuevos cobros ordinarios en este corte.

Respuesta `201`: DTO de detalle de factura actualizado.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `INVOICE_NOT_FOUND` | La factura no existe. |
| `404` | `INVOICE_DUE_DATE_NOT_FOUND` | El vencimiento no existe para la factura. |
| `409` | `INVOICE_NOT_PAYABLE` | La factura no esta emitida. |
| `409` | `INVOICE_DUE_DATE_NOT_UNPAIDABLE` | El vencimiento no admite registro de impago. |

Audita `CUSTOMER_DUE_DATE_MARKED_UNPAID` con `invoiceId`, `dueDateId`,
`customerId`, `unpaidDate`, `reasonCode`, `pendingAmount`,
`resultingPaymentStatus`, `actorUserId` y `correlationId`. Las observaciones
internas no se auditan.
