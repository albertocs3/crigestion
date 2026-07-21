# Contratos HTTP de Plataforma

## 1. Proposito

Define los contratos HTTP iniciales entre la UI web de CriGestión y los Route Handlers de Next.js para la Fase 0.

La API no expone entidades de dominio ni modelos Prisma como contrato estable.

## 2. Convenciones

- Base inicial: `/api/platform`.
- JSON UTF-8.
- Validacion de entrada con Zod.
- Errores con `code` funcional estable.
- Operaciones de escritura idempotentes cuando puedan repetirse.
- Todas las respuestas pasan por `X-Correlation-ID`; si la peticion no lo aporta, el middleware genera uno.
- Los errores emitidos mediante helpers HTTP incluyen `correlationId` en el cuerpo cuando la peticion trae `X-Correlation-ID`.

Formato de error con correlacion:

```json
{
  "code": "FORBIDDEN",
  "message": "No tienes permiso para realizar esta accion.",
  "correlationId": "request-id"
}
```

## 3. Health

### `GET /api/health`

Respuesta `200`:

```json
{
  "status": "ok",
  "database": "ok",
  "verifactu": "disabled",
  "worker": "not_required",
  "timestamp": "2026-06-26T10:00:00.000Z"
}
```

`status` puede ser `ok`, `degraded` o `unavailable`. La ruta responde `200`
para `ok` y `degraded`, y `503` cuando PostgreSQL no responde o la base
declarada no coincide con el aislamiento exigido. `verifactu` solo publica
`disabled`, `ok` o `degraded`; `worker`, `not_required`, `ok` o `degraded`.
La respuesta usa `Cache-Control: no-store` y no expone nombres de base, host,
puerto, identificadores, endpoints, versiones, contadores ni codigos internos.

## 4. Estado de instalacion

### `GET /api/platform/installation`

Respuesta `200`:

```json
{
  "initialized": false,
  "installation": null
}
```

Cuando existe instalacion:

```json
{
  "initialized": true,
  "installation": {
    "id": "uuid",
    "status": "INITIALIZED",
    "startedAt": "2026-06-26T10:00:00.000Z",
    "completedAt": "2026-06-26T10:00:01.000Z",
    "productVersion": "0.1.0"
  }
}
```

## 5. Inicializar plataforma

### `POST /api/platform/installation/initialize`

Cabeceras:

| Cabecera | Obligatoria | Uso |
|---|---|---|
| `Idempotency-Key` | Si | Evitar duplicados por reintentos |
| `Content-Type: application/json` | Si | Rechazar cuerpos no JSON |
| `Origin` | Cuando exista | Debe coincidir con el origen normalizado de `APP_BASE_URL`; en produccion `APP_BASE_URL` debe estar configurado |

Request:

```json
{
  "company": {
    "legalName": "CriGestión S.L.",
    "taxId": "B00000000",
    "email": "admin@example.com"
  },
  "administrator": {
    "displayName": "Administrador",
    "userName": "admin",
    "password": "Cambiar-esta-clave-2026"
  }
}
```

Respuesta `201`:

```json
{
  "id": "uuid",
  "singletonKey": 1,
  "status": "INITIALIZED",
  "productVersion": "0.1.0"
}
```

Si se repite la misma peticion con la misma `Idempotency-Key`, la API puede
devolver `200` con el mismo cuerpo de respuesta ya confirmado.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |
| 409 | `PLATFORM_ALREADY_INITIALIZED` | Ya existe instalacion |
| 409 | `IDEMPOTENCY_KEY_REUSED` | La misma clave se uso con otro cuerpo |
| 429 | `RATE_LIMITED` | Demasiados intentos de inicializacion |

La respuesta `429` incluye la cabecera `Retry-After` y el campo `retryAfterSeconds`.

## 6. Seguridad

- La contrasena se recibe solo en la peticion de inicializacion.
- El servidor calcula `passwordHash`.
- La contrasena debe cumplir complejidad minima: 12 caracteres, mayuscula, minuscula, numero y caracter especial.
- El usuario solo admite letras, numeros, punto, guion y guion bajo.
- El usuario se normaliza para evitar duplicados por mayusculas o espacios.
- El primer administrador queda asociado al rol `Administrador`.
- La contrasena no se guarda en auditoria ni logs.
- El navegador nunca accede a `DATABASE_URL`.
- Aplica rate limit atomico por IP confiable/ventana sobre intentos de inicializacion. En produccion solo se confia en cabeceras de proxy si `TRUST_PROXY_HEADERS=true`.

