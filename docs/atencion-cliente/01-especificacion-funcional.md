# Especificación funcional: Atención al Cliente e Incidencias

## 0. Contexto del sistema

Atención al Cliente e Incidencias es un módulo de un software de gestión empresarial más amplio.

El sistema completo incluirá, entre otras, las siguientes áreas:

- Gestión de clientes y contactos.
- Gestión de suscripciones.
- Facturación.
- Atención al cliente e incidencias.

El módulo de incidencias no mantendrá copias independientes de los datos maestros que pertenezcan a otras áreas. Utilizará las entidades compartidas del sistema y conservará referencias a ellas.

### Principios de integración

- Los clientes y contactos se administran desde el módulo de gestión de clientes.
- Los técnicos y administradores proceden del sistema común de usuarios y permisos.
- Las suscripciones y facturas se consultan desde sus módulos propietarios.
- Una incidencia pertenece obligatoriamente a un cliente existente.
- Las suscripciones y facturas podrán formar parte del contexto consultable del cliente, sin exigir su vinculación a la incidencia.
- Las comunicaciones utilizan los contactos existentes del cliente.
- Desde la ficha del cliente se podrá consultar su historial de comunicaciones e incidencias.
- Desde una incidencia se podrá acceder al resumen del cliente y a la información relacionada autorizada.
- Los cambios realizados en los datos maestros se reflejarán en el módulo de incidencias sin duplicar la información.
- El historial conservará los datos descriptivos necesarios para interpretar correctamente hechos pasados.

## 1. Propósito

El módulo permitirá registrar todas las comunicaciones mantenidas con los clientes y crear incidencias cuando una comunicación requiera seguimiento.

La primera versión estará orientada al trabajo interno de los técnicos y permitirá:

- Registrar comunicaciones telefónicas y de WhatsApp.
- Convertir una comunicación en incidencia.
- Registrar, asignar y seguir incidencias.
- Documentar actuaciones y adjuntar archivos.
- Colaborar entre técnicos manteniendo un único responsable.
- Consultar comunicaciones e incidencias mediante filtros y búsquedas.
- Recibir notificaciones internas.
- Consultar paneles e indicadores operativos.
- Consultar el contexto comercial del cliente necesario para atender la incidencia.

Toda la información será de uso interno. No habrá portal ni información visible directamente por el cliente.

## 2. Alcance de la primera versión

### Incluido

- Registro manual de llamadas telefónicas.
- Registro manual de comunicaciones de WhatsApp.
- Gestión de contactos del cliente durante el registro.
- Conversión de comunicaciones en incidencias.
- Vinculación de comunicaciones a incidencias existentes.
- Gestión completa del ciclo de vida de una incidencia.
- Responsable y colaboradores.
- Actuaciones internas.
- Adjuntos JPG y PDF.
- Historial y auditoría.
- Fusión de incidencias duplicadas.
- Notificaciones dentro de la aplicación.
- Panel principal, filtros, búsquedas e indicadores.
- Consulta y registro sobre clientes activos e inactivos.
- Consulta del historial de incidencias desde la ficha del cliente.
- Acceso desde la incidencia al contexto del cliente.

### Fuera de alcance

- Integración automática con WhatsApp.
- Envío o recepción automática de mensajes.
- Portal del cliente.
- Comunicaciones visibles para el cliente.
- Programación de próximas actuaciones.
- Exportación a Excel o PDF.
- Acuerdos de nivel de servicio (SLA).
- Eliminación definitiva de comunicaciones, actuaciones o incidencias.

## 3. Actores

### Técnico

- Consulta todas las comunicaciones e incidencias.
- Registra comunicaciones.
- Crea incidencias.
- Reabre incidencias.
- Gestiona las incidencias de las que es responsable.
- Participa como colaborador en otras incidencias.
- Consulta únicamente sus propios indicadores.
- Consulta únicamente la información del cliente permitida por su rol. El rol Técnico no accede a suscripciones, facturación ni datos económicos.

### Responsable de incidencia

El responsable es un técnico designado durante la creación de la incidencia.

Puede:

- Modificar los datos principales.
- Cambiar estado, prioridad y categoría.
- Reasignar la incidencia a otro técnico.
- Añadir y retirar colaboradores.
- Resolver o cerrar la incidencia.
- Seleccionar la incidencia principal durante una fusión.

### Colaborador

Puede:

- Consultar la incidencia.
- Añadir actuaciones.
- Añadir adjuntos.

No puede modificar los datos principales ni reasignar, resolver o cerrar la incidencia.

### Administrador

