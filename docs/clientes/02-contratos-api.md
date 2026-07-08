# Contratos HTTP de Clientes

## 1. Convenciones

- Base: `/api/customers`.
- Autenticacion obligatoria con sesion web.
- Las mutaciones validan `Origin`, token CSRF, `Idempotency-Key` y modo mantenimiento.
- Las respuestas son DTOs; no se exponen modelos Prisma.
- Los eventos de auditoria no incluyen NIF, email, telefono, direccion, IBAN ni observaciones completas.

## 2. Permisos

| Permiso | Uso |
|---|---|
| `Customers.View` | Consultar listado de clientes. |
| `Customers.Manage` | Crear clientes, cambiar estado, gestionar tiendas y direcciones. |

## 3. `GET /api/customers`

Permiso requerido: `Customers.View`.

Query:

| Parametro | Tipo | Uso |
|---|---|---|
| `limit` | entero 1-100 | Tamano de pagina. Por defecto 25. |
| `cursor` | UUID | Cursor de paginacion. |
| `status` | `ACTIVE` o `INACTIVE` | Filtro de estado. |
| `search` | texto 1-120 | Busca por codigo, razon social, nombre comercial o NIF/VAT. |

Respuesta `200`:

```json
{
  "customers": [
    {
      "id": "uuid",
      "code": "1",
      "type": "COMPANY",
      "status": "ACTIVE",
      "legalName": "Cliente Demo SL",
      "tradeName": "Cliente Demo",
      "taxId": "B12345674",
      "fiscalTreatment": "DOMESTIC",
      "email": "cliente@example.test",
      "phone": "+34910000000",
      "fiscalAddress": {
        "line": "Calle Mayor 1",
        "postalCode": "28001",
        "city": "Madrid",
        "province": "Madrid",
        "country": "ES"
      },
      "commercialTerms": {
        "defaultPaymentMethod": "BANK_TRANSFER",
        "paymentTermsType": "IMMEDIATE",
        "paymentDays": null,
        "paymentFixedDay": null,
        "creditLimit": null
      },
      "bankAccount": {
        "iban": "ES9121000418450200051332",
        "sepaMandate": {
          "id": "uuid",
          "reference": "SEPA-CLIENTE-1",
          "status": "ACTIVE",
          "signedAt": "2026-07-01",
          "revokedAt": null
        }
      },
      "createdAt": "2026-07-04T14:00:00.000Z",
      "updatedAt": "2026-07-04T14:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Audita `CUSTOMERS_VIEWED` con filtros y recuento, sin texto de busqueda.

## 4. `POST /api/customers`

Permiso requerido: `Customers.Manage`.

Body:

```json
{
  "type": "COMPANY",
  "legalName": "Cliente Demo SL",
  "tradeName": "Cliente Demo",
  "taxId": "B12345674",
  "fiscalTreatment": "DOMESTIC",
  "email": "cliente@example.test",
  "phone": "+34910000000",
  "fiscalAddressLine": "Calle Mayor 1",
  "fiscalPostalCode": "28001",
  "fiscalCity": "Madrid",
  "fiscalProvince": "Madrid",
  "fiscalCountry": "ES",
  "defaultPaymentMethod": "BANK_TRANSFER",
  "paymentTermsType": "IMMEDIATE",
  "paymentDays": null,
  "paymentFixedDay": null,
  "creditLimit": null,
  "bankIban": "ES91 2100 0418 4502 0005 1332",
  "sepaMandate": {
    "reference": "SEPA-CLIENTE-1",
    "signedAt": "2026-07-01"
  },
  "notes": "Observacion interna"
}
```

Respuesta `201`: DTO de cliente.

Validacion fiscal:

- Si `fiscalCountry` es `ES`, `taxId` debe ser un NIF, NIE o CIF formalmente valido.
- Si `fiscalCountry` no es `ES`, se admite el identificador indicado y la validacion VAT internacional queda pendiente de integracion posterior.
- Si `bankIban` se informa, se normaliza sin espacios y debe superar validacion formal IBAN.
- Si `defaultPaymentMethod = DIRECT_DEBIT`, `bankIban` y `sepaMandate` son obligatorios.
- `sepaMandate.reference` se normaliza para unicidad y `signedAt` usa formato `AAAA-MM-DD`.

Errores:

| Estado | Codigo | Uso |
|---|---|---|
| `400` | `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` | Falta la cabecera idempotente o supera la longitud permitida. |
| `401` | `UNAUTHENTICATED` | No hay sesion valida. |
| `403` | `FORBIDDEN` / `CSRF_TOKEN_INVALID` / `ORIGIN_NOT_ALLOWED` | Falta permiso o defensa CSRF/origen. |
| `409` | `CUSTOMER_TAX_ID_ALREADY_USED` | El identificador fiscal normalizado ya existe. |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | El cuerpo no es JSON. |
| `422` | `VALIDATION_ERROR` | Body invalido. |
| `423` | `MAINTENANCE_MODE_ACTIVE` | La plataforma esta en mantenimiento. |

Audita `CUSTOMER_CREATED` con `customerId`, `customerCode`, tipo y tratamiento fiscal. Si se informa mandato, audita `CUSTOMER_SEPA_MANDATE_CREATED` sin incluir IBAN.

## 5. `PATCH /api/customers/{customerId}`

Permiso requerido: `Customers.Manage`.

### Actualizar datos

Body:

```json
{
  "action": "update",
  "customer": {
    "type": "COMPANY",
    "legalName": "Cliente Demo SL",
    "tradeName": "Cliente Demo",
    "taxId": "B12345674",
    "fiscalTreatment": "DOMESTIC",
    "email": "cliente@example.test",
    "phone": "+34910000000",
    "fiscalAddressLine": "Calle Mayor 1",
    "fiscalPostalCode": "28001",
    "fiscalCity": "Madrid",
    "fiscalProvince": "Madrid",
    "fiscalCountry": "ES",
    "defaultPaymentMethod": "BANK_TRANSFER",
    "paymentTermsType": "IMMEDIATE",
    "paymentDays": null,
    "paymentFixedDay": null,
    "creditLimit": null,
    "bankIban": "ES9121000418450200051332",
    "sepaMandate": {
      "reference": "SEPA-CLIENTE-1",
      "signedAt": "2026-07-01"
    }
  }
}
```

Reglas de vencimiento:

- `IMMEDIATE`: `paymentDays` y `paymentFixedDay` deben ser `null`.
- `DAYS`: `paymentDays` debe tener valor y `paymentFixedDay` debe ser `null`.
- `FIXED_DAY_OF_MONTH`: `paymentFixedDay` debe tener valor y `paymentDays` debe ser `null`.
- Si `defaultPaymentMethod = DIRECT_DEBIT`, deben existir `bankIban` y `sepaMandate`.
- Cambiar `bankIban` invalida el mandato SEPA activo anterior. Cambiar o borrar `sepaMandate` revoca el mandato activo anterior.

Audita `CUSTOMER_UPDATED` con `changedFields`, sin incluir valores de NIF, email, telefono, direccion, IBAN ni importes. Los cambios de mandato generan `CUSTOMER_SEPA_MANDATE_CREATED`, `CUSTOMER_SEPA_MANDATE_REVOKED` o `CUSTOMER_SEPA_MANDATE_INVALIDATED`.

### Cambiar estado

Body:

```json
{ "action": "deactivate" }
```

o:

```json
{ "action": "reactivate" }
```

Respuesta `200`: DTO de cliente actualizado.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CUSTOMER_NOT_FOUND` | El cliente no existe. |
| `409` | `CUSTOMER_TAX_ID_ALREADY_USED` | El identificador fiscal normalizado ya existe. |
| `409` | `CUSTOMER_SEPA_MANDATE_REFERENCE_ALREADY_USED` | La referencia SEPA normalizada ya existe. |
| `409` | `CUSTOMER_STATUS_ALREADY_SET` | El cliente ya estaba en el estado solicitado. |

