# Casos de uso: Fase 0 - Plataforma

## 1. Propósito

Este documento convierte el alcance funcional de la Fase 0 en operaciones verificables.

La fase proporciona:

- Inicialización del sistema.
- Autenticación y sesiones.
- Usuarios, roles y permisos.
- Configuración general básica.
- Auditoría.
- Notificaciones internas.
- Repositorio seguro de adjuntos.
- Correo SMTP básico.
- Diagnóstico y registros técnicos.
- Copias de seguridad manuales.

## 2. Convenciones

### Identificadores

Los casos de uso utilizan el prefijo `PLT-CU`.

### Prioridades

- `Crítica`: necesaria para iniciar o proteger el sistema.
- `Alta`: necesaria para completar la Fase 0.
- `Media`: puede entregarse después del flujo principal sin impedir el arranque controlado.

### Actores

- `Administrador inicial`: persona que configura la primera instalación.
- `Administrador`: usuario con acceso completo.
- `Usuario`: empleado interno autenticado.
- `Sistema`: procesos automáticos.
- `Servicio SMTP`: servidor externo de correo.
- `Motor antivirus`: servicio que analiza archivos.
- `Repositorio de copias`: destino protegido de las copias.

## 3. Catálogo

| ID | Caso de uso | Actor principal | Prioridad |
|---|---|---|---|
| PLT-CU-001 | Inicializar el sistema | Administrador inicial | Crítica |
| PLT-CU-002 | Iniciar sesión | Usuario | Crítica |
| PLT-CU-003 | Gestionar intentos fallidos y bloqueo | Sistema | Crítica |
| PLT-CU-004 | Cerrar sesión | Usuario | Alta |
| PLT-CU-005 | Caducar una sesión inactiva | Sistema | Alta |
| PLT-CU-006 | Cambiar la contraseña propia | Usuario | Alta |
| PLT-CU-007 | Restablecer la contraseña de un usuario | Administrador | Alta |
| PLT-CU-008 | Consultar y cerrar sesiones activas | Administrador | Alta |
| PLT-CU-009 | Crear un usuario | Administrador | Crítica |
| PLT-CU-010 | Modificar usuario o cambiar su rol | Administrador | Alta |
| PLT-CU-011 | Desactivar y reactivar un usuario | Administrador | Alta |
| PLT-CU-012 | Desbloquear un usuario | Administrador | Alta |
| PLT-CU-013 | Consultar roles y permisos | Administrador | Alta |
| PLT-CU-014 | Crear o copiar un rol personalizado | Administrador | Alta |
| PLT-CU-015 | Modificar permisos de un rol | Administrador | Alta |
| PLT-CU-016 | Desactivar o reactivar un rol | Administrador | Alta |
| PLT-CU-017 | Configurar datos de la empresa y cuenta bancaria | Administrador | Crítica |
| PLT-CU-018 | Crear un ejercicio y sus contadores | Administrador | Crítica |
| PLT-CU-019 | Configurar impuestos básicos | Administrador | Crítica |
| PLT-CU-020 | Consultar numeraciones | Administrador | Alta |
| PLT-CU-021 | Configurar y probar SMTP | Administrador | Alta |
| PLT-CU-022 | Validar la configuración general | Administrador | Alta |
| PLT-CU-023 | Aplicar cambios de configuración | Administrador | Alta |
| PLT-CU-024 | Consultar auditoría | Administrador | Alta |
| PLT-CU-025 | Exportar auditoría | Administrador | Media |
| PLT-CU-026 | Consultar y gestionar notificaciones | Usuario | Alta |
| PLT-CU-027 | Generar una notificación crítica | Sistema | Alta |
| PLT-CU-028 | Cargar un adjunto seguro | Usuario | Alta |
| PLT-CU-029 | Descargar un adjunto | Usuario | Alta |
| PLT-CU-030 | Reemplazar un adjunto | Usuario | Media |
| PLT-CU-031 | Consultar errores y diagnóstico | Administrador | Alta |
| PLT-CU-032 | Crear y verificar una copia de seguridad | Administrador | Crítica |
| PLT-CU-033 | Restaurar una copia de seguridad | Administrador | Alta |

## 4. Inicialización

### PLT-CU-001 - Inicializar el sistema

**Objetivo:** dejar una instalación nueva en condiciones de acceso administrativo.

**Actor principal:** Administrador inicial.

**Precondiciones:**

- La instalación no está inicializada.
- No existe ningún usuario.
- La base de datos y los servicios mínimos están disponibles.

