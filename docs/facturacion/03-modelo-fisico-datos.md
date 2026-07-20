# Modelo Fisico de Datos de Facturacion

## 1. Primer Corte MVP

El primer corte implementa facturas ordinarias manuales con lineas, resumen de
impuestos, vencimiento inicial, numeracion definitiva al emitir, rectificativas
integras, cobros/devoluciones manuales y descarga PDF regenerada para facturas
emitidas. No incluye presupuestos, envios por correo, remesas SEPA ni envio
VeriFactu real.

## 2. Enumerados

- `InvoiceDocumentType`: `STANDARD`, `RECTIFICATION`.
- `InvoiceDocumentStatus`: `DRAFT`, `ISSUED`, `RECTIFIED`, `VOIDED`.
- `InvoicePaymentStatus`: `PENDING`, `PARTIALLY_PAID`, `PAID`, `UNPAID`.
- `InvoiceVerifactuStatus`: `NOT_APPLICABLE`, `PENDING`, `SENT`, `ACCEPTED`,
  `ACCEPTED_WITH_ERRORS`, `REJECTED`, `CANCELLED`.
- `InvoiceOrigin`: `MANUAL`, `SUBSCRIPTION`.

En el MVP se crean facturas `STANDARD` manuales y rectificativas
`RECTIFICATION` vinculadas a una unica factura original.

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
- La misma transaccion bloquea el ejercicio abierto y crea un unico asiento
  enlazado a la factura: `430` al debe y `700`/`705` mas `477` al haber.
- Si falta el ejercicio o una cuenta activa e imputable, no se consume numero
  ni se emiten la factura, el registro VeriFactu o el asiento.
- Una rectificativa genera el asiento inverso: ventas e IVA al debe y la cuenta
  `430` del cliente al haber. Todo el flujo revierte si el asiento no es viable.
- El numero visible se forma como `{series}{yy}{correlativo_5_digitos}`.

## 4. Tabla `invoices`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `documentType` | Tipo documental: `STANDARD` o `RECTIFICATION`. |
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
| `rectificationReason` | Motivo normalizado de rectificacion, solo para rectificativas. |
| `rectifiesInvoiceId` | Factura original rectificada. Unico en el primer corte. |
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

## 8. Persistencia VeriFactu

La persistencia definitiva se incorpora de forma escalonada. La columna
`invoices.companyId` es nullable durante la transicion para no atribuir a una
empresa facturas historicas cuyo propietario no pueda demostrarse. Las nuevas
facturas copian la empresa de la instalacion inicializada. Antes de hacer la
columna obligatoria se deben sanear las filas legacy y adaptar todos los seeds e
importadores.

### 8.1 Tabla legacy `invoice_verifactu_records`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `invoiceId` | Factura emitida. |
| `status` | Estado del placeholder legacy. Puede seguir `PENDING` aunque la proyeccion de la factura sea `NOT_APPLICABLE` cuando VeriFactu esta desactivado; no sustituye a `verifactu_fiscal_records`. |
| `createdAt` | Instante de creacion del placeholder. |
| `lastErrorCode` | Codigo funcional si falla preparacion futura. |

Esta tabla sigue siendo el placeholder usado por el flujo de emision actual. No
se transforma automaticamente en un registro fiscal: carece del snapshot, hash,
versiones y datos de encadenamiento necesarios para considerarlo conforme.

### 8.2 Tabla `verifactu_sif_installations`

Identifica la instalacion SIF por empresa y entorno, fija las versiones del
contrato, esquema y manifiesto tecnico, y conserva la cabeza de la cadena. Solo
puede existir una instalacion `ACTIVE` por empresa y entorno. `credentialRef`
es una referencia server-side; nunca contiene el certificado ni su secreto.

### 8.3 Tabla `verifactu_fiscal_records`

Registro fiscal inmutable de alta o anulacion. Conserva el snapshot fiscal, el
payload cifrado, sus hashes, la version de canonizacion y el enlace a la cadena.
Las restricciones PostgreSQL garantizan propiedad por empresa, posicion unica,
un unico sucesor por registro y que una anulacion apunte a un alta de la misma
factura e instalacion. Un trigger rechaza cualquier `UPDATE` o `DELETE`.

El JSONB visible contiene solo metadatos tecnicos minimos; el snapshot fiscal y
el XML con datos identificativos se conservan en `payloadCiphertext`. Un indice
parcial impide mas de un `ALTA` por factura e instalacion y un trigger valida que
posicion y huella coincidan con el registro anterior.