- Puede realizar cualquier modificación.
- Gestiona las categorías.
- Puede actuar como responsable o colaborador.
- Consulta indicadores globales.
- Recibe avisos de todas las incidencias urgentes.
- Es el único que puede cambiar el cliente de una incidencia existente.

## 4. Comunicaciones

Toda comunicación con un cliente debe quedar registrada, aunque no requiera seguimiento.

### 4.1 Datos

- Identificador.
- Referencia al cliente existente, obligatoria.
- Referencia a un contacto existente del cliente, opcional.
- Técnico que registra la comunicación.
- Canal: teléfono o WhatsApp.
- Dirección: entrante o saliente.
- Fecha y hora reales de la comunicación.
- Fecha y hora de registro.
- Número de teléfono o WhatsApp utilizado.
- Duración, para llamadas telefónicas.
- Resumen.
- Resultado.
- Incidencia relacionada, opcional.

### 4.2 Información del contacto

Los datos del contacto pertenecen al módulo de gestión de clientes. Durante el registro de la comunicación se podrán consultar:

- Nombre.
- Cargo.
- Teléfono.
- Móvil.
- Correo electrónico.
- Número de WhatsApp.

La comunicación puede registrarse sin contacto, indicando únicamente el cliente.

El módulo conservará, además, el número concreto utilizado en la comunicación aunque posteriormente cambien los datos maestros del contacto.

### 4.3 Resultados

- Resuelta sin seguimiento.
- Requiere seguimiento.
- Sin respuesta.
- Información facilitada.
- Derivada a incidencia.

Seleccionar `Requiere seguimiento` obliga a crear una incidencia.

### 4.4 Relación con incidencias

- Una comunicación puede crear una nueva incidencia.
- Una comunicación puede vincularse a una incidencia existente.
- Una incidencia puede contener varias comunicaciones.
- Una comunicación puede vincularse posteriormente a una incidencia diferente.
- Al crear una incidencia desde una comunicación se copiarán el cliente, contacto, resumen y técnico.

### 4.5 Correcciones

Las comunicaciones no se pueden cancelar ni eliminar.

Se permiten correcciones, conservando:

- Valor o texto original.
- Valor o texto corregido.
- Usuario que realiza la corrección.
- Fecha y hora.
- Motivo de la corrección.

## 5. Incidencias

### 5.1 Datos principales

- Identificador.
- Número automático.
- Referencia al cliente existente, obligatoria.
- Referencia al contacto de origen, opcional.
- Título.
- Descripción.
- Categoría.
- Prioridad.
- Estado.
- Técnico responsable obligatorio.
- Colaboradores.
- Comunicación de origen, opcional.
- Fecha y hora de creación.
- Fecha y hora de última actualización.
- Fecha y hora de primera actuación.
- Fecha y hora de resolución.
- Fecha y hora de cierre.
- Solución, cuando corresponda.
- Motivo de cierre, cuando corresponda.
- Incidencia principal, si fue cerrada como duplicada.

### 5.2 Contexto del cliente

Desde una incidencia se podrá consultar, sin duplicar sus datos:

- Identificación y estado del cliente.
- Contactos.
- Suscripciones, solo para roles autorizados.
- Facturas y situación de facturación, solo para roles autorizados.
- Comunicaciones anteriores.
- Incidencias abiertas y cerradas.

Desde la ficha del cliente se mostrará su historial de comunicaciones e incidencias.

En la primera versión la incidencia no se vincula directamente a una suscripción. Puede vincularse opcionalmente a una tienda del mismo cliente.

### 5.3 Numeración

La numeración será anual y correlativa:

`INC-{AÑO}-{NÚMERO}`

Ejemplo: `INC-2026-00001`.

El contador se reinicia al comenzar cada año.

### 5.4 Prioridades

- Baja.
- Media.
- Alta.
- Urgente.

La prioridad predeterminada es `Media`.

Las incidencias urgentes deben destacarse visualmente y generar las notificaciones correspondientes.

### 5.5 Estados

- Nueva.
- En curso.
- Pendiente del cliente.
- Pendiente de tercero.
- Resuelta.
- Cerrada.

El estado inicial es `Nueva`.

Se permite cambiar entre cualesquiera estados, dejando constancia en el historial.

### 5.6 Significado de estados finales

`Resuelta` indica que la incidencia ha recibido una solución correcta.

`Cerrada` indica que la incidencia termina por una circunstancia distinta del proceso ordinario de resolución.

Una incidencia resuelta o cerrada no admite nuevas actuaciones hasta que sea reabierta.

### 5.7 Motivos de cierre

- Duplicada.
- No procede.
- Cliente desiste.
- Imposible contactar.
- Resuelta externamente.
- Otro.

Cuando se seleccione `Otro`, será obligatorio escribir una explicación.

