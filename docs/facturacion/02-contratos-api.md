# Contratos HTTP de Facturacion

## 1. Primer Corte MVP

El primer corte implementara facturas ordinarias manuales.

Incluye:

- Crear y editar borradores.
- Lineas manuales o desde catalogo.
- Calculo de base, IVA y total.
- Vencimiento inicial calculado desde condiciones del cliente.
- Emision con numero definitivo correlativo.
- Consulta de facturas emitidas en solo lectura.

Fuera del primer corte:

- Presupuestos.
- Facturas rectificativas.
- Cobros, devoluciones, anticipos y remesas SEPA.
- PDF definitivo.
- Envio por correo.
- Envio VeriFactu real.
- Facturas generadas por suscripciones.

## 2. Convenciones

- Base: `/api/invoices`.
- Autenticacion obligatoria con sesion web.
- Las mutaciones validan `Origin`, token CSRF y modo mantenimiento.
- Las respuestas son DTOs; no se exponen modelos Prisma.
- Las mutaciones que crean efectos de negocio requieren `Idempotency-Key`.
- Los eventos de auditoria no incluyen NIF, direccion fiscal completa, email,
  IBAN, observaciones completas ni textos largos de lineas.

## 3. Permisos

| Permiso | Uso |
|---|---|
| `Billing.View` | Consultar facturas y detalle. |
| `Billing.ManageDrafts` | Crear y modificar borradores. |
| `Billing.Issue` | Emitir facturas ordinarias. |

## 4. `GET /api/invoices`

Permiso requerido: `Billing.View`.

Query:

| Parametro | Tipo | Uso |
|---|---|---|
| `limit` | entero 1-100 | Tamano de pagina. Por defecto 25. |
| `cursor` | UUID | Cursor de paginacion. |
| `status` | `DRAFT`, `ISSUED`, `RECTIFIED` o `VOIDED` | Filtro documental. |
| `paymentStatus` | `PENDING`, `PARTIALLY_PAID`, `PAID` o `UNPAID` | Filtro de cobro. |
| `customerId` | UUID | Filtro por cliente. |
| `issuedFrom` | fecha `YYYY-MM-DD` | Fecha de expedicion desde. |
| `issuedTo` | fecha `YYYY-MM-DD` | Fecha de expedicion hasta. |
| `search` | texto 1-120 | Busca por numero, cliente o codigo de cliente. |

Respuesta `200`:

```json
{
  "invoices": [
    {
      "id": "uuid",
      "status": "ISSUED",
      "number": "F2600001",
      "series": "F",
      "year": 2026,
      "customer": {
        "id": "uuid",
        "code": "1",
        "legalName": "Cliente Demo SL"
      },
      "issueDate": "2026-07-07",
      "operationDate": "2026-07-07",
      "paymentStatus": "PENDING",
      "verifactuStatus": "PENDING",
      "total": "121.00",
      "createdAt": "2026-07-07T08:00:00.000Z",
      "updatedAt": "2026-07-07T08:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Audita `INVOICES_VIEWED` con filtros seguros y recuento.

## 5. `POST /api/invoices`

Permiso requerido: `Billing.ManageDrafts`.

Requiere `Idempotency-Key`.

Body:

```json
{
  "customerId": "uuid",
  "issueDate": "2026-07-07",
  "operationDate": "2026-07-07",
  "notes": "Observaciones internas opcionales"
}
```

Reglas:

- El cliente debe existir y estar `ACTIVE`.
- El cliente debe tener identificacion fiscal y direccion fiscal minima.
- Se copia una instantanea fiscal editable mientras el documento esta en
  borrador.
- El borrador nace sin numero definitivo.
- El estado de cobro inicial es `PENDING`.
- El estado VeriFactu inicial es `NOT_APPLICABLE` hasta la emision del MVP.

Respuesta `201`: DTO de detalle de factura.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CUSTOMER_NOT_FOUND` | El cliente no existe. |
| `409` | `CUSTOMER_NOT_ACTIVE` | El cliente no esta activo. |
| `422` | `CUSTOMER_FISCAL_DATA_INCOMPLETE` | Faltan datos fiscales minimos. |

Audita `INVOICE_DRAFT_CREATED` con `invoiceId`, `customerId` y `correlationId`.

## 6. `GET /api/invoices/{invoiceId}`

Permiso requerido: `Billing.View`.

Respuesta `200`: DTO de detalle.

```json
{
  "invoice": {
    "id": "uuid",
    "status": "DRAFT",
    "number": null,
    "series": "F",
    "year": 2026,
    "customerId": "uuid",
    "customerSnapshot": {
      "legalName": "Cliente Demo SL",
      "taxId": "B12345678",
      "fiscalAddress": {
        "line1": "Calle Demo 1",
        "postalCode": "28001",
        "city": "Madrid",
        "province": "Madrid",
        "country": "ES"
      }
    },
    "lines": [],
    "taxSummary": [],
    "dueDates": [],
    "totals": {
      "taxableBase": "0.00",
      "taxAmount": "0.00",
      "total": "0.00"
    }
  }
}
```

Audita `INVOICE_VIEWED`.

## 7. `PATCH /api/invoices/{invoiceId}`

Permiso requerido: `Billing.ManageDrafts`.

