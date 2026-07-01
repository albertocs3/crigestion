# OWASP Top 10:2025 - Controles Para CriGestión

## 1. Proposito

Este documento convierte OWASP Top 10:2025 en requisitos verificables para CriGestión.

Fuente oficial: [OWASP Top 10:2025](https://owasp.org/Top10/2025/).

OWASP define el Top 10 como un documento de concienciacion para desarrolladores y seguridad de aplicaciones web que representa consenso amplio sobre los riesgos mas criticos.

## 2. Lista OWASP Top 10:2025

| OWASP | Riesgo | Control minimo en CriGestión |
|---|---|---|
| A01 | Broken Access Control | RBAC server-side, permisos por endpoint, comprobacion contextual, pruebas de acceso denegado |
| A02 | Security Misconfiguration | Cabeceras seguras, CSP, errores seguros, `poweredByHeader: false`, configuracion por entorno |
| A03 | Software Supply Chain Failures | `npm audit`, lockfile, dependencias justificadas, CI con auditoria |
| A04 | Cryptographic Failures | HTTPS, cookies seguras, hashes de contrasena, cifrado de secretos y certificados |
| A05 | Injection | Prisma parametrizado, Zod, no SQL interpolado, validacion de filtros/ordenacion |
| A06 | Insecure Design | Threat modeling por flujo critico, ADRs, idempotencia, transacciones, revision por subagente |
| A07 | Authentication Failures | Sesiones opacas, hash de token, bloqueo por intentos, revocacion, no `localStorage` |
| A08 | Software or Data Integrity Failures | Migraciones revisadas, seeds idempotentes, integridad de backups, control de CI/CD |
| A09 | Security Logging and Alerting Failures | Auditoria de accesos, acciones denegadas, exportaciones, uso de certificados y alertas |
| A10 | Mishandling of Exceptional Conditions | Manejo centralizado de errores, no secretos en errores/logs, estados de fallo recuperables |

## 3. Requisitos Por Categoria

### A01 - Broken Access Control

- Cada Route Handler declara si es publico o autenticado.
- Cada operacion protegida valida permiso en servidor.
- Los identificadores de recurso no bastan para autorizar.
- Las vistas agregadas vuelven a comprobar permisos por modulo.
- Las descargas y exportaciones repiten la autorizacion.
- Los tests deben cubrir acceso horizontal y vertical no autorizado.

### A02 - Security Misconfiguration

- `next.config.mjs` desactiva `X-Powered-By`.
- La aplicacion define cabeceras base:
  - `Content-Security-Policy`.
  - `X-Content-Type-Options`.
  - `X-Frame-Options`.
  - `Referrer-Policy`.
  - `Permissions-Policy`.
- Los errores no exponen stack traces en produccion.
- Las variables de entorno se validan al arranque.
- Las rutas internas no revelan topologia, secretos ni configuracion sensible.

### A03 - Software Supply Chain Failures

- Usar lockfile cuando se instalen dependencias.
- Ejecutar `npm audit --audit-level=high` en CI.
- Revisar dependencias nuevas antes de incorporarlas.
- No ejecutar scripts externos no revisados.
- Mantener imagenes Docker base actualizadas.

### A04 - Cryptographic Failures

- HTTPS obligatorio en produccion.
- Cookies `HttpOnly`, `Secure`, `SameSite`.
- Hash de contrasenas con algoritmo parametrizable y versionado.
- Hash de token de sesion en base; token en claro solo en cookie.
- Certificados VeriFactu cifrados server-side.
- Claves y secretos fuera del repositorio.

### A05 - Injection

- Validar entradas con Zod.
- Usar Prisma Client para queries ordinarias.
- Si se usa SQL crudo, debe ser parametrizado.
- Whitelist para filtros, campos de ordenacion y columnas exportables.
- No pasar texto de usuario a comandos del sistema.

### A06 - Insecure Design

- Crear ADR para decisiones de seguridad relevantes.
- Hacer threat modeling ligero para:
  - login,
  - sesiones,
  - permisos,
  - facturacion,
  - VeriFactu,
  - certificados,
  - copias/restauracion.
- Usar idempotencia en mutaciones repetibles.
- Mantener transacciones para invariantes economicas.
- Delegar revision independiente a subagentes en cambios criticos.

### A07 - Authentication Failures

- Sesion opaca en cookie segura.
- Una sesion activa por usuario.
- Bloqueo por intentos fallidos.
- Revocacion en cambio de contrasena, rol, permisos, bloqueo o desactivacion.
- No diferenciar en login si falla usuario o contrasena.
- Registrar intentos sin guardar contrasenas.

### A08 - Software or Data Integrity Failures

- Revisar migraciones antes de produccion.
- Seeds idempotentes y sin datos reales sensibles.
- CI/CD con build, tests, auditoria y migraciones controladas.
- Backups cifrados y restauracion probada.
- Verificar integridad de ficheros adjuntos y copias.

### A09 - Security Logging and Alerting Failures

- Auditar:
  - login correcto y fallido,
  - acciones denegadas,
  - cambios de permisos,
  - cambios de usuarios,
  - consultas sensibles,
  - exportaciones,
  - descargas,
  - uso de certificados,
  - errores VeriFactu.
- No auditar secretos.
- Alertar al administrador ante patrones anormales.
- Mantener correlacion entre UI, API, jobs y auditoria.

### A10 - Mishandling of Exceptional Conditions

- Capturar JSON invalido, contenido no soportado y errores de validacion.
- Devolver codigos funcionales estables.
- No exponer stack traces ni detalles internos.
- Registrar errores tecnicos con correlation id.
- Disenar estados recuperables para integraciones externas.

## 4. Checklist Para Pull Requests

Antes de cerrar un cambio relevante:

1. Se identifico que categorias OWASP toca.
2. Se validan entradas externas.
3. Se comprueban permisos en servidor.
4. No se exponen secretos en respuesta, log o auditoria.
5. No hay SQL o comandos interpolados con entrada de usuario.
6. Las mutaciones con cookie tienen CSRF.
7. Hay rate limit si el endpoint es sensible.
8. Hay auditoria si afecta a seguridad, datos sensibles o negocio critico.
9. Hay pruebas proporcionales al riesgo.
10. Un subagente reviso cambios de seguridad no triviales.

## 5. Comandos De Validacion

Cuando el entorno lo permita:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run audit
```

Ademas, para seguridad dinamica se recomienda incorporar OWASP ZAP contra un entorno de pruebas antes de produccion.
