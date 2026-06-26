# Integraciones funcionales transversales

## 1. Propósito

Este documento define los contratos funcionales entre módulos cuando una misma operación afecta a facturación, suscripciones, contabilidad, clientes, incidencias y cumplimiento fiscal.

Prevalece sobre las descripciones aisladas de cada módulo para los flujos aquí regulados.

## 2. Motor único de facturación

Facturación es el único módulo propietario de:

- Cabecera y líneas de factura.
- Series y numeración.
- Datos fiscales congelados.
- Impuestos y redondeos.
- Vencimientos.
- Estados documentales y de cobro.
- PDF y correo.
- Registros de facturación y VeriFactu.
- Rectificaciones.

Suscripciones, Presupuestos y cualquier módulo futuro no crearán estructuras paralelas de factura. Prepararán una solicitud o borrador para el motor común.

### Orígenes

Toda factura indicará su origen:

- Manual.
- Suscripción.
- Presupuesto.
- Anticipo.
- Otro módulo futuro.

### Datos de trazabilidad

Cada línea podrá conservar:

- Módulo de origen.
- Identificador del documento de origen.
- Identificador del concepto de origen.
- Periodo facturado.
- Clave de idempotencia.

### Facturación de suscripciones

Suscripciones:

1. Calcula las renovaciones candidatas.
2. Aplica los cambios programados.
3. Prepara la vista previa.
4. Agrupa por cliente y forma de pago.
5. Envía grupos confirmados al motor de Facturación.

Facturación:

1. Valida cliente, ejercicio, fiscalidad y numeración.
2. Genera la factura y sus vencimientos.
3. Genera el registro de facturación.
4. Genera el asiento contable.
5. Devuelve el resultado a Suscripciones.

Solo tras completar correctamente toda la operación:

- La renovación queda facturada.
- Avanza la próxima fecha.
- La suscripción pasa a `Activa`.

Si falla cualquier paso obligatorio:

- No se considera emitida la factura.
- No avanza la renovación.
- La suscripción queda pendiente.

La clave de idempotencia será, como mínimo:

`Suscripción + concepto + periodo`

## 3. Emisión y contabilidad

La emisión de una factura de venta debe coordinar en una única operación lógica:

- Asignación del número.
- Congelación de datos.
- Registro de facturación de alta.
- Vencimientos.
- Registro de IVA.
- Asiento contable.
- Movimiento de stock, si existen productos físicos.

### Asiento de venta

- Debe: cuenta del cliente por el total.
- Haber: cuentas de ingreso por bases.
- Haber: IVA repercutido por cuotas.
- Haber o Debe: otras partidas fiscales cuando correspondan.

Una factura de suscripción utiliza exactamente este asiento; no genera otro asiento adicional.

### Fallos

No debe quedar una factura emitida sin su representación contable e inventario obligatorios.

Cuando una comunicación externa, como VeriFactu, falle después de consolidarse la emisión:

- La factura continúa emitida.
- El asiento permanece vigente.
- El envío queda pendiente de reintento.

## 4. Cobros y contabilidad

Registrar un cobro genera:

- Aplicación a uno o varios vencimientos.
- Recalculo del saldo y estado de cobro.
- Asiento de banco o caja contra cliente.

La operación debe ser transaccional.

### Devolución

Una devolución:

- Revierte total o parcialmente la aplicación del cobro.
- Recalcula la factura.
- Genera el asiento contable inverso.
- Conserva el cobro y la devolución como operaciones separadas.

La conciliación bancaria no crea estos asientos; solo los verifica.

## 5. Rectificaciones

Una factura emitida nunca se sobrescribe.

La corrección funcional se realiza mediante una nueva factura rectificativa que:

- Tiene serie propia.
- Indica su condición de rectificativa.
- Indica la causa.
- Identifica la factura rectificada.
- Conserva la relación entre ambos documentos.
- Genera su propio registro de facturación.
- Genera su asiento e IVA.
- Revierte stock cuando corresponda.

### Alcance inicial del producto

La primera versión implementará:

- Una factura rectificada por documento.
- Rectificación íntegra.
- Importes inversos y posterior factura correcta cuando proceda.

La normativa permite otros métodos y rectificar varias facturas en ciertos supuestos. Estas posibilidades quedarán fuera del alcance inicial, pero el modelo de datos no deberá impedir incorporarlas.

### Registro de anulación

El registro de facturación de anulación del sistema informático se reservará para el supuesto técnico y fiscal en que se haya emitido erróneamente una factura y deba anularse su registro de alta.

