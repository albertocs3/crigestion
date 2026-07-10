# Especificación funcional: Tesorería y SEPA

## 0. Contexto

Tesorería y SEPA es un módulo común del software de gestión.

Se integra con:

- Clientes y mandatos SEPA.
- Facturación y vencimientos de clientes.
- Compras, proveedores y vencimientos de pago.
- Cobros y pagos.
- Suscripciones.
- Contabilidad.

Los cobros y pagos generan sus asientos antes de la conciliación. La conciliación bancaria verifica movimientos existentes y no crea automáticamente cobros, pagos, gastos ni asientos.

## 1. Propósito

El módulo permitirá:

- Mantener la cuenta bancaria de la empresa.
- Preparar remesas de cobro SEPA CORE.
- Generar ficheros XML para su envío manual al banco.
- Registrar el resultado de las remesas.
- Gestionar devoluciones.
- Importar extractos en formato Norma 43.
- Conciliar movimientos bancarios.
- Preparar previsiones mensuales y anuales de cobros y pagos.
- Consultar indicadores de tesorería.

## 2. Alcance

### Incluido

- Registro manual basico de cobros de clientes sobre vencimientos emitidos.
- Una cuenta bancaria en euros.
- Mandatos SEPA CORE.
- Remesas de cobros de clientes.
- Varios vencimientos por cliente y remesa.
- XML SEPA descargable.
- Registro manual del estado bancario de la remesa.
- Cobros automáticos al procesar una remesa.
- Devoluciones manuales.
- Importación manual de Norma 43.
- Propuestas automáticas de conciliación.
- Conciliación manual muchos a muchos.
- Previsiones mensuales y anuales.
- Gastos periódicos previstos.
- Exportación de previsiones.
- Panel de tesorería.

### Fuera de alcance

- Varias cuentas bancarias.
- Monedas distintas del euro.
- Remesas de pagos a proveedores.
- Envío directo de ficheros al banco.
- Importación automática del resultado de remesas.
- Creación de cobros, pagos o gastos desde la conciliación.
- División de movimientos bancarios.
- Saldo bancario previsto acumulado.
- Conservación obligatoria del fichero Norma 43 original.

## 3. Actores y permisos

### Contabilidad

Puede:

- Gestionar la cuenta bancaria.
- Crear y procesar remesas.
- Registrar devoluciones.
- Importar extractos.
- Conciliar movimientos.
- Gestionar previsiones y gastos periódicos.

### Administrador

Puede realizar todas las operaciones del módulo.

Todas las acciones quedan sujetas al sistema general de permisos y auditoría.

## 4. Cuenta bancaria

El sistema tendrá una única cuenta bancaria operativa.

### Datos

- Alias.
- Entidad bancaria.
- IBAN.
- BIC opcional.
- Cuenta contable.
- Moneda.
- Saldo inicial.
- Fecha del saldo inicial.
- Estado.

La moneda será euro.

### Estados

- Activa.
- Inactiva.

Una cuenta inactiva:

- No admite nuevas remesas.
- No admite importación de extractos.
- Conserva todo su historial.

El IBAN debe validarse formalmente.

## 5. Mandatos SEPA

Los mandatos se mantienen en la ficha del cliente y se consultan desde Tesorería.

El esquema inicial será:

- SEPA CORE.

Para incluir un vencimiento en una remesa se exige:

- Cliente activo.
- IBAN válido.
- Mandato activo.
- Referencia única del mandato.
- Vencimiento domiciliado y pendiente.

Cambiar el IBAN del cliente invalida su mandato anterior.

## 6. Remesas

### Numeración

Formato:

`REM-{AÑO}-{CORRELATIVO}`

Ejemplo:

`REM-2026-00001`.

### Datos

- Número.
- Cuenta bancaria.
- Fecha de creación.
- Fecha común de cargo.
- Concepto bancario.
- Estado.
- Vencimientos.
- Total.
- Usuario.
- Fichero XML.
- Hash del fichero.
- Fecha de generación y envío.

### Estados

- Borrador.
- Generada.
- Enviada al banco.
- Procesada.
- Parcialmente devuelta.
- Cerrada.
- Cancelada.

## 7. Preparación de remesas

Una remesa en borrador permite:

- Añadir vencimientos.
- Retirar vencimientos.
- Seleccionar vencimientos de varias facturas del mismo cliente.
- Incluir varios clientes.
- Editar el concepto bancario.
- Establecer una fecha común de cargo.

### Reglas

- Solo se incluyen vencimientos domiciliados, pendientes y con mandato activo.
- Un vencimiento no puede pertenecer a más de una remesa activa.
- El importe y la fecha propios del vencimiento no se modifican desde la remesa.
- Los cambios deben realizarse en el documento origen antes de incluirlo.
- El concepto se propone con cliente, factura o vencimiento y puede editarse.

