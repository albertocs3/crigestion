# Especificación funcional: Contabilidad, Compras y Proveedores

## 0. Contexto

El módulo llevará la contabilidad de una única empresa conforme al Plan General de Contabilidad español.

Se integra con:

- Clientes.
- Proveedores.
- Catálogo e inventario.
- Facturación.
- Suscripciones, mediante sus facturas.
- Cobros y pagos.

Las reglas fiscales y los modelos oficiales deberán validarse antes de poner el sistema en producción.

## 1. Alcance

### Incluido

- Plan contable precargado.
- Subcuentas de nueve dígitos.
- Asientos manuales y automáticos.
- Plantillas y duplicación de asientos.
- Proveedores.
- Facturas de compra y rectificativas.
- Gastos sin factura.
- Vencimientos y pagos.
- Entradas automáticas de stock por compras.
- Diario y mayor.
- Balance de sumas y saldos.
- Pérdidas y ganancias.
- Balance de situación.
- Registros de IVA soportado y repercutido.
- Ejercicios, regularización, cierre y apertura.
- Exportación a Excel y PDF.

### Fuera de alcance

- Multiempresa.
- PGC de PYMES como plan alternativo.
- Inmovilizado y amortizaciones.
- IVA deducible parcial o no deducible.
- Retenciones de compras.
- Anticipos a proveedores.
- Devoluciones de pagos.
- Remesas de pagos a proveedores.
- La conciliación bancaria detallada, desarrollada en el módulo de Tesorería.
- Bloqueos mensuales o trimestrales.
- Varias cuentas bancarias contables.

## 2. Roles

### Contabilidad

Puede gestionar:

- Plan contable.
- Asientos manuales.
- Plantillas.
- Proveedores.
- Compras y gastos.
- Pagos.
- Informes.
- Registros de IVA.

### Administrador

Puede realizar todas las operaciones y, en exclusiva:

- Renumerar asientos.
- Reabrir ejercicios.
- Deshacer cierres.
- Modificar asientos automáticos de regularización, cierre y apertura.

## 3. Plan contable

El sistema incluirá un plan base conforme al PGC español.

### Cuenta

- Código.
- Nombre.
- Tipo.
- Nivel.
- Cuenta padre.
- Naturaleza deudora o acreedora.
- Estado activo o inactivo.
- Indicador de cuenta imputable.

### Reglas

- Las subcuentas tendrán nueve dígitos.
- Solo las subcuentas de nueve dígitos admiten movimientos.
- Se podrán crear subcuentas propias.
- Una cuenta con movimientos no se elimina.
- Podrá desactivarse conservando su histórico.

## 4. Cuentas de terceros

### Clientes

Cada cliente tendrá una cuenta propia del grupo `430`.

Formato de ejemplo:

`430000050`

El sufijo procede del identificador interno del cliente, rellenado hasta nueve dígitos.

### Proveedores

Cada proveedor tendrá una cuenta propia del grupo `400`.

Ejemplo:

`400000050`

### Reglas

- Las cuentas se crean automáticamente.
- Las cuentas permanecen separadas tras una fusión de clientes o proveedores.
- Los documentos históricos conservan su cuenta original.

## 5. Asientos

### Datos de cabecera

- Identificador.
- Número.
- Ejercicio.
- Fecha contable.
- Concepto.
- Origen.
- Documento relacionado.
- Cliente o proveedor relacionado.
- Usuario y fecha de creación.
- Usuario y fecha de modificación.
- Estado vigente o anulado.

### Líneas

- Cuenta.
- Concepto.
- Debe.
- Haber.
- Orden.
- Cliente o proveedor opcional.
- Referencia documental opcional.

### Validaciones

- Debe existir al menos una línea de Debe y una de Haber.
- La suma del Debe debe coincidir con la suma del Haber.
- Una línea no puede tener Debe y Haber simultáneamente.
- No se admiten importes cero.
- Solo se admiten cuentas imputables y activas.
- La fecha determina el ejercicio.
- No se contabiliza en un ejercicio cerrado.

## 6. Numeración

Formato:

`{AÑO}/{CORRELATIVO}`

Ejemplo:

`2026/000001`

### Renumeración

- Los asientos pueden registrarse con fechas retroactivas.
- El administrador podrá renumerarlos por fecha contable.
- En caso de empate se utilizará el orden de registro.
- No habrá vista previa.
- El número anterior no se mostrará como referencia histórica.
- La operación completa quedará auditada.
- No se renumerarán ejercicios cerrados ni periodos con envíos fiscales definitivos.

## 7. Asientos manuales

- No existe estado borrador.
- Deben guardarse ya cuadrados y válidos.
- Admiten varias líneas.
- Pueden duplicarse.
- Pueden crearse desde una plantilla.
- Admiten un PDF justificativo de hasta 5 MB.

### Plantillas

Incluyen:

- Nombre.
- Concepto.
- Cuentas.
- Posición Debe o Haber.
- Orden.

No incluyen importes.

Administrador y Contabilidad pueden gestionarlas.

## 8. Modificación y trazabilidad

Un asiento puede modificarse si:

- Su ejercicio está abierto.
- No está protegido por un cierre o envío fiscal definitivo.
- No procede de un documento que deba corregirse desde su origen.

Los asientos de facturas, compras, cobros y pagos se corrigen desde el documento origen o mediante anulación.

Cada modificación conserva:

- Versión completa anterior.
- Versión nueva.
- Usuario.
- Fecha.
- Motivo.

## 9. Asientos automáticos

Se generan al emitir o registrar el documento.

### Venta

- Debe: cliente.
- Haber: ventas o servicios.
- Haber: IVA repercutido.

### Compra

- Debe: compra o gasto.
- Debe: IVA soportado.
- Haber: proveedor.

### Cobro

- Debe: banco o caja.
- Haber: cliente.

### Pago

- Debe: proveedor.
- Haber: banco o caja.

### Rectificativas

Invierten el asiento original.

### Anticipo de cliente

- Debe: banco o caja.
- Haber: anticipos recibidos.
- Haber: IVA repercutido, cuando el anticipo esté sujeto.

El anticipo sujeto a IVA se documenta mediante factura de anticipo y no como un cobro fiscalmente neutro.

Las suscripciones solo se contabilizan mediante la factura generada.

## 10. Configuración contable

Se configurarán cuentas predeterminadas para:

- Clientes.
- Proveedores.
- IVA soportado.
- IVA repercutido.
- Banco.
- Caja.
- Anticipos de clientes.
- Resultado del ejercicio.

Los cobros y pagos indicarán si utilizan banco o caja. El sistema tendrá una única cuenta bancaria contable predeterminada.

La conciliación de esa cuenta se realizará desde Tesorería mediante extractos Norma 43. La conciliación verificará asientos ya existentes y no generará contabilidad nueva.

## 11. Proveedores

### Datos

- Identificador.
- Código automático.
- Razón social.
- Nombre comercial.
- NIF o VAT.
- Dirección fiscal.
- Contacto.
- IBAN.
- BIC opcional.
- Forma y condiciones de pago.
- Estado.
- Cuenta contable.

Formato de código:

`PROV00001`

Estados:

- Activo.
- Inactivo.

### Reglas

- No se registran nuevas compras para proveedores inactivos.
- Se controla la duplicidad por NIF o VAT.
- Pueden fusionarse proveedores duplicados.
- Las cuentas, facturas y pagos históricos permanecen separados.
- El proveedor duplicado queda inactivo y enlazado con el principal.

## 12. Facturas de compra

### Estados

- Borrador.
- Registrada.
- Parcialmente pagada.
- Pagada.
- Anulada.

### Datos

- Proveedor.
- Número de factura del proveedor.
- Fecha de expedición.
- Fecha de recepción.
- Fecha de operación.
- Fecha contable.
- Vencimientos.
- Forma de pago.
- Líneas.
- Bases, cuotas y total.
- PDF adjunto opcional.

### Reglas

- No puede repetirse el número para un mismo proveedor.
- El PDF tendrá un máximo de 5 MB.
- Se permiten varios tipos de IVA.
- Se permiten facturas rectificativas con cantidades o importes negativos.
- No se contemplan retenciones ni IVA no deducible.
- Solo se registran o modifican en ejercicios abiertos.

