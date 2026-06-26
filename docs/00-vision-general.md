# Visión general de CriGestión

## 1. Visión

CriGestión será un software de gestión empresarial integrado para una única empresa.

Su objetivo es concentrar en una sola aplicación:

- Clientes y establecimientos.
- Productos, servicios e inventario.
- Suscripciones periódicas.
- Presupuestos y facturación.
- Atención al cliente e incidencias.
- Compras, proveedores y contabilidad.
- Cobros, pagos, tesorería y SEPA.
- Configuración, usuarios, permisos y auditoría.

El sistema evitará aplicaciones y registros paralelos. Cada operación se registrará una sola vez y producirá de forma coherente sus efectos comerciales, fiscales, contables y de tesorería.

## 2. Objetivos

### Operativos

- Mantener una ficha unificada del cliente.
- Automatizar la facturación periódica de suscripciones.
- Reducir duplicidades y errores de introducción.
- Registrar y seguir todas las incidencias.
- Conocer facturación, cobros, pagos y situación contable.
- Controlar productos físicos mediante un inventario básico.
- Preparar remesas y conciliar movimientos bancarios.

### De control

- Mantener trazabilidad completa.
- Impedir modificaciones no autorizadas.
- Aplicar permisos por rol.
- Conservar documentos y registros.
- Evitar facturación duplicada.
- Garantizar coherencia entre documentos, asientos e inventario.

### De cumplimiento

- Aplicar el Plan General de Contabilidad español.
- Mantener registros de IVA.
- Preparar el sistema para VeriFactu.
- Gestionar SEPA CORE.
- Proteger los datos personales y bancarios.

## 3. Alcance organizativo

- Una única empresa.
- Una única moneda: euro.
- Un único idioma inicial: español.
- Zona horaria funcional: `Europe/Madrid`.
- Una única cuenta bancaria empresarial.
- Usuarios exclusivamente internos.
- Aplicación de escritorio conectada a servicios y almacenamiento comunes.

## 4. Usuarios

### Administrador

Acceso completo, incluyendo:

- Usuarios y permisos.
- Configuración.
- Costes y márgenes.
- Operaciones excepcionales.
- Auditoría.

### Facturación

Trabaja principalmente con:

- Clientes y tiendas.
- Catálogo.
- Suscripciones.
- Presupuestos.
- Facturas.
- Vencimientos y cobros.

### Contabilidad

Trabaja principalmente con:

- Clientes y catálogo.
- Proveedores y compras.
- Asientos e informes.
- Pagos.
- Tesorería, remesas y conciliación.

### Técnico

Trabaja con:

- Identificación básica de clientes.
- Tiendas y contactos.
- Comunicaciones.
- Incidencias.

No accede a datos fiscales, bancarios, contractuales o económicos.

## 5. Capacidades principales

### Clientes

- Empresas, autónomos y particulares.
- Tiendas y contactos.
- Datos fiscales y comerciales.
- Condiciones de pago y mandato SEPA.
- Historial unificado.

### Catálogo

- Productos, servicios, software y licencias.
- Categorías.
- Precio y coste.
- Cuentas contables.
- Inventario básico para productos.

### Suscripciones

- Planes y conceptos periódicos.
- Periodicidades mensuales, trimestrales, semestrales y anuales.
- Cambios programados.
- Renovaciones y cancelaciones.
- Preparación supervisada de la facturación.

### Facturación

- Presupuestos.
- Facturas ordinarias.
- Facturas rectificativas.
- Anticipos.
- Vencimientos y cobros.
- PDF, correo y VeriFactu.

### Atención al cliente

- Registro de llamadas y WhatsApp manual.
- Incidencias.
- Actuaciones, adjuntos y colaboración.
- Notificaciones e indicadores.

### Contabilidad

- Plan contable.
- Asientos manuales y automáticos.
- Proveedores, compras y gastos.
- Diario, mayor, balances y registros de IVA.
- Cierre y apertura.

### Tesorería

