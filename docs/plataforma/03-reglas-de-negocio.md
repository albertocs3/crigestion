# Reglas de negocio: Fase 0 - Plataforma

## 1. Propósito

Este documento normaliza las reglas de negocio derivadas de los casos de uso de Plataforma.

Cada regla:

- Tiene un identificador estable.
- Expresa una única condición o consecuencia principal.
- Puede vincularse con validaciones, pruebas y decisiones técnicas.
- Solo debe modificarse conservando trazabilidad documental.

## 2. Prefijos

| Prefijo | Área |
|---|---|
| `INI-RN` | Inicialización |
| `SEG-RN` | Usuarios, autenticación, sesiones, roles y permisos |
| `CFG-RN` | Configuración general |
| `AUD-RN` | Auditoría |
| `NOT-RN` | Notificaciones |
| `ADJ-RN` | Adjuntos |
| `OPS-RN` | Diagnóstico y procesos operativos |
| `BKP-RN` | Copias de seguridad y restauración |

## 3. Inicialización

| ID | Regla |
|---|---|
| INI-RN-001 | La inicialización solo puede ejecutarse cuando la instalación no está inicializada. |
| INI-RN-002 | Una instalación inicializada no puede volver a ejecutar el asistente inicial. |
| INI-RN-003 | La inicialización debe crear los roles base `Administrador`, `Facturación`, `Contabilidad` y `Técnico`. |
| INI-RN-004 | Los roles base creados durante la inicialización quedan protegidos. |
| INI-RN-005 | La inicialización debe crear un primer usuario con rol `Administrador`. |
| INI-RN-006 | Una instalación no puede marcarse como inicializada sin un administrador activo. |
| INI-RN-007 | La inicialización debe crear la identidad técnica `Sistema`. |
| INI-RN-008 | El idioma inicial será español. |
| INI-RN-009 | La moneda inicial será el euro. |
| INI-RN-010 | La zona horaria funcional inicial será `Europe/Madrid`. |
| INI-RN-011 | La inicialización debe crear los contadores globales. |
| INI-RN-012 | La inicialización debe activar la auditoría antes de confirmar su finalización. |
| INI-RN-013 | La inicialización se ejecutará como una operación transaccional. |
| INI-RN-014 | Un fallo durante la inicialización no puede dejar usuarios, roles o configuración parciales. |
| INI-RN-015 | La contraseña del primer administrador nunca se almacenará en texto legible. |

## 4. Usuarios y nombres de acceso

| ID | Regla |
|---|---|
| SEG-RN-001 | Los usuarios son exclusivamente empleados internos. |
| SEG-RN-002 | Cada usuario tendrá un nombre de usuario único. |
| SEG-RN-003 | Un nombre de usuario utilizado anteriormente no podrá reutilizarse. |
| SEG-RN-004 | Los usuarios no se eliminarán físicamente. |
| SEG-RN-005 | Cada usuario tendrá exactamente un rol asignado. |
| SEG-RN-006 | Un usuario necesita un rol activo para iniciar sesión. |
| SEG-RN-007 | Solo el administrador puede crear usuarios. |
| SEG-RN-008 | Solo el administrador puede modificar el rol de un usuario. |
| SEG-RN-009 | Solo el administrador puede desactivar o reactivar usuarios. |
| SEG-RN-010 | Crear un usuario exige una contraseña que cumpla la política vigente. |
| SEG-RN-011 | Un usuario nuevo se crea inicialmente en estado `Activo`. |
| SEG-RN-012 | La desactivación de un usuario exige un motivo. |
| SEG-RN-013 | Un usuario desactivado no puede iniciar sesión. |
| SEG-RN-014 | Desactivar un usuario invalida inmediatamente su sesión. |
| SEG-RN-015 | Reactivar un usuario exige que tenga asignado un rol activo. |
| SEG-RN-016 | La desactivación no elimina la identidad histórica del usuario. |
| SEG-RN-017 | Cambiar el rol de un usuario invalida inmediatamente su sesión. |

## 5. Contraseñas