## 13. Líneas de compra

### Desde catálogo

Utilizan:

- Producto o servicio.
- Descripción.
- Cantidad.
- Precio.
- Descuento.
- IVA.
- Cuenta de compra del catálogo.

### Manuales

Exigen:

- Descripción.
- Cantidad.
- Precio.
- Descuento.
- IVA.
- Cuenta contable de compra o gasto.

Las compras de inmovilizado quedan fuera de la primera versión.

## 14. Modificación y anulación de compras

Una factura registrada puede corregirse mientras el ejercicio esté abierto.

La corrección:

- Anula contablemente el asiento anterior.
- Crea un asiento nuevo.
- Revierte y regenera movimientos de stock.
- Conserva todas las versiones.

Una factura puede anularse únicamente si no tiene pagos.

La anulación:

- Revierte el asiento.
- Revierte el stock.
- Conserva la factura y la auditoría.

## 15. Inventario desde compras

- Una compra registrada de productos aumenta existencias.
- La entrada se enlaza con factura y línea.
- El coste de entrada actualiza el último coste.
- Una rectificativa negativa reduce las unidades incorporadas.
- La operación contable y de inventario será transaccional.

## 16. Gastos sin factura

Tendrán numeración:

`GAS-{AÑO}-{CORRELATIVO}`

Datos:

- Proveedor opcional.
- Fecha.
- Concepto.
- Importe.
- Cuenta contable.
- Forma de pago.
- Justificante PDF opcional.
- Observaciones.

### Reglas

- No generan registro de IVA.
- Si se pagan por tarjeta o contado generan asiento contra banco o caja.
- Las comisiones bancarias pueden registrarse desde un pago o movimiento bancario.

## 17. Vencimientos y pagos

Las facturas generan vencimientos según las condiciones del proveedor.

Formas de pago:

- Transferencia.
- Domiciliación.
- Tarjeta.
- Contado.

### Pagos

- Una factura admite pagos parciales.
- Un pago puede aplicarse a varias facturas.
- El estado `Pagada` se asigna cuando el saldo llega a cero.
- Los pagos domiciliados se registran manualmente.
- No habrá remesas de pagos.
- No se contemplan anticipos ni devoluciones a proveedores.

## 18. Registros de IVA

### IVA repercutido

Se genera exclusivamente desde:

- Facturas de venta emitidas.
- Facturas rectificativas de venta.

### IVA soportado

Se genera exclusivamente desde:

- Facturas de compra registradas.
- Facturas rectificativas de compra.

### Datos

- Fecha.
- Número de factura.
- Cliente o proveedor.
- NIF o VAT.
- Base.
- Tipo.
- Cuota.
- Total.
- Motivo de exención o no sujeción.
- Factura.
- Asiento.

Una factura con varios tipos genera una línea por cada tipo.

Las operaciones exentas, no sujetas y de Canarias aparecerán con su base y motivo.

Los registros no se editan directamente; se corrigen desde el documento origen.

## 19. Informes

### Diario

- Asientos completos por fecha y número.
- Filtros por fechas, cuenta, origen, tercero y documento.

### Mayor

- Movimientos por cuenta.
- Saldo inicial.
- Debe y Haber.
- Saldo acumulado y final.

### Balance de sumas y saldos

- Cualquier rango de fechas.
- Selección de nivel de cuenta.

### Pérdidas y ganancias

- Estructura oficial del PGC.
- Comparativa con ejercicio anterior.

### Balance de situación

- Estructura oficial del PGC.
- Comparativa con ejercicio anterior.

### Registros de IVA

Filtros:

- Fechas.
- Trimestre.
- Ejercicio.
- Cliente o proveedor.
- NIF.
- Número.
- Tipo.
- Estado.

Todos los informes:

- Incluyen únicamente asientos vigentes.
- Excluyen anulados.
- Se exportan a Excel y PDF.
- Respetan los filtros aplicados.

## 20. Ejercicios

### Datos

- Año.
- Fecha de inicio.
- Fecha de fin.
- Estado.
- Fecha y usuario de cierre.

Estados:

- Abierto.
- Cerrado.