Body parcial:

```json
{
  "customerId": "uuid",
  "issueDate": "2026-07-07",
  "operationDate": "2026-07-07",
  "notes": "Observaciones internas opcionales"
}
```

Reglas:

- Solo se pueden modificar facturas `DRAFT`.
- Cambiar cliente refresca la instantanea fiscal desde el cliente actual.
- Recalcula vencimiento y totales derivados si procede.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `INVOICE_NOT_FOUND` | La factura no existe. |
| `409` | `INVOICE_NOT_EDITABLE` | La factura no esta en borrador. |
| `422` | `CUSTOMER_FISCAL_DATA_INCOMPLETE` | Faltan datos fiscales minimos. |

Audita `INVOICE_DRAFT_UPDATED` con `changedFields`.

## 8. `POST /api/invoices/{invoiceId}/lines`

Permiso requerido: `Billing.ManageDrafts`.

Body para linea de catalogo:

```json
{
  "catalogItemId": "uuid",
  "description": "Servicio mensual",
  "quantity": "1.000",
  "unitPrice": "49.90",
  "discountPercent": "0.00",
  "discountAmount": "0.00",
  "taxRateId": "uuid"
}
```

Body para linea manual:

```json
{
  "description": "Concepto manual",
  "quantity": "1.000",
  "unitPrice": "49.90",
  "discountPercent": "0.00",
  "discountAmount": "0.00",
  "taxRateId": "uuid"
}
```

Reglas:

- Solo se pueden anadir lineas a facturas `DRAFT`.
- Si `catalogItemId` se informa, debe apuntar a un elemento `ACTIVE`.
- El tipo de IVA debe estar `ACTIVE`.
- Se copian codigo, nombre, tipo, precio e IVA vigentes a la linea.
- Los importes se calculan con `Decimal` y redondeo monetario por linea.
- Descuentos porcentual e importe fijo pueden coexistir, aplicandose primero el
  porcentaje y despues el importe fijo.

Respuesta `201`: DTO de detalle actualizado.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `INVOICE_NOT_FOUND` | La factura no existe. |
| `409` | `INVOICE_NOT_EDITABLE` | La factura no esta en borrador. |
| `422` | `CATALOG_ITEM_NOT_FOUND` | El elemento no existe o no esta activo. |
| `422` | `CATALOG_TAX_RATE_NOT_FOUND` | El tipo de IVA no existe o no esta activo. |

Audita `INVOICE_LINE_CREATED`.

## 9. `PATCH /api/invoices/{invoiceId}/lines/{lineId}`

Permiso requerido: `Billing.ManageDrafts`.

Body parcial:

```json
{
  "description": "Servicio mensual actualizado",
  "quantity": "2.000",
  "unitPrice": "49.90",
  "discountPercent": "10.00",
  "discountAmount": "0.00",
  "taxRateId": "uuid"
}
```

Reglas:

- Solo se pueden modificar lineas de facturas `DRAFT`.
- Recalcula la linea, resumen de impuestos, vencimientos y totales.

Audita `INVOICE_LINE_UPDATED`.

## 10. `DELETE /api/invoices/{invoiceId}/lines/{lineId}`

Permiso requerido: `Billing.ManageDrafts`.

Reglas:

- Solo se pueden eliminar lineas de facturas `DRAFT`.
- Recalcula resumen de impuestos, vencimientos y totales.

Respuesta `200`: DTO de detalle actualizado.

Audita `INVOICE_LINE_DELETED`.

## 11. `POST /api/invoices/{invoiceId}/issue`

Permiso requerido: `Billing.Issue`.

Requiere `Idempotency-Key`.

Body:

```json
{
  "issueDate": "2026-07-07"
}
```

Reglas:

- Solo se emiten facturas `DRAFT`.
- Debe existir al menos una linea.
- El total debe ser mayor o igual que cero en facturas ordinarias del MVP.
- Se valida de nuevo el cliente y la instantanea fiscal minima.
- Se asigna numero definitivo en una transaccion.
- La numeracion usa serie `F`, ano de `issueDate` y correlativo sin huecos por
  rollback.
- No se permite emitir con fecha anterior a la ultima factura emitida de la
  serie si rompe el orden cronologico.
- Tras emitir, la factura queda bloqueada.
- Se crea placeholder de registro VeriFactu con estado `PENDING`, sin envio real.

Respuesta `200`: DTO de detalle emitido.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `INVOICE_NOT_FOUND` | La factura no existe. |
| `409` | `INVOICE_NOT_ISSUABLE` | La factura no esta en estado emitible. |
| `409` | `INVOICE_EMPTY` | No tiene lineas. |
| `409` | `INVOICE_CHRONOLOGY_VIOLATION` | Rompe el orden cronologico de la serie. |
| `422` | `CUSTOMER_FISCAL_DATA_INCOMPLETE` | Faltan datos fiscales minimos. |

Audita `INVOICE_ISSUED` con `invoiceId`, `number`, `customerId`, `total`,
`actorUserId` y `correlationId`.

## 12. Bloqueo por Mantenimiento

Todas las mutaciones anteriores devuelven `423 MAINTENANCE_MODE_ACTIVE` si la
plataforma esta en mantenimiento. Las consultas siguen permitidas para soporte
operativo.
