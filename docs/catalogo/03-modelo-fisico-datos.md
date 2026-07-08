# Modelo Fisico de Datos de Catalogo

## 1. Primer Corte Implementado

El corte actual implementa un maestro unico de articulos, servicios, software y licencias. Incluye codigo automatico numerico, categorias, precios netos, tipo de IVA, coste, estado, campos basicos de stock para productos y ajustes de stock trazables. No incluye aun historico de precios, movimientos de inventario de ventas/compras ni vigencias fiscales por fecha.

## 2. Tabla `catalog_items`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `code` | Codigo automatico numerico correlativo, unico. |
| `categoryId` | Categoria opcional desde `catalog_categories`. |
| `kind` | `PRODUCT`, `SERVICE`, `SOFTWARE` o `LICENSE`. |
| `status` | `ACTIVE` o `INACTIVE`. |
| `name` | Nombre comercial unico. |
| `description` | Descripcion comercial opcional. |
| `unitName` | Unidad visible inicial. Por defecto `Unidades`. |
| `salePrice` | Precio de venta sin IVA. |
| `costPrice` | Ultimo coste sin IVA. |
| `taxRateId` | Tipo de IVA activo seleccionado desde `catalog_tax_rates`. |
| `taxRate` | Porcentaje de IVA copiado desde el tipo elegido. Es el valor operativo que podra copiarse a lineas de venta. |
| `stockTracked` | Indica si se controla stock. Solo aplica a productos. |
| `stockCurrent` | Stock actual. Puede ser negativo si se controla stock. |
| `stockMinimum` | Stock minimo operativo. |
| `createdById`, `updatedById` | Usuarios responsables de alta o ultimo cambio. |
| `createdAt`, `updatedAt` | Trazabilidad temporal. |

## 3. Tabla `catalog_categories`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `code` | Codigo automatico numerico correlativo, unico. |
| `name` | Nombre unico de la categoria. |
| `description` | Descripcion interna opcional. |
| `status` | `ACTIVE` o `INACTIVE`. Solo se proponen activas al asignar articulos. |
| `createdAt`, `updatedAt` | Trazabilidad temporal. |

Las categorias no se borran desde la aplicacion. Se pueden crear, activar e inactivar para preservar articulos historicos asociados.

## 4. Tabla `catalog_stock_movements`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `itemId` | Producto afectado. |
| `type` | Tipo de movimiento. En este corte: `ADJUSTMENT`. |
| `quantity` | Cantidad firmada del ajuste. Positiva suma stock, negativa lo resta. |
| `previousStock` | Stock antes del ajuste. |
| `newStock` | Stock resultante tras el ajuste. |
| `reason` | Motivo operativo del ajuste. |
| `createdById`, `createdAt` | Usuario y momento del ajuste. |

Cada ajuste actualiza `catalog_items.stockCurrent` en la misma transaccion. Solo se admiten ajustes en productos con `stockTracked = true`.

## 5. Tabla `catalog_tax_rates`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `code` | Codigo estable del tipo de IVA (`IVA_21`, `IVA_10`, etc.). |
| `name` | Nombre visible para formularios y listados. |
| `rate` | Porcentaje vigente del tipo. |
| `status` | `ACTIVE` o `INACTIVE`. Solo se seleccionan activos. |
| `isDefault` | Marca el IVA propuesto por defecto en altas. |
| `createdAt`, `updatedAt` | Trazabilidad temporal. |

Datos iniciales: IVA general 21%, IVA reducido 10%, IVA superreducido 4%, IVA 0% y Exento 0%.

Los tipos de IVA no se borran desde la aplicacion. Se pueden crear nuevos tipos, marcar uno activo como valor por defecto e inactivar tipos que ya no deben usarse en nuevas altas. El tipo por defecto no puede inactivarse mientras siga marcado como tal.

## 6. Restricciones e Indices

- `catalog_items.code` es unico.
- `catalog_items.name` es unico.
- `catalog_items.categoryId` referencia `catalog_categories.id` con borrado restringido.
- `catalog_items.taxRateId` referencia `catalog_tax_rates.id` con borrado restringido.
- `catalog_items_status_name_id_idx` soporta listados por estado.
- `catalog_items_kind_status_name_id_idx` soporta filtros por tipo y estado.
- `catalog_items_categoryId_status_name_id_idx` soporta filtros por categoria.
- `catalog_items_taxRateId_idx` soporta consultas por tipo de IVA.
- `catalog_stock_movements_itemId_createdAt_id_idx` soporta historico por producto.
- `catalog_stock_movements_createdById_createdAt_idx` soporta auditoria por usuario.
- `catalog_categories.code` y `catalog_categories.name` son unicos.
- `catalog_categories_status_name_id_idx` soporta desplegables y listados.
- `catalog_tax_rates.code` es unico.
- `catalog_tax_rates_single_default_idx` impide mas de un tipo de IVA por defecto.
- `catalog_tax_rates_status_name_id_idx` soporta el desplegable de tipos activos.
- `catalog_item_code_seq` genera el correlativo de `code`.
- La aplicacion impide activar control de stock en tipos distintos de `PRODUCT`.
- Checks PostgreSQL refuerzan que los porcentajes de IVA esten entre 0 y 100,
  que precios/costes/minimos no sean negativos y que cada movimiento cumpla
  `newStock = previousStock + quantity`.

## 7. Auditoria

Eventos actuales:

- `CATALOG_ITEMS_VIEWED`.
- `CATALOG_ITEM_CREATED`.
- `CATALOG_ITEM_UPDATED`.
- `CATALOG_ITEM_DEACTIVATED`.
- `CATALOG_ITEM_REACTIVATED`.
- `CATALOG_CATEGORY_CREATED`.
- `CATALOG_CATEGORY_DEACTIVATED`.
- `CATALOG_CATEGORY_REACTIVATED`.
- `CATALOG_STOCK_ADJUSTED`.
- `CATALOG_TAX_RATE_CREATED`.
- `CATALOG_TAX_RATE_DEFAULT_SET`.
- `CATALOG_TAX_RATE_DEACTIVATED`.
- `CATALOG_TAX_RATE_REACTIVATED`.

Los payloads evitan guardar nombre, descripcion, precios, costes y cantidades completas. Las actualizaciones guardan `changedFields` con nombres de campos modificados.

## 8. Decisiones Pendientes

- Numeracion independiente de articulos por categoria, si se confirma como requisito funcional.
- Historico de precios y costes.
- Vigencias fiscales por fecha y motivos de exencion/no sujecion.
- Snapshot fiscal completo en lineas de venta: codigo, nombre, porcentaje y motivo aplicados.
- Cuentas contables obligatorias antes de facturar.
- Movimientos de stock automaticos por compras, ventas, devoluciones y regularizaciones avanzadas.
- Panel de inventario, alertas y valoracion.