**Flujo principal:**

1. El sistema detecta que no está inicializado.
2. Solicita los datos mínimos de la empresa.
3. Solicita el nombre de usuario y contraseña del primer administrador.
4. Valida el NIF, el nombre de usuario y la contraseña.
5. Crea los cuatro roles base protegidos.
6. Crea el primer usuario con rol `Administrador`.
7. Crea la identidad técnica `Sistema`.
8. Inicializa la configuración de idioma, moneda y zona horaria.
9. Inicializa la auditoría y los contadores globales.
10. Marca la instalación como inicializada.
11. Registra el evento de inicialización.

**Flujos alternativos:**

- Si la configuración es inválida, no se crea ningún dato parcial.
- Si ya existe una inicialización, se rechaza repetir el proceso.
- Si falla cualquier escritura, se revierte toda la operación.

**Resultado:**

- Existe un administrador operativo.
- Los roles base están disponibles.
- El sistema puede mostrar la pantalla de acceso.

**Criterios de aceptación:**

1. No puede existir una instalación inicializada sin administrador.
2. La contraseña nunca queda almacenada en texto legible.
3. La inicialización es transaccional.
4. El proceso no puede ejecutarse dos veces.

## 5. Autenticación y sesiones

### PLT-CU-002 - Iniciar sesión

**Objetivo:** obtener una sesión autorizada.

**Actor principal:** Usuario.

**Precondiciones:**

- El sistema está inicializado.
- El usuario existe y está activo.
- Su rol está activo.

**Flujo principal:**

1. El usuario introduce nombre y contraseña.
2. El sistema valida las credenciales.
3. Comprueba que no existe otra sesión activa.
4. Restablece el contador de intentos fallidos.
5. Crea una sesión.
6. Registra fecha, hora, origen y último acceso.
7. Carga los permisos del rol.
8. Muestra únicamente los módulos permitidos.
9. Audita el acceso correcto.

**Excepciones:**

- Credenciales incorrectas: se aplica `PLT-CU-003`.
- Usuario bloqueado o desactivado: se rechaza el acceso.
- Rol inactivo: se rechaza el acceso.
- Otra sesión activa: se rechaza el nuevo acceso.
- Error técnico: no se crea la sesión y se registra un error sin secretos.

**Resultado:** sesión activa única.

**Criterios de aceptación:**

1. La interfaz y el servidor aplican los mismos permisos.
2. Un usuario no puede mantener dos sesiones.
3. Cada intento queda auditado.

### PLT-CU-003 - Gestionar intentos fallidos y bloqueo

**Objetivo:** limitar ataques de acceso.

**Actor principal:** Sistema.

**Disparador:** intento de acceso incorrecto o realizado durante un bloqueo.

**Flujo principal:**

1. Incrementa los intentos fallidos.
2. Registra usuario indicado, fecha, origen y resultado.
3. Al quinto intento bloquea la cuenta durante 30 minutos.
4. Genera una notificación al administrador.
5. Rechaza el acceso.

**Reglas:**

- Un intento durante el bloqueo reinicia los 30 minutos.
- Un acceso correcto posterior al desbloqueo pone el contador a cero.
- No se revela si el nombre de usuario existe.

**Resultado:** acceso denegado y bloqueo cuando corresponda.

### PLT-CU-004 - Cerrar sesión

**Actor principal:** Usuario.

**Precondición:** sesión activa.

**Flujo principal:**

1. El usuario solicita cerrar sesión.
2. El sistema invalida inmediatamente la sesión.
3. Registra fecha y motivo.
4. Muestra la pantalla de acceso.

**Criterio:** reutilizar las credenciales de sesión cerradas debe fallar.

### PLT-CU-005 - Caducar una sesión inactiva

**Actor principal:** Sistema.

**Disparador:** sesión próxima al límite de inactividad.

**Flujo principal:**

1. Cinco minutos antes, muestra una advertencia.
2. La actividad válida con el servidor renueva la sesión.
3. Al alcanzar el límite configurado, inicialmente cinco horas, invalida la sesión.
4. Audita el cierre por caducidad.

**Resultado:** ninguna sesión inactiva permanece válida indefinidamente.

### PLT-CU-006 - Cambiar la contraseña propia

**Actor principal:** Usuario.

**Precondiciones:** sesión activa y conocimiento de la contraseña actual.

**Flujo principal:**

