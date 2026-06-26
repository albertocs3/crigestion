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
- Correlation ID pendiente de integrar en middleware.

## 3. Health

### `GET /api/health`

Respuesta `200`:

```json
{
  "status": "ok",
  "database": "ok",
  "timestamp": "2026-06-26T10:00:00.000Z"
}
```

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
| `Origin` | Cuando exista | Debe coincidir con `APP_BASE_URL` |

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

Errores:

| Estado | Codigo | Causa |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Falta la cabecera |
| 400 | `INVALID_JSON` | Cuerpo JSON mal formado |
| 403 | `ORIGIN_NOT_ALLOWED` | Origen no permitido |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | No se envio JSON |
| 422 | `VALIDATION_ERROR` | Payload invalido |
| 409 | `PLATFORM_ALREADY_INITIALIZED` | Ya existe instalacion |

## 6. Seguridad

- La contrasena se recibe solo en la peticion de inicializacion.
- El servidor calcula `passwordHash`.
- La contrasena debe cumplir complejidad minima: 12 caracteres, mayuscula, minuscula, numero y caracter especial.
- El usuario solo admite letras, numeros, punto, guion y guion bajo.
- El usuario se normaliza para evitar duplicados por mayusculas o espacios.
- El primer administrador queda asociado al rol `Administrador`.
- La contrasena no se guarda en auditoria ni logs.
- El navegador nunca accede a `DATABASE_URL`.

## 7. Contratos pendientes de acceso

La autenticacion posterior debera exponer contratos para:

- `POST /api/auth/login`.
- `POST /api/auth/logout`.
- `GET /api/auth/session`.
- `POST /api/auth/change-password`.

Todos usaran sesion web con cookie segura, validacion Zod, proteccion CSRF en mutaciones y auditoria.

## 8. Criterios de aceptacion

1. Ningun contrato devuelve modelos Prisma completos como compromiso publico.
2. Los errores son estables.
3. La inicializacion valida entrada y usa transaccion.
4. La segunda inicializacion devuelve conflicto.