## 7. Autenticacion y sesiones

### `POST /api/auth/login`

Endpoint publico mientras exista instalacion inicializada.

Request:

```json
{
  "userName": "admin",
  "password": "Cambiar-esta-clave-2026"
}
```

Respuesta `200`:

```json
{
  "authenticated": true,
  "user": {
    "id": "uuid",
    "displayName": "Administrador",
    "userName": "admin",
    "role": {
      "code": "Administrador",
      "name": "Administrador"
    },
    "permissions": ["Platform.ManageUsers"]
  },
  "expiresAt": "2026-06-26T15:00:00.000Z"
}
```

Efectos:

- Crea una sesion en `sessions`.
- Guarda solo hash del token.
- Devuelve el token solo en cookie `HttpOnly`, `Secure` en produccion, `SameSite=Lax` por defecto, `Path=/`.
- Registra `login_attempts`.
- Audita `LOGIN_SUCCEEDED` o `LOGIN_FAILED` sin contrasena.
- Aplica rate limit atomico por IP confiable/ventana sobre intentos de login. En produccion solo se confia en cabeceras de proxy si `TRUST_PROXY_HEADERS=true`.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `INVALID_CREDENTIALS` | Usuario, contrasena o estado no validos; incluye cuentas bloqueadas |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 409 | `ACTIVE_SESSION_EXISTS` | Ya existe una sesion activa |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |
| 429 | `LOGIN_RATE_LIMITED` | Demasiados intentos recientes desde la misma IP confiable |

El estado bloqueado se conserva solo en `login_attempts` y auditoria mediante
`ACCOUNT_LOCKED`; la respuesta publica permanece indistinguible de otras
credenciales invalidas. La respuesta `429` incluye la cabecera `Retry-After` y
el campo `retryAfterSeconds`.

Cuando vence `lockedUntil`, el siguiente intento materializa el desbloqueo:
audita `ACCOUNT_UNLOCKED` con motivo `LOCK_EXPIRED`, reinicia el ciclo de fallos
y mantiene el mismo contrato HTTP de login. Al producirse el bloqueo se revocan
las sesiones previas con motivo `ACCOUNT_LOCKED`, evitando que recuperen validez
cuando termine el plazo.

### `GET /api/auth/session`

Respuesta sin sesion:

```json
{
  "authenticated": false
}
```

Respuesta con sesion valida:

```json
{
  "authenticated": true,
  "user": {
    "id": "uuid",
    "displayName": "Administrador",
    "userName": "admin",
    "role": {
      "code": "Administrador",
      "name": "Administrador"
    },
    "permissions": ["Platform.ManageUsers"]
  },
  "expiresAt": "2026-06-26T15:00:00.000Z"
}
```

### `GET /api/auth/csrf`

Requiere cookie de sesion.

Respuesta `200`:

```json
{
  "csrfToken": "token"
}
```

El token devuelto debe enviarse en `X-CSRF-Token` en mutaciones autenticadas con cookie.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No hay sesion activa |

### `POST /api/auth/logout`

Requiere cookie de sesion y cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Respuesta `200`:

```json
{
  "authenticated": false
}
```

Efectos:

- Marca `revokedAt`.
- Guarda motivo `USER_LOGOUT`.
- Borra la cookie.
- Audita `LOGOUT_SUCCEEDED`.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 401 | `UNAUTHENTICATED` | No hay sesion activa |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |

### `POST /api/auth/change-password`