La huella normativa se genera en hexadecimal mayusculo. La restriccion acepta
temporalmente ambos casos para conservar fixtures y registros de desarrollo
anteriores, mientras el servicio de persistencia exige mayusculas para todas las
nuevas preparaciones.

`payloadCiphertext` almacena el sobre autenticado completo, no XML en claro.
`encryptionKeyId` permite seleccionar claves historicas del keyring durante
restauraciones, exportaciones autorizadas o reenvios. El hash SHA-256 del XML se
mantiene separado para integridad e idempotencia y tambien queda ligado al AAD.

### 8.4 Tabla `verifactu_submission_attempts`

Cada fila representa un intento ya finalizado. Guarda resultado, hashes,
identificadores AEAT y, cuando proceda, peticion/respuesta cifradas. Es
append-only: las recuperaciones ambiguas se registran como nuevos intentos de
tipo `RECONCILE`, nunca modificando el intento anterior.

`credentialVersionId` identifica de forma inmutable la version mTLS utilizada.
Las tablas `verifactu_mtls_credentials` y
`verifactu_mtls_credential_versions` separan la identidad logica de sus
versiones cifradas. Un indice parcial permite una sola version activa y las
restricciones exigen vigencia, prueba ligada al SHA-256 del PFX y estados de
ciclo de vida coherentes. Las versiones retiradas se conservan por trazabilidad.
El ciclo es `STAGED -> TESTED -> ACTIVE -> RETIRED`; el material es inmutable
desde su creacion y `TESTED` exige un intento `PASSED` con el mismo hash en
`verifactu_mtls_credential_test_attempts`. La FK compuesta de la instalacion
con `companyId` impide asignar una credencial de otra empresa.

### 8.5 Tabla `verifactu_outbox_messages`

Cola durable y mutable para separar la transaccion fiscal de la llamada externa.
Sus estados `PENDING`, `CLAIMED`, `PROCESSED` y `DEAD` tienen invariantes de
lease reforzadas en PostgreSQL. `commitPreparedVerifactuAlta` bloquea la
instalacion SIF y confirma registro, outbox, cabeza de cadena y auditoria en una
sola transaccion. `issueInvoice` reutiliza el mismo `TransactionClient`, por lo
que numeracion, asiento, factura, alta fiscal y outbox confirman o revierten
juntos cuando `VERIFACTU_ENABLED=true`.

La activacion falla cerrada: exige una instalacion SIF activa del entorno, clave
de idempotencia, preparador server-side y credencial probada por el adaptador
AEAT. No existe fallback al placeholder cuando VeriFactu esta activo.

El polling del worker usa el indice de pendientes por estado/fecha y un indice
parcial de recuperacion para leases `CLAIMED`. El contador aumenta al iniciar
una llamada externa; un lease `SUBMIT` abandonado se considera resultado
indeterminado y genera conciliacion antes de cualquier nuevo envio.

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

La aplicacion impide sobrecobros comparando la suma neta de cobros menos
devoluciones con el importe del vencimiento dentro de la transaccion.

## 10. Tabla `customer_payment_returns`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `paymentId` | Cobro sobre el que se registra la devolucion. |
| `invoiceId` | Factura emitida afectada. |
| `dueDateId` | Vencimiento afectado. |
| `returnDate` | Fecha de devolucion. |
| `amount` | Importe devuelto. |
| `reasonCode` | Motivo opcional normalizable. |
| `notes` | Observaciones internas opcionales. |
| `createdById`, `createdAt` | Trazabilidad de alta. |

Restricciones e indices:

- `amount > 0`.
- FK restrictivas a cobro, factura, vencimiento y usuario.
- Indices por `(paymentId, returnDate, id)`, `(invoiceId, returnDate, id)`,
  `(dueDateId, returnDate, id)` y `(createdById, createdAt)`.

La aplicacion impide que la suma de devoluciones supere el importe del cobro.

## 11. Transacciones Criticas

Crear/editar borradores:

- Actualiza factura, lineas, resumen fiscal y vencimiento en una transaccion.
- No llama a servicios externos.

Emitir:

1. Bloquea la factura `DRAFT`.
2. Valida lineas, totales, cliente y cronologia.
3. Bloquea o crea la fila de `invoice_number_sequences`.
4. Asigna numero definitivo.
5. Congela snapshot fiscal y economico.
6. Crea el placeholder legacy `invoice_verifactu_records` mientras se migra el
   caso de uso al registro fiscal append-only y al outbox atomico.
7. Audita `INVOICE_ISSUED`.

Registrar cobro manual:

1. Valida que la factura esta `ISSUED`.
2. Valida que el vencimiento pertenece a la factura y admite cobro.
3. Calcula el saldo pendiente neto del vencimiento.
4. Crea `customer_payments`.
5. Actualiza estado del vencimiento.
6. Recalcula `paymentStatus` de la factura.
7. Crea en la misma transaccion un asiento enlazado al cobro: `570` para caja o
   `572` para banco al debe y la cuenta `430` del cliente al haber.
7. Audita `CUSTOMER_PAYMENT_REGISTERED`.

Registrar devolucion manual:

1. Valida que la factura esta `ISSUED`.
2. Valida que el cobro pertenece a la factura.
3. Calcula el importe todavia no devuelto del cobro.
4. Crea `customer_payment_returns`.
5. Recalcula el estado del vencimiento con importes netos.
6. Recalcula `paymentStatus` de la factura con importes netos.
7. Audita `CUSTOMER_PAYMENT_RETURNED`.

Crear rectificativa integra:

1. Valida que la factura original existe, es ordinaria y esta `ISSUED`.
2. Valida que no existe ya una rectificativa asociada.
3. Bloquea o crea la secuencia de serie `R`.
4. Crea la rectificativa ya `ISSUED` con importes invertidos.
5. Copia lineas, resumen fiscal y vencimiento invertido.
6. Crea placeholder VeriFactu legacy mientras se migra el caso de uso.
7. Marca la factura original como `RECTIFIED`.
8. Audita `INVOICE_RECTIFICATION_CREATED`.

Finalizar anulacion tecnica VeriFactu:

1. Exige factura ordinaria `ISSUED`, `verifactuStatus=CANCELLED` y evidencia
   terminal de una `ANULACION` que referencia su `ALTA`.
2. Rechaza pagos, devoluciones, remesas, vencimientos alterados y rectificativa.
3. Conserva el asiento original `POSTED` y crea otro asiento
   `INVOICE_VOIDING`, enlazado mediante `reversesEntryId` y `voidsInvoiceId`.
4. Cambia factura a `VOIDED`, pago a `CANCELLED` y vencimientos a `CANCELLED`.
5. Persiste replay idempotente y auditoria en la misma transaccion.

## 12. Auditoria

Eventos actuales del MVP:

- `INVOICES_VIEWED`.
- `INVOICE_VIEWED`.
- `INVOICE_DRAFT_CREATED`.
- `INVOICE_DRAFT_UPDATED`.
- `INVOICE_LINE_CREATED`.
- `INVOICE_LINE_UPDATED`.
- `INVOICE_LINE_DELETED`.
- `INVOICE_ISSUED`.
- `INVOICE_RECTIFICATION_CREATED`.
- `INVOICE_PDF_DOWNLOADED`.
- `CUSTOMER_PAYMENT_REGISTERED`.
- `CUSTOMER_PAYMENT_RETURNED`.

Los payloads incluyen ids, numero, estado, total y campos modificados. No deben
incluir NIF, direccion fiscal completa, email, IBAN, notas completas ni textos
largos de lineas.

## 13. PDF

El PDF del MVP se genera bajo demanda para facturas emitidas desde los datos
congelados de la factura, lineas, resumen de impuestos y vencimientos. No anade
tablas de persistencia propias ni conserva obligatoriamente el binario generado.

Quedan fuera del MVP la firma digital, el envio por correo, la plantilla
definitiva versionada y el hash del PDF enviado.

## 14. Decisiones Pendientes

- Modelo definitivo de presupuestos.
- Rectificativas integras.
- Varios vencimientos manuales.
- Devoluciones, anticipos, remesas y conciliacion.
- Plantilla PDF definitiva, firma digital y hash de plantilla.
- Adaptador de preparacion XML/hash/QR validado con fixtures oficiales AEAT.
- Aplicar el mismo flujo atomico a altas de facturas rectificativas.
- Worker de envio/reconciliacion AEAT y politica de reintentos.
- Saneamiento de facturas legacy para hacer `invoices.companyId` obligatorio.
- Conexion con contabilidad.
