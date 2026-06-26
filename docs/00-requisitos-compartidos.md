# Requisitos funcionales compartidos

## 1. Propósito y aplicación

Este documento define las reglas comunes para todos los módulos del software:

- Clientes y tiendas.
- Catálogo e inventario.
- Suscripciones.
- Facturación.
- Atención al cliente e incidencias.
- Contabilidad, compras y proveedores.
- Tesorería y SEPA.
- Configuración.
- Seguridad.

Las especificaciones de cada módulo solo deberán definir sus excepciones. Cuando exista una contradicción, prevalecerá la regla más específica del módulo siempre que esté identificada expresamente y no vulnere requisitos legales o de seguridad.

## 2. Auditoría central

La auditoría será única, transversal e inmutable.

### Datos mínimos

Cada evento conservará:

- Fecha y hora UTC.
- Usuario.
- Dirección IP o identificador de origen disponible.
- Módulo.
- Acción.
- Tipo e identificador de entidad.
- Resultado.
- Valor anterior, cuando proceda.
- Valor nuevo, cuando proceda.
- Motivo.
- Descripción legible.
- Proceso de origen.

### Eventos auditados

- Altas y modificaciones.
- Activaciones, inactivaciones y cancelaciones.
- Cambios de estado.
- Operaciones económicas y contables.
- Correcciones y anulaciones.
- Fusiones.
- Exportaciones y descargas.
- Consultas de datos sensibles.
- Cambios de configuración.
- Accesos correctos y fallidos.
- Acciones denegadas.
- Procesos automáticos.

### Procesos automáticos

- Utilizarán el usuario técnico `Sistema`.
- Identificarán el proceso concreto que originó el evento.
- Registrarán resultado y errores.

### Motivos

Las operaciones sensibles exigirán un motivo cuando así se defina en el módulo.

### Consulta

- Solo el administrador puede consultar la auditoría completa.
- Permitirá filtrar por usuario, fecha, módulo, acción, entidad, resultado e IP.
- Podrá exportarse.
- La exportación también quedará auditada.

### Integridad y conservación

- Los registros no pueden modificarse.
- No pueden eliminarse manualmente.
- Se conservarán durante el plazo legal y de seguridad aplicable.
- El acceso a registros archivados seguirá sujeto a permisos.
- Nunca se almacenarán contraseñas, claves ni secretos.

## 3. Notificaciones internas

Existirá un centro común de notificaciones para todos los módulos.

No se enviarán notificaciones externas salvo que un módulo lo especifique expresamente.

### Datos

- Tipo.
- Nivel o gravedad.
- Título.
- Mensaje.
- Fecha y hora.
- Usuario destinatario.
- Estado.
- Entidad relacionada.
- Enlace directo.
- Proceso de origen.

### Estados

- No leída.
- Leída.
- Archivada.

### Operaciones

- Marcar individualmente como leída.
- Marcar varias como leídas.
- Volver a marcar como no leída.
- Archivar.
- Consultar el elemento relacionado.

### Reglas

- Los usuarios no podrán desactivar tipos de notificación.
- Las notificaciones críticas serán obligatorias.
- Los avisos críticos se mostrarán también mediante una ventana emergente.
- Los procesos masivos generarán preferentemente una notificación resumida.
- La notificación no sustituye al registro de auditoría.

### Conservación

- Las notificaciones se conservarán durante un año.
- Después podrán eliminarse de la bandeja, manteniendo el evento original en auditoría cuando corresponda.

## 4. Adjuntos

Los archivos se almacenarán en un repositorio protegido. La base de datos conservará sus metadatos y relación con la entidad funcional.

### Metadatos

- Identificador interno.
- Nombre original.
- Nombre o clave interna de almacenamiento.
- Descripción.
- Tipo declarado.
- Tipo real detectado.
- Tamaño.
- Hash.
- Usuario.
- Fecha y hora de subida.
- Entidad relacionada.

### Validaciones

- La extensión debe estar permitida por el módulo.
- El contenido real debe coincidir con el tipo declarado.
- Cambiar únicamente la extensión no permitirá cargar un formato prohibido.
- El tamaño se validará antes de completar la carga.
- El archivo se analizará con antivirus.
- Un archivo no estará disponible hasta superar las validaciones.

### Acceso

- La descarga exige permiso sobre el registro relacionado.
- No existirán enlaces públicos permanentes.
- Las descargas de información sensible quedarán auditadas.
- El nombre original podrá mostrarse al usuario.
- El almacenamiento utilizará identificadores internos para evitar colisiones y rutas manipuladas.

### Reemplazo

