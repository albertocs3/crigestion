# Contratos HTTP de Catalogo

## 1. Convenciones

- Base: `/api/catalog/items`.
- Categorias: `/api/catalog/categories`.
- Tipos de IVA: `/api/catalog/tax-rates`.
- Autenticacion obligatoria con sesion web.
- Las mutaciones validan `Origin`, token CSRF y modo mantenimiento.
- Las respuestas son DTOs; no se exponen modelos Prisma.
- Los eventos de auditoria no incluyen nombre, descripcion, precios ni costes completos.

## 2. Permisos

| Permiso | Uso |
|---|---|
| `Catalog.View` | Consultar catalogo. |
| `Catalog.Manage` | Crear, modificar, activar e inactivar elementos, categorias y tipos de IVA. |

## 3. `GET /api/catalog/items`

Permiso requerido: `Catalog.View`.

Query:

| Parametro | Tipo | Uso |
|---|---|---|
| `limit` | entero 1-100 | Tamano de pagina. Por defecto 25. |
| `cursor` | UUID | Cursor de paginacion. |
| `status` | `ACTIVE` o `INACTIVE` | Filtro de estado. |
| `kind` | `PRODUCT`, `SERVICE`, `SOFTWARE` o `LICENSE` | Filtro de tipo. |
| `categoryId` | UUID | Filtro de categoria. |
| `search` | texto 1-120 | Busca por codigo, nombre o descripcion. |

Respuesta `200`:

```json
{
  "items": [
    {
      "id": "uuid",
      "code": "1",
      "category": {
        "id": "uuid",
        "code": "1",
        "name": "Servicios recurrentes"
      },
      "kind": "SERVICE",
      "status": "ACTIVE",
      "name": "Servicio mensual",
      "description": "Cuota mensual de soporte",
      "unitName": "Unidades",
      "salePrice": "49.90",
      "costPrice": "10.00",
      "taxRate": "21.00",
      "tax": {
        "id": "uuid",
        "code": "IVA_21",
        "name": "IVA general 21%",
        "rate": "21.00"
      },
      "stock": {
        "tracked": false,
        "current": "0.000",
        "minimum": "0.000",
        "belowMinimum": false,
        "negative": false
      },
      "createdAt": "2026-07-06T13:00:00.000Z",
      "updatedAt": "2026-07-06T13:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Audita `CATALOG_ITEMS_VIEWED`.

## 4. `POST /api/catalog/items`

Permiso requerido: `Catalog.Manage`.

Body:

```json
{
  "kind": "SERVICE",
  "categoryId": "uuid",
  "name": "Servicio mensual",
  "description": "Cuota mensual de soporte",
  "unitName": "Unidades",
  "salePrice": "49.90",
  "costPrice": "10.00",
  "taxRateId": "uuid",
  "stockTracked": false,
  "stockCurrent": "0.000",
  "stockMinimum": "0.000"
}
```

Respuesta `201`: DTO de elemento.

Reglas:

- `code` se genera automaticamente con `catalog_item_code_seq`.
- `name` es unico.
- `categoryId` es opcional. Si se informa, debe apuntar a una categoria activa.
- Solo `PRODUCT` puede tener `stockTracked = true`.
- Si el tipo no es `PRODUCT`, el stock se mantiene en cero.
- Precio y coste se reciben como texto decimal para evitar errores de coma flotante.
- `taxRateId` debe apuntar a un tipo de IVA activo. El producto guarda ademas el porcentaje copiado en `taxRate`.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `409` | `CATALOG_ITEM_NAME_ALREADY_USED` | Ya existe un elemento con ese nombre. |
| `422` | `CATALOG_CATEGORY_NOT_FOUND` | La categoria no existe o no esta activa. |
| `422` | `CATALOG_TAX_RATE_NOT_FOUND` | El tipo de IVA no existe o no esta activo. |

Audita `CATALOG_ITEM_CREATED`.

## 5. `PATCH /api/catalog/items/{itemId}`

Permiso requerido: `Catalog.Manage`.

### Actualizar datos

Body:

```json
{
  "action": "update",
  "item": {
    "kind": "PRODUCT",
    "categoryId": "uuid",
    "name": "Producto fisico",
    "description": "Producto con stock",
    "unitName": "Unidades",
    "salePrice": "99.00",
    "costPrice": "40.00",
    "taxRateId": "uuid",
    "stockTracked": true,
    "stockCurrent": "5.000",
    "stockMinimum": "1.000"
  }
}
```

### Cambiar estado

Body:

```json
{ "action": "deactivate" }
```

o:

```json
{ "action": "reactivate" }
```

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CATALOG_ITEM_NOT_FOUND` | El elemento no existe. |
| `409` | `CATALOG_ITEM_NAME_ALREADY_USED` | Ya existe un elemento con ese nombre. |
| `409` | `CATALOG_ITEM_STATUS_ALREADY_SET` | El elemento ya estaba en el estado solicitado. |
| `422` | `CATALOG_CATEGORY_NOT_FOUND` | La categoria no existe o no esta activa. |
| `422` | `CATALOG_TAX_RATE_NOT_FOUND` | El tipo de IVA no existe o no esta activo. |

Audita `CATALOG_ITEM_UPDATED`, `CATALOG_ITEM_DEACTIVATED` o `CATALOG_ITEM_REACTIVATED`.

