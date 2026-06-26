# Glosario común

## 1. Propósito

Este glosario unifica los términos utilizados en las especificaciones funcionales.

Cuando un término tenga un significado particular dentro de un módulo, deberá indicarse expresamente sin cambiar su definición general.

## 2. Organización y personas

### Empresa

Entidad titular del software, emisora de facturas y responsable de la contabilidad. La primera versión gestiona una sola empresa.

### Usuario

Empleado interno con credenciales de acceso y un único rol activo.

### Rol

Conjunto de permisos asignado a un usuario. Puede ser base o personalizado.

### Permiso

Autorización para realizar una acción concreta dentro de un módulo.

### Administrador

Rol con acceso completo, incluida configuración, seguridad, auditoría, costes y operaciones excepcionales.

### Facturación

Rol orientado a clientes, catálogo, suscripciones, presupuestos, facturas, vencimientos y cobros.

### Contabilidad

Rol orientado a proveedores, compras, asientos, pagos, impuestos, tesorería e informes contables.

### Técnico

Rol orientado a comunicaciones e incidencias. No accede a datos fiscales, bancarios, contractuales ni económicos.

## 3. Clientes

### Cliente

Empresa, autónomo o particular con el que se mantiene una relación comercial o de soporte.

### Cliente activo

Cliente habilitado para nuevas facturas, presupuestos y renovaciones.

### Cliente inactivo

Cliente sin nuevas operaciones comerciales. Conserva su histórico y puede recibir soporte.

### Tienda

Establecimiento, sede o punto operativo perteneciente a un cliente.

### Tienda principal

Tienda identificada como referencia principal del cliente.

### Contacto general

Persona de contacto del cliente que no pertenece a una tienda concreta.

### Contacto de tienda

Única persona de contacto asignada a una tienda.

### Datos maestros

Información mantenida por un módulo propietario y reutilizada por el resto del sistema.

### Instantánea

Copia inmutable de los datos relevantes en el momento de una operación. Se utiliza para conservar el significado histórico de documentos emitidos.

## 4. Catálogo e inventario

### Categoría

Agrupación de elementos del catálogo. Determina el prefijo del código y puede proponer cuentas contables.

### Elemento de catálogo

Concepto reutilizable en facturas, presupuestos, suscripciones o compras.

### Producto

Elemento físico que controla existencias.

### Servicio

Prestación no física sin control de stock.

### Software

Aplicación o solución informática comercializada sin control de stock.

### Licencia

Derecho de uso comercializado como elemento del catálogo, sin control automático de usuarios.

### Precio de venta

Importe base sin IVA común para todos los clientes.

### Coste

Último precio de adquisición utilizado para calcular márgenes y valorar existencias.

### Stock

Cantidad registrada de un producto físico.

### Stock disponible

Stock utilizable. En la primera versión coincide con el stock actual porque no existen reservas.

### Stock mínimo

Umbral que genera avisos de reposición.

### Movimiento de stock

Entrada o salida que modifica las existencias y conserva su documento de origen.

### Entrada

Movimiento que aumenta el stock.

### Venta

Movimiento que reduce el stock al emitir una factura.

### Devolución

Movimiento que repone stock por rectificación, línea negativa u operación manual.

## 5. Suscripciones

### Suscripción

Contrato periódico de software o servicios perteneciente a un cliente.

### Plan

Modalidad comercial reutilizable con conceptos y reglas de precio.

### Concepto de suscripción

Línea periódica incluida en una suscripción.

### Periodicidad

Frecuencia de renovación: mensual, trimestral, semestral o anual.

### Renovación

Nuevo periodo contractual que debe facturarse anticipadamente.

### Próxima renovación

Fecha en la que corresponde facturar el siguiente periodo.

### Cambio programado

Modificación contractual que entra en vigor en la siguiente renovación.

### Pendiente de renovación

Estado que indica que una renovación no ha podido completarse o fue excluida.

### Vista previa de facturación

Preparación revisable de las facturas de suscripciones antes de emitirlas.

### Periodo facturado

Intervalo de servicio cubierto por una línea de factura.

## 6. Facturación

### Presupuesto

Propuesta comercial sin efectos contables ni de inventario hasta su conversión.

### Factura

Documento emitido que acredita una operación comercial y produce efectos fiscales, contables y de cobro.

### Factura ordinaria

Factura de venta no rectificativa.

### Factura rectificativa

Nueva factura que corrige una factura emitida e identifica su causa y documento original.

### Factura de anticipo

Factura emitida por un pago anticipado que produce devengo fiscal.

### Borrador

Documento editable que todavía no está emitido ni dispone de número fiscal definitivo.

### Emisión

Operación que numera, valida, bloquea y consolida una factura.

### Serie

Prefijo y secuencia utilizados para numerar un tipo de documento.

### Línea de factura

Detalle de producto, servicio o concepto facturado.

### Base imponible

Importe sobre el que se calcula un impuesto.

### Cuota

Importe resultante de aplicar un tipo impositivo.

### Retención

Importe fiscal descontado del total a pagar según la configuración aplicable.

### Exento

Tratamiento de una operación sujeta que no soporta cuota por una causa legal.

### No sujeto

Tratamiento de una operación que queda fuera del ámbito del impuesto.

### Vencimiento

Importe y fecha en que debe producirse un cobro o pago.

### Cobro

Recepción de dinero aplicada a uno o varios vencimientos o facturas.