- Remesas SEPA CORE.
- Devoluciones.
- Extractos Norma 43.
- Conciliación.
- Previsiones de cobros y pagos.

## 6. Principios funcionales

### Dato maestro único

Cada dato tiene un módulo propietario. Los demás módulos lo referencian y no mantienen copias editables independientes.

### Motor único de facturación

Las facturas manuales, de presupuestos, suscripciones y anticipos usan el mismo motor.

### Automatización con supervisión

Los procesos económicos relevantes permiten revisión antes de confirmar cuando se haya definido funcionalmente.

### Inmutabilidad

Los documentos emitidos no se sobrescriben. Las correcciones generan operaciones nuevas y trazables.

### Trazabilidad

Las acciones relevantes registran usuario, fecha, resultado y cambios.

### Seguridad por defecto

La autorización se comprueba en la aplicación y en el servidor. Los datos sensibles se cifran y su consulta queda auditada.

### Evolución modular

Cada área puede ampliarse sin duplicar funciones de otros módulos.

## 7. Flujos empresariales principales

### Suscripción a cobro

```text
Cliente
  -> Suscripción
  -> Vista previa
  -> Factura
  -> Vencimiento
  -> Remesa o cobro
  -> Asiento
  -> Conciliación
```

### Venta manual

```text
Cliente
  -> Presupuesto opcional
  -> Factura
  -> Salida de stock
  -> Vencimiento
  -> Cobro
  -> Asientos
```

### Compra

```text
Proveedor
  -> Factura de compra
  -> Entrada de stock
  -> Vencimiento
  -> Pago
  -> Asientos
```

### Atención al cliente

```text
Cliente
  -> Comunicación
  -> Incidencia, si requiere seguimiento
  -> Actuaciones
  -> Resolución o cierre
```

## 8. Alcance inicial

La primera versión funcional deberá cubrir el ciclo diario esencial:

- Gestión de maestros.
- Suscripciones.
- Facturación.
- Compras.
- Contabilidad.
- Cobros y pagos.
- Atención al cliente.
- Remesas y conciliación.
- Seguridad, configuración y auditoría.

La priorización por entregas se define en [Alcance y fases del MVP](04-alcance-mvp.md).

## 9. Fuera de alcance global inicial

- Multiempresa.
- Multimoneda.
- Aplicación multidioma.
- Portal del cliente.
- Aplicación móvil.
- Integración automática con WhatsApp.
- Múltiples almacenes.
- Gestión avanzada de inmovilizado.
- Nóminas y recursos humanos.
- Producción.
- Comercio electrónico.
- Firma digital de PDF.
- Conciliación bancaria que cree automáticamente movimientos económicos.
- Inteligencia artificial operativa.

## 10. Restricciones y riesgos

### Normativa

Deberán revisarse antes de producción:

- VeriFactu.
- Factura electrónica B2B.
- IVA, anticipos y rectificaciones.
- SEPA y formatos bancarios.
- Conservación documental.
- Protección de datos.

### Integridad

Los procesos que afectan a varios módulos deberán impedir estados parciales, especialmente:

- Emisión de facturas.
- Contabilización.
- Movimientos de inventario.
- Renovaciones.
- Cobros y devoluciones.

### Volumen

El diseño técnico deberá dimensionar:

- Historiales.
- Auditoría.
- Adjuntos.
- Búsquedas.
- Vistas previas de facturación.
- Informes contables.

## 11. Criterios de éxito

El producto será funcionalmente satisfactorio cuando:

1. Cada operación se introduce una sola vez.
2. Los módulos muestran información coherente.
3. No pueden duplicarse renovaciones ni facturas.
4. Los documentos emitidos permanecen inmutables.
5. Los asientos automáticos son trazables hasta su origen.
6. Los usuarios solo acceden a información autorizada.
7. La ficha del cliente reúne toda su actividad.
8. Los informes proceden de datos vigentes y conciliables.
9. Los procesos críticos informan claramente de errores.
10. La documentación permite construir pruebas verificables.