Audita `CUSTOMER_DEACTIVATED` o `CUSTOMER_REACTIVATED`.

## 6. `GET /api/customers/{customerId}/addresses`

Permiso requerido: `Customers.View`.

Query:

| Parametro | Tipo | Uso |
|---|---|---|
| `type` | `BILLING`, `SHIPPING` u `OTHER` | Filtro por tipo. |
| `status` | `ACTIVE` o `INACTIVE` | Filtro de estado. |

Respuesta `200`:

```json
{
  "customer": {
    "id": "uuid",
    "code": "1",
    "legalName": "Cliente Demo SL",
    "status": "ACTIVE"
  },
  "addresses": [
    {
      "id": "uuid",
      "customerId": "uuid",
      "type": "SHIPPING",
      "status": "ACTIVE",
      "label": "Almacen principal",
      "isPrimary": true,
      "address": {
        "line": "Calle Envio 1",
        "postalCode": "28001",
        "city": "Madrid",
        "province": "Madrid",
        "country": "ES"
      },
      "contact": {
        "name": "Contacto Envio",
        "phone": "+34910000010",
        "email": "contacto@example.test"
      },
      "createdAt": "2026-07-06T12:00:00.000Z",
      "updatedAt": "2026-07-06T12:00:00.000Z"
    }
  ]
}
```

