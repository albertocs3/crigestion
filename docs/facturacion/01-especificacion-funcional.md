# Especificación funcional: Facturación

## 0. Contexto del sistema

Facturación es un módulo común del software general de gestión.

Será utilizado tanto para:

- Facturas creadas manualmente.
- Facturas generadas desde Suscripciones.
- Presupuestos.
- Facturas rectificativas.
- Cobros, vencimientos y anticipos.
- Preparación posterior de remesas SEPA.

Todos los orígenes compartirán el mismo motor de facturas, series, impuestos, vencimientos, cobros, PDF, correo y VeriFactu.

La presente especificación recoge requisitos funcionales. Las reglas fiscales y técnicas de VeriFactu deberán validarse con la normativa vigente antes de implementar o poner el módulo en producción.

## 1. Propósito

El módulo permitirá:

- Elaborar presupuestos.
- Crear facturas ordinarias manualmente.
- Recibir facturas generadas por otros módulos.
- Emitir facturas rectificativas.
- Calcular impuestos, retenciones y vencimientos.
- Generar documentos PDF.
- Enviar y reenviar documentos por correo electrónico.
- Registrar cobros, devoluciones, impagados y anticipos.
- Preparar domiciliaciones para SEPA.
- Gestionar el envío y seguimiento de registros VeriFactu.
- Consultar listados, estados e indicadores.

## 2. Alcance

### Incluido

- Facturas ordinarias.
- Facturas rectificativas íntegras.
- Presupuestos.
- Líneas de catálogo y líneas manuales.
- Varios tipos de IVA por factura.
- Recargo de equivalencia.
- Retención de IRPF.
- Operaciones exentas y no sujetas.
- Descuentos por línea y globales.
- Varios vencimientos.
- Cobros parciales.
- Anticipos y cobros a cuenta.
- Devoluciones e incobrables.
- PDF personalizable.
- Envío por correo.
- Series y numeración anual.
- Integración con VeriFactu.
- Consulta de facturas manuales y de suscripciones.

### Fuera de alcance

- Facturas simplificadas.
- Proformas y albaranes.
- Firma digital de los PDF.
- Rectificativas por diferencias.
- Rectificación conjunta de varias facturas.
- Varias retenciones en una misma factura.
- Recargos comerciales distintos del recargo de equivalencia.
- Conciliación bancaria automática.
- Generación de remesas SEPA dentro de este módulo.
- Conservación de versiones históricas de presupuestos.

## 3. Actores y permisos

### Usuario general

Puede:

- Crear borradores de facturas.
- Crear y modificar borradores de presupuestos.
- Consultar documentos según sus permisos.

### Rol Facturación

Puede:

- Emitir facturas ordinarias.
- Emitir facturas rectificativas.
- Crear, enviar y convertir presupuestos.
- Generar y enviar PDF.
- Gestionar comunicaciones con VeriFactu.

### Administrador

Puede realizar todas las operaciones del módulo y administrar:

- Configuración.
- Series.
- Plantillas.
- Impuestos.
- Reglas de emisión.
- Permisos.

### Rol Contabilidad

Gestiona:

- Cobros.
- Vencimientos.
- Devoluciones.
- Impagados.
- Incobrables.
- Anticipos.
- Compensaciones.

Las capacidades concretas estarán sujetas al sistema común de permisos.

## 4. Cliente y datos fiscales

- Toda factura y presupuesto pertenece a un cliente registrado.
- Se podrá crear un cliente durante la elaboración del documento.
- La validación de NIF, dirección fiscal y código postal se realizará al crear o modificar el cliente.
- El cliente podrá tener un correo principal de facturación y destinatarios adicionales en copia.
- La factura utilizará los datos fiscales y condiciones de pago del cliente.
- Al emitir se conservará una instantánea fiscal completa del emisor y destinatario: razón social o nombre, NIF o VAT, domicilio y menciones fiscales aplicadas.

## 5. Tipos de documento

### Factura ordinaria

Documento de venta emitido manualmente o generado desde otro módulo.

### Factura rectificativa

