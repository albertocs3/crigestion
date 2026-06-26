# Especificación funcional: Suscripciones

## 0. Contexto del sistema

Suscripciones es un módulo del software general de gestión empresarial.

Se integra con:

- Clientes y contactos.
- Catálogo de productos y servicios.
- Facturación.
- Usuarios y permisos.
- Contabilidad, mediante cuentas contables asociadas a los conceptos.
- SEPA, gestionado desde el módulo de facturación.

El módulo utilizará los datos maestros comunes y no mantendrá copias independientes de clientes, usuarios, productos ni formas de pago.

## 1. Propósito

El módulo permitirá crear, mantener, renovar y facturar contratos periódicos de software y servicios.

La primera versión deberá permitir:

- Mantener un catálogo de planes y conceptos.
- Crear y modificar suscripciones.
- Gestionar precios fijos o por usuarios/licencias.
- Programar cambios para la siguiente renovación.
- Cancelar y reactivar suscripciones.
- Preparar manualmente la facturación periódica mediante una vista previa.
- Agrupar la facturación por cliente y forma de pago.
- Gestionar errores y renovaciones pendientes.
- Consultar historial, avisos e indicadores.

## 2. Alcance

### Incluido

- CRUD de categorías, planes, conceptos y suscripciones.
- Suscripciones de software de gestión y servicios.
- Periodicidades mensual, trimestral, semestral y anual.
- Renovación y facturación anticipadas.
- Precios fijos o por usuarios/licencias.
- Varios conceptos por suscripción.
- Precios personalizados por suscripción, descuentos y recargos.
- Cambios programados.
- Cancelaciones inmediatas o programadas.
- Reactivación conservando el historial.
- Vista previa editable de facturación.
- Facturación agrupada.
- Gestión manual de pendientes y reintentos.
- Historial y auditoría.
- Avisos internos y panel de control.
- Consulta desde la ficha del cliente.

### Fuera de alcance

- Prorrateo de altas o cancelaciones.
- Mezcla de modalidades de precio dentro de una suscripción.
- Periodicidades diferentes dentro de una suscripción.
- Activación automática de borradores.
- Ejecución automática desatendida de la facturación.
- Generación de remesas SEPA.
- Modificación retroactiva de facturas ya emitidas.

## 3. Actores y permisos

### Usuario

Cualquier usuario autorizado puede:

- Consultar suscripciones.
- Crear suscripciones.
- Modificar datos no económicos.
- Activar una suscripción en borrador.
- Programar cambios.
- Cancelar y reactivar.
- Preparar vistas previas.
- Incluir o excluir clientes y suscripciones.
- Modificar textos, cantidades, fechas y otros datos no económicos de la vista previa.
- Confirmar la facturación.
- Consultar y reintentar renovaciones pendientes.

### Administrador

Además de las acciones anteriores, puede:

- Modificar precios.
- Modificar descuentos y recargos.
- Alterar datos económicos en la suscripción y en la vista previa.
- Activar una suscripción pendiente sin facturar.
- Administrar el catálogo y la configuración general.

Todas las operaciones quedan sujetas a los permisos generales del sistema.

## 4. Catálogo

### 4.1 Categorías

Las categorías iniciales son:

- Software de gestión.
- Servicios.

Una categoría podrá contener varios planes.

### 4.2 Planes

Un plan representa una modalidad comercial contratable.

Datos mínimos:

- Identificador.
- Categoría.
- Nombre.
- Descripción.
- Modalidad de precio.
- Precio base, cuando corresponda.
- Conceptos incluidos.
- Estado activo o inactivo.

Los planes pueden desactivarse sin afectar a las suscripciones existentes.

### 4.3 Modalidades de precio

- Importe fijo.
- Por usuarios/licencias.

Todos los conceptos de una suscripción compartirán la misma modalidad. No se podrá combinar un concepto fijo con otro por licencias dentro de la misma suscripción.

### 4.4 Conceptos

Datos mínimos:

- Identificador.
- Código.
- Descripción.
- Producto o servicio relacionado.
- Cuenta contable.
- Precio predeterminado.
- Estado activo o inactivo.

Los conceptos del plan se copiarán a la suscripción. También podrán añadirse conceptos manuales que no pertenezcan al plan.

## 5. Suscripción

### 5.1 Datos principales

- Identificador.
- Número automático.
- Cliente obligatorio.
- Nombre.
- Categoría.
- Plan.
- Periodicidad.
- Modalidad de precio.
- Estado.
- Fecha de inicio.
- Fecha de próxima renovación.
- Fecha de finalización opcional.
- Forma de pago.
- Conceptos.
- Cancelación programada, opcional.
- Observaciones.
- Fecha y usuario de creación.
- Fecha y usuario de última modificación.