### 5.8 Reglas

- Toda incidencia debe crearse con un responsable.
- Solo el responsable o el administrador pueden modificar sus datos principales.
- Solo el responsable puede reasignarla, salvo intervención del administrador.
- La primera actuación escrita por un técnico cambia automáticamente el estado de `Nueva` a `En curso`.
- Pasar a `Pendiente del cliente` o `Pendiente de tercero` exige indicar el motivo.
- Pasar a `Resuelta` exige documentar la solución.
- Pasar a `Cerrada` exige seleccionar el motivo de cierre.
- El responsable o el administrador pueden resolver o cerrar.
- Cualquier técnico puede reabrir una incidencia.
- La reapertura exige motivo, conserva al responsable y cambia el estado a `En curso`.
- Solo el administrador puede cambiar el cliente de una incidencia, dejando auditoría.

## 6. Categorías

Las categorías serán configurables por el administrador.

Cada categoría tendrá:

- Nombre.
- Descripción.
- Color identificativo.
- Estado activa o inactiva.

Una categoría inactiva no podrá seleccionarse en nuevas incidencias, pero continuará visible en el histórico.

## 7. Actuaciones

Las actuaciones documentan el trabajo realizado en una incidencia.

Cada actuación tendrá:

- Incidencia.
- Texto descriptivo.
- Técnico autor.
- Fecha y hora reales de la actuación.
- Fecha y hora de registro.

El responsable, los colaboradores y el administrador pueden añadir actuaciones.

Las actuaciones no se eliminan. Se permiten correcciones conservando texto original, texto corregido, autor, fecha y motivo.

## 8. Adjuntos

Los adjuntos pertenecen directamente a la incidencia.

### Reglas

- Formatos admitidos: JPG y PDF.
- Tamaño máximo: 16 MB por archivo.
- No existe límite total por incidencia.
- Pueden añadirlos el responsable, los colaboradores y el administrador.
- No se eliminan definitivamente.

## 9. Colaboración y reasignación

- Una incidencia tiene un único responsable.
- Puede tener varios colaboradores.
- Los colaboradores son añadidos y retirados manualmente por el responsable.
- Un colaborador puede seguir participando aunque la incidencia se reasigne.
- La reasignación conserva todo el historial.
- La incorporación y retirada de colaboradores quedan auditadas.

## 10. Fusión de incidencias

Las incidencias duplicadas se pueden fusionar.

### Reglas

- El responsable selecciona cuál será la incidencia principal.
- El administrador puede intervenir sin restricciones.
- La incidencia duplicada queda en estado `Cerrada`.
- Su motivo de cierre será `Duplicada`.
- La incidencia duplicada mantiene un enlace a la principal.
- Comunicaciones, actuaciones y adjuntos permanecen en sus registros originales.
- Todo el contenido relacionado se muestra conjuntamente desde la incidencia principal.
- La fusión queda registrada en el historial de ambas incidencias.

## 11. Historial y auditoría

El sistema registrará automáticamente:

- Creación.
- Cambios de cliente.
- Cambios de título o descripción.
- Cambios de categoría.
- Cambios de prioridad.
- Cambios de estado.
- Cambios de responsable.
- Incorporación o retirada de colaboradores.
- Actuaciones y sus correcciones.
- Adjuntos.
- Vinculación y cambio de comunicaciones.
- Resolución, cierre y reapertura.
- Fusión de incidencias.

Cada registro incluirá:

- Acción.
- Valor anterior.
- Valor nuevo.
- Usuario.
- Fecha y hora.
- Motivo, cuando proceda.

## 12. Notificaciones internas

Las notificaciones aparecerán dentro de la aplicación, enlazarán directamente con la incidencia y podrán marcarse como leídas.

Se generarán por:

- Asignación.
- Reasignación.
- Incorporación como colaborador.
- Nueva actuación de un colaborador.
- Reapertura.
- Cambio a prioridad urgente.
- Fusión de incidencias.

El administrador recibirá una notificación por cada incidencia urgente.

## 13. Pantallas

### 13.1 Panel principal

Mostrará:

- Incidencias nuevas.
- Incidencias en curso.
- Incidencias pendientes.
- Incidencias urgentes.
- Mis incidencias.
- Incidencias asignadas por técnico.
- Últimas comunicaciones.
- Notificaciones pendientes.

No existirá una lista de incidencias sin responsable porque el responsable es obligatorio.

### 13.2 Comunicaciones

Vista independiente con todas las comunicaciones, incluidas las que no generaron incidencia.

Permitirá:

- Crear una comunicación.
- Consultar su detalle.
- Corregirla.
- Crear una incidencia.
- Vincularla o cambiar su vinculación.

