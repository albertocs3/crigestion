# Especificación funcional: Catálogo de Productos y Servicios

## 0. Contexto del sistema

El Catálogo de Productos y Servicios es un módulo maestro compartido por Facturación, Presupuestos, Suscripciones, Contabilidad e Inventario.

Los conceptos reutilizables serán elementos del catálogo. No existirán tarifas por cliente: cada elemento tendrá un precio base común y los posibles precios personalizados se establecerán en el documento o suscripción concreta.

## 1. Propósito

El módulo permitirá:

- Organizar productos y servicios por categorías.
- Mantener conceptos reutilizables.
- Gestionar precios de venta y costes.
- Configurar impuestos y tratamientos fiscales.
- Asociar cuentas contables.
- Activar e inactivar elementos.
- Controlar existencias de productos físicos.
- Registrar entradas, ventas y devoluciones.
- Consultar márgenes, movimientos y avisos de stock.

## 2. Alcance

### Incluido

- Categorías.
- Productos, servicios, software y licencias.
- Códigos automáticos.
- Precio de venta y último coste.
- Historial de precios y costes.
- IVA con vigencia temporal.
- Tratamientos exentos y no sujetos.
- Tratamiento funcional para Canarias.
- Cuentas contables de venta y compra.
- Un almacén.
- Entradas manuales, salidas por venta y devoluciones.
- Stock negativo con aviso.
- Stock mínimo.
- Listado de movimientos.
- Panel de inventario.

### Fuera de alcance

- Tarifas por cliente.
- Descuento general de cliente.
- Múltiples almacenes.
- Reservas de stock.
- Códigos de barras, marcas y referencias de proveedor.
- Cuentas contables de existencias y variación de existencias.
- FIFO y precio medio ponderado.
- Unidades de medida distintas de unidades.
- Productos físicos dentro de suscripciones.

## 3. Actores y permisos

### Administrador

Puede administrar categorías, elementos, precios, costes, impuestos, cuentas contables y movimientos manuales.

### Rol Facturación

Puede:

- Crear, modificar, duplicar, activar e inactivar elementos.
- Modificar precios y costes.
- Registrar entradas y devoluciones.
- Consultar inventario y márgenes.

Otros usuarios podrán consultar o utilizar el catálogo según sus permisos generales.

## 4. Categorías

### Datos

- Identificador.
- Código corto.
- Nombre.
- Descripción.
- Cuenta de ventas predeterminada.
- Cuenta de compras predeterminada.
- Estado activa o inactiva.
- Fecha y usuario de creación y modificación.

Ejemplos: `PRO`, `SER`, `SOF` y `LIC`.

### Reglas

- El código será único.
- Cada categoría tendrá su propio contador.
- Las cuentas se propondrán al crear un elemento.
- Una categoría puede desactivarse conservando sus elementos.
- No se pueden crear elementos en una categoría inactiva.
- La categoría de un elemento no puede cambiarse.

## 5. Elementos del catálogo

### Tipos

- Producto.
- Servicio.
- Software.
- Licencia.

Solo `Producto` controla existencias.

### Datos

- Identificador.
- Código automático.
- Tipo.
- Categoría.
- Nombre.
- Descripción comercial.
- Unidad de medida.
- Precio de venta sin IVA.
- Último coste sin IVA.
- Cuenta contable de venta.
- Cuenta contable de compra.
- Estado activo o inactivo.
- Stock actual y mínimo, solo para productos.
- Fecha y usuario de creación y modificación.

La unidad inicial será siempre `Unidades`.

## 6. Códigos

El código se compone del código de categoría y un correlativo independiente.

Ejemplo: `SOF00001`.

### Reglas

- Se genera automáticamente.
- No puede modificarse.
- La numeración es independiente por categoría.
- No cambia si se modifica el nombre o la descripción.

## 7. Unicidad y duplicación

- No pueden existir dos elementos con el mismo nombre.
- El código es único.
- Se puede duplicar un elemento para crear otro similar.
- La copia recibe un código nuevo y debe tener un nombre único.
- No se copian movimientos ni historial.