### 5.2 Numeración

La numeración será anual y correlativa:

`SUS-{AÑO}-{NÚMERO}`

Ejemplo: `SUS-2026-00001`.

### 5.3 Relación con clientes

- Toda suscripción pertenece a un único cliente.
- Un cliente puede tener varias suscripciones simultáneas.
- Las suscripciones podrán consultarse desde la ficha del cliente.
- La factura utilizará los datos fiscales, forma de pago y vencimientos configurados para el cliente.

### 5.4 Periodicidades

- Mensual.
- Trimestral.
- Semestral.
- Anual.

Todos los conceptos de una suscripción tendrán la misma periodicidad.

## 6. Estados

### Borrador

Se utiliza para suscripciones futuras o todavía no confirmadas.

- No se factura.
- No se activa automáticamente al llegar la fecha de inicio.
- Cualquier usuario autorizado puede activarla manualmente.

### Activa

La suscripción está vigente y puede incluirse en el proceso de facturación cuando corresponda su renovación.

### Pendiente de renovación

La renovación no se ha completado.

Puede deberse a:

- Exclusión manual.
- Error de validación.
- Error al generar la factura.
- Datos fiscales incompletos.
- Ausencia de forma de pago.
- Otro.

El motivo deberá quedar registrado.

### Cancelada

La suscripción ha finalizado por cancelación inmediata o programada.

Debe conservarse todo su historial y puede reactivarse.

## 7. Conceptos e importes

Cada concepto de una suscripción tendrá:

- Descripción.
- Cantidad.
- Número de usuarios/licencias, cuando corresponda.
- Precio unitario.
- Descuento porcentual, opcional.
- Descuento fijo, opcional.
- Recargo porcentual, opcional.
- Recargo fijo, opcional.
- Importe resultante.
- Producto o servicio relacionado.
- Cuenta contable.

### Reglas económicas

- Para precios por licencias, el importe base será precio unitario por cantidad.
- Se permiten precios personalizados en cada suscripción.
- Se permiten descuentos y recargos porcentuales o fijos.
- Solo el administrador puede modificar precios, descuentos y recargos.
- Los precios se copian a la suscripción y no cambian cuando se modifica posteriormente el catálogo.
- Todos los importes se calculan con `decimal`.
- Se usan dos decimales.
- El redondeo se realiza por línea.
- Los conceptos de importe cero se incluyen en la factura.
- El IVA se obtiene de la configuración general del sistema, no de cada concepto.

## 8. Calendario y renovación

### 8.1 Inicio

- Se permiten fechas de inicio futuras.
- Una alta realizada a mitad de mes comenzará normalmente el primer día del mes siguiente.
- No existe prorrateo.
- Si se cobra un alta, se factura el periodo completo.
- La próxima renovación se calcula desde el primer día del periodo inicial.

### 8.2 Facturación anticipada

Las suscripciones se cobran por anticipado el primer día del mes en el que comienza el nuevo periodo.

Ejemplo:

Una suscripción trimestral que comienza el 1 de febrero se factura el 1 de febrero por el periodo febrero-abril. Su siguiente renovación corresponde al 1 de mayo.

### 8.3 Próxima renovación

- Se calcula automáticamente según fecha inicial y periodicidad.
- Solo avanza cuando la factura se genera correctamente.
- Mensual: un mes.
- Trimestral: tres meses.
- Semestral: seis meses.
- Anual: un año.

### 8.4 Varios periodos pendientes

Si existen varios periodos atrasados:

- Se generará una línea por cada periodo.
- Cada línea identificará claramente sus fechas.
- La próxima renovación solo avanzará por los periodos correctamente facturados.

## 9. Cambios programados

Se podrá modificar:

- Plan.
- Periodicidad.
- Conceptos.
- Cantidades.
- Número de licencias.
- Otros datos contractuales.

### Reglas

- Los cambios no alteran un periodo ya facturado.
- Se guardan como modificaciones programadas.
- Entran en vigor en la siguiente renovación.
- Se aplican antes de preparar la vista previa de esa renovación.
- Pueden cancelarse antes de su aplicación.
- Deben conservar valor anterior, valor nuevo, fecha efectiva, usuario y motivo.
- Los cambios económicos requieren permisos de administrador.

## 10. Cancelación y reactivación

### 10.1 Cancelación

La cancelación requiere:

- Fecha efectiva.
- Motivo.
- Usuario.
- Fecha de registro.

Puede ser:

- Inmediata.
- Programada.

Si la cancelación efectiva coincide con la fecha de renovación, se procesa la cancelación antes de facturar.

