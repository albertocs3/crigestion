# Especificacion funcional: Usuarios, Roles, Permisos, Auditoria y Sesiones

## 0. Contexto

Este modulo proporciona identidad, autorizacion y trazabilidad a toda la aplicacion web CriGestión.

La arquitectura vigente usa Next.js. Por tanto, la seguridad de acceso se basa en validacion server-side, sesiones web seguras y permisos comprobados en cada operacion.

## 1. Proposito

El modulo permitira:

- Autenticar usuarios internos mediante nombre de usuario y contrasena.
- Mantener usuarios activos, bloqueados o desactivados.
- Asignar un unico rol a cada usuario.
- Administrar roles personalizados.
- Autorizar acciones por modulo.
- Restringir acceso a informacion economica y sensible.
- Controlar sesiones web.
- Auditar accesos, cambios, consultas sensibles y acciones denegadas.
- Alertar sobre eventos de seguridad.

## 2. Alcance

Incluido:

- Usuarios internos.
- Login con usuario y contrasena.
- Sesion web con cookie `HttpOnly`, `Secure` y `SameSite`.
- Proteccion CSRF en operaciones mutables.
- Roles base protegidos.
- Roles personalizados.
- Matriz de permisos.
- Un unico rol por usuario.
- Una unica sesion simultanea.
- Bloqueo temporal por intentos fallidos.
- Caducidad por inactividad.
- Cierre remoto de sesiones.
- Auditoria append-only a nivel de aplicacion.

Fuera de alcance inicial:

- Usuarios externos o portal de clientes.
- Inicio de sesion con Google, Microsoft o certificado.
- Segundo factor de autenticacion.
- Varios roles simultaneos.
- Permisos asignados directamente a usuarios.
- Simulacion o suplantacion de roles.
- Caducidad periodica obligatoria de contrasenas.
- Reutilizacion historica de contrasenas.

## 3. Usuarios

Datos minimos:

- Identificador.
- Nombre y apellidos.
- Nombre de usuario visible.
- Nombre de usuario normalizado.
- Telefono opcional.
- Rol.
- Estado.
- Hash de contrasena.
- Fecha del ultimo cambio de contrasena.
- Intentos fallidos.
- Bloqueo hasta fecha.
- Version de seguridad.
- Ultimo acceso correcto.

Reglas:

- El nombre de usuario normalizado es unico.
- Un nombre utilizado se reserva y no puede reutilizarse tras una baja.
- Los usuarios no se eliminan.
- Un usuario conserva su identidad historica en auditoria.
- Cada usuario tiene exactamente un rol activo para acceder.

## 4. Estados de usuario

- `Activo`: puede iniciar sesion si su rol tambien esta activo.
- `Bloqueado`: no puede iniciar sesion hasta terminar el bloqueo o desbloqueo manual.
- `Desactivado`: no puede iniciar sesion y sus sesiones se revocan.

## 5. Contrasenas

Requisitos minimos:

- 12 caracteres.
- Una letra mayuscula.
- Una letra minuscula.
- Un numero.
- Un caracter especial.

Reglas:

- Nunca se guarda ni registra la contrasena en texto claro.
- El servidor calcula el hash.
- El hash debe usar algoritmo resistente y parametrizable, preferiblemente Argon2id o PBKDF2 con parametros versionados.
- Cambiar o restablecer la contrasena incrementa la version de seguridad y revoca sesiones.
- Los errores de login no deben indicar si falla el usuario o la contrasena.

## 6. Bloqueo por intentos fallidos

- Se permiten cinco intentos fallidos consecutivos.
- Al quinto intento, la cuenta se bloquea durante 30 minutos.
- Un intento durante el bloqueo no debe filtrar informacion adicional.
- Cada intento se registra en `login_attempts`.
- Se registra IP, user-agent, usuario normalizado, resultado y codigo de fallo seguro.

## 7. Sesiones web

Decision:

- La sesion se representa en base de datos.
- El navegador recibe solo un token opaco en cookie segura.
- En base de datos se guarda el hash del token, nunca el token en claro.
- Cada peticion server-side valida cookie, hash, expiracion, revocacion, usuario, rol y version de seguridad.

Cookies:

- `HttpOnly`.
- `Secure` en entornos no locales.
- `SameSite=Lax` como minimo.
- `Path=/`.
- Sin acceso desde JavaScript cliente.

Caducidad:

- Maximo inicial: cinco horas sin actividad.
- Renovacion al realizar actividad valida en servidor.
- Aviso en UI antes de caducar.

Sesion unica:

- Un usuario solo puede mantener una sesion activa.
- Un nuevo inicio de sesion se rechaza si ya existe otra sesion activa.
- Cambio de contrasena, rol, permisos, bloqueo o desactivacion revoca sesiones.

## 8. CSRF