## 8. Estado

### Activo

Puede añadirse a facturas, presupuestos y, si no es un producto físico, a suscripciones.

### Inactivo

- No puede añadirse a nuevos documentos o suscripciones.
- Permanece visible en históricos.
- Se mantiene y puede seguir facturándose desde suscripciones existentes.
- Conserva movimientos e historial.

Las suscripciones no incluirán productos físicos.

## 9. Precios, costes y márgenes

### Precio

- Se almacena sin IVA.
- Es común para todos los clientes.
- Se copia al documento o suscripción.
- Administrador y Facturación pueden modificarlo.
- El cambio no altera documentos existentes.
- Se conserva historial.

### Coste

- Se almacena sin IVA.
- Se utiliza el último precio de coste.
- Una entrada manual actualiza el último coste.
- Se permiten entradas con coste cero.
- Cada entrada conserva su coste histórico.

### Margen

Se mostrará:

- Margen monetario: precio de venta menos último coste.
- Margen porcentual.

La base exacta del porcentaje deberá unificarse durante el diseño técnico.

## 10. Impuestos y tratamientos fiscales

El elemento no tendrá un impuesto predeterminado.

El impuesto se determina al crear el documento según:

- Configuración fiscal general.
- Tratamiento fiscal del cliente.
- Fecha de operación.
- Exención o no sujeción.

### IVA

- Tendrá porcentaje y fechas de vigencia.
- No podrá modificarse retroactivamente cuando ya se haya utilizado.
- Un cambio de porcentaje crea una nueva vigencia.

### Exento y no sujeto

- No tienen porcentaje.
- Requieren motivo fiscal.

### Canarias

En la primera versión se tratará funcionalmente sin IVA.

Esta decisión no implica ausencia de tributación indirecta y deberá revisarse fiscalmente antes de implementar.

## 11. Cuentas contables

Cada elemento tendrá:

- Una cuenta contable de ventas.
- Una cuenta contable de compras.

### Reglas

- Las categorías proponen cuentas predeterminadas.
- Pueden personalizarse en el elemento.
- Ambas son obligatorias antes de utilizarlo.
- Software y licencias usarán normalmente cuentas de servicios.
- No se gestionan cuentas de existencias ni variación de existencias.

## 12. Uso en documentos

Al incorporar un elemento se copiarán código, descripción, precio, cuenta contable y datos fiscales aplicables.

### Reglas

- La descripción puede modificarse en el documento.
- El cambio no modifica el catálogo.
- Los cambios posteriores del catálogo no alteran documentos existentes.
- Servicios, software y licencias admiten cantidades libres.
- Una licencia no calcula automáticamente los usuarios de una suscripción.

## 13. Inventario

- Solo los productos controlan stock.
- Existe un único almacén.
- No hay reservas.
- Stock actual y disponible son iguales.
- Se permite stock negativo.

Se mostrarán:

- Stock actual.
- Stock disponible.
- Stock mínimo.
- Último coste.
- Valor estimado: stock actual por último coste.

## 14. Movimientos de stock

Tipos:

- Entrada manual.
- Venta.
- Devolución.

### Datos

- Producto.
- Tipo.
- Fecha y hora.
- Cantidad.
- Coste unitario, cuando corresponda.
- Saldo posterior.
- Proveedor opcional.
- Documento o referencia.
- Factura y línea de origen, cuando corresponda.
- Observaciones.
- Usuario.

### Entrada manual

- Sirve para stock inicial y otras incorporaciones.
- Aumenta el stock.
- Admite coste cero.
- Actualiza el último coste.

### Compra

- Se genera al registrar una factura de proveedor con productos físicos.
- Aumenta el stock.
- Conserva el coste histórico de la línea.
- Actualiza el último coste.
- Se vincula con la factura de compra y su línea.

### Venta

- Se genera al emitir una factura.
- Descuenta la cantidad.
- Se vincula con la factura y su línea.
- No se genera en borradores ni depende del cobro.
- Puede dejar stock negativo mostrando un aviso.

### Devolución