1. Introduce contraseña actual y nueva.
2. El sistema valida la actual.
3. Valida la complejidad de la nueva.
4. Guarda el nuevo hash.
5. Registra la fecha del cambio.
6. Invalida la sesión actual y cualquier otra credencial.
7. Audita la operación sin registrar contraseñas.

**Excepciones:** contraseña actual incorrecta o nueva contraseña inválida.

### PLT-CU-007 - Restablecer la contraseña de un usuario

**Actor principal:** Administrador.

**Precondición:** usuario existente.

**Flujo principal:**

1. El administrador selecciona al usuario.
2. Establece una contraseña nueva.
3. El sistema valida su complejidad.
4. Sustituye el hash.
5. Invalida sesiones y credenciales anteriores.
6. Registra administrador, fecha y usuario afectado.

**Regla:** el administrador nunca puede consultar la contraseña anterior.

### PLT-CU-008 - Consultar y cerrar sesiones activas

**Actor principal:** Administrador.

**Flujo principal:**

1. Consulta usuario, inicio, última actividad, origen y estado.
2. Selecciona una sesión.
3. Indica motivo cuando corresponda.
4. Confirma el cierre.
5. El sistema invalida la sesión.
6. Audita la acción y notifica al usuario afectado si sigue conectado.

## 6. Usuarios

### PLT-CU-009 - Crear un usuario

**Actor principal:** Administrador.

**Precondición:** existe al menos un rol activo.

**Flujo principal:**

1. Introduce nombre, usuario, teléfono, rol y contraseña.
2. El sistema valida unicidad y complejidad.
3. Comprueba que el rol está activo.
4. Crea el usuario en estado `Activo`.
5. Audita la creación.

**Excepciones:**

- Nombre de usuario utilizado ahora o anteriormente.
- Rol inactivo.
- Contraseña inválida.

### PLT-CU-010 - Modificar usuario o cambiar su rol

**Actor principal:** Administrador.

**Flujo principal:**

1. Selecciona un usuario.
2. Modifica sus datos o rol.
3. El sistema valida el nuevo rol.
4. Guarda los cambios.
5. Si cambia el rol, cierra su sesión.
6. Audita valores anteriores y nuevos.

### PLT-CU-011 - Desactivar y reactivar un usuario

**Actor principal:** Administrador.

**Desactivación:**

1. Selecciona un usuario activo.
2. Introduce un motivo.
3. Confirma.
4. El sistema lo marca `Desactivado`.
5. Cierra sus sesiones.
6. Conserva toda su identidad histórica.

**Reactivación:**

1. Selecciona un usuario desactivado.
2. Asigna un rol activo si fuera necesario.
3. Lo marca `Activo`.
4. Audita la operación.

**Regla:** ningún usuario se elimina.

### PLT-CU-012 - Desbloquear un usuario

**Actor principal:** Administrador.

**Precondición:** usuario bloqueado.

**Flujo principal:**

1. Selecciona al usuario.
2. Introduce motivo.
3. Confirma el desbloqueo.
4. El sistema elimina el bloqueo y reinicia intentos.
5. Audita la operación.

## 7. Roles y permisos

### PLT-CU-013 - Consultar roles y permisos

**Actor principal:** Administrador.

**Flujo principal:**

1. Abre la matriz de permisos.
2. El sistema muestra roles base y personalizados.
3. Muestra permisos por módulo y acción.
4. Identifica roles inactivos, roles sin usuarios y usuarios bloqueados por rol.

### PLT-CU-014 - Crear o copiar un rol personalizado

**Actor principal:** Administrador.

**Flujo principal:**

1. Elige crear vacío o copiar un rol.
2. Introduce un nombre único.
3. Selecciona permisos.
4. El sistema impide guardar sin permisos.
5. Crea el rol activo.
6. Audita permisos concedidos.

### PLT-CU-015 - Modificar permisos de un rol

**Actor principal:** Administrador.

**Precondiciones:**

- Rol personalizado.
- El rol no está protegido.

**Flujo principal:**

1. Añade o retira permisos.
2. El sistema valida combinaciones reservadas.
3. Impide conceder `Ver costes y márgenes` a un rol no administrador.
4. Guarda la nueva matriz.
5. Aplica los cambios a las siguientes peticiones.
6. Cierra sesiones de usuarios afectados.
7. Audita permisos añadidos y retirados.

**Regla:** los roles base no se modifican.

### PLT-CU-016 - Desactivar o reactivar un rol

**Actor principal:** Administrador.

**Precondición:** rol personalizado.

**Desactivación:**