El ejercicio coincide normalmente con el año natural.

### Reglas

- Se crea manualmente.
- Normalmente existe un único ejercicio abierto.
- Durante el cierre pueden coexistir el ejercicio anterior y el siguiente abiertos.
- No existen cierres ni bloqueos mensuales o trimestrales.
- Un ejercicio cerrado impide modificar documentos y asientos.

## 21. Cierre

Antes del cierre se validará:

- Asientos cuadrados.
- Ausencia de errores contables.
- Ausencia de documentos contables pendientes.
- Coherencia de facturas y compras.
- Preparación de todos los datos necesarios.

El cierre genera:

1. Asiento de regularización de grupos 6 y 7 contra resultado.
2. Asiento de cierre de cuentas patrimoniales.
3. Ejercicio siguiente, si no existe.
4. Asiento de apertura del ejercicio siguiente.

Se conservará un informe con validaciones, resultados, usuario y fecha.

Los asientos automáticos de regularización, cierre y apertura solo pueden modificarse por el administrador mientras el ejercicio lo permita.

## 22. Deshacer cierre

Solo el administrador puede deshacerlo.

La operación:

- Reabre el ejercicio.
- Anula lógicamente regularización y cierre.
- Anula o revierte la apertura relacionada.
- Conserva todos los asientos y versiones en auditoría.
- Registra usuario, fecha y motivo.

## 23. Panel contable

Mostrará:

- Resultado provisional.
- Ingresos.
- Gastos.
- IVA soportado.
- IVA repercutido.
- Clientes pendientes de cobro.
- Proveedores pendientes de pago.
- Errores de contabilización.
- Asientos descuadrados, si existiera alguna incidencia técnica.

## 24. Pantallas mínimas

- Plan contable.
- Asiento manual.
- Plantillas de asiento.
- Diario.
- Mayor.
- Balance de sumas y saldos.
- Pérdidas y ganancias.
- Balance de situación.
- Registro de IVA soportado.
- Registro de IVA repercutido.
- Proveedores.
- Facturas de compra.
- Gastos sin factura.
- Pagos y vencimientos.
- Ejercicios y cierre.
- Configuración contable.
- Panel contable.

## 25. Auditoría

Se conservarán usuario, fecha, motivo y versión anterior completa para:

- Asientos.
- Compras.
- Gastos.
- Pagos.
- Proveedores.
- Cuentas.
- Renumeraciones.
- Cierres y reaperturas.
- Configuración contable.

Los registros contabilizados no se eliminan físicamente.

## 26. Criterios de aceptación

1. Solo las subcuentas de nueve dígitos admiten movimientos.
2. Cada cliente y proveedor dispone de subcuenta propia.
3. Todo asiento debe estar cuadrado.
4. No se admiten líneas de importe cero.
5. Los documentos generan sus asientos automáticamente.
6. Las suscripciones no generan asiento adicional a su factura.
7. Los asientos automáticos se corrigen desde el documento origen.
8. Las compras de producto generan entradas de stock.
9. Una factura de compra no puede duplicarse para el mismo proveedor.
10. Una compra con pagos no puede anularse.
11. Los gastos sin factura no generan registro de IVA.
12. Los registros de IVA solo se modifican desde su origen.
13. Los informes excluyen asientos anulados.
14. Las exportaciones respetan los filtros.
15. No se contabiliza en ejercicios cerrados.
16. El cierre genera regularización, cierre y apertura.
17. Solo el administrador puede deshacer el cierre y renumerar.
18. Toda modificación conserva trazabilidad completa.

## 27. Decisiones pendientes para el diseño técnico

- Plan contable base exacto y mecanismo de importación.
- Estructura oficial y mapeo de balances.
- Algoritmo transaccional de renumeración.
- Tratamiento de referencias externas tras renumerar.
- Reglas fiscales definitivas de IVA.
- Gestión de registros afectados por envíos fiscales.
- Coordinación transaccional entre documentos, asientos e inventario.
- Definición de cuentas para anticipos y rectificativas.
- Política de reapertura cuando el ejercicio siguiente tiene movimientos.
- Seguridad y conservación de justificantes.