Si la cancelación ocurre dentro de un periodo que ya se va a cobrar o ya está cobrado, se factura el periodo completo y no se prorratea.

### 10.2 Reactivación

- Se reutiliza la misma suscripción.
- Se conserva todo el historial.
- Se puede indicar una nueva fecha de inicio.
- Se puede indicar una nueva fecha de próxima renovación.
- La reactivación debe quedar auditada.

## 11. Preparación de la facturación

La facturación periódica no se ejecutará automáticamente sin supervisión.

### 11.1 Inicio

- El proceso se inicia manualmente.
- Normalmente se ejecutará el primer día de cada mes.
- Puede ejecutarse en otra fecha para reintentos o casos especiales.
- Se selecciona el mes o fecha de proceso.
- Se incluyen únicamente renovaciones correspondientes al periodo seleccionado y los pendientes elegidos expresamente.

### 11.2 Vista previa

Antes de emitir facturas se generará una vista previa.

Permitirá:

- Seleccionar o excluir clientes.
- Seleccionar o excluir suscripciones.
- Consultar la agrupación prevista.
- Modificar descripciones.
- Modificar cantidades.
- Modificar fechas.
- Modificar líneas y otros datos de la factura.
- Modificar precios, descuentos y recargos únicamente al administrador.
- Cancelar el proceso sin emitir facturas.

Las modificaciones hechas en la vista previa afectan solamente a esa factura y no alteran la suscripción ni futuras renovaciones.

### 11.3 Exclusiones

- Una suscripción excluida queda en estado `Pendiente de renovación`.
- Se registra el motivo `Excluida manualmente`.
- Queda destacada en la pantalla de pendientes.
- No aparecerá automáticamente en una nueva vista previa ordinaria.
- Deberá seleccionarse expresamente desde la gestión de pendientes.

## 12. Generación de facturas

### 12.1 Agrupación

Las renovaciones se agrupan por:

- Cliente.
- Forma de pago.

Un mismo cliente tendrá facturas separadas cuando existan distintas formas de pago.

### 12.2 Líneas

La factura conservará líneas independientes por:

- Suscripción.
- Concepto.
- Periodo facturado.

Cada línea incluirá una referencia a la suscripción y una descripción del periodo, por ejemplo:

`Servicio del 01/02/2026 al 30/04/2026`.

### 12.3 Datos de facturación

Se utilizarán:

- Datos fiscales del cliente.
- Serie de facturación configurada.
- Forma de pago.
- Vencimientos.
- Tipo de IVA general.
- Productos o servicios.
- Cuentas contables relacionadas.

Las facturas con vencimientos podrán incorporarse posteriormente a remesas SEPA desde el módulo de facturación. Suscripciones no generará las remesas.

### 12.4 Atomicidad por factura agrupada

- Si falla una suscripción incluida en una factura agrupada, no se genera ninguna parte de esa factura.
- Todas las suscripciones del grupo afectado quedan pendientes con su motivo.
- El fallo de un cliente o forma de pago no debe impedir generar correctamente otros grupos independientes.

### 12.5 Facturas emitidas

- Una factura emitida no cambia aunque posteriormente se modifique la suscripción.
- Las correcciones se realizarán mediante los mecanismos del módulo de facturación.
- Los cambios de suscripción solo afectan a futuras renovaciones.

## 13. Prevención de duplicados

El sistema impedirá facturar dos veces la misma combinación de:

- Suscripción.
- Concepto.
- Periodo.

La comprobación deberá mantenerse aunque:

- Se repita el proceso.
- Se modifique la fecha de emisión.
- Se prepare un reintento.
- Varias ejecuciones coincidan en el tiempo.

## 14. Gestión de pendientes

Existirá una pantalla específica de renovaciones pendientes.

Mostrará:

- Cliente.
- Suscripción.
- Periodo pendiente.
- Motivo.
- Fecha del intento.
- Usuario.
- Detalle del error.
- Número de intentos.

Permitirá:

- Seleccionar pendientes.
- Preparar una nueva vista previa.
- Reintentar manualmente con el mismo periodo.
- Utilizar una fecha de factura diferente del día 1.
- Cancelar la suscripción.
- Activar sin facturar, únicamente por un administrador.

### Resultado del reintento

Si se factura correctamente:

- La próxima renovación avanza.
- La suscripción pasa automáticamente a `Activa`.
- Se cierra el pendiente.

Si vuelve a fallar:

- Permanece `Pendiente de renovación`.
- Se registra el nuevo intento y su resultado.

Una suscripción pendiente no se incluirá automáticamente en vistas previas ordinarias.

## 15. Resultado del proceso

Al finalizar se mostrará y conservará un informe con:

- Facturas creadas.
- Clientes procesados.
- Suscripciones facturadas.
- Suscripciones excluidas.
- Suscripciones pendientes.
- Errores de validación.
- Errores de generación.
- Importes totales.
- Usuario y fecha de ejecución.

## 16. Avisos internos

Se generarán avisos por:

- Próximas renovaciones.
- Suscripciones pendientes.
- Errores de facturación.
- Cancelaciones próximas.
- Cambios programados próximos a aplicarse.

Los avisos:

- Aparecerán dentro de la aplicación.
- Enlazarán con la suscripción o proceso relacionado.
- Podrán marcarse como leídos.

## 17. Panel

Mostrará:

- Suscripciones activas.
- Suscripciones en borrador.
- Suscripciones pendientes de renovación.
- Cancelaciones próximas.
- Renovaciones del mes.
- Importe previsto del mes.
- Errores del último proceso.

Los importes del panel serán estimaciones y no sustituirán los totales de facturas emitidas.

## 18. Historial y auditoría

Se conservarán indefinidamente:

- Creación.
- Activación.
- Cambios de estado.
- Cambios de plan.
- Cambios de periodicidad.
- Cambios de cantidades o licencias.
- Cambios de precios, descuentos y recargos.
- Cambios programados y su cancelación.
- Renovaciones.
- Facturas generadas.
- Exclusiones y errores.
- Cancelaciones.
- Reactivaciones.

Cada entrada incluirá:

- Acción.
- Valor anterior.
- Valor nuevo.
- Motivo.
- Usuario.
- Fecha y hora.

No se eliminará el historial al reactivar una suscripción.

## 19. Pantallas mínimas

- Panel de suscripciones.
- Listado de suscripciones.
- Alta y edición de suscripción.
- Detalle e historial.
- Catálogo de categorías.
- Catálogo de planes.
- Catálogo de conceptos.
- Cambios programados.
- Preparación y vista previa de facturación.
- Resultado del proceso.
- Renovaciones pendientes.
- Configuración general.
- Suscripciones dentro de la ficha del cliente.

## 20. Filtros y búsquedas

### Filtros

- Cliente.
- Categoría.
- Plan.
- Estado.
- Periodicidad.
- Modalidad de precio.
- Forma de pago.
- Próxima renovación.
- Fecha de inicio.
- Fecha de cancelación.

### Búsqueda

- Número de suscripción.
- Nombre.
- Cliente.
- Concepto.

## 21. Configuración general

Incluirá, al menos:

- Tipo de IVA aplicable.
- Serie de facturación.
- Día habitual de preparación de facturas.
- Reglas de redondeo.
- Periodo de antelación para avisos.
- Valores predeterminados de forma de pago y vencimientos cuando no estén definidos por el cliente.

## 22. Criterios generales de aceptación

1. Un cliente puede tener varias suscripciones.
2. Toda suscripción tiene número anual, cliente, periodicidad, modalidad, estado y conceptos.
3. Una suscripción en borrador no se activa ni factura automáticamente.
4. Todos sus conceptos comparten periodicidad y modalidad de precio.
5. Los cambios del catálogo no alteran precios ya contratados.
6. Solo el administrador puede modificar precios, descuentos y recargos.
7. Los cambios contractuales se aplican en la siguiente renovación.
8. La facturación requiere una vista previa y confirmación manual.
9. Las facturas se agrupan por cliente y forma de pago.
10. Cada línea identifica suscripción, concepto y periodo.
11. El proceso impide facturar dos veces el mismo periodo.
12. Si falla una suscripción, falla su factura agrupada completa.
13. Una exclusión deja la suscripción pendiente y exige reintento manual.
14. La próxima renovación solo avanza tras facturar correctamente.
15. Un reintento correcto devuelve la suscripción a `Activa`.
16. Una cancelación en fecha de renovación se procesa antes de facturar.
17. No se realizan prorrateos.
18. Las facturas emitidas no cambian por modificaciones posteriores.
19. Todos los cambios relevantes quedan auditados.
20. La reactivación conserva el historial de la suscripción.

## 23. Decisiones pendientes para el diseño técnico

- Contratos exactos con clientes, catálogo y facturación.
- Modelo de instantáneas de datos fiscales y económicos.
- Estrategia transaccional para facturas agrupadas.
- Mecanismo concurrente de numeración.
- Clave de idempotencia para evitar facturación duplicada.
- Reglas exactas de cálculo y orden de descuentos y recargos.
- Política de permisos detallada para acciones no económicas.
- Tratamiento técnico de periodos acumulados.
- Programación y caducidad de avisos.
- Volumen esperado y paginación de vistas previas e historiales.