### 13.3 Incidencias

Permitirá:

- Crear una incidencia.
- Consultar y modificar según permisos.
- Añadir actuaciones y adjuntos.
- Gestionar colaboradores.
- Reasignar.
- Resolver, cerrar o reabrir.
- Fusionar duplicados.
- Consultar historial y comunicaciones relacionadas.
- Consultar el contexto del cliente.

### 13.4 Acceso desde clientes

La ficha del cliente incluirá:

- Historial de comunicaciones.
- Incidencias abiertas.
- Incidencias resueltas y cerradas.
- Acceso a la creación de una comunicación.
- Acceso a la creación de una incidencia con el cliente ya seleccionado.

### 13.5 Categorías

Pantalla administrativa para crear, modificar, activar y desactivar categorías.

### 13.6 Notificaciones

Listado de notificaciones pendientes y leídas, con acceso directo a la incidencia.

## 14. Filtros y búsquedas

### Filtros

- Cliente.
- Contacto.
- Técnico responsable.
- Colaborador.
- Estado.
- Prioridad.
- Categoría.
- Canal.
- Fecha desde y hasta.

### Búsqueda

- Número de incidencia.
- Título.
- Descripción.
- Contenido de actuaciones.

## 15. Indicadores

### Para técnicos

Cada técnico verá únicamente sus propios indicadores:

- Incidencias abiertas por estado.
- Incidencias por prioridad.
- Tiempo medio hasta primera actuación.
- Tiempo medio de resolución.
- Incidencias resueltas por periodo.
- Incidencias cerradas por periodo.

### Para administradores

El administrador verá indicadores globales y desglosados por técnico:

- Incidencias abiertas por estado.
- Incidencias por prioridad.
- Incidencias asignadas por técnico.
- Tiempo medio hasta primera actuación.
- Tiempo medio de resolución.
- Incidencias resueltas y cerradas por periodo.

## 16. Cálculo de tiempos

### Primera actuación

Se calcula desde la creación de la incidencia hasta la primera actuación textual escrita por un técnico.

Los eventos automáticos y los cambios de estado no cuentan como primera actuación.

### Resolución

Se calcula desde la creación hasta el cambio a `Resuelta`.

Se excluirá el tiempo permanecido en:

- Pendiente del cliente.
- Pendiente de tercero.

El sistema deberá registrar los intervalos de estado para calcular correctamente estos tiempos.

## 17. Conservación

- Comunicaciones, incidencias, actuaciones, auditorías y adjuntos se conservarán indefinidamente.
- No habrá eliminación definitiva desde la aplicación.
- Los clientes inactivos podrán consultarse y tener nuevas comunicaciones e incidencias.

## 18. Criterios generales de aceptación

1. Toda comunicación puede registrarse sin crear una incidencia.
2. Marcar una comunicación como `Requiere seguimiento` obliga a crear una incidencia.
3. Toda incidencia se crea con número anual, cliente, responsable, estado `Nueva` y prioridad `Media`.
4. La primera actuación textual cambia automáticamente una incidencia nueva a `En curso`.
5. Solo el responsable o el administrador modifican los datos principales.
6. Los colaboradores pueden añadir actuaciones y adjuntos.
7. Resolver exige una solución y cerrar exige un motivo.
8. Una incidencia finalizada debe reabrirse antes de admitir nuevas actuaciones.
9. Todas las modificaciones relevantes quedan auditadas.
10. Ninguna comunicación o actuación puede eliminarse.
11. Una incidencia duplicada puede cerrarse y enlazarse con su principal mediante una fusión.
12. Las notificaciones enlazan con la incidencia y pueden marcarse como leídas.
13. Los técnicos ven sus indicadores y el administrador puede consultar los globales.
14. Los tiempos de resolución excluyen los periodos pendientes.
15. La aplicación admite JPG y PDF de hasta 16 MB por archivo.

## 19. Decisiones pendientes para el diseño técnico

Estas decisiones no alteran la funcionalidad acordada, pero deberán resolverse antes de implementar:

- Método de almacenamiento y descarga segura de adjuntos.
- Convención horaria para fechas reales y fechas de registro.
- Estrategia de generación concurrente de números de incidencia.
- Mecanismo de búsqueda sobre títulos, descripciones y actuaciones.
- Modelo de permisos y relación con los usuarios existentes.
- Diseño de las notificaciones en tiempo real o mediante actualización periódica.
- Política de seguridad para archivos y datos personales.
- Contratos de integración entre clientes, suscripciones, facturación e incidencias.
- Datos históricos que deberán conservarse como instantánea cuando cambien los datos maestros.