| ID | Regla |
|---|---|
| SEG-RN-018 | Las contraseñas tendrán al menos 10 caracteres. |
| SEG-RN-019 | Las contraseñas incluirán al menos una letra mayúscula. |
| SEG-RN-020 | Las contraseñas incluirán al menos una letra minúscula. |
| SEG-RN-021 | Las contraseñas incluirán al menos un número. |
| SEG-RN-022 | Las contraseñas incluirán al menos un carácter especial. |
| SEG-RN-023 | Las contraseñas se almacenarán mediante un hash seguro. |
| SEG-RN-024 | Las contraseñas no se almacenarán mediante cifrado reversible. |
| SEG-RN-025 | El contenido de una contraseña nunca se incluirá en auditoría o registros técnicos. |
| SEG-RN-026 | Un usuario puede cambiar su propia contraseña. |
| SEG-RN-027 | Cambiar la contraseña propia exige validar la contraseña actual. |
| SEG-RN-028 | Solo el administrador puede restablecer la contraseña de otro usuario. |
| SEG-RN-029 | El administrador no puede consultar la contraseña anterior de un usuario. |
| SEG-RN-030 | Cambiar o restablecer una contraseña invalida todas las credenciales de sesión del usuario. |
| SEG-RN-031 | El sistema conservará la fecha del último cambio de contraseña. |
| SEG-RN-032 | Las contraseñas no caducarán periódicamente. |
| SEG-RN-033 | La primera versión no impedirá reutilizar contraseñas anteriores. |
| SEG-RN-034 | No será obligatorio cambiar la contraseña en el primer acceso. |

## 6. Acceso, bloqueo y sesiones

| ID | Regla |
|---|---|
| SEG-RN-035 | Cada intento de inicio de sesión quedará auditado. |
| SEG-RN-036 | Un acceso correcto reiniciará el contador de intentos fallidos. |
| SEG-RN-037 | Un intento fallido incrementará el contador del usuario identificado. |
| SEG-RN-038 | La cuenta se bloqueará al quinto intento fallido consecutivo. |
| SEG-RN-039 | El bloqueo automático tendrá una duración de 30 minutos. |
| SEG-RN-040 | Un intento realizado durante el bloqueo reiniciará el plazo de 30 minutos. |
| SEG-RN-041 | El mensaje de rechazo no revelará si el nombre de usuario existe. |
| SEG-RN-042 | El bloqueo automático generará una notificación al administrador. |
| SEG-RN-043 | Solo el administrador podrá desbloquear una cuenta antes de finalizar el plazo. |
| SEG-RN-044 | El desbloqueo manual exigirá un motivo. |
| SEG-RN-045 | El desbloqueo reiniciará el contador de intentos fallidos. |
| SEG-RN-046 | Un usuario solo puede mantener una sesión activa. |
| SEG-RN-047 | Si existe una sesión activa, se rechazará un nuevo inicio de sesión. |
| SEG-RN-048 | Cerrar una sesión invalidará inmediatamente sus credenciales. |
| SEG-RN-049 | El usuario podrá cerrar manualmente su sesión. |
| SEG-RN-050 | El administrador podrá cerrar remotamente una sesión. |
| SEG-RN-051 | El cierre remoto exigirá un motivo cuando así lo determine la política de seguridad. |
| SEG-RN-052 | La duración inicial de inactividad será de cinco horas. |
| SEG-RN-053 | El administrador podrá configurar el límite de inactividad. |
| SEG-RN-054 | El sistema avisará cinco minutos antes de la caducidad. |
| SEG-RN-055 | La actividad válida con el servidor renovará la última actividad. |
| SEG-RN-056 | Alcanzar el límite de inactividad invalidará la sesión. |
| SEG-RN-057 | Bloquear un usuario invalidará inmediatamente su sesión. |
| SEG-RN-058 | Desactivar el rol de un usuario invalidará inmediatamente su sesión. |
| SEG-RN-059 | Cada sesión conservará inicio, última actividad, origen, estado y motivo de cierre. |

## 7. Roles y permisos