Como la arquitectura usa navegador y cookies, toda operacion mutable debe protegerse frente a CSRF.

Controles aceptables:

- Token CSRF por sesion para formularios y Route Handlers mutables.
- Verificacion de `Origin` y `Host` en peticiones mutables.
- `SameSite` en cookies como defensa adicional, no unica.

No se debe confiar solo en ocultar botones en UI.

## 9. Roles y permisos

Roles base:

- Administrador.
- Facturacion.
- Contabilidad.
- Tecnico.

Reglas:

- Los roles base estan protegidos.
- Un rol personalizado debe tener al menos un permiso.
- Los permisos se asignan al rol, no directamente al usuario.
- Cambiar permisos de un rol incrementa version de seguridad o revoca sesiones afectadas.
- La UI oculta acciones no permitidas, pero el servidor vuelve a validar cada operacion.

Formato de permisos:

```text
Modulo.Accion
```

Ejemplos:

- `Platform.ManageUsers`.
- `Platform.ManageRoles`.
- `Platform.ManageSessions`.
- `Platform.ManageConfiguration`.
- `Platform.ViewAudit`.
- `Billing.Issue`.
- `Accounting.Post`.

## 10. Datos sensibles

Datos especialmente protegidos:

- Contrasenas.
- Tokens de sesion.
- Certificados y claves.
- IBAN.
- NIF completo cuando no sea necesario.
- Datos economicos.
- Costes y margenes.

Reglas:

- Costes y margenes son exclusivos del administrador.
- El rol Tecnico no accede a datos fiscales, bancarios, contractuales ni economicos.
- Las descargas, exportaciones y adjuntos vuelven a comprobar permisos.
- Los logs y errores no contienen secretos ni payloads sensibles completos.

## 11. Auditoria

Se auditan:

- Login correcto y fallido.
- Logout.
- Revocacion y caducidad de sesion.
- Bloqueos y desbloqueos.
- Cambios y restablecimientos de contrasena.
- Creacion, modificacion y desactivacion de usuarios.
- Cambios de rol.
- Cambios de permisos.
- Acciones denegadas.
- Consultas de datos sensibles.
- Exportaciones y descargas.
- Uso de certificados.

La auditoria no contiene contrasenas, tokens, certificados ni secretos.

## 12. Endpoints y Route Handlers

Cada Route Handler debe declarar:

- Si requiere sesion.
- Permiso necesario.
- Si requiere CSRF.
- Validacion Zod de entrada.
- Tipo de auditoria.

Excepciones:

- `GET /api/health` puede ser publico si no revela informacion sensible.
- `GET /api/platform/installation` puede ser publico antes de inicializacion.
- `POST /api/platform/installation/initialize` solo puede estar abierto mientras no exista instalacion y debe estar protegido por idempotencia, validacion estricta y rate limit.

## 13. Criterios generales de aceptacion

1. Los usuarios no se eliminan.
2. Los nombres de usuario no se reutilizan.
3. Cada usuario tiene un unico rol.
4. Los permisos se asignan solo mediante roles.
5. Las acciones sin permiso se ocultan y se rechazan en servidor.
6. Las contrasenas se reciben solo por HTTPS y se guardan como hash.
7. Los tokens de sesion no se guardan en claro.
8. Las cookies de sesion son `HttpOnly`, `Secure` y `SameSite`.
9. Las mutaciones tienen proteccion CSRF.
10. Solo se admite una sesion simultanea.
11. La sesion caduca por inactividad.
12. Los cambios de seguridad revocan sesiones.
13. Los intentos fallidos se registran y bloquean la cuenta tras el limite.
14. La auditoria registra accesos, consultas sensibles, exportaciones y acciones denegadas.
15. La auditoria no puede modificarse desde la aplicacion.
16. El rol Tecnico no accede a datos fiscales, economicos ni bancarios.
17. Costes y margenes son exclusivos del administrador.
18. Los endpoints documentan sesion, permisos, CSRF y auditoria.
19. Cada cambio relevante identifica categorias OWASP Top 10 afectadas.
20. Los controles minimos de [OWASP Top 10:2025](02-owasp-top-10.md) se aplican antes de produccion.

## 14. OWASP Top 10

Los controles OWASP aplicables a CriGestión se mantienen en [OWASP Top 10:2025 - Controles Para CriGestión](02-owasp-top-10.md).

Toda tarea de seguridad, API, persistencia, despliegue o UI que toque datos sensibles debe revisar ese documento.

## 15. Decisiones pendientes para diseno tecnico

- Elegir libreria o implementacion final de autenticacion.
- Elegir algoritmo final de hash: Argon2id o PBKDF2 versionado.
- Definir mecanismo exacto de token CSRF.
- Definir catalogo completo de permisos por modulo.
- Definir retencion de auditoria y login attempts.
