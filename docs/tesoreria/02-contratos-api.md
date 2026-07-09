# Contratos HTTP de Tesoreria

## 1. Primer Corte

El primer corte de Tesoreria implementa registro manual de cobros de clientes
sobre vencimientos de facturas emitidas.

Incluye:

- Registrar cobros parciales o completos.
- Actualizar el estado del vencimiento.
- Recalcular el estado de cobro de la factura.
- Auditar la operacion sin datos sensibles.

Fuera del primer corte:

- Remesas SEPA.
- Devoluciones.
- Conciliacion bancaria.
- Asientos contables automaticos.
- Previsiones de tesoreria.

## 2. Convenciones

- Base inicial: `/api/invoices/{invoiceId}/payments`.
- Autenticacion obligatoria con sesion web.
- Las mutaciones validan `Origin`, token CSRF y modo mantenimiento.
- Las mutaciones requieren `Idempotency-Key`.
- Las respuestas son DTOs; no se exponen modelos Prisma.
- La auditoria no incluye NIF, IBAN, notas completas ni referencias bancarias
  sensibles.

## 3. Permisos

| Permiso | Uso |
|---|---|
| `Treasury.ManagePayments` | Registrar cobros manuales de clientes. |

El administrador protegido recibe este permiso en el seed inicial.

## 4. `POST /api/invoices/{invoiceId}/payments`

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