## 8. Generación del XML

Antes de generar se validarán:

- IBAN de la empresa.
- IBAN del cliente.
- Mandato.
- Referencia del mandato.
- Importe.
- Estado del vencimiento.
- Fecha de cargo.
- Ausencia de duplicidad.

Al generar:

- Se crea el fichero XML SEPA.
- Se calcula y guarda su hash.
- La composición queda bloqueada.
- La remesa pasa a `Generada`.

Si una remesa generada necesita cambios antes de enviarse:

- Se cancela.
- Se crea una nueva remesa.

Una remesa enviada al banco no puede cancelarse desde la aplicación.

## 9. Procesamiento de remesas

Contabilidad marca manualmente las remesas como:

- Enviadas.
- Procesadas.
- Cerradas.

Al marcar una remesa como procesada:

- Se registran los cobros de sus vencimientos.
- Se actualizan facturas y estados de cobro.
- Se generan los asientos correspondientes.

Antes de implementar remesas completas, el primer corte tecnico permite
registrar cobros manuales de vencimientos de facturas emitidas. Este registro
actualiza el estado del vencimiento y el estado de cobro de la factura, pero no
genera asientos contables ni conciliaciones bancarias automaticas.

El primer corte tecnico tambien incorpora una consulta operativa de
vencimientos de cliente en `/app/treasury`, con filtros por estado, cliente,
rango de vencimiento y busqueda por factura o cliente. Los importes se muestran
en neto, descontando devoluciones registradas. La consulta puede exportarse a
CSV respetando los mismos filtros y dejando auditoria de la descarga.

El primer corte de remesas permite crear borradores de remesa de cobro desde
vencimientos domiciliados pendientes, con cliente activo, IBAN y mandato SEPA
activo. Este corte conserva la composicion y bloquea duplicidades de
vencimiento en lineas activas. La pantalla operativa inicial queda disponible
en `/app/treasury/remittances`. Los borradores pueden cancelarse para liberar
sus vencimientos antes de generar XML o registrar cobros.

El corte actual genera y conserva un XML SEPA CORE basico `pain.008.001.02`
con nombre de fichero, identificador de mensaje, fecha de generacion y hash
SHA-256. La remesa pasa de `DRAFT` a `GENERATED` y el fichero puede descargarse
desde el detalle de remesa. Esta generacion requiere que Configuracion tenga
IBAN de cobro de la empresa e identificador acreedor SEPA. Una vez descargado o
remitido por los canales bancarios externos, la remesa puede marcarse como
`SENT`, guardando fecha de envio y auditoria. No importa respuestas bancarias y
no crea conciliaciones automaticas.

Una remesa `SENT` puede rechazarse manualmente si el banco no acepta o no
procesa el fichero antes de que exista cobro. En ese caso la remesa queda
`REJECTED`, se guarda motivo y fecha de rechazo, se conservan XML y hash, y sus
lineas se cancelan para permitir preparar una nueva remesa con los mismos
vencimientos pendientes. Este rechazo no crea cobros ni se considera devolucion.

Las remesas en `DRAFT`, `GENERATED` o `SENT` pueden procesarse manualmente para
registrar cobros de origen `SEPA_REMITTANCE` y actualizar vencimientos y
facturas; los asientos automaticos quedan para un corte posterior. El listado
de remesas puede exportarse a CSV con sus lineas, sin IBAN ni datos bancarios
completos, y deja auditoria de la descarga. Cada remesa dispone de una vista de
detalle para revisar cabecera, estado, lineas, vencimientos, importes
remesados, cobros, devoluciones y netos antes de procesarla o cerrarla.
Una remesa procesada puede cerrarse manualmente para indicar que su ciclo
operativo queda finalizado. Si se registra una devolucion manual sobre un cobro
creado por remesa SEPA, la remesa pasa a `Parcialmente devuelta` y queda
trazado el cambio. La devolucion puede registrarse desde el detalle de la
remesa para evitar saltar manualmente a la factura asociada.

También se podrá procesar cada vencimiento como:

- Cobrado.
- Devuelto.
- Impagado manualmente.

Una remesa podrá quedar parcialmente devuelta.

## 10. Conservación de remesas

Las remesas, sus datos, XML y hash se conservarán durante el plazo legal aplicable y nunca menos que los documentos, cobros y asientos asociados.

No podrán eliminarse mientras tengan relevancia fiscal, bancaria o contable.

## 11. Devoluciones

La devolución se registra seleccionando:

- Remesa.
- Vencimiento.

### Datos

- Fecha.
- Importe.
- Motivo bancario.
- Gastos de devolución.
- Observaciones.
- Usuario.