Requiere cookie de sesion y cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "currentPassword": "Cambiar-esta-clave-2026",
  "newPassword": "Nueva-clave-segura-2026"
}
```

Respuesta `200`:

```json
{
  "passwordChanged": true
}
```

Efectos:

- Verifica la contrasena actual.
- Guarda solo el hash de la nueva contrasena.
- Incrementa `securityVersion`.
- Revoca las sesiones activas del usuario con motivo `USER_PASSWORD_CHANGED`.
- Borra la cookie de sesion actual.
- Audita `PASSWORD_CHANGED` o `PASSWORD_CHANGE_FAILED` sin contrasenas ni hashes.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 401 | `INVALID_CURRENT_PASSWORD` | La contrasena actual no coincide |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 409 | `PASSWORD_REUSE_NOT_ALLOWED` | La nueva contrasena coincide con la actual |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |

## 8. Usuarios, roles y permisos

### `GET /api/platform/users`

Endpoint autenticado.

Permiso requerido: `Platform.ManageUsers`.

Respuesta `200`:

```json
{
  "users": [
    {
      "id": "uuid",
      "displayName": "Administrador",
      "userName": "admin",
      "status": "ACTIVE",
      "role": {
        "code": "Administrador",
        "name": "Administrador"
      },
      "failedLoginCount": 0,
      "lockedUntil": null,
      "lastLoginAt": "2026-06-26T10:00:00.000Z",
      "createdAt": "2026-06-26T10:00:00.000Z"
    }
  ]
}
```

### `POST /api/platform/users`

Endpoint autenticado.

Permiso requerido: `Platform.ManageUsers`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "displayName": "Usuario interno",
  "userName": "usuario",
  "password": "Cambiar-esta-clave-2026",
  "roleCode": "Administrador"
}
```

Respuesta `201`: usuario creado sin `passwordHash`.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 409 | `USER_NAME_ALREADY_USED` | El usuario actual o reservado ya existe |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `ROLE_NOT_FOUND` | El rol indicado no existe |
| 422 | `VALIDATION_ERROR` | Payload invalido |

### `PATCH /api/platform/users/{userId}`

Endpoint autenticado.

Permiso requerido: `Platform.ManageUsers`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "action": "deactivate"
}
```

Tambien admite:

```json
{
  "action": "changeRole",
  "roleCode": "ConsultaAuditoria"
}
```

Acciones admitidas:

- `deactivate`.
- `reactivate`.
- `changeRole`.

Respuesta `200`: usuario actualizado sin `passwordHash`.

Efectos:

- `deactivate` marca el usuario como `INACTIVE`.
- `deactivate` revoca sesiones activas del usuario.
- `reactivate` marca el usuario como `ACTIVE` y reinicia bloqueo/intentos.
- `changeRole` asigna el nuevo rol y revoca sesiones activas del usuario.
- Las acciones mutadoras incrementan `securityVersion`.
- Audita `USER_DEACTIVATED`, `USER_REACTIVATED` o `USER_ROLE_CHANGED`.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 404 | `USER_NOT_FOUND` | El usuario no existe |
| 409 | `SELF_ROLE_CHANGE_NOT_ALLOWED` | Intento de cambiar el propio rol |
| 409 | `SELF_STATUS_CHANGE_NOT_ALLOWED` | Intento de cambiar el propio estado |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `ROLE_NOT_FOUND` | El rol indicado no existe |
| 422 | `VALIDATION_ERROR` | Payload o identificador invalido |

### `GET /api/platform/roles`

Endpoint autenticado.

Permiso requerido: `Platform.ManageRoles`.

Respuesta `200`:

```json
{
  "roles": [
    {
      "id": "uuid",
      "code": "Administrador",
      "name": "Administrador",
      "isProtected": true,
      "permissions": [
        {
          "code": "Platform.ManageUsers",
          "name": "Gestionar usuarios"
        }
      ],
      "userCount": 1,
      "createdAt": "2026-06-26T10:00:00.000Z"
    }
  ],
  "permissions": [
    {
      "code": "Platform.ManageUsers",
      "name": "Gestionar usuarios"
    }
  ]
}
```

### `POST /api/platform/roles`

Endpoint autenticado.

Permiso requerido: `Platform.ManageRoles`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "code": "Tecnico",
  "name": "Tecnico",
  "permissionCodes": ["Platform.ViewAudit"]
}
```

Respuesta `201`: rol creado.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 409 | `ROLE_CODE_ALREADY_USED` | El codigo de rol ya existe |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `PERMISSION_NOT_FOUND` | Algun permiso no existe |
| 422 | `VALIDATION_ERROR` | Payload invalido |

### `PATCH /api/platform/roles/{roleId}`

Endpoint autenticado.

