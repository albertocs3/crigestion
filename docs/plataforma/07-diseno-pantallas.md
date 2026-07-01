# Diseno de pantallas de Plataforma

## 1. Proposito

Define la experiencia web inicial de Plataforma para CriGestión con Next.js.

## 2. Pantallas iniciales

| Ruta | Pantalla | Proposito |
|---|---|---|
| `/` | Inicio operativo | Mostrar estado general y acceso a inicializacion |
| `/platform/installation` | Estado de instalacion | Mostrar si la plataforma esta inicializada |
| `/login` | Acceso | Autenticar usuarios internos |
| `/app` | Inicio autenticado | Mostrar sesion activa y accesos operativos |
| `/app/users` | Gestion de usuarios | Listar, crear, activar, desactivar y cambiar roles |
| `/app/roles` | Gestion de roles | Listar y crear roles con permisos |
| `/app/sessions` | Gestion de sesiones | Listar sesiones activas y revocar sesiones remotas |

## 3. Inicio operativo

Contenido:

- Marca `CriGestión`.
- Estado de instalacion.
- Acceso a `/platform/installation`.

Estados:

- Pendiente de inicializacion.
- Inicializado.
- Error de conexion a base de datos, gestionado por error boundary futuro.

## 4. Estado de instalacion

Contenido cuando no existe instalacion:

- Mensaje de instalacion pendiente.
- Formulario de inicializacion con datos de empresa y primer administrador.
- Validacion local orientativa y validacion final server-side.
- Estados de carga, exito y error.

Contenido cuando existe instalacion:

- Estado.
- Empresa.
- Administrador inicial.

## 5. Acceso

Contenido:

- Formulario de usuario y contrasena.
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

## 7. Gestion de usuarios

Contenido:

- Listado de usuarios como DTOs sin hashes ni secretos.
- Estado, rol, bloqueos, intentos fallidos y fecha de creacion.
- Formulario para crear usuario.
- Acciones para desactivar, reactivar y cambiar rol.
- Estados de error cuando falta permiso o falla la validacion.

## 8. Gestion de roles

Contenido:

- Listado de roles, permisos y numero de usuarios.
- Formulario para crear rol con permisos seleccionados.
- Edicion de permisos en roles personalizados.
- Roles protegidos en solo lectura.
- Estados de error cuando falta permiso o falla la validacion.

## 9. Gestion de sesiones

Contenido:

- Listado de sesiones no revocadas como DTOs sin token ni hash.
- Usuario, rol, inicio, ultima actividad, caducidad, IP y user-agent resumido.
- Accion para revocar sesiones remotas.
- La sesion propia se cierra desde la accion de logout, no desde revocacion remota.
- Estados de error cuando falta permiso o falla la validacion.

## 10. Criterios UI

- Server Components por defecto.
- Client Components solo para formularios.
- Textos claros y compactos.
- Nada de secretos en pantalla de resumen.
- Estados vacio, carga y error visibles.
- Controles accesibles con labels, foco visible y mensajes junto a la accion afectada.