Documento que rectifica íntegramente una única factura emitida.

### Presupuesto

Propuesta comercial que puede convertirse, total o parcialmente, en una única factura.

## 6. Series y numeración

Las series son fijas por tipo de documento:

- `F`: factura ordinaria.
- `R`: factura rectificativa.
- `P`: presupuesto.

Formato:

`{TIPO}{AA}{CORRELATIVO}`

Ejemplos:

- `F2600001`
- `R2600001`
- `P2600001`

### Reglas

- El correlativo se reinicia cada año.
- La serie se selecciona automáticamente por tipo de documento.
- No habrá varias series del mismo tipo.
- El número definitivo se asigna al emitir.
- Los borradores de factura no tienen número definitivo.
- La numeración emitida será correlativa y sin huecos.
- No podrá emitirse una factura con fecha anterior a la última factura de su serie si rompe el orden cronológico.
- Las fechas retroactivas solo se permiten dentro de ejercicios abiertos.

## 7. Estados

### 7.1 Estado documental de factura

- Borrador.
- Emitida.
- Rectificada.
- Anulada.

`Anulada` se reservará para documentos que puedan anularse antes de su registro definitivo. Una factura emitida se corrige siempre mediante una rectificativa.

### 7.2 Estado de cobro

- Pendiente.
- Parcialmente cobrada.
- Cobrada.
- Impagada.

El estado de cobro se mantiene separado del estado documental.

### 7.3 Estado VeriFactu

- No aplicable.
- Pendiente.
- Enviada.
- Aceptada.
- Aceptada con errores.
- Rechazada.

El estado VeriFactu se mantiene separado de los estados documental y de cobro.

## 8. Fechas

Una factura tendrá:

- Fecha de expedición.
- Fecha de operación, que podrá ser diferente.
- Fecha de creación.
- Fecha de emisión.

### Reglas

- Se permiten fechas de expedición anteriores al día actual.
- Se permiten fechas de operación de otro mes o ejercicio.
- Solo se emitirán documentos en ejercicios abiertos.
- La fecha no podrá infringir el orden cronológico de su serie.

## 9. Líneas de factura

Las líneas podrán:

- Seleccionarse del catálogo.
- Introducirse manualmente.

Cada línea tendrá:

- Producto o servicio, opcional en líneas manuales.
- Descripción.
- Cantidad.
- Precio unitario sin IVA.
- Descuento porcentual, opcional.
- Descuento fijo, opcional.
- Tipo de IVA.
- Recargo de equivalencia, cuando corresponda.
- Indicador de exención o no sujeción.
- Motivo fiscal, cuando corresponda.
- Cuenta contable, cuando proceda.
- Base.
- Cuota.
- Total.

Las líneas manuales utilizarán inicialmente los impuestos predeterminados, que podrán modificarse antes de emitir.

## 10. Cálculos e impuestos

### Orden funcional de cálculo

1. Cantidad por precio unitario.
2. Descuento de línea.
3. Descuento global.
4. IVA.
5. Recargo de equivalencia.
6. Retención global, cuando corresponda.

No habrá recargos comerciales adicionales.

### Descuentos

- Por línea: porcentaje o importe fijo.
- Global: porcentaje.

### IVA

- Se permiten varios tipos de IVA en una factura.
- Los precios del catálogo se guardan sin IVA.
- No se admite introducción de precios con IVA incluido.
- Se mostrará el desglose de bases y cuotas por tipo.

### Exención y no sujeción

- Se admiten operaciones exentas.
- La exención será habitualmente consecuencia de la localización del cliente.
- Se admiten operaciones no sujetas.
- Se deberá conservar el motivo fiscal aplicable.

### Retención

- Se admite una única retención por factura.
- Se aplica globalmente sobre la base correspondiente.

### Precisión

- Se utilizará `decimal`.
- Los importes tendrán dos decimales.
- El redondeo monetario se realizará por línea.

Las reglas exactas de cálculo y redondeo deberán validarse con los requisitos fiscales y contables.

## 11. Emisión y bloqueo