1. El sistema muestra usuarios afectados.
2. El administrador introduce motivo.
3. Confirma.
4. El rol queda inactivo.
5. Se cierran las sesiones de sus usuarios.
6. Estos usuarios no pueden acceder.

**Reactivación:** devuelve el rol a estado activo y permite nuevamente el acceso de sus usuarios activos.

## 8. Configuración básica

### PLT-CU-017 - Configurar datos de la empresa y cuenta bancaria

**Actor principal:** Administrador.

**Flujo principal:**

1. Introduce razón social, NIF, dirección, contacto y datos públicos.
2. Carga opcionalmente un logotipo válido.
3. Introduce IBAN y BIC opcional.
4. El sistema valida campos, NIF, IBAN y archivo.
5. Guarda los datos cifrados cuando corresponda.
6. Marca que existen cambios pendientes de reinicio.
7. Audita valores anteriores y nuevos.

**Excepciones:**

- Logotipo distinto de PNG/JPG o superior a 5 MB.
- NIF o IBAN inválido.
- Intento de cambiar el NIF cuando existan facturas emitidas.

### PLT-CU-018 - Crear un ejercicio y sus contadores

**Actor principal:** Administrador.

**Precondición:** no existe otro ejercicio incompatible con las reglas contables.

**Flujo principal:**

1. Indica año y fechas.
2. El sistema propone del 1 de enero al 31 de diciembre.
3. Valida solapamientos.
4. Crea el ejercicio abierto.
5. Crea todos los contadores anuales con sus formatos fijos.
6. Copia impuestos y configuración vigente.
7. Audita la creación.

**Resultado:** los módulos pueden reservar números del ejercicio.

### PLT-CU-019 - Configurar impuestos básicos

**Actor principal:** Administrador.

**Flujo principal:**

1. Consulta IVA, recargo, retención y causas fiscales.
2. Crea o activa los tipos iniciales 21 %, 10 % y 4 %.
3. Configura sus fechas de vigencia.
4. Configura el porcentaje único de retención.
5. Crea causas de exención y no sujeción.
6. Guarda y audita.

**Reglas:**

- Un tipo utilizado no se modifica retroactivamente.
- Un tipo utilizado no se elimina.
- Un cambio de porcentaje crea una vigencia nueva.

### PLT-CU-020 - Consultar numeraciones

**Actor principal:** Administrador.

**Flujo principal:**

1. Consulta contadores globales y anuales.
2. Filtra por tipo y ejercicio.
3. El sistema muestra último, siguiente y última asignación.

**Reglas:**

- No puede cambiar formato ni siguiente número.
- La consulta no reserva números.

### PLT-CU-021 - Configurar y probar SMTP

**Actor principal:** Administrador.

**Actores secundarios:** Servicio SMTP.

**Flujo principal:**

1. Introduce servidor, puerto, seguridad, usuario, contraseña, remitente y nombre.
2. El sistema cifra la contraseña.
3. El administrador indica un destinatario de prueba.
4. El sistema comprueba conexión y autenticación.
5. Envía un correo de prueba.
6. Muestra resultado y diagnóstico seguro.
7. Permite habilitar la configuración.
8. Audita sin exponer secretos.

**Excepciones:**

- Error de conexión.
- Error de autenticación.
- Certificado TLS no válido.
- Error de envío.

**Regla:** un fallo de prueba no debe borrar la configuración anterior válida.

### PLT-CU-022 - Validar la configuración general

**Actor principal:** Administrador.

**Flujo principal:**

1. Ejecuta la validación.
2. El sistema revisa empresa, IBAN, ejercicio, impuestos, SMTP, contadores y cuentas disponibles.
3. Clasifica problemas por gravedad.
4. Muestra descripción, módulo y enlace.
5. Conserva el resultado y fecha de la última validación.

**Resultado:** lista verificable de bloqueos y advertencias.

### PLT-CU-023 - Aplicar cambios de configuración

**Actor principal:** Administrador.

**Precondición:** existen cambios guardados pendientes.

**Flujo principal:**

1. El sistema muestra un aviso de reinicio.
2. El administrador cierra o reinicia la aplicación.
3. La nueva sesión carga una versión coherente de configuración.
4. El sistema elimina el indicador pendiente.

**Regla:** una operación ya iniciada no puede mezclar versiones de configuración.

## 9. Auditoría

### PLT-CU-024 - Consultar auditoría

**Actor principal:** Administrador.

**Flujo principal:**