| ID | Regla |
|---|---|
| SEG-RN-060 | Los roles base no pueden eliminarse. |
| SEG-RN-061 | Los roles base no pueden desactivarse. |
| SEG-RN-062 | Los roles base no pueden modificarse. |
| SEG-RN-063 | Solo el administrador puede crear roles personalizados. |
| SEG-RN-064 | Un rol personalizado puede copiar los permisos de otro rol. |
| SEG-RN-065 | El nombre de un rol será único. |
| SEG-RN-066 | No se puede guardar un rol personalizado sin permisos. |
| SEG-RN-067 | Los permisos se asignan a roles, nunca directamente a usuarios. |
| SEG-RN-068 | Un rol personalizado puede combinar permisos de varios módulos. |
| SEG-RN-069 | Solo el administrador puede modificar permisos. |
| SEG-RN-070 | Los cambios de permisos se aplicarán a las siguientes peticiones. |
| SEG-RN-071 | Modificar permisos invalidará las sesiones de los usuarios afectados. |
| SEG-RN-072 | Desactivar un rol personalizado bloqueará el acceso de sus usuarios. |
| SEG-RN-073 | Desactivar un rol personalizado exige mostrar los usuarios afectados. |
| SEG-RN-074 | Desactivar un rol personalizado con usuarios exige un motivo. |
| SEG-RN-075 | Reactivar un rol permitirá el acceso de sus usuarios activos. |
| SEG-RN-076 | Los módulos sin permiso de consulta se ocultarán. |
| SEG-RN-077 | Las acciones no permitidas se ocultarán. |
| SEG-RN-078 | Ocultar una acción en la interfaz no sustituye la autorización del servidor. |
| SEG-RN-079 | Cada operación será autorizada en la capa de aplicación o servidor. |
| SEG-RN-080 | Descargar o exportar requiere permiso de consulta sobre los datos. |
| SEG-RN-081 | La primera versión no aplicará restricciones por cliente concreto. |
| SEG-RN-082 | `Ver costes y márgenes` será exclusivo del administrador. |
| SEG-RN-083 | Un rol personalizado no administrador no podrá recibir efectivamente `Ver costes y márgenes`. |
| SEG-RN-084 | El administrador tendrá acceso completo e irrevocable. |

## 8. Datos de la empresa y cuenta bancaria

| ID | Regla |
|---|---|
| CFG-RN-001 | El sistema gestionará una única empresa. |
| CFG-RN-002 | Solo el administrador puede modificar la configuración general. |
| CFG-RN-003 | La empresa tendrá una única dirección fiscal. |
| CFG-RN-004 | El NIF de la empresa deberá validarse antes de guardar. |
| CFG-RN-005 | El NIF de la empresa no podrá cambiarse después de emitir facturas. |
| CFG-RN-006 | La razón social y dirección podrán cambiar para operaciones futuras. |
| CFG-RN-007 | Los cambios de empresa no alterarán documentos emitidos. |
| CFG-RN-008 | El logotipo solo admitirá PNG o JPG. |
| CFG-RN-009 | El logotipo no podrá superar 5 MB. |
| CFG-RN-010 | El sistema utilizará una única cuenta bancaria empresarial. |
| CFG-RN-011 | El IBAN empresarial deberá validarse. |
| CFG-RN-012 | El BIC empresarial será opcional. |
| CFG-RN-013 | El IBAN empresarial será común a Configuración, Facturación, Contabilidad y Tesorería. |
| CFG-RN-014 | Los campos sensibles de empresa se almacenarán cifrados según los requisitos compartidos. |

## 9. Ejercicios y numeraciones

| ID | Regla |
|---|---|
| CFG-RN-015 | Solo el administrador puede crear ejercicios. |
| CFG-RN-016 | El sistema propondrá ejercicios del 1 de enero al 31 de diciembre. |
| CFG-RN-017 | Las fechas del ejercicio podrán modificarse antes de guardarlo. |
| CFG-RN-018 | Los ejercicios no podrán solaparse de forma incompatible. |
| CFG-RN-019 | Crear un ejercicio generará todos sus contadores anuales. |
| CFG-RN-020 | Los formatos de numeración serán fijos. |
| CFG-RN-021 | El administrador no podrá modificar manualmente el siguiente número. |
| CFG-RN-022 | Consultar un contador no reservará ningún número. |
| CFG-RN-023 | La asignación de números será transaccional. |
| CFG-RN-024 | Un contador no podrá generar números duplicados. |
| CFG-RN-025 | Los contadores anuales se reiniciarán al crear el nuevo ejercicio. |
| CFG-RN-026 | Los contadores globales no se reiniciarán anualmente. |
| CFG-RN-027 | La consulta mostrará último número, siguiente número y última asignación. |