## 6. `POST /api/catalog/items/{itemId}/stock-movements`

Permiso requerido: `Catalog.Manage`.

Body:

```json
{
  "quantity": "-2.500",
  "reason": "Regularizacion de inventario"
}
```

Respuesta `201`:

```json
{
  "id": "uuid",
  "itemId": "uuid",
  "itemCode": "1",
  "itemName": "Producto inventariable",
  "type": "ADJUSTMENT",
  "quantity": "-2.500",
  "previousStock": "10.000",
  "newStock": "7.500",
  "reason": "Regularizacion de inventario",
  "createdAt": "2026-07-06T13:00:00.000Z"
}
```

Reglas:

- `quantity` es firmada: positiva suma stock, negativa lo resta.
- La cantidad no puede ser cero.
- Solo se admiten ajustes en elementos `PRODUCT` con `stockTracked = true`.
- El movimiento y el nuevo `stockCurrent` se guardan en la misma transaccion.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CATALOG_ITEM_NOT_FOUND` | El elemento no existe. |
| `409` | `CATALOG_ITEM_STOCK_NOT_TRACKED` | El elemento no es un producto con control de stock. |

Audita `CATALOG_STOCK_ADJUSTED`.

## 7. `GET /api/catalog/categories`

Permiso requerido: `Catalog.Manage`.

Query:

| Parametro | Tipo | Uso |
|---|---|---|
| `includeInactive` | booleano | Incluye categorias inactivas. Por defecto `false`. |

Respuesta `200`:

```json
{
  "items": [
    {
      "id": "uuid",
      "code": "1",
      "name": "Servicios recurrentes",
      "description": "Cuotas y mantenimientos",
      "status": "ACTIVE",
      "createdAt": "2026-07-06T13:00:00.000Z",
      "updatedAt": "2026-07-06T13:00:00.000Z"
    }
  ]
}
```

## 8. `POST /api/catalog/categories`

Permiso requerido: `Catalog.Manage`.

Body:

```json
{
  "name": "Servicios recurrentes",
  "description": "Cuotas y mantenimientos"
}
```

Reglas:

- `code` se genera automaticamente con `catalog_category_code_seq`.
- `name` es unico.
- La categoria nueva nace `ACTIVE`.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `409` | `CATALOG_CATEGORY_NAME_ALREADY_USED` | Ya existe una categoria con ese nombre. |

Audita `CATALOG_CATEGORY_CREATED`.

## 9. `PATCH /api/catalog/categories/{categoryId}`

Permiso requerido: `Catalog.Manage`.

Body:

```json
{ "action": "deactivate" }
```

o:

```json
{ "action": "reactivate" }
```

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CATALOG_CATEGORY_NOT_FOUND` | La categoria no existe. |
| `409` | `CATALOG_CATEGORY_STATUS_ALREADY_SET` | La categoria ya estaba en el estado solicitado. |

Audita `CATALOG_CATEGORY_DEACTIVATED` o `CATALOG_CATEGORY_REACTIVATED`.

## 10. `GET /api/catalog/tax-rates`

Permiso requerido: `Catalog.Manage`.

Query:

| Parametro | Tipo | Uso |
|---|---|---|
| `includeInactive` | booleano | Incluye tipos inactivos. Por defecto `false`. |

Respuesta `200`:

```json
{
  "items": [
    {
      "id": "uuid",
      "code": "IVA_21",
      "name": "IVA general 21%",
      "rate": "21.00",
      "status": "ACTIVE",
      "isDefault": true,
      "createdAt": "2026-07-06T13:00:00.000Z",
      "updatedAt": "2026-07-06T13:00:00.000Z"
    }
  ]
}
```

## 11. `POST /api/catalog/tax-rates`

Permiso requerido: `Catalog.Manage`.

Body:

```json
{
  "code": "IVA_23",
  "name": "IVA general 23%",
  "rate": "23.00",
  "isDefault": true
}
```

Reglas:

- `code` es unico y se normaliza a mayusculas.
- Si `isDefault` es `true`, se desmarca cualquier tipo anterior por defecto.
- El tipo nuevo nace `ACTIVE`.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `409` | `CATALOG_TAX_RATE_CODE_ALREADY_USED` | Ya existe un tipo de IVA con ese codigo. |

Audita `CATALOG_TAX_RATE_CREATED`.

## 12. `PATCH /api/catalog/tax-rates/{taxRateId}`

Permiso requerido: `Catalog.Manage`.

Body para cambiar estado:

```json
{ "action": "deactivate" }
```

o:

```json
{ "action": "reactivate" }
```

Body para marcar por defecto:

```json
{ "action": "setDefault" }
```

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CATALOG_TAX_RATE_NOT_FOUND` | El tipo de IVA no existe. |
| `409` | `CATALOG_TAX_RATE_STATUS_ALREADY_SET` | El tipo ya estaba en el estado solicitado. |
| `409` | `CATALOG_TAX_RATE_DEFAULT_CANNOT_BE_INACTIVE` | El tipo por defecto debe estar activo. |

Audita `CATALOG_TAX_RATE_DEFAULT_SET`, `CATALOG_TAX_RATE_DEACTIVATED` o `CATALOG_TAX_RATE_REACTIVATED`.