### Cobro parcial

Cobro que no liquida todo el saldo.

### Anticipo

Pago recibido antes de la operación definitiva. Cuando produce devengo de IVA exige factura de anticipo.

### Impagado

Importe vencido cuyo impago ha sido registrado expresamente.

### Incobrable

Deuda que se mantiene registrada pero se considera de difícil o imposible cobro.

## 7. Atención al cliente

### Comunicación

Interacción con un cliente por teléfono o WhatsApp, exista o no seguimiento posterior.

### Incidencia

Caso que requiere seguimiento técnico y pertenece obligatoriamente a un cliente.

### Responsable

Técnico con capacidad principal de gestión sobre una incidencia.

### Colaborador

Técnico autorizado para añadir actuaciones y adjuntos sin modificar los datos principales.

### Actuación

Descripción textual del trabajo realizado en una incidencia.

### Resolución

Finalización correcta de una incidencia con solución documentada.

### Cierre

Finalización por una circunstancia distinta de la resolución ordinaria.

### Reapertura

Retorno de una incidencia finalizada al estado `En curso`.

### Fusión

Operación que identifica un registro como duplicado y lo relaciona con otro principal.

## 8. Compras y proveedores

### Proveedor

Tercero que suministra productos o servicios a la empresa.

### Factura de compra

Factura recibida de un proveedor y registrada en el sistema.

### Gasto sin factura

Documento interno para registrar un gasto que no genera registro de IVA.

### Pago

Salida de dinero aplicada a uno o varios vencimientos de proveedor.

### Justificante

Archivo asociado a una operación contable o de compra.

## 9. Contabilidad

### Plan contable

Estructura de cuentas basada en el Plan General de Contabilidad español.

### Cuenta

Elemento del plan contable.

### Subcuenta

Cuenta imputable de nueve dígitos que admite movimientos.

### Asiento

Registro contable cuadrado formado por líneas de Debe y Haber.

### Asiento manual

Asiento creado directamente por un usuario.

### Asiento automático

Asiento generado desde una factura, cobro, compra, pago u otra operación.

### Debe

Columna izquierda de un asiento.

### Haber

Columna derecha de un asiento.

### Diario

Listado cronológico de asientos.

### Mayor

Listado de movimientos y saldo de una cuenta.

### Registro de IVA

Detalle fiscal derivado de facturas emitidas o recibidas.

### Ejercicio

Periodo contable, normalmente anual.

### Regularización

Asiento que salda las cuentas de ingresos y gastos contra el resultado.

### Cierre

Proceso y asiento que finalizan un ejercicio.

### Apertura

Asiento inicial del ejercicio siguiente.

### Anulación lógica

Invalidación de un registro sin eliminarlo físicamente.

## 10. Tesorería y SEPA

### Mandato SEPA

Autorización del cliente para recibir adeudos directos.

### SEPA CORE

Esquema de adeudos utilizado inicialmente por el sistema.

### Remesa

Agrupación de vencimientos domiciliados enviada al banco mediante un fichero SEPA.

### Devolución bancaria

Rechazo o retroceso de un cobro domiciliado.

### Extracto

Conjunto de movimientos bancarios importados.

### Norma 43

Formato bancario utilizado para importar extractos.

### Conciliación

Relación entre movimientos bancarios y cobros, pagos o asientos existentes.

### Previsión de tesorería

Estimación mensual o anual de cobros y pagos futuros.

## 11. Seguridad y trazabilidad

### Sesión

Acceso autenticado y temporal de un usuario.

### Auditoría

Registro central e inmutable de acciones, consultas y resultados.

### Evento

Hecho funcional o técnico registrado por el sistema.

### Usuario Sistema

Identidad técnica utilizada para procesos automáticos.

### Notificación

Aviso interno dirigido a un usuario y enlazado con un registro.

### Adjunto

Archivo protegido asociado a una entidad funcional.

### Hash

Huella digital utilizada para comprobar integridad.

### Idempotencia

Propiedad que impide que repetir una operación produzca duplicados.

### Dato sensible

Información personal, fiscal, bancaria, credencial o secreto que requiere protección reforzada.

## 12. VeriFactu

### Sistema informático de facturación

Software que soporta procesos de facturación y debe cumplir los requisitos normativos de integridad, conservación, trazabilidad e inalterabilidad.

### Registro de facturación de alta

Registro generado al expedir una factura.

### Registro de facturación de anulación

Registro específico que anula un registro de alta cuando legal y técnicamente proceda. No sustituye a una factura rectificativa.

### Encadenamiento

Relación criptográfica entre registros consecutivos.

### Código QR

Código incorporado a la factura con la información exigida por la normativa.

### Estado VeriFactu

Situación de la comunicación del registro con la AEAT, independiente del estado documental y de cobro.

## 13. Términos que no deben confundirse

| Término | No equivale a |
|---|---|
| Cliente inactivo | Cliente eliminado |
| Factura rectificativa | Edición de una factura emitida |
| Registro de anulación | Rectificación comercial general |
| Cobro | Conciliación bancaria |
| Anticipo | Cobro fiscalmente neutro |
| Suscripción pendiente | Factura pendiente de cobro |
| Incidencia resuelta | Incidencia cerrada por otro motivo |
| Plantilla PDF | Datos fiscales de la factura |
| Mandato SEPA | Fichero de remesa |
| Auditoría | Historial visible del módulo |