## 10. Impuestos

| ID | Regla |
|---|---|
| CFG-RN-028 | Solo el administrador puede modificar impuestos y retención. |
| CFG-RN-029 | La configuración inicial incluirá IVA del 21 %, 10 % y 4 %. |
| CFG-RN-030 | Cada tipo de IVA tendrá una fecha inicial de vigencia. |
| CFG-RN-031 | Un tipo de IVA podrá tener una fecha final de vigencia. |
| CFG-RN-032 | Un tipo utilizado no podrá modificarse retroactivamente. |
| CFG-RN-033 | Un cambio de porcentaje creará una nueva vigencia. |
| CFG-RN-034 | Un tipo utilizado no podrá eliminarse. |
| CFG-RN-035 | Un tipo utilizado podrá desactivarse para operaciones futuras. |
| CFG-RN-036 | El sistema tendrá un único porcentaje de retención activo. |
| CFG-RN-037 | Las causas de exención y no sujeción tendrán código, descripción, tipo y estado. |
| CFG-RN-038 | Una causa fiscal utilizada no podrá eliminarse. |

## 11. SMTP y aplicación de configuración

| ID | Regla |
|---|---|
| CFG-RN-039 | El sistema tendrá una única configuración SMTP. |
| CFG-RN-040 | SMTP admitirá SSL/TLS y STARTTLS. |
| CFG-RN-041 | La contraseña SMTP se almacenará cifrada. |
| CFG-RN-042 | La contraseña SMTP no se mostrará completa después de guardarse. |
| CFG-RN-043 | La prueba SMTP utilizará una dirección indicada por el administrador. |
| CFG-RN-044 | La prueba verificará conexión, autenticación y envío. |
| CFG-RN-045 | Los errores de prueba no mostrarán secretos. |
| CFG-RN-046 | Un fallo de prueba no eliminará la configuración válida anterior. |
| CFG-RN-047 | El envío de correo podrá desactivarse sin borrar la configuración. |
| CFG-RN-048 | Sin SMTP habilitado se podrán emitir documentos, pero no enviarlos por correo. |
| CFG-RN-049 | Los reintentos de correo serán manuales. |
| CFG-RN-050 | Los cambios de configuración se guardarán inmediatamente. |
| CFG-RN-051 | Los cambios de configuración requerirán reiniciar la aplicación para aplicarse. |
| CFG-RN-052 | La aplicación mostrará que existen cambios pendientes de reinicio. |
| CFG-RN-053 | Una operación iniciada utilizará una única versión coherente de configuración. |

## 12. Validación de configuración

| ID | Regla |
|---|---|
| CFG-RN-054 | La validación revisará los datos obligatorios de la empresa. |
| CFG-RN-055 | La validación revisará la cuenta bancaria. |
| CFG-RN-056 | La validación revisará la existencia de un ejercicio abierto. |
| CFG-RN-057 | La validación revisará los impuestos vigentes. |
| CFG-RN-058 | La validación revisará SMTP. |
| CFG-RN-059 | La validación revisará contadores y cuentas requeridas. |
| CFG-RN-060 | Cada problema tendrá gravedad, descripción, módulo y enlace de resolución. |
| CFG-RN-061 | El sistema conservará la fecha y el resultado de la última validación. |

## 13. Auditoría