1. Abre la auditoría.
2. Filtra por usuario, fecha, módulo, acción, entidad, resultado o IP.
3. El sistema muestra una descripción legible.
4. Puede consultar valores anteriores y nuevos permitidos.
5. La propia consulta de datos sensibles queda auditada.

**Reglas:**

- No existe edición ni eliminación.
- Los secretos nunca se muestran.

### PLT-CU-025 - Exportar auditoría

**Actor principal:** Administrador.

**Flujo principal:**

1. Aplica filtros.
2. Solicita exportación.
3. El sistema genera un archivo protegido.
4. Registra usuario, filtros, fecha y resultado.
5. El archivo temporal caduca después de 24 horas.

## 10. Notificaciones

### PLT-CU-026 - Consultar y gestionar notificaciones

**Actor principal:** Usuario.

**Flujo principal:**

1. Abre el centro común.
2. Consulta no leídas, leídas y archivadas.
3. Marca una o varias como leídas.
4. Puede devolverlas a no leídas.
5. Puede archivarlas.
6. Abre el enlace relacionado.
7. El sistema vuelve a comprobar permisos.

**Regla:** una notificación se conserva un año.

### PLT-CU-027 - Generar una notificación crítica

**Actor principal:** Sistema.

**Disparador:** bloqueo de usuario, error crítico u otro evento configurado.

**Flujo principal:**

1. Crea la notificación sin datos sensibles innecesarios.
2. La dirige a los destinatarios obligatorios.
3. La muestra en el centro común.
4. Muestra una ventana emergente.
5. Enlaza con el registro permitido.
6. Audita el proceso automático como `Sistema`.

## 11. Adjuntos

### PLT-CU-028 - Cargar un adjunto seguro

**Actor principal:** Usuario.

**Actores secundarios:** Motor antivirus.

**Precondiciones:**

- El usuario puede modificar la entidad relacionada.
- El módulo define formatos y tamaño admitidos.

**Flujo principal:**

1. El usuario selecciona archivo y descripción.
2. El sistema valida extensión y tamaño.
3. Detecta el tipo real.
4. Comprueba que coincide con la extensión.
5. Calcula el hash.
6. Envía el archivo al antivirus.
7. Si es seguro, lo almacena con identificador interno.
8. Guarda metadatos.
9. Audita la carga.

**Excepciones:**

- Formato o tamaño no permitido.
- Contenido incoherente.
- Malware o resultado inconcluso.
- Fallo de almacenamiento.

**Resultado:** archivo disponible solo tras superar todas las validaciones.

### PLT-CU-029 - Descargar un adjunto

**Actor principal:** Usuario.

**Flujo principal:**

1. Solicita un adjunto.
2. El sistema comprueba permiso sobre la entidad.
3. Comprueba existencia e integridad mediante hash.
4. Entrega el archivo con su nombre original.
5. Audita la descarga cuando contenga información sensible.

### PLT-CU-030 - Reemplazar un adjunto

**Actor principal:** Usuario.

**Precondición:** permiso de modificación.

**Flujo principal:**

1. Selecciona el adjunto y un archivo nuevo.
2. El sistema ejecuta las validaciones de `PLT-CU-028`.
3. Sustituye la referencia activa.
4. Audita los metadatos anteriores y nuevos.
5. Elimina físicamente el anterior solo si no existe obligación de conservarlo.

**Regla:** no se ofrece historial descargable de versiones reemplazadas.

## 12. Diagnóstico

### PLT-CU-031 - Consultar errores y diagnóstico

**Actor principal:** Administrador.

**Flujo principal:**

1. Consulta errores de los últimos 90 días.
2. Filtra por fecha, gravedad, módulo, proceso y estado.
3. Visualiza un identificador de correlación y diagnóstico seguro.
4. Puede marcar el incidente como revisado.
5. Puede exportar datos técnicos sin secretos.

**Reglas:**

- NIF, IBAN, correos, teléfonos, certificados y credenciales se enmascaran.
- Los registros relacionados con incidentes legales o de seguridad pueden conservarse más de 90 días.

## 13. Copias de seguridad

### PLT-CU-032 - Crear y verificar una copia de seguridad

**Actor principal:** Administrador.

**Actores secundarios:** Repositorio de copias.

**Precondiciones:**

- Destino protegido disponible.
- Espacio suficiente.
- No existe otra copia o restauración incompatible en curso.

**Flujo principal:**