No se utilizará como sustituto general de:

- Una factura rectificativa.
- Una devolución comercial.
- Una cancelación de servicio.
- Una corrección contable.

Los registros originales permanecerán inalterados.

## 6. Anticipos de clientes

Un pago anticipado sujeto a IVA produce devengo por el importe cobrado.

Por tanto, no se tratará únicamente como un saldo a favor sin documento fiscal.

### Flujo

1. Se registra el cobro anticipado.
2. Se emite una factura de anticipo por el importe percibido y sus impuestos.
3. Se genera el registro de facturación y el asiento correspondiente.
4. El anticipo queda disponible para aplicarse a la factura definitiva.
5. La factura definitiva refleja y descuenta el anticipo sin duplicar base ni cuota.

### Asiento orientativo

Al cobrar el anticipo:

- Debe: banco o caja.
- Haber: anticipo de cliente.
- Haber: IVA repercutido, cuando corresponda.

La estructura exacta se configurará y validará contablemente.

### Excepciones

Las operaciones no sujetas, exentas o con reglas especiales deberán aplicar su tratamiento fiscal específico.

No se implementará un “cobro a cuenta” fiscalmente neutro cuando el pago determine devengo de IVA.

## 7. Clientes, incidencias y suscripciones

### Cliente

- Toda incidencia pertenece obligatoriamente a un cliente.
- El cliente es el dato maestro.
- Una fusión no cambia el titular histórico de documentos emitidos.

### Tienda

- Una incidencia puede vincularse opcionalmente a una tienda del mismo cliente.
- Las comunicaciones se mantienen vinculadas al cliente general.

### Suscripción

En la primera versión:

- Una suscripción pertenece al cliente general.
- Una incidencia no exige ni mantiene una vinculación directa con una suscripción.
- Las suscripciones forman parte del contexto consultable del cliente.
- Solo usuarios con permiso de Suscripciones pueden consultar ese contexto.
- El rol Técnico no puede ver datos contractuales ni económicos de las suscripciones.

Una futura vinculación directa deberá garantizar que la suscripción pertenece al cliente de la incidencia.

## 8. VeriFactu y registros de facturación

El sistema de facturación deberá cumplir los requisitos aplicables a los sistemas informáticos de facturación.

### Requisitos funcionales mínimos

- Registro de alta simultáneo o inmediatamente anterior a la expedición.
- Registro de anulación cuando proceda.
- Integridad e inalterabilidad.
- Conservación, accesibilidad y legibilidad.
- Trazabilidad.
- Encadenamiento.
- Huella o hash.
- Firma electrónica de los registros cuando la modalidad aplicable lo exija.
- Fecha, hora, minuto y segundo de generación.
- Identificación del sistema y su productor.
- Registro de eventos.
- Código QR en las facturas cuando corresponda.
- Leyenda `VERI*FACTU` cuando el registro haya sido remitido bajo esa modalidad.
- Capacidad de remisión electrónica a la AEAT.
- Declaración responsable del productor del software.

### Modalidad

La solución se diseñará para operar como sistema de emisión de facturas verificables con remisión a la AEAT.

El estado de envío se mantendrá separado del estado documental:

- Pendiente.
- Enviada.
- Aceptada.
- Aceptada con errores.
- Rechazada.

### Certificado digital y custodia

En la arquitectura web de CriGestión, el certificado digital para remision VeriFactu se custodiara en servidor, no en el navegador ni en el equipo del usuario.

Reglas:

- El certificado pertenecera al obligado tributario o a un tercero autorizado para remitir en su nombre.
- Configuracion sera propietaria de los metadatos, estado, caducidad y prueba del certificado.
- Facturacion consumira el certificado solo a traves del adaptador VeriFactu.
- El archivo del certificado y sus secretos se almacenaran cifrados fuera del repositorio.
- Cada uso del certificado quedara auditado con factura, intento, fecha, resultado y respuesta AEAT.
- Los reintentos se ejecutaran desde servidor o jobs, sin requerir sesion abierta ni PC de usuario encendido.
- Un certificado caducado, revocado, no probado o sin permisos bloqueara nuevos envios.

Si el envio lo realiza CriGestión como tercero en nombre del cliente, antes de activar la remision debera constar la representacion o colaboracion social aplicable.

### Fechas vigentes de adaptación

Según el texto consolidado publicado el 3 de diciembre de 2025:

