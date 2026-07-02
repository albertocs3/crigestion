# Diseno de pantallas de Plataforma

## 1. Proposito

Define la experiencia web inicial de Plataforma para CriGestión con Next.js.

## 2. Pantallas iniciales

| Ruta | Pantalla | Proposito |
|---|---|---|
| `/` | Entrada | Redirigir a instalacion, login o inicio autenticado segun estado |
| `/platform/installation` | Instalacion | Inicializar la plataforma cuando aun no esta operativa |
| `/login` | Acceso | Autenticar usuarios internos |
| `/app` | Inicio autenticado | Mostrar sesion activa y accesos operativos |
| `/app/users` | Gestion de usuarios | Listar, crear, activar, desactivar y cambiar roles |
| `/app/roles` | Gestion de roles | Listar y crear roles con permisos |
| `/app/sessions` | Gestion de sesiones | Listar sesiones activas y revocar sesiones remotas |

## 3. Entrada

Comportamiento:

- Si la plataforma no esta inicializada, redirige a `/platform/installation`.
- Si la plataforma esta inicializada y no hay sesion valida, redirige a `/login`.
- Si existe sesion valida, redirige a `/app`.

## 4. Instalacion

Contenido cuando la plataforma no esta inicializada:

- Mensaje de instalacion pendiente.
- Formulario de inicializacion con datos de empresa y primer administrador.
- Validacion local orientativa y validacion final server-side.
- Estados de carga, exito y error.

Comportamiento cuando la plataforma ya esta inicializada:

- Redireccion a `/app` si existe sesion valida.
- Redireccion a `/login` si no existe sesion valida.

## 5. Acceso

Contenido:

- Formulario de usuario y contrasena.
- Redireccion a `/platform/installation` si la plataforma no esta inicializada.
- Redireccion a `/app` si ya existe sesion autenticada.
- Estados de carga y error.

## 6. Inicio autenticado

Contenido:

- Usuario autenticado.
- Rol vigente.
- Numero de permisos.
- Caducidad de sesion.
- Accesos a usuarios y roles.
- Acceso a sesiones activas cuando el rol lo permite.
- Formulario de cambio de contrasena.
- Accion de cierre de sesion.
- Redireccion a `/platform/installation` si la plataforma no esta inicializada.
- Redireccion a `/login` si no existe sesion valida.

## 7. Gestion de usuarios

Contenido:

- Listado de usuarios como DTOs sin hashes ni secretos.
- Estado, rol, bloqueos, intentos fallidos y fecha de creacion.
- Formulario para crear usuario.
- Acciones para desactivar, reactivar y cambiar rol.
- Estados de error cuando falta permiso o falla la validacion.
- Redireccion a `/login` si no existe sesion valida.

## 8. Gestion de roles

Contenido:

- Listado de roles, permisos y numero de usuarios.
- Formulario para crear rol con permisos seleccionados.
- Edicion de permisos en roles personalizados.
- Roles protegidos en solo lectura.
- Estados de error cuando falta permiso o falla la validacion.
- Redireccion a `/login` si no existe sesion valida.

## 9. Gestion de sesiones

Contenido:

- Listado de sesiones no revocadas como DTOs sin token ni hash.
- Usuario, rol, inicio, ultima actividad, caducidad, IP y user-agent resumido.
- Accion para revocar sesiones remotas.
- La sesion propia se cierra desde la accion de logout, no desde revocacion remota.
- Estados de error cuando falta permiso o falla la validacion.
- Redireccion a `/login` si no existe sesion valida.

## 10. Criterios UI

- Server Components por defecto.
- Client Components solo para formularios.
- Textos claros y compactos.
- Nada de secretos en pantalla de resumen.
- Estados vacio, carga y error visibles.
- Controles accesibles con labels, foco visible y mensajes junto a la accion afectada.
