# Modelo Fisico de Datos de Clientes

## 1. Primer Corte Implementado

El corte actual implementa el maestro fiscal minimo de clientes, una cuenta bancaria IBAN por cliente, mandatos SEPA basicos, condiciones comerciales basicas, direcciones de cliente y tiendas con un contacto operativo unico. No incluye aun fusion.

## 2. Tabla `customers`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `code` | Codigo automatico numerico correlativo, unico. |
| `type` | `COMPANY`, `SELF_EMPLOYED` o `INDIVIDUAL`. |
| `status` | `ACTIVE` o `INACTIVE`. |
| `legalName` | Razon social o nombre completo. |
| `tradeName` | Nombre comercial opcional. |
| `taxId` | NIF, VAT u otro identificador fiscal visible. |
| `normalizedTaxId` | Identificador fiscal normalizado para unicidad. |
| `fiscalTreatment` | `DOMESTIC`, `EU`, `EXPORT` o `CANARY_CEUTA_MELILLA`. |
| `email`, `phone` | Contacto general inicial. |
| `fiscalAddress*` | Direccion fiscal embebida en este primer corte. |
| `defaultPaymentMethod` | Forma de pago predeterminada: transferencia, contado o domiciliacion. |
| `paymentTermsType` | Tipo de vencimiento: al contado, a dias o dia fijo del mes. |
| `paymentDays` | Dias de vencimiento cuando `paymentTermsType = DAYS`. |
| `paymentFixedDay` | Dia fijo cuando `paymentTermsType = FIXED_DAY_OF_MONTH`. |
| `creditLimit` | Limite de credito decimal. |
| `bankIban` | IBAN normalizado sin espacios para la cuenta bancaria activa del cliente. |
| `notes` | Observaciones internas no expuestas en listados. |
| `createdById`, `updatedById` | Usuario responsable de alta o ultimo cambio. |
| `createdAt`, `updatedAt` | Trazabilidad temporal. |

## 3. Restricciones e Indices

- `customers.code` es unico.
- `customers.normalizedTaxId` es unico.
- `customers_status_legalName_id_idx` soporta listados por estado y orden estable.
- `customers_createdAt_id_idx` soporta paginacion temporal futura.
- `customers_createdById_createdAt_idx` soporta trazabilidad por usuario.
- `customer_code_seq` genera el correlativo de `code` dentro de una transaccion.
- La aplicacion valida formalmente NIF, NIE y CIF cuando `fiscalCountry = ES`.
- La aplicacion valida formalmente el IBAN cuando se informa.
- Si la forma de pago es domiciliacion, la aplicacion exige IBAN y mandato SEPA activo.

## 4. Tabla `customer_sepa_mandates`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `customerId` | Cliente titular del mandato. |
| `reference` | Referencia visible del mandato. |
| `referenceNormalized` | Referencia normalizada y unica para evitar duplicados por espacios o mayusculas. |
| `status` | `ACTIVE`, `REVOKED` o `INVALIDATED`. |
| `signedAt` | Fecha de firma del mandato. |
| `revokedAt` | Fecha/hora de revocacion o invalidacion. |
| `createdById`, `revokedById` | Usuarios responsables de alta y revocacion/invalidation. |
| `createdAt`, `updatedAt` | Trazabilidad temporal. |

Restricciones e indices:

- `customer_sepa_mandates_referenceNormalized_key` impide reutilizar referencias normalizadas.
- `customer_sepa_mandates_one_active_per_customer_idx` es un indice unico parcial PostgreSQL que impide mas de un mandato activo por cliente.
- `customer_sepa_mandates_customerId_status_idx` soporta lectura del mandato activo del cliente.
- Cambiar `customers.bankIban` invalida el mandato activo anterior dentro de la misma transaccion.

