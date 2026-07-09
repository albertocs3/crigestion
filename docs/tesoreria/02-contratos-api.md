# Contratos HTTP de Tesoreria

## 1. Primer Corte

El primer corte de Tesoreria implementa registro manual de cobros de clientes
y devoluciones manuales sobre cobros registrados de facturas emitidas.

Incluye:

- Registrar cobros parciales o completos.
- Registrar devoluciones parciales o completas de cobros.
- Actualizar el estado del vencimiento.
- Recalcular el estado de cobro de la factura.
- Auditar la operacion sin datos sensibles.

Fuera del primer corte:

- Remesas SEPA.
- Conciliacion bancaria.
- Asientos contables automaticos.
- Previsiones de tesoreria.

## 2. Convenciones

- Base inicial de cobros: `/api/invoices/{invoiceId}/payments`.
- Base inicial de devoluciones: `/api/invoices/{invoiceId}/payment-returns`.
- Base inicial de vencimientos: `/api/treasury/customer-due-dates`.
- Exportacion de vencimientos: `/api/treasury/customer-due-dates/export`.
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

## 6. `POST /api/invoices/{invoiceId}/payments`

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
- El vencimiento no puede estar `PAID` ni `RETURNED`.
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

## 7. `POST /api/invoices/{invoiceId}/payment-returns`

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
`resultingPaymentStatus`, `actorUserId` y `correlationId`.
