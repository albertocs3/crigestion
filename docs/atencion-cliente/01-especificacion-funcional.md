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
- Recibe avisos de todas las incidencias urgentes mediante el permiso `Support.ReceiveUrgentNotifications`.
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

La prioridad predeterminada es `Media`, pero puede seleccionarse otra prioridad durante el alta.

Las incidencias urgentes deben destacarse visualmente y generar las notificaciones correspondientes.
El responsable vigente o un administrador puede cambiar posteriormente la prioridad dejando motivo e historial. Una incidencia `Resuelta` o `Cerrada` debe reabrirse antes de cambiarla.

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
El motivo `Duplicada` se aplica exclusivamente mediante la fusión con una incidencia principal; no está disponible en el cierre ordinario.

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
- La plataforma aplica un límite operativo de capacidad por empresa para proteger disco y copias integrales; no cambia la ausencia de una cuota funcional por expediente y requiere intervención administrativa cuando se alcanza.
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

- La fusión requiere `Support.MergeIncidents`. Salvo el administrador, el actor debe ser responsable vigente tanto de la principal como de la duplicada.
- El responsable selecciona cuál será la incidencia principal; el administrador puede intervenir sin esa restricción de asignación.
- Ambas incidencias pertenecen a la misma empresa y al mismo cliente. La principal debe ser un registro canónico y no puede estar fusionada a otra.
- La incidencia duplicada queda en estado `Cerrada`.
- Su motivo de cierre será `Duplicada`.
- La incidencia duplicada mantiene un enlace a la principal.
- Ambas incidencias deben estar activas. La incidencia duplicada es terminal tras la fusión: no puede reabrirse ni recibir nuevas modificaciones operativas.
- Una principal que ya agrupa duplicadas no puede fusionarse a su vez dentro de otra incidencia.
- Comunicaciones, actuaciones y adjuntos permanecen en sus registros originales.
- Todo el contenido relacionado se muestra conjuntamente desde la incidencia principal.
- La fusión queda registrada en el historial de ambas incidencias.
- La operación exige motivo y confirmación explícita, incrementa la versión de ambas incidencias y no puede deshacerse mediante el flujo ordinario.

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

Cada usuario activo con `Support.ReceiveUrgentNotifications` recibirá una notificación cuando una incidencia se cree como urgente o cambie de una prioridad no urgente a `Urgente`. Un mismo destinatario recibe un único aviso por evento, aunque también sea responsable de la incidencia.

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

La foto considera únicamente incidencias canónicas abiertas. `Pendientes` es
la suma de `Pendiente del cliente` y `Pendiente de tercero`, aunque el panel
mantiene visibles ambos subtotales. `Mis incidencias` son las que tienen al
usuario de la sesión como responsable vigente; la colaboración no altera esta
atribución.

La carga nominal por técnico solo se muestra a quien posee
`Support.ViewGlobalIndicators`. Conserva responsables inactivos mientras aún
tengan carga abierta, para que esa carga no quede oculta. Las cinco últimas
comunicaciones se ordenan por `occurredAt` e identificador y solo se muestran
con `Support.ViewCommunications`; la vista resumida no expone teléfono, resumen,
duración, contacto ni correcciones. Las notificaciones pendientes son las no
leídas, no expiradas y destinadas al usuario de la sesión. El panel se actualiza
al navegar o recargar y no promete entrega en tiempo real.

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

La integración no amplía por sí sola el acceso del técnico a la ficha fiscal o
económica del cliente: la ficha continúa exigiendo `Customers.View`. Dentro de
ella, las incidencias se consultan únicamente con `Support.View` y las
comunicaciones solo con `Support.ViewCommunications`. Las acciones de alta
requieren además `Support.Create` o `Support.ManageCommunications`, según
corresponda, y reutilizan los contratos protegidos con CSRF e idempotencia.

La vista muestra como máximo las diez filas más recientes de cada bloque y
enlaza a los listados completos filtrados por cliente. Las incidencias
fusionadas se conservan entre las finalizadas e identifican su principal. La
proyección de comunicaciones no incluye número utilizado, resumen ni
correcciones.

### 13.5 Categorías

Pantalla administrativa para crear, modificar, activar y desactivar categorías.

### 13.6 Notificaciones

Listado de notificaciones pendientes y leídas, con acceso directo a la incidencia.

## 14. Filtros y búsquedas

### Filtros

- El listado de incidencias combina con `AND` cliente, técnico responsable,
  colaborador activo, estado, prioridad, categoría y fecha de creación.
- El listado de comunicaciones combina con `AND` cliente, contacto vigente o
  histórico, incidencia, canal, dirección, resultado y fecha real de la
  comunicación.
- Los rangos son fechas locales inclusivas de `Europe/Madrid`, requieren ambos
  extremos y no pueden superar 366 días. El servidor los convierte a un rango
  UTC semiabierto, incluidos los días de cambio horario.
- Los filtros operan sobre el registro físico: una duplicada fusionada conserva
  su historial y no se mezcla implícitamente con la principal en los listados.
- Las referencias de filtrado son proyecciones mínimas y no exponen teléfonos,
  resúmenes ni datos económicos.

