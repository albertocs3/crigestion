# Contratos HTTP de Contabilidad

## 1. Primer Corte

El primer corte expone cuentas contables y asientos manuales ya contabilizados.
No incluye todavia plantillas, adjuntos, anulaciones, modificacion de asientos,
ejercicios cerrados ni contabilizacion automatica desde facturas.

Permisos:

| Permiso | Uso |
|---|---|
| `Accounting.View` | Consultar cuentas y diario. |
| `Accounting.ManageEntries` | Crear cuentas y asientos manuales. |

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
