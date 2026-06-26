# ADR-0009: Autenticacion y sesiones web

## Estado

Aceptada.

## Contexto

CriGestión usa Next.js y se ejecuta como aplicacion web. El navegador no debe almacenar tokens accesibles desde JavaScript ni secretos. La autorizacion debe validarse siempre en servidor.

## Decision

Se usaran sesiones web con token opaco en cookie segura.

Reglas:

- Cookie `HttpOnly`, `Secure` y `SameSite`.
- El token de sesion se genera con entropia suficiente.
- En PostgreSQL se almacena solo el hash del token.
- Cada sesion queda asociada a usuario, expiracion, ultima actividad, version de seguridad, IP y user-agent.
- Cada peticion protegida valida sesion, usuario, rol, permisos y version de seguridad en servidor.
- Las operaciones mutables tendran proteccion CSRF.
- Solo se permite una sesion activa por usuario.

## Alternativas consideradas

- JWT de larga duracion en navegador: mas dificil de revocar y mayor impacto ante robo.
- Token en localStorage: descartado por exposicion ante XSS.
- Autenticacion externa desde el inicio: puede evaluarse mas adelante, pero no es necesaria para la primera version interna.

## Consecuencias

- Se necesita tabla `sessions`.
- Los cambios de contrasena, rol, permisos, bloqueo o desactivacion revocan sesiones.
- Los Route Handlers protegidos deben declarar permiso necesario.
- La UI solo mejora la experiencia; no sustituye la autorizacion server-side.