- Un adjunto puede reemplazarse.
- No se conservarán versiones históricas del archivo reemplazado.
- El reemplazo conservará auditoría y metadatos de la operación.
- El archivo anterior se eliminará físicamente únicamente cuando no esté sujeto a una obligación de conservación.

### Eliminación

- No se eliminará físicamente un adjunto mientras el registro relacionado deba conservarse.
- Cuando proceda una supresión, se aplicarán las reglas de protección de datos y conservación.

### Copias de seguridad

- Todos los adjuntos se incluirán en las copias de seguridad completas.
- Las copias estarán cifradas.

### Excepciones por módulo

- Incidencias: JPG y PDF, hasta 16 MB por archivo.
- Contabilidad, compras y justificantes: PDF, hasta 5 MB.
- Logotipo empresarial: PNG y JPG, hasta 5 MB.

Cada nuevo módulo deberá declarar formatos y tamaño máximo.

## 5. Fechas y zona horaria

### Zona horaria

- Zona funcional: `Europe/Madrid`.
- El horario de verano se aplicará automáticamente.
- La semana comienza en lunes.

### Marcas temporales

Las fechas y horas de eventos se almacenarán en UTC y se convertirán a `Europe/Madrid` para mostrarlas.

Ejemplos:

- Creación.
- Modificación.
- Acceso.
- Auditoría.
- Envío.
- Procesamiento.

La hora oficial será la del servidor.

### Fechas puras

Las fechas que no representan un instante se almacenarán sin hora ni conversión de zona.

Ejemplos:

- Fecha de factura.
- Fecha de operación.
- Fecha de vencimiento.
- Fecha de inicio o fin.
- Fecha contable.

### Fecha real y fecha de registro

Algunas operaciones pueden registrarse posteriormente a su realización.

En esos casos se conservarán:

- Fecha y hora real introducida por el usuario.
- Fecha y hora de registro generada por el sistema.

Esta excepción se aplica, entre otros, a:

- Comunicaciones.
- Actuaciones.
- Operaciones o documentos con fecha retroactiva permitida.

Las fechas del sistema y de auditoría no pueden editarse.

### Formato

- Fecha: `dd/MM/yyyy`.
- Fecha y hora: `dd/MM/yyyy HH:mm`.
- Los filtros diarios abarcarán el día completo en `Europe/Madrid`.

## 6. Importes, cantidades y porcentajes

### Tipo numérico

- Los importes se almacenarán con precisión decimal.
- No se utilizarán `float` ni `double` para cálculos económicos.
- La moneda será exclusivamente el euro.

### Escalas

- Importes monetarios finales: 2 decimales.
- Cantidades: hasta 4 decimales.
- Precios unitarios: hasta 6 decimales.
- Porcentajes: hasta 4 decimales.

### Redondeo

- Se aplicará redondeo comercial alejándose de cero cuando el siguiente dígito sea 5.
- Cada línea se redondeará antes de calcular los totales.
- Bases y cuotas se obtendrán de los valores redondeados según la regla fiscal aplicable.
- Una diferencia inevitable de un céntimo se ajustará en la última línea compatible.
- El ajuste deberá quedar identificado internamente.

### Documentos históricos

- Los informes utilizarán los importes almacenados.
- No recalcularán documentos históricos con reglas o porcentajes actuales.
- Los cambios fiscales solo afectarán a documentos futuros.

### Presentación

- Formato monetario español: `1.234,56 €`.
- Los valores negativos mostrarán signo menos.
- Los porcentajes eliminarán ceros finales innecesarios.
- Las exportaciones a Excel conservarán valores numéricos, no texto formateado.

## 7. Conservación de información

### Regla general

No se eliminarán físicamente desde la aplicación:

- Clientes y tiendas.
- Usuarios.
- Facturas y presupuestos emitidos.
- Asientos y registros contables.
- Compras registradas.
- Cobros y pagos.
- Incidencias, comunicaciones y actuaciones.
- Historiales y auditoría.

Cuando un elemento deje de utilizarse se aplicará, según el módulo:

- Inactivación.
- Cancelación.
- Anulación lógica.
- Archivo.

### Plazos

Los periodos se configurarán por tipo de información según:

- Obligaciones fiscales.
- Obligaciones contables.
- Obligaciones laborales o contractuales.
- Seguridad.
- Protección de datos.

No se utilizará un único plazo para toda la información.

### Registros técnicos

- Los registros técnicos y errores se conservarán 90 días.
- Podrán conservarse más tiempo si están relacionados con una incidencia de seguridad o una obligación legal.
- Deberán excluir o enmascarar datos sensibles.

## 8. Protección de datos