Permiso requerido: `Platform.ManageRoles`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "permissionCodes": ["Platform.ViewAudit"]
}
```

Respuesta `200`: rol actualizado.

Efectos:

- Reemplaza la matriz de permisos del rol personalizado.
- Incrementa `securityVersion` de los usuarios del rol.
- Revoca sesiones activas de usuarios del rol con motivo `ROLE_PERMISSIONS_CHANGED`.
- Audita `ROLE_PERMISSIONS_CHANGED` con permisos anteriores y nuevos.
- Rechaza cambios sobre roles protegidos.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 404 | `ROLE_NOT_FOUND` | El rol no existe |
| 409 | `ROLE_PROTECTED` | El rol base protegido no permite editar permisos |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `PERMISSION_NOT_FOUND` | Algun permiso no existe |
| 422 | `VALIDATION_ERROR` | Payload o identificador invalido |

## 9. Sesiones activas

### `GET /api/platform/sessions`

Endpoint autenticado.

Permiso requerido: `Platform.ManageSessions`.

Respuesta `200`:

```json
{
  "sessions": [
    {
      "id": "uuid",
      "user": {
        "id": "uuid",
        "displayName": "Administrador",
        "userName": "admin",
        "role": {
          "code": "Administrador",
          "name": "Administrador"
        }
      },
      "startedAt": "2026-06-26T10:00:00.000Z",
      "lastActivityAt": "2026-06-26T10:05:00.000Z",
      "expiresAt": "2026-06-26T15:00:00.000Z",
      "ipAddress": "203.0.113.10",
      "userAgent": "Mozilla/5.0",
      "isCurrentSession": true
    }
  ]
}
```

No devuelve token, `tokenHash` ni hashes de contrasena.

### `PATCH /api/platform/sessions/{sessionId}`

Endpoint autenticado.

Permiso requerido: `Platform.ManageSessions`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "action": "revoke"
}
```

Respuesta `200`:

```json
{
  "revoked": true
}
```

Efectos:

- Marca `revokedAt`.
- Guarda motivo `ADMIN_SESSION_REVOKED`.
- Audita `SESSION_REVOKED`.
- No permite revocar la sesion actual; para eso se usa logout.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 404 | `SESSION_NOT_FOUND` | La sesion no existe o ya fue revocada |
| 409 | `SELF_SESSION_REVOKE_NOT_ALLOWED` | Intento de revocar la propia sesion |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload o identificador invalido |

## 10. Configuracion

### `GET /api/platform/configuration`

Endpoint autenticado.

Permiso requerido: `Platform.ManageConfiguration`.

Respuesta `200`:

```json
{
  "company": {
    "id": "uuid",
    "legalName": "CriGestion SL",
    "taxId": "B12345678",
    "email": "admin@example.com",
    "updatedAt": "2026-06-26T10:00:00.000Z"
  },
  "installation": {
    "id": "uuid",
    "status": "INITIALIZED",
    "productVersion": "0.1.0",
    "completedAt": "2026-06-26T10:00:00.000Z"
  }
}
```

### `PATCH /api/platform/configuration/company`

Endpoint autenticado.

Permiso requerido: `Platform.ManageConfiguration`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "legalName": "CriGestion SL",
  "taxId": "B12345678",
  "email": "admin@example.com"
}
```

Respuesta `200`: empresa actualizada como DTO.

Efectos:

- Actualiza los datos base de empresa.
- Audita `COMPANY_CONFIGURATION_UPDATED` con campos cambiados, sin guardar valores fiscales/email completos en el payload.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 404 | `CONFIGURATION_NOT_FOUND` | La configuracion no existe |
| 409 | `COMPANY_TAX_ID_ALREADY_USED` | El NIF ya pertenece a otra empresa |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |

### `PATCH /api/platform/configuration/billing`

Endpoint autenticado.

Permiso requerido: `Platform.ManageConfiguration`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "invoiceLegalFooter": "Texto legal de factura",
  "invoiceAccentColor": "#0f766e"
}
```

Respuesta `200`: configuracion de facturacion actualizada.

Efectos:

- Actualiza el pie legal y el color de acento usados en facturas.
- Audita `BILLING_CONFIGURATION_UPDATED` solo con nombres de campos cambiados.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |

## 11. Auditoria

### `GET /api/platform/audit`

Endpoint autenticado.

Permiso requerido: `Platform.ViewAudit`.