Al emitir una factura:

- Se asigna el número definitivo.
- Se bloquean los datos fiscales.
- Se bloquean fechas, líneas, impuestos, vencimientos y totales.
- Se genera el registro necesario para VeriFactu.
- La factura se considera emitida antes del envío por correo.

Una factura emitida no se modifica. Cualquier corrección se realiza mediante factura rectificativa.

Los cambios posteriores del cliente, catálogo, suscripción o configuración no alterarán los datos económicos del documento emitido.

## 12. Presupuestos

### 12.1 Datos

Un presupuesto contiene:

- Número.
- Cliente.
- Fecha.
- Fecha de validez.
- Líneas.
- Impuestos.
- Totales.
- Estado.

La validez predeterminada será de un mes.

### 12.2 Estados

- Borrador.
- Enviado.
- Aceptado.
- Rechazado.
- Caducado.
- Convertido.
- Descartado.

Los presupuestos no se eliminan. Los que ya no sean necesarios se marcan como `Descartado`.

### 12.3 Operaciones

- Se puede crear una factura sin presupuesto.
- Un presupuesto puede enviarse por correo.
- Un presupuesto enviado puede modificarse.
- Las modificaciones quedan auditadas.
- No se conservarán versiones completas anteriores consultables.
- Tras modificarlo se podrá volver a enviar.
- La aceptación se registra manualmente con fecha y usuario.
- Un presupuesto rechazado o caducado puede reabrirse.

### 12.4 Conversión

- Un presupuesto aceptado puede convertirse en factura.
- Copia cliente, líneas e importes.
- Puede convertirse total o parcialmente.
- Solo puede generar una factura.
- Al convertir parcialmente, la parte restante se descarta definitivamente.
- Tras la conversión queda bloqueado.
- La factura conserva referencia al presupuesto.

## 13. Facturas rectificativas

### 13.1 Reglas

- Una rectificativa afecta a una única factura.
- La rectificación será íntegra.
- No se admite rectificación solo por diferencias.
- No se admite una rectificativa para varias facturas.
- Copia inicialmente las líneas de la factura original.
- Invierte las unidades y, por tanto, bases, impuestos y totales.
- Puede tener total negativo.
- La factura original pasa a estado `Rectificada`.
- Después podrá emitirse una nueva factura correcta.

### 13.2 Motivos

- Error en datos.
- Error en importes.
- Devolución.
- Descuento posterior.
- Anulación de operación.
- Impago.
- Otro.

### 13.3 Relación con la factura original

Aunque inicialmente se indicó que la vinculación no siempre sería obligatoria, el flujo definido exige seleccionar una factura original para aplicar una rectificación íntegra.

La relación y sus excepciones deberán validarse durante la revisión normativa.

### 13.4 Compensación

- La rectificativa se compensa automáticamente con la factura original.
- También podrá utilizarse su saldo para compensar otras facturas del cliente.
- Toda compensación quedará registrada.

## 14. Vencimientos

Los vencimientos:

- Se calculan según las condiciones de pago del cliente.
- Se pueden modificar antes de emitir.
- Pueden ser varios por factura.

Cada vencimiento tendrá:

- Fecha.
- Importe.
- Estado.
- Forma de pago.

La suma de vencimientos debe coincidir exactamente con el total de la factura.

Formas de pago iniciales:

- Transferencia.
- Contado.
- Domiciliación.

Los vencimientos domiciliados podrán incluirse posteriormente en remesas SEPA desde el módulo correspondiente.

Solo podrán remesarse vencimientos pendientes con IBAN válido y mandato SEPA CORE activo. Un vencimiento incluido en una remesa activa no podrá incorporarse a otra.

Un vencimiento no pasa automáticamente a impagado solo por superar su fecha. Contabilidad debe registrar el impago.

## 15. Cobros

Se permiten:

- Cobros completos.
- Cobros parciales.
- Cobros aplicados a varias facturas o vencimientos.
- Devoluciones.
- Anticipos.
- Incobrables.

Cada cobro tendrá:

- Cliente.
- Fecha.
- Importe.
- Medio de cobro.
- Referencia bancaria.
- Observaciones.
- Usuario.
- Aplicaciones a facturas o vencimientos.

### Reglas

- `Cobrada` se asigna automáticamente cuando el saldo pendiente llega a cero.
- Una devolución recalcula el estado como pendiente o parcialmente cobrada.
- Las transferencias se concilian manualmente inicialmente.
- No se permiten cobros ordinarios sin asignar.
- Los anticipos se mantienen como saldo a favor hasta su aplicación o devolución.
- El saldo de anticipos se muestra en la ficha del cliente.
- Una factura puede marcarse como incobrable sin anularla.

## 16. Anticipos

Los anticipos sujetos a IVA requieren una factura de anticipo por el importe percibido.

### Reglas

- Pueden superar el importe de una factura.
- El remanente queda disponible para futuras aplicaciones.
- Pueden aplicarse a una o varias facturas definitivas sin duplicar bases ni cuotas.
- Pueden devolverse total o parcialmente.
- Se conserva su saldo y movimientos.
- Generan registro de facturación, IVA y asiento contable.
- Las operaciones exentas, no sujetas o especiales aplicarán su tratamiento específico.

## 17. PDF

El PDF incluirá:

- Logotipo.
- Datos fiscales de la empresa.
- Datos fiscales del cliente.
- Número y fechas.
- Líneas.
- Desglose fiscal.
- Totales.
- Vencimientos.
- Pie y condiciones configurables.
- Código QR VeriFactu cuando corresponda.

### Reglas

- Los PDF podrán regenerarse.
- No se conservará obligatoriamente cada archivo PDF generado.
- Se podrán descargar copias de facturas.
- No se requiere firma digital del PDF.
- El certificado digital se utilizará para la comunicación con VeriFactu.
- En la arquitectura web, ese certificado se custodia en servidor y nunca en el navegador ni en el equipo del usuario.

### Riesgo funcional

Para regenerar se conservarán todos los datos de emisión. La apariencia podrá cambiar con la plantilla vigente, pero el contenido fiscal y económico será idéntico. Se conservará el hash del PDF enviado y la versión o hash de la plantilla utilizada.

## 18. Correo electrónico

Facturas y presupuestos podrán enviarse y reenviarse desde la aplicación.

Antes del envío se podrán editar:

- Destinatario principal.
- Destinatarios en copia.
- Asunto.
- Mensaje.

Se propondrán valores predeterminados, por ejemplo:

`Adjuntamos su factura número F2600001.`

Cada intento conservará:

- Destinatarios.
- Asunto.
- Mensaje.
- Documento.
- Fecha y hora.
- Usuario.
- Resultado.
- Detalle del error.

Un envío fallido puede reintentarse sin alterar la factura.

## 19. VeriFactu

El módulo se preparará para:

- Generación de huella o hash.
- Encadenamiento de registros.
- Envío mediante certificado digital.
- Seguimiento de estado.
- Conservación de intentos y respuestas.
- Conservación de códigos y referencias devueltos.
- Inclusión del QR en el PDF cuando corresponda.

### Certificado digital

Facturacion no gestionara directamente el archivo del certificado. Consumira un servicio server-side de Configuracion o del adaptador VeriFactu.

Reglas:

- El certificado no se instala en el PC del usuario para operar la aplicacion web.
- Los envios y reintentos se realizan desde servidor o jobs.
- Cada intento registra que certificado logico se uso, sin exponer secretos.
- Un certificado no probado, caducado, revocado o sin representacion valida bloquea la remision.
- Si CriGestión actua como tercero, debe constar representacion o colaboracion social aplicable.

### Envío fallido

Si el envío falla:

- La factura continúa emitida.
- Su estado VeriFactu queda `Pendiente` o `Rechazada`, según el caso.
- Se podrá reintentar.
- Se conservará cada intento.

Los formatos, plazos, estados y reglas exactas deberán ajustarse a la normativa y especificaciones técnicas vigentes.

## 20. Listados

### Facturas

