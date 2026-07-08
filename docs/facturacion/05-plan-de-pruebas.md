# Plan de Pruebas de Facturacion

## 1. Alcance MVP

Este plan cubre facturas ordinarias manuales. Presupuestos, rectificativas,
cobros, PDF, correo, remesas SEPA y VeriFactu real quedan fuera del primer
corte.

## 2. Unitarias de Dominio

Cubrir:

- Calculo de linea con cantidad, precio, descuento porcentual y descuento fijo.
- Redondeo monetario por linea.
- Agrupacion de impuestos por tipo de IVA.
- Total de factura como suma de lineas.
- Vencimiento unico segun condiciones del cliente.
- Formato de numero `F{AA}{correlativo}`.

Casos clave:

- Cantidades con tres decimales.
- Precio cero.
- Descuento que deja base cero.
- Varios tipos de IVA.
- IVA 0%.
- Intento de cantidad cero.

## 3. Integracion Prisma/PostgreSQL

Cubrir contra PostgreSQL real:

- Crear borrador con snapshot fiscal del cliente.
- Anadir, editar y eliminar lineas recalculando totales.
- Emitir factura en transaccion.
- Numeracion concurrente sin duplicados.
- Rollback de emision no consume numero.
- No modificar factura emitida.
- Indices unicos de numero y secuencia.
- Suma de vencimientos igual al total.

## 4. Contratos HTTP

Cubrir:

- `GET /api/invoices` requiere `Billing.View`.
- `POST /api/invoices` requiere `Billing.ManageDrafts`, CSRF e
  `Idempotency-Key`.
- `PATCH /api/invoices/{invoiceId}` rechaza emitidas.
- `POST /api/invoices/{invoiceId}/lines` valida catalogo e IVA activos.
- `PATCH /api/invoices/{invoiceId}/lines/{lineId}` recalcula totales.
- `DELETE /api/invoices/{invoiceId}/lines/{lineId}` recalcula totales.
- `POST /api/invoices/{invoiceId}/issue` requiere `Billing.Issue`, CSRF e
  `Idempotency-Key`.
- Mutaciones devuelven `423 MAINTENANCE_MODE_ACTIVE` en mantenimiento.

Errores estables:

- `UNAUTHENTICATED`.
- `FORBIDDEN`.
- `CSRF_TOKEN_INVALID`.
- `INVOICE_NOT_FOUND`.
- `INVOICE_NOT_EDITABLE`.
- `INVOICE_NOT_ISSUABLE`.
- `INVOICE_EMPTY`.
- `INVOICE_CHRONOLOGY_VIOLATION`.
- `CUSTOMER_FISCAL_DATA_INCOMPLETE`.

## 5. Seguridad

Cubrir:

- Usuarios sin permiso no pueden crear ni emitir aunque llamen a la API.
- Auditoria de denegaciones.
- Auditoria de emision sin NIF, direccion fiscal completa, IBAN ni notas.
- Idempotencia: mismo body y misma key devuelve replay seguro.
- Idempotencia: misma key con body distinto devuelve conflicto.
- No se exponen modelos Prisma ni campos sensibles del cliente en listados.

## 6. E2E Playwright

Flujo P0:

1. Inicializar plataforma.
2. Crear cliente activo con datos fiscales minimos.
3. Crear tipo de catalogo/usar IVA semilla.
4. Crear factura.
5. Anadir linea desde catalogo.
6. Ver totales.
7. Emitir.
8. Confirmar numero definitivo.
9. Confirmar que la factura emitida queda en solo lectura.

Flujo de permisos:

- Usuario con `Billing.View` pero sin `Billing.Issue` puede consultar y no puede
  emitir.

Flujo de mantenimiento:

- Activar mantenimiento de restore.
- Intentar crear factura y recibir bloqueo.
- Desactivar mantenimiento.

## 7. Validacion de Release

Antes de cerrar el primer corte:

```powershell
npm run prisma:generate
npm run prisma:deploy
npm run typecheck
npm test
npm run lint
npm run build
npm run audit
npm run test:e2e
```

Si alguna validacion no se puede ejecutar por entorno, debe indicarse en el
cierre de tarea.