- Los obligados del artículo 3.1.a) deberán tener los sistemas adaptados antes del 1 de enero de 2027.
- El resto de obligados del artículo 3.1 deberán tenerlos operativos antes del 1 de julio de 2027.

Estas fechas deberán verificarse de nuevo antes de la puesta en producción.

### Actualización normativa

La implementación deberá basarse en:

- Real Decreto 1007/2023 y sus modificaciones.
- Orden técnica vigente.
- Esquemas, servicios web, validaciones y preguntas frecuentes publicados por la AEAT.

Los contratos con AEAT no deberán codificarse como lógica rígida dispersa; se encapsularán para poder actualizar versiones.

## 9. Inmutabilidad del documento emitido

Tras la emisión quedan bloqueados:

- Número y serie.
- Fechas.
- Emisor.
- Destinatario.
- Direcciones fiscales.
- NIF o VAT.
- Líneas.
- Cantidades y precios.
- Descuentos.
- Bases, tipos y cuotas.
- Retenciones.
- Totales.
- Vencimientos iniciales.
- Motivos fiscales.
- Referencias al origen.

Los cambios posteriores de clientes, catálogo, suscripciones, impuestos o configuración no alteran esos datos.

### Instantánea fiscal

No basta con conservar únicamente el NIF.

La factura conservará como mínimo:

- Razón social o nombre completo del emisor.
- NIF del emisor.
- Domicilio del emisor.
- Razón social o nombre completo del destinatario.
- NIF o VAT del destinatario.
- Domicilio del destinatario.
- Datos fiscales y menciones aplicadas.

## 10. Conservación del documento

Se conservarán durante el plazo legal:

- Copia o matriz de cada factura expedida.
- Facturas recibidas.
- Registros de alta y anulación.
- Encadenamiento, hash y firma.
- Respuestas e intentos de envío.
- Datos y mecanismos necesarios para garantizar autenticidad, integridad y legibilidad.

La Administración deberá poder:

- Visualizar.
- Buscar.
- Copiar.
- Descargar.
- Imprimir.

## 11. Representación PDF

El PDF es una representación de la factura, no el único registro fiscal.

### Regla acordada

- No se conservará obligatoriamente cada binario PDF generado.
- Se conservará la matriz completa e inmutable de datos.
- El PDF podrá regenerarse.
- Podrá utilizar la plantilla vigente y diferir visualmente del enviado originalmente.

### Garantía mínima

Aunque cambie la presentación:

- El contenido fiscal y económico será idéntico.
- El número, fechas, partes, líneas, impuestos, totales y QR aplicables no cambiarán.
- La copia se identificará como tal cuando corresponda.

### Riesgo aceptado

No conservar el PDF originalmente remitido impide demostrar que su apariencia era exactamente la misma.

Por ello, se conservarán al menos:

- Fecha de generación.
- Usuario.
- Versión o hash de la plantilla.
- Hash del PDF enviado, cuando se envíe.
- Destinatarios y resultado del envío.

Esto permite demostrar qué datos y configuración intervinieron, aunque no se conserve el archivo binario.

## 12. Criterios transversales de aceptación

1. No existen dos motores de facturación.
2. Toda factura indica origen y referencias.
3. Una renovación solo avanza después de emitir correctamente.
4. La emisión crea de forma coherente factura, vencimientos, IVA, asiento y stock.
5. Los cobros y devoluciones generan su contabilidad.
6. La conciliación no crea asientos.
7. Una factura emitida no se sobrescribe.
8. Una rectificación genera un documento y registro nuevos.
9. Un anticipo sujeto a IVA genera factura de anticipo.
10. Toda incidencia pertenece a un cliente.
11. La tienda relacionada debe pertenecer al cliente.
12. Los técnicos no acceden a datos de suscripciones.
13. Los registros de facturación originales permanecen inalterados.
14. Se conserva una instantánea fiscal completa.
15. Los PDF regenerados mantienen el contenido fiscal aunque cambie la plantilla.
16. Se conserva el hash de los PDF enviados.

## 13. Decisiones técnicas pendientes

- Límite exacto de la transacción distribuida entre módulos.
- Patrón de eventos y bandeja de salida para comunicaciones externas.
- Esquema de claves de idempotencia.
- Plan de cuentas definitivo para anticipos.
- Representación de anticipos en la factura final.
- Modelo extensible para rectificaciones por diferencias y agrupadas.
- Modalidad exacta y versionado de servicios VeriFactu.
- Modelo legal-operativo final para remision propia o en representacion de terceros.
- Declaración responsable del productor.
- Política final sobre conservación del PDF original.