Audita `CUSTOMER_ADDRESSES_VIEWED`.

## 7. `POST /api/customers/{customerId}/addresses`

Permiso requerido: `Customers.Manage`.

Body:

```json
{
  "type": "SHIPPING",
  "label": "Almacen principal",
  "isPrimary": true,
  "addressLine": "Calle Envio 1",
  "postalCode": "28001",
  "city": "Madrid",
  "province": "Madrid",
  "country": "ES",
  "contactName": "Contacto Envio",
  "phone": "+34910000010",
  "email": "contacto@example.test",
  "notes": "Observacion interna"
}
```

Respuesta `201`: DTO de direccion.

Si `isPrimary` es `true`, el sistema desmarca cualquier otra direccion principal activa del mismo cliente y tipo dentro de la misma transaccion.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CUSTOMER_NOT_FOUND` | El cliente no existe. |

Audita `CUSTOMER_ADDRESS_CREATED` sin incluir valores completos de direccion, contacto, telefono, email ni observaciones.

## 8. `PATCH /api/customers/{customerId}/addresses/{addressId}`

Permiso requerido: `Customers.Manage`.

### Actualizar datos

Body:

```json
{
  "action": "update",
  "address": {
    "type": "BILLING",
    "label": "Facturacion central",
    "isPrimary": true,
    "addressLine": "Calle Facturacion 1",
    "postalCode": "28001",
    "city": "Madrid",
    "province": "Madrid",
    "country": "ES",
    "contactName": "Administracion",
    "phone": "+34910000010",
    "email": "admin-cliente@example.test",
    "notes": null
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

Al desactivar una direccion, `isPrimary` pasa a `false`.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CUSTOMER_NOT_FOUND` | El cliente no existe. |
| `404` | `CUSTOMER_ADDRESS_NOT_FOUND` | La direccion no existe o no pertenece al cliente. |
| `409` | `CUSTOMER_ADDRESS_STATUS_ALREADY_SET` | La direccion ya estaba en el estado solicitado. |

Audita `CUSTOMER_ADDRESS_UPDATED`, `CUSTOMER_ADDRESS_DEACTIVATED` o `CUSTOMER_ADDRESS_REACTIVATED`.

## 9. `GET /api/customers/{customerId}/stores`

Permiso requerido: `Customers.View`.

Query:

| Parametro | Tipo | Uso |
|---|---|---|
| `status` | `ACTIVE` o `INACTIVE` | Filtro de estado. |

Respuesta `200`:

```json
{
  "customer": {
    "id": "uuid",
    "code": "1",
    "legalName": "Cliente Demo SL",
    "status": "ACTIVE"
  },
  "stores": [
    {
      "id": "uuid",
      "customerId": "uuid",
      "code": "1",
      "name": "Tienda Centro",
      "status": "ACTIVE",
      "isPrimary": true,
      "address": {
        "line": "Calle Tienda 1",
        "postalCode": "28001",
        "city": "Madrid",
        "province": "Madrid",
        "country": "ES"
      },
      "email": "tienda@example.test",
      "phone": "+34910000001",
      "whatsapp": "+34910000002",
      "contact": {
        "name": "Contacto Tienda",
        "role": "Gerencia",
        "phone": "+34910000003",
        "mobile": "+34600000001",
        "whatsapp": "+34600000002",
        "email": "contacto@example.test"
      },
      "createdAt": "2026-07-04T14:00:00.000Z",
      "updatedAt": "2026-07-04T14:00:00.000Z"
    }
  ]
}
```

Audita `CUSTOMER_STORES_VIEWED`.

## 10. `POST /api/customers/{customerId}/stores`

Permiso requerido: `Customers.Manage`.

Body:

```json
{
  "name": "Tienda Centro",
  "isPrimary": true,
  "addressLine": "Calle Tienda 1",
  "postalCode": "28001",
  "city": "Madrid",
  "province": "Madrid",
  "country": "ES",
  "email": "tienda@example.test",
  "phone": "+34910000001",
  "whatsapp": "+34910000002",
  "contactName": "Contacto Tienda",
  "contactRole": "Gerencia",
  "contactPhone": "+34910000003",
  "contactMobile": "+34600000001",
  "contactWhatsapp": "+34600000002",
  "contactEmail": "contacto@example.test",
  "notes": "Observacion interna"
}
```

Respuesta `201`: DTO de tienda.

Si `isPrimary` es `true`, el sistema desmarca cualquier otra tienda principal del mismo cliente dentro de la misma transaccion.

Errores propios:

| Estado | Codigo | Uso |
|---|---|---|
| `404` | `CUSTOMER_NOT_FOUND` | El cliente no existe. |

Audita `CUSTOMER_STORE_CREATED`.

## 11. `PATCH /api/customers/{customerId}/stores/{storeId}`

Permiso requerido: `Customers.Manage`.

### Actualizar datos

Body:

```json
{
  "action": "update",
  "store": {
    "name": "Tienda Centro",
    "isPrimary": true,
    "addressLine": "Calle Tienda 1",
    "postalCode": "28001",
    "city": "Madrid",
    "province": "Madrid",
    "country": "ES",
    "email": "tienda@example.test",
    "phone": "+34910000001",
    "whatsapp": "+34910000002",
    "contactName": "Contacto Tienda",
    "contactRole": "Gerencia",
    "contactPhone": "+34910000003",
    "contactMobile": "+34600000001",
    "contactWhatsapp": "+34600000002",
    "contactEmail": "contacto@example.test",
    "notes": "Observacion interna"
  }
}
```

Audita `CUSTOMER_STORE_UPDATED` con `changedFields`, sin valores de direccion, contacto, email, telefono ni observaciones.

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
| `404` | `CUSTOMER_NOT_FOUND` | El cliente no existe. |
| `404` | `CUSTOMER_STORE_NOT_FOUND` | La tienda no existe o no pertenece al cliente. |
| `409` | `CUSTOMER_STORE_STATUS_ALREADY_SET` | La tienda ya estaba en el estado solicitado. |

Audita `CUSTOMER_STORE_DEACTIVATED` o `CUSTOMER_STORE_REACTIVATED`.