## 5. Tabla `customer_addresses`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `customerId` | Cliente propietario. |
| `type` | `BILLING`, `SHIPPING` u `OTHER`. |
| `status` | `ACTIVE` o `INACTIVE`. |
| `label` | Etiqueta operativa visible. |
| `isPrimary` | Marca la direccion principal activa para ese cliente y tipo. |
| `address*` | Direccion postal. |
| `contactName`, `phone`, `email` | Contacto opcional asociado a la direccion. |
| `notes` | Observaciones internas no expuestas en listados. |
| `createdById`, `updatedById` | Usuario responsable de alta o ultimo cambio. |

Restricciones e indices:

- `customer_addresses_one_active_primary_per_type_idx` impide mas de una direccion principal activa por cliente y tipo.
- `customer_addresses_customerId_type_status_isPrimary_idx` soporta busqueda de direcciones principales.
- `customer_addresses_customerId_status_label_id_idx` soporta listados por cliente.
- Al desactivar una direccion, `isPrimary` pasa a `false`.

## 6. Auditoria

Eventos actuales:

- `CUSTOMERS_VIEWED`.
- `CUSTOMER_VIEWED`.
- `CUSTOMER_CREATED`.
- `CUSTOMER_UPDATED`.
- `CUSTOMER_DEACTIVATED`.
- `CUSTOMER_REACTIVATED`.
- `CUSTOMER_SEPA_MANDATE_CREATED`.
- `CUSTOMER_SEPA_MANDATE_REVOKED`.
- `CUSTOMER_SEPA_MANDATE_INVALIDATED`.
- `CUSTOMER_ADDRESSES_VIEWED`.
- `CUSTOMER_ADDRESS_CREATED`.
- `CUSTOMER_ADDRESS_UPDATED`.
- `CUSTOMER_ADDRESS_DEACTIVATED`.
- `CUSTOMER_ADDRESS_REACTIVATED`.

Los payloads evitan guardar NIF, email, telefono, direccion, IBAN y observaciones completas. Las actualizaciones guardan `changedFields` con nombres de campos modificados.

## 7. Tabla `customer_stores`

| Campo | Uso |
|---|---|
| `id` | UUID tecnico. |
| `customerId` | Cliente propietario. |
| `code` | Codigo automatico numerico correlativo, unico. |
| `name` | Nombre comercial de la sede. |
| `status` | `ACTIVE` o `INACTIVE`. |
| `isPrimary` | Marca la tienda principal del cliente. |
| `address*` | Direccion de la tienda. |
| `email`, `phone`, `whatsapp` | Contacto operativo de la tienda. |
| `contact*` | Contacto unico de la tienda. |
| `notes` | Observaciones internas no expuestas en listados. |
| `createdById`, `updatedById` | Usuario responsable de alta o ultimo cambio. |

Restricciones e indices:

- `customer_stores.code` es unico.
- `customer_stores_customerId_status_name_id_idx` soporta listados por cliente.
- `customer_stores_one_primary_per_customer_idx` impide mas de una tienda principal por cliente.
- `customer_store_code_seq` genera el correlativo de `code`.

## 8. Auditoria de Tiendas

Eventos actuales:

- `CUSTOMER_STORES_VIEWED`.
- `CUSTOMER_STORE_CREATED`.
- `CUSTOMER_STORE_UPDATED`.
- `CUSTOMER_STORE_DEACTIVATED`.
- `CUSTOMER_STORE_REACTIVATED`.

Los payloads evitan guardar direccion, contacto, email, telefono y observaciones completas.

## 9. Decisiones Pendientes

- Extraer identidad fiscal comun a `Party` si proveedores comparten NIF/VAT con clientes.
- Extraer direcciones a tabla comun si proveedores, empresas propias o tiendas necesitan compartir la misma estructura.
- Completar validacion formal de VAT internacional.
- Permisos mas granulares para datos fiscales, pago, bancos, mandatos SEPA y credito.
- Bloquear modificacion de NIF cuando existan facturas emitidas.
- Gestionar fusiones con indice parcial de identificador fiscal entre clientes no fusionados.