Parametros query:

| Parametro | Uso |
|---|---|
| `limit` | Tamano de pagina entre 1 y 100. Por defecto 25 |
| `cursor` | Cursor devuelto por la pagina anterior |
| `eventType` | Filtro opcional por tipo de evento |

Respuesta `200`:

```json
{
  "events": [
    {
      "id": "uuid",
      "eventType": "LOGIN_SUCCEEDED",
      "actorType": "USER",
      "payload": {
        "userId": "uuid"
      },
      "createdAt": "2026-06-26T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Efectos:

- Devuelve DTOs de auditoria, no modelos Prisma.
- Redacta claves sensibles conocidas en `payload`.
- Audita la propia consulta como `AUDIT_VIEWED`.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `FORBIDDEN` | Falta permiso |
| 422 | `VALIDATION_ERROR` | Query invalida |

## 12. Copias de seguridad

### `GET /api/platform/backups`

Endpoint autenticado.

Permiso requerido: `Platform.ManageBackups`.

Parametros query:

| Parametro | Uso |
|---|---|
| `limit` | Tamano de pagina entre 1 y 100. Por defecto 25 |
| `cursor` | Cursor devuelto por la pagina anterior |
| `status` | Filtro opcional: `REQUESTED`, `RUNNING`, `VERIFIED` o `FAILED` |

Respuesta `200`:

```json
{
  "backups": [
    {
      "id": "uuid",
      "status": "VERIFIED",
      "requestedBy": {
        "id": "uuid",
        "displayName": "Administrador",
        "userName": "admin"
      },
      "requestedAt": "2026-07-02T10:00:00.000Z",
      "startedAt": "2026-07-02T10:00:01.000Z",
      "completedAt": "2026-07-02T10:01:00.000Z",
      "productVersion": "0.1.0",
      "sizeBytes": "123456",
      "sha256": "hex-sha256",
      "errorCode": null
    }
  ],
  "nextCursor": null
}
```

Efectos:

- Devuelve DTOs de operaciones de copia, no modelos Prisma.
- No expone rutas fisicas ni `storageKey`.
- Audita la propia consulta como `BACKUP_OPERATIONS_VIEWED`.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `FORBIDDEN` | Falta permiso |
| 422 | `VALIDATION_ERROR` | Query invalida |

La creacion fisica, cifrado y verificacion de la copia se procesa fuera del request HTTP. En desarrollo puede dispararse automaticamente tras registrar la solicitud; en operacion controlada tambien puede ejecutarse con `npm run backup:run`.

### `POST /api/platform/backups`

Endpoint autenticado.

Permiso requerido: `Platform.ManageBackups`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{}
```

Respuesta `202`:

```json
{
  "id": "uuid",
  "status": "REQUESTED",
  "requestedBy": {
    "id": "uuid",
    "displayName": "Administrador",
    "userName": "admin"
  },
  "requestedAt": "2026-07-02T10:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "productVersion": "0.1.0",
  "sizeBytes": null,
  "sha256": null,
  "errorCode": null
}
```

Efectos:

- Registra una operacion `REQUESTED`.
- Impide otra operacion de copia `REQUESTED` o `RUNNING`, o una restauracion activa, de forma simultanea.
- Audita `BACKUP_REQUESTED`.
- No ejecuta el volcado fisico dentro del request HTTP.
- Invoca el procesado automatico si `BACKUP_AUTO_PROCESS` esta habilitado. Sin valor explicito, queda habilitado en desarrollo, deshabilitado en test y deshabilitado en produccion.

El worker `npm run backup:run` procesa la siguiente operacion `REQUESTED`:

1. La marca como `RUNNING`.
2. Ejecuta `pg_dump` sin shell.
3. Cifra el volcado con AES-256-GCM.
4. Guarda el artefacto en `BACKUP_DIRECTORY`.
5. Reabre el artefacto cifrado y valida el tag de autenticacion AES-GCM.
6. Calcula SHA-256 del artefacto cifrado.
7. Marca `VERIFIED` o `FAILED`.
8. Audita `BACKUP_VERIFIED` o `BACKUP_FAILED`.

Antes de procesar nuevas solicitudes, el worker marca como `FAILED` las operaciones `RUNNING` que superen `BACKUP_RUNNING_TIMEOUT_MINUTES`, con error `BACKUP_WORKER_TIMEOUT`.