| ID | Regla |
|---|---|
| AUD-RN-001 | La auditoría será única para todos los módulos. |
| AUD-RN-002 | Los registros de auditoría serán inmutables. |
| AUD-RN-003 | Los registros de auditoría no podrán eliminarse desde la aplicación. |
| AUD-RN-004 | Cada evento conservará fecha y hora UTC. |
| AUD-RN-005 | Cada evento identificará usuario o proceso de origen. |
| AUD-RN-006 | Cada evento identificará módulo, acción, entidad y resultado. |
| AUD-RN-007 | Las modificaciones conservarán valores anteriores y nuevos cuando proceda. |
| AUD-RN-008 | Las acciones sensibles conservarán su motivo. |
| AUD-RN-009 | Los procesos automáticos utilizarán la identidad `Sistema`. |
| AUD-RN-010 | Los eventos automáticos identificarán el proceso concreto. |
| AUD-RN-011 | Los accesos correctos y fallidos quedarán auditados. |
| AUD-RN-012 | Los cambios de usuarios, roles y permisos quedarán auditados. |
| AUD-RN-013 | Las consultas de datos sensibles quedarán auditadas. |
| AUD-RN-014 | Las exportaciones y descargas sensibles quedarán auditadas. |
| AUD-RN-015 | Solo el administrador podrá consultar la auditoría completa. |
| AUD-RN-016 | La consulta permitirá filtrar por usuario, fecha, módulo, acción, entidad, resultado e IP. |
| AUD-RN-017 | Exportar la auditoría generará un nuevo evento de auditoría. |
| AUD-RN-018 | La auditoría nunca almacenará contraseñas, claves o secretos. |
| AUD-RN-019 | La auditoría se conservará durante el plazo legal y de seguridad aplicable. |
| AUD-RN-020 | Los archivos temporales de exportación se eliminarán después de 24 horas. |

## 14. Notificaciones

| ID | Regla |
|---|---|
| NOT-RN-001 | Existirá un centro común de notificaciones. |
| NOT-RN-002 | Cada notificación tendrá destinatario, tipo, gravedad, título, mensaje, fecha y estado. |
| NOT-RN-003 | Cada notificación podrá enlazar con una entidad relacionada. |
| NOT-RN-004 | Los estados serán `No leída`, `Leída` y `Archivada`. |
| NOT-RN-005 | El usuario podrá marcar notificaciones individualmente o en bloque como leídas. |
| NOT-RN-006 | Una notificación leída podrá volver a marcarse como no leída. |
| NOT-RN-007 | Las notificaciones no se eliminarán manualmente; se archivarán. |
| NOT-RN-008 | Las notificaciones se conservarán un año. |
| NOT-RN-009 | Los usuarios no podrán desactivar tipos de notificación. |
| NOT-RN-010 | Las notificaciones críticas serán obligatorias. |
| NOT-RN-011 | Una notificación crítica generará una ventana emergente. |
| NOT-RN-012 | Los procesos masivos generarán preferentemente una notificación resumida. |
| NOT-RN-013 | Las notificaciones no incluirán secretos ni datos sensibles completos. |
| NOT-RN-014 | Abrir un enlace desde una notificación volverá a validar permisos. |
| NOT-RN-015 | Una notificación no sustituirá al evento de auditoría relacionado. |

## 15. Adjuntos

| ID | Regla |
|---|---|
| ADJ-RN-001 | Cada módulo definirá formatos y tamaño máximo de sus adjuntos. |
| ADJ-RN-002 | El usuario necesita permiso sobre la entidad para cargar un adjunto. |
| ADJ-RN-003 | La extensión del archivo deberá estar permitida. |
| ADJ-RN-004 | El tamaño se validará antes de completar la carga. |
| ADJ-RN-005 | El sistema detectará el tipo real del archivo. |
| ADJ-RN-006 | El tipo real deberá coincidir con la extensión declarada. |
| ADJ-RN-007 | Todo archivo se analizará con antivirus. |
| ADJ-RN-008 | Un archivo no estará disponible hasta superar todas las validaciones. |
| ADJ-RN-009 | Un resultado antivirus inconcluso impedirá publicar el archivo. |
| ADJ-RN-010 | El sistema calculará un hash del archivo. |
| ADJ-RN-011 | El repositorio utilizará un identificador interno de almacenamiento. |
| ADJ-RN-012 | El nombre original se conservará como metadato. |
| ADJ-RN-013 | Los metadatos incluirán tipo, tamaño, hash, usuario, fecha y entidad. |
| ADJ-RN-014 | No existirán enlaces públicos permanentes. |
| ADJ-RN-015 | Descargar un adjunto volverá a comprobar permisos. |
| ADJ-RN-016 | La descarga comprobará la integridad del archivo. |
| ADJ-RN-017 | Las descargas sensibles quedarán auditadas. |
| ADJ-RN-018 | Reemplazar un adjunto exigirá las mismas validaciones que una carga nueva. |
| ADJ-RN-019 | La primera versión no ofrecerá versiones históricas descargables de adjuntos reemplazados. |
| ADJ-RN-020 | El reemplazo conservará los metadatos anteriores y nuevos en auditoría. |
| ADJ-RN-021 | El archivo anterior solo se eliminará físicamente si no existe obligación de conservación. |
| ADJ-RN-022 | Los adjuntos se incluirán en las copias de seguridad completas. |