Filtros:

- Cliente.
- Fecha desde y hasta.
- Serie.
- Número.
- Origen manual o suscripción.
- Estado documental.
- Estado de cobro.
- Forma de pago.
- Estado VeriFactu.
- Vencimiento.

### Presupuestos

Se mostrarán en un listado independiente.

Filtros:

- Cliente.
- Fecha.
- Validez.
- Estado.
- Número.

## 21. Panel

Mostrará:

- Facturación del periodo.
- Facturas pendientes de cobro.
- Importe pendiente.
- Vencimientos vencidos.
- Facturas parcialmente cobradas.
- Facturas impagadas.
- Facturas rectificadas.
- Anticipos disponibles.
- Errores y pendientes VeriFactu.

El panel incluirá facturas manuales y facturas generadas por Suscripciones.

## 22. Historial y auditoría

Se registrarán:

- Creación y modificación de borradores.
- Emisión.
- Conversión de presupuestos.
- Cambios de estado.
- Rectificaciones.
- Generaciones de PDF.
- Envíos y reenvíos.
- Intentos VeriFactu.
- Vencimientos.
- Cobros.
- Devoluciones.
- Incobrables.
- Anticipos.
- Compensaciones.

Cada registro incluirá:

- Acción.
- Usuario.
- Fecha y hora.
- Valor anterior.
- Valor nuevo.
- Resultado.
- Motivo, cuando corresponda.

## 23. Pantallas mínimas

- Panel de facturación.
- Listado de facturas.
- Alta y edición de borrador.
- Detalle de factura.
- Emisión.
- Creación de rectificativa.
- Listado de presupuestos.
- Alta y edición de presupuesto.
- Conversión de presupuesto.
- Vencimientos.
- Cobros.
- Anticipos.
- Estado e historial VeriFactu.
- Generación y envío de PDF.
- Configuración fiscal.
- Configuración de plantillas.

## 24. Criterios generales de aceptación

1. Toda factura pertenece a un cliente.
2. Puede crearse un cliente durante la elaboración de un borrador.
3. Las líneas pueden proceder del catálogo o introducirse manualmente.
4. Una factura admite varios tipos de IVA y varios vencimientos.
5. El número definitivo se asigna al emitir.
6. La emisión bloquea los datos del documento.
7. Una factura emitida solo se corrige mediante rectificativa.
8. La rectificativa íntegra invierte cantidades, impuestos y totales.
9. Los estados documental, de cobro y VeriFactu son independientes.
10. La suma de vencimientos coincide con el total.
11. El estado de cobro se calcula según cobros y devoluciones.
12. Los presupuestos no se eliminan.
13. Un presupuesto solo genera una factura.
14. Una conversión parcial descarta la parte no facturada.
15. Facturas y presupuestos pueden enviarse y reenviarse por correo.
16. Cada envío e intento VeriFactu queda registrado.
17. Un fallo de correo o VeriFactu no deshace la emisión.
18. Los envios VeriFactu usan certificado custodiado server-side.
19. El panel incluye facturas manuales y de suscripciones.
20. No se emite en ejercicios cerrados.
21. No se permite romper el orden cronológico de la serie.

## 25. Decisiones pendientes y revisión normativa

Antes del diseño técnico deberán revisarse:

- Datos fiscales exactos que deben congelarse al emitir.
- Reglas de numeración y orden cronológico aplicables.
- Casos en los que una rectificativa debe vincularse a la original.
- Motivos y métodos legales de rectificación.
- Tratamiento de operaciones exentas y no sujetas.
- Orden exacto de descuentos, impuestos, recargo y retención.
- Reglas oficiales de redondeo.
- Requisitos de conservación de documentos y registros.
- Requisitos técnicos y plazos vigentes de VeriFactu.
- Modelo de custodia final del certificado y representacion para remision.
- Contenido y formato obligatorio del QR.
- Decisión final sobre conservar además el binario PDF originalmente enviado.
- Significado y uso permitido del estado `Anulada`.
- Compensación contable de rectificativas con otras facturas.