### Principios

- Acceso limitado por roles y permisos.
- Minimización de datos.
- Finalidad definida.
- Conservación limitada.
- Trazabilidad.
- Protección desde el diseño.

### Derechos

Existirá un procedimiento para atender:

- Acceso.
- Rectificación.
- Oposición.
- Supresión.

Cuando una obligación legal impida suprimir:

- Los datos quedarán bloqueados.
- Solo podrán utilizarse para la obligación que justifica su conservación.
- Se suprimirán o anonimizarán cuando termine el plazo aplicable.

### Anonimización

- Los datos sin relevancia legal podrán anonimizarse.
- La anonimización deberá ser irreversible.
- No deberá romper totales contables ni relaciones documentales obligatorias.
- La operación quedará auditada.

### Datos sensibles

Se cifrarán, al menos:

- IBAN.
- NIF y VAT.
- Teléfonos.
- Correos electrónicos.
- Certificados.
- Contraseñas.
- Claves y secretos.

Además:

- Las contraseñas se almacenarán mediante hash seguro, no mediante cifrado reversible.
- Los secretos necesarios para operar se almacenarán cifrados.
- El acceso a NIF, IBAN, teléfonos, correos y direcciones quedará auditado.
- Los datos archivados conservarán sus controles de acceso.

### Texto libre

Las pantallas de comunicaciones, incidencias, actuaciones y observaciones mostrarán una advertencia para evitar registrar datos sensibles o innecesarios.

### Errores y registros

- Los mensajes de error no mostrarán secretos.
- Los registros técnicos ocultarán o enmascararán datos personales.
- Los diagnósticos para usuarios no incluirán información interna sensible.

## 9. Exportaciones y archivos temporales

- Toda exportación con datos personales quedará auditada.
- Los permisos aplicables serán los mismos que para consultar los datos.
- Los archivos temporales se eliminarán automáticamente después de 24 horas.
- No deberán almacenarse en ubicaciones públicas o compartidas sin protección.
- Las exportaciones deberán respetar filtros y restricciones del usuario.

## 10. Copias de seguridad

- Las copias serán completas e incluirán base de datos, adjuntos y configuración necesaria.
- Estarán cifradas.
- Solo el administrador podrá restaurarlas.
- La restauración quedará auditada.
- Los secretos deberán mantenerse protegidos dentro de la copia.
- El módulo técnico de copias definirá periodicidad, retención, verificación y recuperación.

## 11. Notificaciones y protección de datos

- Las notificaciones mostrarán únicamente la información necesaria.
- No incluirán IBAN, contraseñas, certificados ni datos fiscales completos.
- El enlace al registro aplicará de nuevo los permisos.
- Archivar o marcar una notificación no altera el evento funcional relacionado.

## 12. Criterios generales de aceptación

1. Todos los módulos utilizan la auditoría central.
2. Los eventos automáticos se identifican como `Sistema`.
3. La auditoría no puede modificarse ni eliminarse.
4. Existe un centro común de notificaciones.
5. Las notificaciones pueden marcarse en bloque y archivarse.
6. Los avisos críticos generan una ventana emergente.
7. Los adjuntos se validan por extensión y contenido.
8. Todo adjunto se analiza con antivirus.
9. La descarga vuelve a comprobar permisos.
10. Las marcas temporales se almacenan en UTC.
11. Las fechas puras no se convierten por zona horaria.
12. Fecha real y fecha de registro se conservan cuando sean distintas.
13. Los cálculos económicos utilizan precisión decimal.
14. Los documentos se redondean por línea.
15. Los informes usan importes históricos almacenados.
16. Los registros principales no se eliminan físicamente.
17. Los datos pueden bloquearse o anonimizarse según la obligación legal.
18. Los datos personales definidos se almacenan protegidos.
19. Las exportaciones con datos personales quedan auditadas.
20. Los archivos temporales se eliminan después de 24 horas.
21. Las copias de seguridad están cifradas.
22. Solo el administrador puede restaurar una copia.

## 13. Decisiones pendientes para el diseño técnico

- Repositorio físico de adjuntos.
- Motor antivirus y tratamiento de archivos en cuarentena.
- Gestión de claves de cifrado.
- Estrategia de búsqueda sobre campos cifrados.
- Catálogo definitivo de plazos de conservación.
- Procedimiento técnico de bloqueo y anonimización.
- Algoritmo decimal exacto por tipo de documento.
- Gestión de ajustes de céntimos en documentos fiscales.
- Sistema de entrega de notificaciones en escritorio.
- Política técnica de copias de seguridad.
- Base jurídica y análisis de impacto de protección de datos.