## 16. Diagnóstico y procesos operativos

| ID | Regla |
|---|---|
| OPS-RN-001 | Solo el administrador podrá consultar el diagnóstico técnico completo. |
| OPS-RN-002 | Los errores tendrán fecha, gravedad, módulo, proceso, estado e identificador de correlación. |
| OPS-RN-003 | Los registros técnicos se conservarán inicialmente 90 días. |
| OPS-RN-004 | Un incidente legal o de seguridad podrá conservar sus registros más de 90 días. |
| OPS-RN-005 | Los mensajes de error no mostrarán secretos. |
| OPS-RN-006 | NIF, IBAN, teléfonos, correos, certificados y credenciales se enmascararán en registros técnicos. |
| OPS-RN-007 | Una exportación de diagnóstico no incluirá secretos. |
| OPS-RN-008 | Los procesos automáticos se ejecutarán como `Sistema`. |
| OPS-RN-009 | Los procesos automáticos dejarán una auditoría resumida. |
| OPS-RN-010 | Las exportaciones temporales se eliminarán después de 24 horas. |
| OPS-RN-011 | Las notificaciones vencidas se tratarán según su plazo de un año. |
| OPS-RN-012 | Los registros técnicos vencidos se depurarán automáticamente. |

## 17. Copias de seguridad

| ID | Regla |
|---|---|
| BKP-RN-001 | Solo el administrador podrá crear copias manuales. |
| BKP-RN-002 | Solo el administrador podrá restaurar copias. |
| BKP-RN-003 | Una copia completa incluirá base de datos, adjuntos y configuración necesaria. |
| BKP-RN-004 | Las copias estarán cifradas. |
| BKP-RN-005 | Los secretos permanecerán protegidos dentro de la copia. |
| BKP-RN-006 | Cada copia tendrá un hash de integridad. |
| BKP-RN-007 | Una copia deberá verificarse después de crearla. |
| BKP-RN-008 | Una copia no verificada no podrá restaurarse. |
| BKP-RN-009 | Una copia fallida no se mostrará como restaurable. |
| BKP-RN-010 | No podrán ejecutarse simultáneamente operaciones incompatibles de copia y restauración. |
| BKP-RN-011 | Cada copia conservará fecha, versión, tamaño, resultado y usuario. |
| BKP-RN-012 | Restaurar exige una copia compatible con la versión del sistema. |
| BKP-RN-013 | Restaurar exige validar el hash antes de modificar el sistema. |
| BKP-RN-014 | Restaurar exige confirmación y motivo. |
| BKP-RN-015 | La restauración requerirá acceso exclusivo de mantenimiento. |
| BKP-RN-016 | Antes de restaurar se creará una copia del estado actual cuando sea posible. |
| BKP-RN-017 | La restauración incluirá base de datos, adjuntos y configuración. |
| BKP-RN-018 | La restauración deberá verificar la consistencia final. |
| BKP-RN-019 | Una restauración invalidará todas las sesiones. |
| BKP-RN-020 | Una restauración requerirá reiniciar la aplicación. |
| BKP-RN-021 | La restauración quedará auditada mediante un registro preservado o externo al contenido restaurado. |
| BKP-RN-022 | Una copia alterada no podrá restaurarse. |
| BKP-RN-023 | Una copia que no pueda descifrarse no podrá restaurarse. |
| BKP-RN-024 | Un fallo de restauración deberá informar claramente y activar el procedimiento de recuperación. |