### Reglas

- El vencimiento pasa a estado `Devuelto`.
- Una devolución completa revierte el cobro y su asiento.
- Una devolución parcial recalcula el saldo pendiente.
- La factura vuelve a `Pendiente` o `Parcialmente cobrada`.
- Solo se admite una devolución por vencimiento.
- Los gastos no generan una factura automáticamente.
- Si se repercuten al cliente, se hará mediante factura manual.

## 11.1 Impagos manuales

Un vencimiento pendiente puede marcarse como impagado desde la factura emitida.
Este registro no se dispara automaticamente por fecha vencida.

### Datos

- Vencimiento.
- Fecha de impago.
- Motivo.
- Observaciones.
- Usuario.

### Reglas

- Solo se admiten vencimientos pendientes con saldo pendiente.
- El vencimiento pasa a estado `Impagado`.
- La factura pasa a estado de cobro `Impagada`.
- No se eliminan cobros ni devoluciones previas.
- Un vencimiento impagado no admite cobros ordinarios en este primer corte.
- Las observaciones internas no se copian al evento de auditoria.

## 12. Extractos Norma 43

Los extractos se importan manualmente.

### Datos conservados

- Identificador del extracto.
- Cuenta.
- Fecha inicial y final.
- Saldo inicial y final.
- Hash.
- Fecha de importación.
- Usuario.
- Movimientos.

No será obligatorio conservar el fichero original, pero sí sus metadatos, hash y movimientos importados durante el plazo legal aplicable.

### Estados

- Importado.
- Parcialmente conciliado.
- Conciliado.

### Validaciones

- Cuenta bancaria correcta.
- Coherencia de fechas.
- Coherencia entre saldos y movimientos.
- Detección de solapamientos.
- Prevención de importación duplicada.

Un movimiento se identifica inicialmente mediante:

- Cuenta.
- Fecha.
- Importe.
- Referencia.
- Número de movimiento.

## 13. Movimientos bancarios

### Estados

- Pendiente.
- Propuesto.
- Conciliado.
- Ignorado.

Un movimiento ignorado no exige motivo.

Un movimiento parcialmente conciliado mantiene pendiente la diferencia.

No se podrán dividir movimientos en movimientos bancarios nuevos.

## 14. Propuestas de conciliación

El sistema propondrá coincidencias utilizando:

- Importe exacto.
- Diferencia máxima de 30 días entre fechas.
- Referencia bancaria.
- Número de factura o documento.
- NIF, IBAN o identificación del tercero.
- Cliente o proveedor.

La coincidencia de referencia e identidad del tercero aumentará la prioridad de la propuesta.

La propuesta nunca se confirma automáticamente.

## 15. Conciliación manual

Administrador y Contabilidad pueden confirmar la conciliación.

Se admite:

- Un movimiento con varios cobros o pagos.
- Varios movimientos con un cobro o pago.
- Aplicación parcial indicando manualmente el importe.
- Búsqueda manual cuando no haya propuesta.

### Reglas

- La conciliación no genera cobros, pagos, gastos ni asientos.
- Los registros contables deben existir previamente.
- La conciliación parcial deja pendiente la diferencia.
- Un extracto parcialmente conciliado puede seguir trabajándose.
- Se puede deshacer una conciliación.
- Al deshacerla, todas sus aplicaciones vuelven a quedar pendientes.
- Toda operación queda auditada.

## 16. Conciliación de remesas

Una remesa procesada podrá conciliarse:

- Con un único movimiento bancario por su total.
- Con varios movimientos bancarios.

También podrá relacionarse el movimiento con los cobros individuales cuando sea necesario.

## 17. Previsiones de tesorería

Las previsiones tendrán vistas:

- Mensual.
- Anual, mostrando los doce meses.

No se calculará un saldo previsto acumulado.

El primer corte tecnico calcula una prevision mensual basica de cobros de
clientes desde vencimientos reales de facturas emitidas con saldo pendiente.
Los vencimientos anteriores a la fecha de referencia se muestran en el mes
actual como atrasados. No incluye todavia pagos de proveedor, gastos periodicos
ni simulaciones persistidas.

### Orígenes de cobro

- Facturas pendientes.
- Facturas parcialmente cobradas.
- Facturas vencidas.
- Suscripciones todavía no facturadas.

### Orígenes de pago

- Facturas de compra pendientes.
- Facturas de compra parcialmente pagadas.
- Gastos periódicos manuales.

### Fechas

- Se usan las fechas reales de vencimiento.
- Los documentos vencidos aparecen en el mes actual como atrasados.
- Las suscripciones se estiman por próxima renovación e importe vigente.

## 18. Gastos periódicos previstos

Datos:

- Concepto.
- Importe.
- Periodicidad.
- Fecha inicial.
- Fecha final opcional.
- Estado.

Periodicidades:

- Mensual.
- Trimestral.
- Semestral.
- Anual.

Los gastos periódicos:

- Se utilizan inicialmente como previsiones.
- Podrán convertirse posteriormente en gastos reales.
- La conversión debe evitar duplicar la previsión y el gasto realizado.

## 19. Simulación de previsiones

En la vista de previsión se podrá:

- Excluir elementos.
- Cambiar fecha solo para simulación.
- Cambiar importe solo para simulación.
- Restablecer los valores de origen.

Los ajustes:

- No modifican facturas, vencimientos, suscripciones ni compras.
- Permanecen guardados hasta que el usuario los restablezca.
- Una previsión excluida permanece excluida durante ese periodo.

### Estados de previsión

- Confirmada.
- Estimada.
- Vencida.
- Excluida.

## 20. Totales y filtros

Se mostrarán por mes:

- Cobros previstos.
- Pagos previstos.
- Diferencia.

Filtros:

- Cliente.
- Proveedor.
- Origen.
- Estado.
- Mes.
- Año.

Las previsiones se exportarán a:

- Excel.
- PDF.

Las exportaciones respetarán filtros y ajustes de simulación.

## 21. Panel de tesorería

Mostrará:

- Vencimientos de cliente abiertos, pagados, devueltos o impagados.
- Saldo pendiente por vencimiento.
- Vista de prevision mensual de cobros de cliente basada en vencimientos
  reales pendientes.
- Saldo bancario real.
- Fecha del saldo.
- Movimientos pendientes de conciliar.
- Extractos parcialmente conciliados.
- Cobros del mes.
- Pagos del mes.
- Previsión mensual de cobros.
- Previsión mensual de pagos.
- Diferencia prevista.
- Remesas pendientes de enviar.
- Remesas enviadas.
- Remesas procesadas.
- Remesas con devoluciones.

El saldo real se obtiene del último extracto importado.

## 22. Historial y auditoría

Se auditarán:

- Registro manual de cobros.
- Cambios de la cuenta bancaria.
- Creación y modificación de remesas.
- Generación del XML.
- Cambios de estado.
- Procesamiento de vencimientos.
- Devoluciones.
- Importación de extractos.
- Propuestas aceptadas o rechazadas.
- Conciliaciones y anulaciones.
- Gastos periódicos.
- Ajustes y exclusiones de previsiones.

Cada registro incluirá:

- Acción.
- Usuario.
- Fecha y hora.
- Valor anterior.
- Valor nuevo.
- Motivo o resultado.
- Documento relacionado.

## 23. Pantallas mínimas

- Panel de tesorería.
- Cuenta bancaria.
- Consulta de mandatos.
- Preparación de remesas.
- Detalle y estado de remesa.
- Registro de devoluciones.
- Importación de Norma 43.
- Conciliación bancaria.
- Movimientos pendientes.
- Previsión mensual.
- Previsión anual.
- Gastos periódicos previstos.

## 24. Criterios de aceptación

1. Solo existe una cuenta bancaria operativa en euros.
2. Una cuenta inactiva no admite remesas ni extractos.
3. Solo se remesan vencimientos domiciliados, pendientes y con mandato activo.
4. Un vencimiento no puede estar en dos remesas activas.
5. Generar el XML bloquea la composición.
6. Una remesa enviada no puede cancelarse.
7. Procesar una remesa registra sus cobros.
8. Una devolución revierte el cobro y recalcula la factura.
9. Los extractos duplicados o solapados se detectan.
10. Las propuestas usan importe exacto y hasta 30 días de diferencia.
11. La conciliación siempre requiere confirmación manual.
12. La conciliación no crea movimientos económicos ni contables.
13. Se admite conciliación muchos a muchos y parcial.
14. Una conciliación puede deshacerse con auditoría.
15. Las previsiones usan vencimientos reales.
16. Los vencidos aparecen en el mes actual.
17. Los cambios de simulación no alteran documentos origen.
18. Las exclusiones permanecen hasta restablecerse.
19. El saldo real procede del último extracto.
20. Toda operación relevante queda auditada.

## 25. Decisiones pendientes para el diseño técnico

- Versión exacta del esquema SEPA CORE y formato XML.
- Plazo legal concreto de conservación.
- Catálogo de motivos bancarios de devolución.
- Estructura exacta de Norma 43 admitida.
- Algoritmo de detección de duplicados y solapamientos.
- Ponderación de propuestas de conciliación.
- Tratamiento de diferencias de redondeo.
- Conversión transaccional de gastos previstos en reales.
- Actualización del saldo si existen extractos solapados.
- Política de cifrado y acceso a IBAN, XML y datos bancarios.