`VERIFIED` confirma integridad criptografica del artefacto cifrado. La comprobacion de restaurabilidad con `pg_restore` se realizara en el flujo de restauracion controlada.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 409 | `BACKUP_OPERATION_ALREADY_ACTIVE` | Ya existe una copia solicitada/en ejecucion o una restauracion activa |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |

### `GET /api/platform/restores`

Endpoint autenticado.

Permiso requerido: `Platform.ManageBackups`.

Parametros query:

| Parametro | Uso |
|---|---|
| `limit` | Tamano de pagina entre 1 y 100. Por defecto 25 |
| `cursor` | Cursor devuelto por la pagina anterior |
| `status` | Filtro opcional por estado de restauracion |

Respuesta `200`:

```json
{
  "restores": [
    {
      "id": "uuid",
      "status": "REQUESTED",
      "backup": {
        "id": "uuid",
        "productVersion": "0.1.0",
        "requestedAt": "2026-07-02T10:00:00.000Z",
        "completedAt": "2026-07-02T10:01:00.000Z",
        "sizeBytes": "123456",
        "sha256": "hex-sha256"
      },
      "requestedBy": {
        "id": "uuid",
        "displayName": "Administrador",
        "userName": "admin"
      },
      "reason": "Restauracion de prueba controlada",
      "requestedAt": "2026-07-02T11:00:00.000Z",
      "startedAt": null,
      "validatedAt": null,
      "completedAt": null,
      "errorCode": null
    }
  ],
  "nextCursor": null
}
```

Efectos:

- Devuelve DTOs de restauracion, no modelos Prisma.
- No expone rutas fisicas ni `storageKey` de la copia.
- Audita la propia consulta como `RESTORE_OPERATIONS_VIEWED`.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `FORBIDDEN` | Falta permiso |
| 422 | `VALIDATION_ERROR` | Query invalida |

### `POST /api/platform/restores`

Endpoint autenticado.

