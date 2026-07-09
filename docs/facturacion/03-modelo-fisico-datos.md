# Modelo Fisico de Datos de Facturacion

## 1. Primer Corte MVP

El primer corte implementa facturas ordinarias manuales con lineas, resumen de
impuestos, vencimiento inicial, numeracion definitiva al emitir y descarga PDF
regenerada para facturas emitidas. No incluye presupuestos, rectificativas,
cobros, envios por correo, remesas SEPA ni envio VeriFactu real.

## 2. Enumerados

- `InvoiceDocumentType`: `STANDARD`.
- `InvoiceDocumentStatus`: `DRAFT`, `ISSUED`, `RECTIFIED`, `VOIDED`.
- `InvoicePaymentStatus`: `PENDING`, `PARTIALLY_PAID`, `PAID`, `UNPAID`.
- `InvoiceVerifactuStatus`: `NOT_APPLICABLE`, `PENDING`, `SENT`, `ACCEPTED`,
  `ACCEPTED_WITH_ERRORS`, `REJECTED`.
- `InvoiceOrigin`: `MANUAL`, `SUBSCRIPTION`.

En el MVP solo se crean `STANDARD` y `MANUAL`.

## 3. Tabla `invoice_number_sequences`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `series` | Serie fiscal. En el MVP siempre `F`. |
| `year` | Ano natural de la fecha de expedicion. |
| `nextNumber` | Siguiente correlativo disponible. |
| `updatedAt` | Ultima modificacion. |

Restricciones e indices:

- Unico por `(series, year)`.
- La emision bloquea la fila de secuencia dentro de la transaccion antes de
  asignar numero.
- El numero visible se forma como `{series}{yy}{correlativo_5_digitos}`.

## 4. Tabla `invoices`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `documentType` | Tipo documental. MVP: `STANDARD`. |
| `origin` | Origen de la factura. MVP: `MANUAL`. |
| `status` | Estado documental. |
| `paymentStatus` | Estado de cobro separado del estado documental. |
| `verifactuStatus` | Estado VeriFactu separado. |
| `series`, `year`, `numberSequence`, `number` | Numeracion definitiva tras emision. |
| `customerId` | Cliente vivo referenciado. |
| `customerCodeSnapshot` | Codigo del cliente al crear/emitir. |
| `customerLegalNameSnapshot` | Razon social o nombre congelado. |
| `customerTaxIdSnapshot` | Identificador fiscal congelado. |
| `customerFiscalTreatmentSnapshot` | Tratamiento fiscal congelado. |
| `customerFiscalAddressSnapshot` | Direccion fiscal congelada como JSON seguro. |
| `issueDate` | Fecha de expedicion. |
| `operationDate` | Fecha de operacion. |
| `issuedAt` | Instante de emision. |
| `subtotal`, `discountTotal`, `taxableBase`, `taxAmount`, `total` | Totales calculados. |
| `notes` | Observaciones internas del borrador. |
| `createdById`, `updatedById`, `issuedById` | Usuarios responsables. |
| `createdAt`, `updatedAt` | Trazabilidad temporal. |

Restricciones e indices:

- `number` unico cuando no es nulo.
- Unico por `(series, year, numberSequence)` cuando `numberSequence` no es nulo.
- Indices para `(status, issueDate, id)`, `(customerId, issueDate, id)`,
  `(paymentStatus, issueDate, id)` y `(verifactuStatus, issueDate, id)`.
- `total >= 0` para facturas ordinarias MVP.
- `issuedAt` y `number` deben estar informados cuando `status = ISSUED`.

## 5. Tabla `invoice_lines`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `invoiceId` | Factura propietaria. |
| `position` | Orden estable dentro de la factura. |
| `catalogItemId` | Elemento de catalogo opcional. |
| `catalogItemCodeSnapshot` | Codigo copiado si procede. |
| `catalogItemKindSnapshot` | Tipo copiado si procede. |
| `description` | Texto de linea congelado al emitir. |
| `quantity` | Cantidad decimal con tres decimales. |
| `unitPrice` | Precio unitario sin IVA. |
| `discountPercent`, `discountAmount` | Descuentos de linea. |
| `taxRateId` | Tipo de IVA vivo referenciado. |
| `taxRateCodeSnapshot`, `taxRateNameSnapshot`, `taxRateSnapshot` | IVA copiado. |
| `lineSubtotal`, `lineDiscountTotal`, `lineTaxableBase`, `lineTaxAmount`, `lineTotal` | Importes calculados. |
| `createdAt`, `updatedAt` | Trazabilidad temporal. |

Restricciones e indices:

- Unico por `(invoiceId, position)`.
- Indice por `(catalogItemId)`.
- Checks para `quantity <> 0`, importes no negativos y porcentajes 0..100.
- Borrado fisico solo permitido mientras la factura esta en `DRAFT`.

