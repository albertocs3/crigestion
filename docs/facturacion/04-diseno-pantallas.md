# Diseno de Pantallas de Facturacion

## 1. Primer Corte MVP

El MVP prioriza operar facturas ordinarias manuales con rapidez y trazabilidad.
Incluye descarga PDF de facturas emitidas. No incluye panel avanzado,
presupuestos, rectificativas, cobros, envio por correo ni envio VeriFactu real.

## 2. Rutas

| Ruta | Pantalla | Uso |
|---|---|---|
| `/app/invoices` | Facturas | Listado operativo y filtros. |
| `/app/invoices/new` | Nueva factura | Alta de borrador. |
| `/app/invoices/{invoiceId}` | Detalle de factura | Edicion de borrador o consulta emitida. |

## 3. Listado `/app/invoices`

Contenido:

- Filtros por estado, cliente, fecha y busqueda.
- Tabla con numero, cliente, fecha, estado documental, estado de cobro, estado
  VeriFactu y total.
- Accion primaria para crear factura.
- Estado vacio cuando no hay facturas.
- Estado de error si falla la carga.

Reglas:

- Usuarios sin `Billing.ManageDrafts` no ven crear borrador.
- Usuarios sin `Billing.Issue` no ven acciones de emision.
- El control visual no sustituye los permisos server-side.

## 4. Nueva Factura `/app/invoices/new`

Flujo:

1. Seleccionar cliente activo.
2. Informar fecha de expedicion y fecha de operacion.
3. Crear borrador.
4. Redirigir al detalle.

Validaciones UI:

- Cliente obligatorio.
- Fechas obligatorias.
- Aviso si el cliente no tiene datos fiscales minimos.

La validacion definitiva se realiza en servidor.

## 5. Detalle de Borrador `/app/invoices/{invoiceId}`

Zonas:

- Cabecera: cliente, fechas, estado y acciones.
- Snapshot fiscal visible en modo compacto.
- Lineas con alta desde catalogo o manual.
- Resumen de IVA.
- Totales.
- Vencimiento inicial.
- Auditoria basica visible mediante timestamps y usuario cuando aplique.

Acciones:

- Guardar cambios de cabecera.
- Anadir linea.
- Editar linea.
- Eliminar linea.
- Emitir factura.

Estados:

- Cargando.
- Vacio de lineas.
- Error de validacion.
- Bloqueo por mantenimiento.
- Conflicto si la factura ya fue emitida por otra sesion.

## 6. Detalle de Emitida

Una factura `ISSUED` se muestra en solo lectura:

- Numero definitivo destacado.
- Fechas.
- Cliente y snapshot fiscal usado.
- Lineas congeladas.
- Resumen fiscal.
- Total.
- Vencimiento.
- Estado VeriFactu `PENDING` en el MVP.
- Accion de descarga PDF para usuarios con `Billing.View`.
- Accion de registrar cobro para usuarios con `Treasury.ManagePayments`.

Acciones futuras, fuera del MVP:

- Enviar correo.
- Crear rectificativa.
- Reintentar VeriFactu.

## 7. Accesibilidad y UX

- Formularios con labels visibles.
- Botones con nombres de accion claros.
- Tablas legibles por teclado.
- Mensajes de error junto al campo afectado cuando sea posible.
- Totales con formato monetario consistente.
- No usar colores como unico indicador de estado.

## 8. Navegacion

La home operativa enlazara a Facturas para usuarios con `Billing.View`.
Clientes y Catalogo deben seguir siendo accesibles porque son prerequisitos del
flujo de facturacion.