Permiso requerido: `Platform.ManageBackups`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{
  "backupOperationId": "uuid",
  "reason": "Restauracion de prueba controlada"
}
```

Respuesta `202`: restauracion registrada en estado `REQUESTED`.

Efectos:

- Registra una solicitud de restauracion; no ejecuta todavia `pg_restore`.
- Exige que la copia exista, este `VERIFIED`, tenga metadatos de integridad y pertenezca a la misma `productVersion`.
- Impide crear la solicitud si existe una copia `REQUESTED`/`RUNNING` o una restauracion activa.
- Audita `RESTORE_REQUESTED` sin rutas ni secretos.

El comando operativo `npm run restore:validate` procesa solicitudes `REQUESTED` de forma no destructiva:

1. `REQUESTED -> VALIDATING`.
2. Valida contencion de `storageKey`, `sizeBytes`, `sha256` y autenticacion AES-GCM del artefacto cifrado.
3. `VALIDATING -> VALIDATED` si la validacion termina correctamente.
4. `VALIDATING -> FAILED` si detecta artefacto ausente, alterado, no descifrable, metadatos incompatibles o configuracion invalida.

Eventos auditables del worker:

- `RESTORE_VALIDATION_STARTED`.
- `RESTORE_VALIDATED`.
- `RESTORE_VALIDATION_FAILED`.

El comando operativo `npm run restore:apply` orquesta la aplicacion real fuera
del request HTTP y solo puede partir de una restauracion `VALIDATED` con modo
mantenimiento activo:

1. `VALIDATED -> PREPARING`.
2. Crea una copia previa obligatoria mediante el mismo mecanismo de backup.
3. Si la copia previa queda `VERIFIED`, enlaza `preRestoreBackupOperationId`.
4. `PREPARING -> RESTORING`.
5. Ejecuta `pg_restore` contra `RESTORE_TARGET_DATABASE_URL`, leyendo el
   artefacto descifrado por stdin, usando una unica transaccion y pasando la
   contrasena solo como `PGPASSWORD`. En Windows puede usar shell solo cuando el
   binario configurado sea `.cmd` o `.bat`.
6. `RESTORING -> COMPLETED` si termina correctamente.
   Antes de responder, repone el mantenimiento `RESTORE`, incrementa la
   `securityVersion` de todos los usuarios y revoca todas las sesiones activas.
   El resultado queda marcado con `restartRequired: true`; el mantenimiento no
   debe desactivarse hasta reiniciar todos los procesos de la aplicacion.
7. `RESTORING -> FAILED` si la configuracion del destino no es valida.
8. `RESTORING -> REQUIRES_RECOVERY` si falla el puerto destructivo despues de
   la copia previa.

Eventos auditables de aplicacion:

- `RESTORE_PREPARING_STARTED`.
- `PRE_RESTORE_BACKUP_VERIFIED`.
- `RESTORE_APPLY_STARTED`.
- `RESTORE_COMPLETED`.
- `RESTORE_SESSIONS_INVALIDATED`.
- `RESTORE_APPLY_FAILED`.
- `RESTORE_REQUIRES_RECOVERY`.

El puerto destructivo no debe exponer rutas fisicas, `storageKey`, contrasenas ni
material criptografico en auditoria. Si la aplicacion se dispara desde HTTP, los
eventos conservan `actorUserId` y `correlationId`. La implementacion concreta de
`pg_restore` debe ejecutarse en un proceso operativo revisado, porque restaurar
la propia base puede reemplazar tambien las tablas que contienen el estado de la
operacion en curso.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 409 | `BACKUP_NOT_RESTORABLE` | La copia no esta verificada, es incompatible o no tiene metadatos completos |
| 409 | `BACKUP_VERSION_INCOMPATIBLE` | La copia pertenece a otra version de producto |
| 409 | `RESTORE_OPERATION_ALREADY_ACTIVE` | Ya existe una copia o restauracion activa |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |

### `POST /api/platform/restores/apply`

Endpoint autenticado.

Permiso requerido: `Platform.ManageMaintenance`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Request:

```json
{}
```

Respuesta `200` si la restauracion finaliza:

```json
{
  "processed": true,
  "operationId": "uuid",
  "status": "COMPLETED",
  "backupOperationId": "uuid",
  "preRestoreBackupOperationId": "uuid",
  "revokedSessionCount": 3,
  "versionedUserCount": 3,
  "restartRequired": true
}
```

Reglas:

- No acepta `restoreOperationId` desde el navegador.
- En produccion no ejecuta el paso destructivo y devuelve
  `503 RESTORE_APPLY_REQUIRES_OPERATIVE_RUNNER`; debe usarse el runner operativo
  con la aplicacion y los workers detenidos.
- Aplica la siguiente restauracion `VALIDATED` que tenga mantenimiento activo en modo `RESTORE`.
- Crea y verifica una copia previa antes de ejecutar `pg_restore`.
- En desarrollo, si `RESTORE_TARGET_DATABASE_URL` no esta definida, puede usar `DATABASE_URL` como destino.
- En produccion, `RESTORE_TARGET_DATABASE_URL` debe estar definida explicitamente.
- Una finalizacion correcta repone el mantenimiento, invalida todas las sesiones
  por revocacion y cambio de version de seguridad, y exige reiniciar la aplicacion
  antes de desactivar mantenimiento.
- `PATCH /api/platform/maintenance` devuelve `409 RESTORE_RESTART_REQUIRED` si
  el proceso que intenta desactivar mantenimiento se inicio antes del restore.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 409 | `NO_VALIDATED_RESTORE_IN_MAINTENANCE` | No hay restauracion validada con mantenimiento activo |
| 422 | `VALIDATION_ERROR` | Payload invalido |
| 500 | Ver tabla de errores de restauracion | El worker registro la restauracion como fallida o requiere recuperacion |
| 503 | `RESTORE_APPLY_REQUIRES_OPERATIVE_RUNNER` | El apply HTTP esta deshabilitado en produccion |

Errores de worker:

| Codigo | Causa |
|---|---|
| `RESTORE_BACKUP_NOT_RESTORABLE` | La copia ya no es verificada, compatible o completa |
| `RESTORE_BACKUP_STORAGE_KEY_INVALID` | El identificador del artefacto no queda contenido en `BACKUP_DIRECTORY` |
| `RESTORE_BACKUP_ARTIFACT_NOT_FOUND` | El artefacto no existe |
| `RESTORE_BACKUP_SIZE_MISMATCH` | El tamano real no coincide con `sizeBytes` |
| `RESTORE_BACKUP_SHA256_MISMATCH` | El hash real no coincide con `sha256` |
| `RESTORE_BACKUP_DECRYPTION_FAILED` | El encabezado, payload o tag AES-GCM no valida |
| `BACKUP_ENCRYPTION_KEY_INVALID` | La clave de cifrado no es valida |
| `RESTORE_ENV_INVALID` | La configuracion minima del worker no es valida |
| `RESTORE_WORKER_TIMEOUT` | Una validacion quedo atascada mas alla del timeout configurado |
| `PRE_RESTORE_BACKUP_FAILED` | No se pudo crear o verificar la copia previa obligatoria |
| `RESTORE_APPLY_PORT_NOT_CONFIGURED` | No hay puerto operativo configurado para el paso destructivo |
| `RESTORE_TARGET_DATABASE_URL_INVALID` | Falta la base destino de restauracion o no es PostgreSQL |
| `RESTORE_APPLY_FAILED` | Fallo el puerto operativo durante el paso destructivo |

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 404 | `BACKUP_NOT_FOUND` | La copia indicada no existe |
| 409 | `BACKUP_NOT_RESTORABLE` | La copia no esta verificada o no tiene metadatos completos |
| 409 | `BACKUP_VERSION_INCOMPATIBLE` | La copia pertenece a otra version del producto |
| 409 | `RESTORE_OPERATION_ALREADY_ACTIVE` | Ya existe una copia o restauracion activa |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |

## 13. Modo mantenimiento

### `GET /api/platform/maintenance`

Endpoint autenticado.

Permiso requerido: `Platform.ManageMaintenance`.

Respuesta `200`:

```json
{
  "enabled": true,
  "mode": "RESTORE",
  "reason": "Ventana de restauracion controlada",
  "restoreOperation": {
    "id": "uuid",
    "status": "VALIDATED",
    "backupOperationId": "uuid"
  },
  "enabledBy": {
    "id": "uuid",
    "displayName": "Administrador",
    "userName": "admin"
  },
  "disabledBy": null,
  "enabledAt": "2026-07-02T12:00:00.000Z",
  "disabledAt": null
}
```

### `PATCH /api/platform/maintenance`

Endpoint autenticado.

Permiso requerido: `Platform.ManageMaintenance`.

Requiere cabeceras `X-CSRF-Token` e `Idempotency-Key`.

Activar:

```json
{
  "enabled": true,
  "restoreOperationId": "uuid",
  "reason": "Ventana de restauracion controlada"
}
```

Desactivar:

```json
{
  "enabled": false
}
```

Efectos:

- Solo activa mantenimiento para una restauracion `VALIDATED`.
- Audita `MAINTENANCE_MODE_ENABLED` o `MAINTENANCE_MODE_DISABLED`.
- Durante mantenimiento, las mutaciones normales devuelven `423 MAINTENANCE_MODE_ACTIVE` y auditan `MAINTENANCE_MUTATION_BLOCKED`.
- Se mantienen permitidos login, logout, sesion, CSRF, health, consultas de auditoria y lectura de backups/restores para evitar lockout operativo.

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `IDEMPOTENCY_KEY_INVALID` | La cabecera supera la longitud permitida |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 401 | `UNAUTHENTICATED` | No hay sesion valida |
| 403 | `CSRF_TOKEN_INVALID` | Token CSRF ausente o invalido |
| 403 | `FORBIDDEN` | Falta permiso |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 404 | `RESTORE_OPERATION_NOT_FOUND` | La restauracion indicada no existe |
| 409 | `RESTORE_OPERATION_NOT_VALIDATED` | La restauracion no esta validada |
| 409 | `MAINTENANCE_MODE_ALREADY_ENABLED` | El mantenimiento ya esta activo |
| 409 | `MAINTENANCE_MODE_NOT_ENABLED` | El mantenimiento no esta activo |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |
| 423 | `MAINTENANCE_MODE_ACTIVE` | La plataforma esta en modo mantenimiento |

## 14. Criterios de aceptacion

1. Ningun contrato devuelve modelos Prisma completos como compromiso publico.
2. Los errores son estables.
3. La inicializacion valida entrada y usa transaccion.
4. La segunda inicializacion devuelve conflicto.