## 6. Tabla `invoice_tax_summaries`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `invoiceId` | Factura propietaria. |
| `taxRateCode` | Codigo de IVA agrupado. |
| `taxRate` | Porcentaje aplicado. |
| `taxableBase` | Base agrupada. |
| `taxAmount` | Cuota agrupada. |
| `total` | Base mas cuota. |

Restricciones e indices:

- Unico por `(invoiceId, taxRateCode, taxRate)`.
- Se recalcula completo al cambiar lineas de un borrador.
- En emitidas actua como snapshot fiscal regenerable.

## 7. Tabla `invoice_due_dates`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `invoiceId` | Factura propietaria. |
| `position` | Orden estable. |
| `dueDate` | Fecha de vencimiento. |
| `amount` | Importe del vencimiento. |
| `paymentMethod` | `BANK_TRANSFER`, `CASH` o `DIRECT_DEBIT`. |
| `status` | `PENDING`, `PAID`, `RETURNED` o `UNPAID`. |

Restricciones e indices:

- Unico por `(invoiceId, position)`.
- En el MVP se crea un unico vencimiento por el total.
- La suma de vencimientos debe coincidir exactamente con `invoices.total`.

## 8. Tabla `invoice_verifactu_records`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `invoiceId` | Factura emitida. |
| `status` | Estado de preparacion/envio. MVP: `PENDING`. |
| `createdAt` | Instante de creacion del placeholder. |
| `lastErrorCode` | Codigo funcional si falla preparacion futura. |

El MVP no envia a AEAT ni guarda certificados. La tabla reserva el punto de
integracion para el adaptador VeriFactu server-side.

## 9. Tabla `customer_payments`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `invoiceId` | Factura emitida cobrada total o parcialmente. |
| `dueDateId` | Vencimiento sobre el que se aplica el cobro. |
| `source` | Origen del cobro. Primer corte: `MANUAL`. |
| `paymentDate` | Fecha del cobro. |
| `amount` | Importe cobrado. |
| `reference` | Referencia bancaria o interna opcional. |
| `notes` | Observaciones internas opcionales. |
| `createdById`, `createdAt` | Trazabilidad de alta. |

Restricciones e indices:

- `amount > 0`.
- FK restrictivas a factura, vencimiento y usuario.
- Indices por `(invoiceId, paymentDate, id)`, `(dueDateId, paymentDate, id)` y
  `(createdById, createdAt)`.

La aplicacion impide sobrecobros comparando la suma de cobros registrados con el
importe del vencimiento dentro de la transaccion.

## 10. Transacciones Criticas

Crear/editar borradores:

- Actualiza factura, lineas, resumen fiscal y vencimiento en una transaccion.
- No llama a servicios externos.

Emitir:

1. Bloquea la factura `DRAFT`.
2. Valida lineas, totales, cliente y cronologia.
3. Bloquea o crea la fila de `invoice_number_sequences`.
4. Asigna numero definitivo.
5. Congela snapshot fiscal y economico.
6. Crea `invoice_verifactu_records`.
7. Audita `INVOICE_ISSUED`.

Registrar cobro manual:

1. Valida que la factura esta `ISSUED`.
2. Valida que el vencimiento pertenece a la factura y admite cobro.
3. Calcula el saldo pendiente del vencimiento.
4. Crea `customer_payments`.
5. Actualiza estado del vencimiento.
6. Recalcula `paymentStatus` de la factura.
7. Audita `CUSTOMER_PAYMENT_REGISTERED`.

## 11. Auditoria

Eventos actuales del MVP:

- `INVOICES_VIEWED`.
- `INVOICE_VIEWED`.
- `INVOICE_DRAFT_CREATED`.
- `INVOICE_DRAFT_UPDATED`.
- `INVOICE_LINE_CREATED`.
- `INVOICE_LINE_UPDATED`.
- `INVOICE_LINE_DELETED`.
- `INVOICE_ISSUED`.
- `INVOICE_PDF_DOWNLOADED`.
- `CUSTOMER_PAYMENT_REGISTERED`.

Los payloads incluyen ids, numero, estado, total y campos modificados. No deben
incluir NIF, direccion fiscal completa, email, IBAN, notas completas ni textos
largos de lineas.

## 12. PDF

El PDF del MVP se genera bajo demanda para facturas emitidas desde los datos
congelados de la factura, lineas, resumen de impuestos y vencimientos. No anade
tablas de persistencia propias ni conserva obligatoriamente el binario generado.

Quedan fuera del MVP la firma digital, el envio por correo, la plantilla
definitiva versionada y el hash del PDF enviado.

## 13. Decisiones Pendientes

- Modelo definitivo de presupuestos.
- Rectificativas integras.
- Varios vencimientos manuales.
- Devoluciones, anticipos, remesas y conciliacion.
- Plantilla PDF definitiva, firma digital y hash de plantilla.
- Encadenamiento y envio VeriFactu real.
- Conexion con contabilidad.