- Se genera al emitir una rectificativa.
- También se genera por una línea negativa de producto.
- Puede registrarse manualmente.
- Aumenta el stock.

## 15. Correcciones

- Los movimientos no se editan ni eliminan.
- Los errores se corrigen mediante un movimiento contrario.
- El movimiento corrector referencia al original.
- Debe indicar motivo, usuario y fecha.

## 16. Integración con Facturación

- Las líneas positivas de producto generan salidas al emitir.
- Las líneas negativas generan devoluciones.
- Las rectificativas reponen automáticamente las unidades.
- Las facturas de compra registradas generan entradas.
- Las rectificativas de compra revierten las unidades correspondientes.
- Servicios, software y licencias no generan movimientos.
- Borradores y presupuestos no reservan stock.
- Los movimientos se enlazan con factura y línea de origen.

La emisión y el movimiento de stock deberán ejecutarse dentro de una operación transaccional.

## 17. Avisos

Se generarán cuando:

- El stock sea inferior o igual al mínimo.
- El stock sea negativo.
- Una venta vaya a dejarlo por debajo del mínimo.

Los avisos aparecerán en el panel y durante la facturación, pero no bloquearán la venta.

## 18. Listado de movimientos

Mostrará:

- Fecha.
- Producto.
- Tipo.
- Documento.
- Entrada.
- Salida.
- Coste.
- Saldo acumulado.
- Usuario.

Filtros:

- Producto.
- Categoría.
- Tipo.
- Fechas.
- Documento.

## 19. Panel

Mostrará:

- Productos bajo mínimo.
- Productos con stock negativo.
- Últimos movimientos.
- Valor estimado del stock al último coste.
- Elementos activos e inactivos.

## 20. Búsquedas y filtros

### Búsqueda

- Código.
- Nombre.
- Descripción.
- Categoría.

### Filtros

- Tipo.
- Categoría.
- Estado.
- Con control de stock.
- Bajo mínimo.
- Stock negativo.

## 21. Historial y auditoría

Se registrarán:

- Creación.
- Cambios de nombre y descripción.
- Cambios de precio y coste.
- Cambios de cuentas.
- Activación e inactivación.
- Duplicación.
- Movimientos y correcciones.

Cada registro tendrá acción, valores anterior y nuevo, motivo, usuario, fecha y documento relacionado.

## 22. Pantallas mínimas

- Listado del catálogo.
- Alta y edición.
- Detalle e historial.
- Categorías.
- Impuestos y vigencias.
- Entradas manuales.
- Movimientos.
- Panel de inventario.

## 23. Criterios generales de aceptación

1. Todo elemento pertenece a una categoría activa al crearse.
2. El código se genera por categoría y no puede modificarse.
3. No puede cambiarse la categoría.
4. No pueden existir nombres duplicados.
5. Solo los productos controlan existencias.
6. Precio y coste se almacenan sin IVA.
7. Los cambios económicos conservan historial.
8. Los impuestos se determinan al crear el documento.
9. Las cuentas de venta y compra son obligatorias antes de usar el elemento.
10. Un elemento inactivo no puede añadirse a documentos nuevos.
11. Permanece en históricos y suscripciones existentes.
12. Emitir una factura descuenta stock.
13. Una rectificativa o línea negativa repone stock.
14. Los borradores y presupuestos no reservan.
15. Se permite vender sin stock mostrando aviso.
16. Los movimientos no se eliminan ni editan.
17. Los errores se corrigen con movimientos contrarios.
18. Las entradas actualizan el último coste.
19. El panel muestra alertas y valor estimado.
20. Todo cambio queda auditado.

## 24. Decisiones pendientes para el diseño técnico

- Longitud del correlativo.
- Fórmula exacta del margen porcentual.
- Modelo de vigencias fiscales.
- Motivos fiscales de exención y no sujeción.
- Tratamiento fiscal definitivo de Canarias.
- Concurrencia y consistencia del stock.
- Reversión si falla una emisión.
- Valoración histórica del inventario.
- Reglas de reversión y regeneración al modificar una compra.