## 18. Matriz de trazabilidad con casos de uso

| Casos de uso | Reglas principales |
|---|---|
| PLT-CU-001 | INI-RN-001 a 015 |
| PLT-CU-002 | SEG-RN-006, 035, 036, 041, 046, 047, 059, 076 a 084 |
| PLT-CU-003 | SEG-RN-037 a 045 |
| PLT-CU-004 | SEG-RN-048 y 049 |
| PLT-CU-005 | SEG-RN-052 a 056 |
| PLT-CU-006 | SEG-RN-018 a 027, 030 y 031 |
| PLT-CU-007 | SEG-RN-018 a 025, 028 a 031 |
| PLT-CU-008 | SEG-RN-050, 051 y 059 |
| PLT-CU-009 | SEG-RN-001 a 011, 018 a 025 |
| PLT-CU-010 | SEG-RN-005, 006, 008 y 017 |
| PLT-CU-011 | SEG-RN-004, 009, 012 a 016 |
| PLT-CU-012 | SEG-RN-043 a 045 |
| PLT-CU-013 | SEG-RN-060 a 084 |
| PLT-CU-014 | SEG-RN-063 a 068 |
| PLT-CU-015 | SEG-RN-069 a 071, 078, 079, 082 y 083 |
| PLT-CU-016 | SEG-RN-060 a 062 y 072 a 075 |
| PLT-CU-017 | CFG-RN-001 a 014 |
| PLT-CU-018 | CFG-RN-015 a 027 |
| PLT-CU-019 | CFG-RN-028 a 038 |
| PLT-CU-020 | CFG-RN-020 a 027 |
| PLT-CU-021 | CFG-RN-039 a 049 |
| PLT-CU-022 | CFG-RN-054 a 061 |
| PLT-CU-023 | CFG-RN-050 a 053 |
| PLT-CU-024 | AUD-RN-001 a 019 |
| PLT-CU-025 | AUD-RN-014 a 020 |
| PLT-CU-026 | NOT-RN-001 a 009 y 013 a 015 |
| PLT-CU-027 | NOT-RN-010 a 015 |
| PLT-CU-028 | ADJ-RN-001 a 013 |
| PLT-CU-029 | ADJ-RN-014 a 017 |
| PLT-CU-030 | ADJ-RN-018 a 021 |
| PLT-CU-031 | OPS-RN-001 a 007 |
| PLT-CU-032 | BKP-RN-001, 003 a 011 |
| PLT-CU-033 | BKP-RN-002 y 012 a 024 |

## 19. Reglas críticas para la salida de Fase 0

Las siguientes familias deben estar implementadas y probadas antes de cerrar la fase:

- `INI-RN-001` a `INI-RN-015`.
- `SEG-RN-001` a `SEG-RN-084`.
- `CFG-RN-001` a `CFG-RN-061`.
- `AUD-RN-001` a `AUD-RN-020`.
- `NOT-RN-001` a `NOT-RN-015`.
- `ADJ-RN-001` a `ADJ-RN-022`.
- `OPS-RN-001` a `OPS-RN-012`.
- `BKP-RN-001` a `BKP-RN-024`.

## 20. Pendientes de decisión técnica

Las reglas funcionales no fijan todavía:

- Algoritmo y parámetros del hash de contraseñas.
- Tecnología de autorización y sesiones.
- Persistencia de sesión única.
- Mecanismo de cifrado de secretos.
- Repositorio de archivos.
- Motor antivirus.
- Formato de copias.
- Gestión de claves de las copias.
- Registro externo utilizado durante una restauración.
- Canal técnico de notificaciones en escritorio.

El modelo conceptual derivado se encuentra en [Modelo de dominio de Plataforma](04-modelo-de-dominio.md).