### Búsqueda

- Número de incidencia.
- Título.
- Descripción.
- Contenido de actuaciones.

La primera rebanada implementa número, título y descripción, con términos de 3
a 120 caracteres, índices trigram y una cuota persistente de 30 búsquedas por
actor y empresa cada 15 minutos. La búsqueda sobre actuaciones queda pendiente
de incorporar su propio índice de texto y timeout de consulta; no se habilitará
con un `ILIKE` sin protección sobre todo el histórico.

## 15. Indicadores

### Para técnicos

Cada técnico verá únicamente sus propios indicadores:

- Incidencias abiertas por estado.
- Incidencias por prioridad.
- Tiempo medio hasta primera actuación.
- Tiempo medio de resolución.
- Incidencias resueltas por periodo.
- Incidencias cerradas por periodo.

La foto de incidencias abiertas se atribuye al responsable vigente. La primera
actuación se atribuye al autor de la actuación textual real más temprana. Las
resoluciones y cierres se atribuyen al responsable que constaba en el evento,
de forma que una reasignación posterior no reescribe indicadores históricos.
La muestra de primera actuación se imputa al periodo de su fecha real
`performedAt`, aunque se haya registrado posteriormente; una corrección
retroactiva legítima puede por tanto actualizar un informe histórico.

### Para administradores

El administrador verá indicadores globales y desglosados por técnico:

- Incidencias abiertas por estado.
- Incidencias por prioridad.
- Incidencias asignadas por técnico.
- Tiempo medio hasta primera actuación.
- Tiempo medio de resolución.
- Incidencias resueltas y cerradas por periodo.

La vista global incluye el desglose por técnico aplicando las mismas reglas de
atribución. Las incidencias cerradas como duplicadas mediante fusión no se
consideran cierres operativos y las duplicadas fusionadas no forman parte de la
foto ni de los tiempos de productividad.

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

Los tiempos son naturales, no laborables, y se expresan internamente en
segundos enteros. Cada transición a `Resuelta` constituye un episodio: el
primero comienza en la creación y los siguientes en la reapertura anterior. Se
descuenta la unión de los intervalos `Pendiente del cliente` y `Pendiente de
tercero` comprendidos dentro del episodio. Las incidencias sin muestra no
aportan cero a una media; el indicador muestra media nula y tamaño de muestra
cero.

Los periodos se introducen como fechas locales inclusivas y se interpretan en
`Europe/Madrid`. La consulta usa un intervalo UTC semiabierto desde las 00:00
de la primera fecha hasta las 00:00 del día posterior a la última, respetando
los cambios de horario. El periodo máximo consultable es de 366 días.

## 17. Conservación

- Comunicaciones, incidencias, actuaciones, auditorías y adjuntos se conservarán indefinidamente.
- No habrá eliminación definitiva desde la aplicación.
- Los clientes inactivos podrán consultarse y tener nuevas comunicaciones e incidencias.

## 18. Criterios generales de aceptación

1. Toda comunicación puede registrarse sin crear una incidencia.
2. Marcar una comunicación como `Requiere seguimiento` obliga a crear una incidencia.
3. Toda incidencia se crea con número anual, cliente, responsable, estado `Nueva` y prioridad seleccionable, `Media` de forma predeterminada.
4. La primera actuación textual cambia automáticamente una incidencia nueva a `En curso`.
5. Solo el responsable o el administrador modifican los datos principales.
6. Los colaboradores pueden añadir actuaciones y adjuntos.
7. Resolver exige una solución y cerrar exige un motivo.
8. Una incidencia finalizada debe reabrirse antes de admitir nuevas actuaciones o cambios de prioridad.
9. Todas las modificaciones relevantes quedan auditadas.
10. Ninguna comunicación o actuación puede eliminarse.
11. Una incidencia duplicada solo puede cerrarse con motivo `Duplicada` mediante una fusión confirmada que la enlace con una principal del mismo cliente.
12. Las notificaciones enlazan con la incidencia y pueden marcarse como leídas.
13. Los técnicos ven sus indicadores y el administrador puede consultar los globales.
14. Los tiempos de resolución excluyen los periodos pendientes.
15. La aplicación admite JPG y PDF de hasta 16 MB por archivo.

## 19. Decisiones pendientes para el diseño técnico

Estas decisiones no alteran la funcionalidad acordada, pero deberán resolverse antes de implementar:

- Evolución de capacidad y archivado cuando el volumen de adjuntos supere el techo operativo inicial.
- Convención horaria de integraciones futuras distintas de los indicadores,
  que ya usan `Europe/Madrid` conforme al apartado 16.
- Estrategia de generación concurrente de números de incidencia.
- Mecanismo de búsqueda sobre títulos, descripciones y actuaciones.
- Modelo de permisos y relación con los usuarios existentes.
- Diseño de las notificaciones en tiempo real o mediante actualización periódica.
- Política de seguridad para archivos y datos personales.
- Contratos de integración entre clientes, suscripciones, facturación e incidencias.
- Datos históricos que deberán conservarse como instantánea cuando cambien los datos maestros.