1. El administrador solicita una copia manual.
2. El sistema identifica base de datos, adjuntos y configuración.
3. Crea una instantánea consistente.
4. Cifra la copia.
5. Calcula su hash.
6. La almacena en el repositorio.
7. Verifica lectura, estructura e integridad.
8. Registra tamaño, fecha, versión, resultado y usuario.
9. Muestra el resultado.

**Excepciones:**

- Espacio insuficiente.
- Error de lectura.
- Error de cifrado.
- Error de almacenamiento.
- Verificación fallida.

**Resultado:**

- Copia válida y marcada como verificada, o fallo explícito.
- Una copia fallida nunca aparece como restaurable.

**Criterios de aceptación:**

1. Incluye base de datos, adjuntos y configuración necesaria.
2. No expone secretos sin cifrar.
3. El hash permite detectar alteraciones.
4. La operación queda auditada.

### PLT-CU-033 - Restaurar una copia de seguridad

**Actor principal:** Administrador.

**Precondiciones:**

- Copia verificada.
- Compatibilidad de versión comprobada.
- Acceso exclusivo de mantenimiento.

**Flujo principal:**

1. El administrador selecciona una copia.
2. El sistema muestra fecha, versión, tamaño e impacto.
3. Solicita confirmación y motivo.
4. Valida hash y descifra.
5. Crea una copia de seguridad previa a la restauración cuando sea posible.
6. Restaura base de datos, adjuntos y configuración.
7. Verifica consistencia.
8. Invalida todas las sesiones.
9. Registra la restauración en un registro externo o preservado.
10. Solicita reiniciar la aplicación.

**Excepciones:**

- Copia alterada.
- Clave no disponible.
- Versión incompatible.
- Restauración o verificación fallida.

**Resultado:** sistema restaurado a un punto consistente.

## 14. Procesos automáticos de soporte

El sistema ejecutará:

- Caducidad de sesiones.
- Desbloqueo temporal al vencer el plazo.
- Eliminación de exportaciones temporales después de 24 horas.
- Archivo o eliminación de notificaciones según retención.
- Depuración de registros técnicos después de 90 días.
- Avisos de seguridad.

Todos los procesos se ejecutarán como `Sistema` y dejarán auditoría resumida.

## 15. Matriz de trazabilidad

| Área | Casos de uso | Documento de origen |
|---|---|---|
| Inicialización | PLT-CU-001 | Seguridad, Configuración |
| Autenticación y sesiones | PLT-CU-002 a 008 | Seguridad |
| Usuarios | PLT-CU-009 a 012 | Seguridad |
| Roles y permisos | PLT-CU-013 a 016 | Seguridad |
| Configuración básica | PLT-CU-017 a 023 | Configuración |
| Auditoría | PLT-CU-024 y 025 | Seguridad, Requisitos compartidos |
| Notificaciones | PLT-CU-026 y 027 | Requisitos compartidos |
| Adjuntos | PLT-CU-028 a 030 | Requisitos compartidos |
| Diagnóstico | PLT-CU-031 | Requisitos compartidos |
| Copias | PLT-CU-032 y 033 | Requisitos compartidos, Configuración |

## 16. Criterios de finalización de la Fase 0

1. La instalación puede inicializarse una sola vez.
2. Existe un administrador operativo.
3. Los roles base están protegidos.
4. Los permisos se validan en interfaz y servidor.
5. El bloqueo y la sesión única funcionan.
6. La empresa, ejercicio, impuestos y contadores están configurados.
7. SMTP puede probarse sin exponer secretos.
8. Toda operación relevante queda auditada.
9. Las notificaciones críticas son visibles.
10. Los adjuntos se validan y analizan.
11. Los errores se consultan sin datos sensibles.
12. Puede crearse y verificarse una copia completa.
13. Puede demostrarse una restauración controlada.
14. Los cuatro roles base acceden únicamente a sus áreas.

## 17. Pendientes para reglas y diseño técnico

- Definir el catálogo exacto de permisos por módulo.
- Decidir el mecanismo de creación del primer administrador.
- Elegir el algoritmo de hash de contraseñas.
- Diseñar el formato de tokens y la sesión única.
- Elegir repositorio y antivirus.
- Definir el formato, cifrado y versión de las copias.
- Determinar cómo preservar la auditoría durante una restauración.
- Definir el identificador de dispositivo para una aplicación de escritorio.
- Diseñar el esquema de notificaciones en tiempo real.
- Concretar los registros técnicos y niveles de gravedad.

Las reglas derivadas de estos casos se encuentran en [Reglas de negocio de Plataforma](03-reglas-de-negocio.md).
