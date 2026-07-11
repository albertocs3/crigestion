# Contratos HTTP de Contabilidad

## 1. Primer Corte

El primer corte expone cuentas contables, ejercicios y asientos manuales ya
contabilizados. Incluye el PGC PYMES y la copia del plan al siguiente ejercicio.
No incluye todavia adjuntos, anulaciones, modificacion de asientos ni
reaperturas. La emision de facturas ordinarias y rectificativas crea ya su
asiento automatico. Los cobros manuales crean tambien su asiento; las
devoluciones, cobros de remesas y pagos se incorporaran en cortes posteriores.

Permisos:

| Permiso | Uso |
|---|---|
| `Accounting.View` | Consultar cuentas y diario. |
| `Accounting.ManageEntries` | Crear cuentas y asientos manuales. |
| `Accounting.ManageExercises` | Crear la primera contabilidad. |
| `Accounting.CloseExercises` | Cerrar ejercicios y crear el siguiente. |

## 1.a Ejercicios contables

- `GET /api/accounting/fiscal-years`: requiere `Accounting.View`.
- `POST /api/accounting/fiscal-years`: crea la primera contabilidad con PGC
  PYMES; requiere `Accounting.ManageExercises`, CSRF e `Idempotency-Key`.
- `POST /api/accounting/fiscal-years/{fiscalYearId}/close`: regulariza grupos 6
  y 7, genera el asiento de cierre patrimonial, crea el siguiente ejercicio,
  copia sus cuentas y genera la apertura. Requiere `Accounting.CloseExercises`,
  CSRF e `Idempotency-Key`.

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
