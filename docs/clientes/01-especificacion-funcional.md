# Especificación funcional: Clientes y Tiendas

## 0. Contexto del sistema

Clientes y Tiendas es el módulo maestro común del software de gestión.

Proporciona información a:

- Suscripciones.
- Facturación.
- Cobros y SEPA.
- Atención al cliente e incidencias.
- Presupuestos.
- Contabilidad.

Los demás módulos utilizarán referencias a clientes y tiendas, evitando duplicar datos maestros. Los documentos emitidos conservarán las instantáneas fiscales necesarias para mantener su integridad histórica.

En este módulo, una tienda representa una sede, establecimiento o punto operativo dependiente de un cliente. Cada tienda dispone de una única persona de contacto.

## 1. Propósito

El módulo permitirá:

- Registrar empresas, autónomos y particulares.
- Mantener sus datos fiscales y comerciales.
- Gestionar direcciones fiscal y de envío.
- Gestionar tiendas.
- Mantener un contacto general y contactos de tienda.
- Configurar condiciones de pago y riesgo comercial.
- Mantener cuenta bancaria y mandato SEPA.
- Controlar el riesgo comercial.
- Activar, inactivar y fusionar clientes.
- Consultar toda la relación comercial y de soporte desde una ficha unificada.

## 2. Alcance

### Incluido

- CRUD de clientes.
- CRUD de tiendas.
- Empresas, autónomos y particulares.
- Clientes nacionales e internacionales.
- Validación de NIF y VAT.
- Detección de duplicados fiscales.
- Direcciones fiscal y de envío.
- Contacto general del cliente.
- Contacto único por tienda.
- Condiciones de pago y vencimientos.
- Una cuenta bancaria por cliente.
- Mandato SEPA CORE.
- Límite de crédito con aviso.
- Activación, inactivación y reactivación.
- Fusión de clientes duplicados.
- Ficha unificada.
- Historial y auditoría.

### Fuera de alcance

- Varias direcciones de envío por cliente.
- Varias cuentas bancarias por cliente.
- Varios contactos por tienda.
- Gestión de comerciales.
- Adjuntos del cliente.
- Monedas distintas del euro.
- Idiomas distintos del español.
- Eliminación definitiva de clientes o tiendas.
- Modificación del titular histórico de facturas emitidas durante una fusión.
- Generación de remesas SEPA.

## 3. Actores y permisos

### Administrador

Puede:

- Crear y modificar clientes.
- Crear y modificar tiendas.
- Activar, inactivar y reactivar.
- Fusionar clientes.
- Modificar datos fiscales.
- Modificar condiciones comerciales.
- Modificar cuenta bancaria y mandato.
- Ignorar avisos de límite de crédito.

### Rol Facturación

Dispone de las mismas operaciones funcionales sobre clientes y tiendas, según los permisos concretos configurados.

### Otros usuarios

Pueden consultar la ficha del cliente según sus permisos generales.

Los módulos de Incidencias y Atención al Cliente podrán consultar clientes y tiendas inactivos y registrar incidencias para ellos.

## 4. Cliente

### 4.1 Tipos

- Empresa.
- Autónomo.
- Particular.

En clientes particulares, el campo de razón social podrá utilizarse para registrar nombre y apellidos.

### 4.2 Datos principales

- Identificador.
- Código automático.
- Tipo de cliente.
- Razón social o nombre y apellidos.
- Nombre comercial.
- NIF.
- VAT, cuando corresponda.
- Estado.
- Tratamiento fiscal.
- Dirección fiscal.
- Dirección de envío.
- Contacto general, opcional.
- Forma de pago predeterminada.
- Condiciones de vencimiento.
- Cuenta bancaria.
- Mandato SEPA.
- Límite de crédito.
- Observaciones.
- Fecha y usuario de creación.
- Fecha y usuario de última modificación.

### 4.3 Código

El código será automático y correlativo.

Formato:

`CLI{NÚMERO}`

Ejemplo: `CLI00001`.

### 4.4 Estados

- Activo.
- Inactivo.

Los clientes inactivos:

- No pueden recibir nuevas facturas.
- No pueden recibir nuevos presupuestos.
- No renuevan suscripciones.
- Sí pueden consultarse.
- Sí pueden tener nuevas incidencias y actuaciones de soporte.

## 5. Identificación fiscal

### 5.1 Identificadores

- NIF para clientes españoles.
- VAT u otro identificador fiscal admitido para clientes extranjeros.

Todo cliente debe tener un identificador fiscal válido antes de guardarse.

### 5.2 Validaciones

- Validación formal de NIF, NIE y CIF españoles.
- Validación formal del VAT cuando exista un mecanismo disponible.
- El NIF o VAT no puede estar duplicado entre clientes no fusionados.
- Antes de crear un cliente se comprobarán posibles duplicados por identificador fiscal.

### 5.3 Modificación

El NIF no puede modificarse cuando el cliente tenga facturas emitidas.

Si existe un error fiscal en esa situación deberá aplicarse el procedimiento administrativo o de fusión que se defina, conservando la trazabilidad.

## 6. Direcciones

### 6.1 Tipos

- Dirección fiscal.
- Dirección de envío.

Cada cliente tendrá como máximo una dirección de cada tipo.

La dirección de envío podrá copiarse inicialmente de la fiscal.

### 6.2 Datos

- Dirección.
- Código postal.
- Localidad.
- Provincia, región o estado.
- País.

Las direcciones admitirán cualquier país.

Las tiendas utilizarán el mismo modelo internacional de dirección.

## 7. Tratamiento fiscal

Valores iniciales:

- Nacional.
- Intracomunitario.
- Exportación.
- Canarias, Ceuta o Melilla.

### Reglas

- El sistema propondrá el tratamiento según país y provincia.
- Administrador o Facturación podrán corregirlo manualmente.
- La corrección quedará auditada.
- El VAT será obligatorio cuando el tipo de operación internacional lo requiera.
- El idioma inicial es español.
- La moneda del sistema es el euro.

Las reglas fiscales exactas deberán revisarse antes de implementar el cálculo de impuestos.

## 8. Contacto general

El cliente puede tener un contacto general opcional.

Datos:

- Nombre y apellidos.
- Cargo o departamento.
- Teléfono.
- Móvil.
- Número de WhatsApp.
- Correo electrónico.
- Función.

El contacto general no pertenece a ninguna tienda.

## 9. Tiendas

### 9.1 Datos

- Identificador.
- Código automático.
- Cliente.
- Nombre comercial.
- Dirección.
- Teléfono.
- WhatsApp.
- Correo electrónico.
- Persona de contacto.
- Observaciones.
- Estado.
- Indicador de tienda principal.
- Fecha y usuario de creación.
- Fecha y usuario de última modificación.

### 9.2 Código

Formato:

`T{NÚMERO}`

Ejemplo: `T00001`.

### 9.3 Contacto de tienda

Cada tienda tendrá como máximo un contacto:

- Nombre y apellidos.
- Cargo o departamento.
- Teléfono.
- Móvil.
- WhatsApp.
- Correo electrónico.

Un contacto de tienda tiene una única función.

Los correos y teléfonos pueden repetirse entre varias tiendas.

### 9.4 Reglas

- Un cliente puede tener varias tiendas.
- Puede existir una tienda principal.
- La dirección de tienda puede usarse como dirección de envío.
- Una tienda puede estar activa o inactiva.
- Las tiendas inactivas se mantienen visibles en históricos.
- Se pueden registrar incidencias para tiendas inactivas.
- Una incidencia puede vincularse opcionalmente a una tienda.
- Las comunicaciones se vinculan al cliente general, no a una tienda.
- Las suscripciones pertenecen al cliente general.
- Las facturas se emiten al cliente general aunque sus conceptos correspondan a tiendas.

## 10. Formas y condiciones de pago

Formas de pago iniciales:

- Transferencia.
- Contado.
- Domiciliación.

Cada cliente tendrá una forma de pago predeterminada.

### Condiciones de vencimiento

Podrán definirse:

- Al contado.
- A un número de días.
- A día fijo del mes.
- En varios vencimientos.
- Mediante configuración personalizada por cliente.

Las facturas copiarán las condiciones del cliente y podrán modificarlas antes de emitirse.

## 11. Cuenta bancaria

Cada cliente tendrá como máximo una cuenta bancaria activa.

Datos:

- IBAN.
- BIC, opcional.
- Titular.
- Estado.

### Reglas

- El IBAN debe validarse formalmente.
- La cuenta es obligatoria para usar domiciliación.
- Cambiar el IBAN invalida el mandato SEPA anterior.
- El cambio queda auditado.

## 12. Mandato SEPA

En la primera versión se utilizará el esquema:

- SEPA CORE.

Datos:

- Referencia única del mandato.
- Fecha de firma.
- Esquema.
- IBAN asociado.
- Estado.
- Fecha de alta.
- Fecha de cancelación o caducidad.

Estados:

- Pendiente.
- Activo.
- Cancelado.
- Caducado.

### Reglas

- La domiciliación exige IBAN válido y mandato activo.
- Cambiar el IBAN invalida el mandato.
- La generación de remesas pertenece al módulo de Facturación o Tesorería.
- El formato bancario de remesa no se confunde con el tipo de mandato.

La referencia mencionada como `N19.14` deberá tratarse como formato o norma bancaria histórica relacionada con adeudos, no como tipo de mandato.

## 13. Precios

- No existen tarifas por cliente.
- El catálogo mantiene un precio de venta común.
- Los precios personalizados se definen, cuando proceda, en cada factura, presupuesto o suscripción.
- Los cambios realizados en un documento no modifican el catálogo ni al cliente.

## 14. Límite de crédito

El cliente puede tener un límite de crédito.

### Cálculo de riesgo

Se incluirán únicamente los importes pendientes de las facturas emitidas.

No se incluirán:

- Presupuestos.
- Facturas completamente cobradas.
- Importes todavía no facturados.

### Comportamiento

- Superar el límite muestra un aviso.
- No bloquea automáticamente la operación.
- El usuario autorizado puede continuar.
- Se registra usuario, fecha, importe de riesgo y motivo de la excepción.

## 15. Inactivación

Inactivar un cliente exige:

- Motivo.
- Fecha.
- Usuario.

### Efectos

- Se impide emitir nuevas facturas.
- Se impide crear nuevos presupuestos.
- Las suscripciones se cancelan según el flujo del módulo de Suscripciones.
- Se cancelan domiciliaciones futuras o remesas todavía no enviadas.
- Los cobros ya realizados se conservan.
- Las deudas y vencimientos existentes se conservan.
- Se mantienen visibles facturas, cobros, presupuestos e historial.
- Se permiten nuevas incidencias.

La cancelación de suscripciones debe conservar su historial y motivo de origen.

## 16. Reactivación

- El cliente puede reactivarse.
- Se conserva todo el historial.
- Las suscripciones canceladas no se reactivan automáticamente.
- Cada suscripción deberá reactivarse manualmente desde su módulo.
- Deben revisarse forma de pago, IBAN y mandato antes de nuevas domiciliaciones.

## 17. Inactivación de tiendas

Inactivar una tienda requiere:

- Motivo.
- Fecha.
- Usuario.

La tienda:

- Permanece visible en el historial.
- Puede seguir vinculada a incidencias históricas.
- Puede recibir nuevas incidencias.
- No se elimina.

## 18. Fusión de clientes

Se podrán fusionar clientes duplicados.

### Reglas

- Se selecciona un cliente principal.
- El duplicado queda inactivo y enlazado con el principal.
- No se elimina ningún cliente.
- La fusión queda auditada.

Se trasladan al cliente principal:

- Tiendas.
- Suscripciones, cuando sea funcional y legalmente válido.
- Incidencias.
- Comunicaciones.
- Datos operativos no emitidos.

### Facturas y documentos emitidos

- Las facturas emitidas conservan el cliente y los datos fiscales originales.
- No se cambia retroactivamente su titular.
- Desde la ficha del cliente principal se podrá consultar el historial del cliente fusionado.
- Los cobros y saldos conservarán su trazabilidad con los documentos originales.

Las reglas exactas para presupuestos abiertos, domiciliaciones y suscripciones activas deberán aplicarse transaccionalmente durante la fusión.

## 19. Ficha unificada

La ficha del cliente tendrá las siguientes áreas:

### General

- Identificación.
- Estado.
- Datos fiscales.
- Direcciones.
- Contacto general.

### Tiendas

- Tiendas activas e inactivas.
- Contactos y direcciones.

### Condiciones comerciales

- Forma de pago.
- Vencimientos.
- Cuenta bancaria.
- Mandato SEPA.
- Límite de crédito.

### Suscripciones

- Activas.
- Pendientes.
- Canceladas.
- Próximas renovaciones.

### Facturas y cobros

- Facturado.
- Pendiente.
- Vencido.
- Cobros.
- Devoluciones.
- Anticipos disponibles.

### Presupuestos

- Borradores.
- Enviados.
- Aceptados.
- Rechazados.
- Convertidos.

### Incidencias

- Abiertas.
- Resueltas.
- Cerradas.
- Vinculadas a tiendas.

### Comunicaciones

- Llamadas.
- WhatsApp registrado.
- Comunicaciones con o sin incidencia.

### Historial

- Modificaciones.
- Inactivaciones.
- Reactivaciones.
- Fusiones.
- Excepciones de crédito.

## 20. Resumen económico

La ficha mostrará:

- Facturación acumulada del periodo seleccionado.
- Saldo pendiente.
- Saldo vencido.
- Anticipos disponibles.
- Límite de crédito.
- Riesgo actual.

Los importes procederán del módulo de Facturación y no se duplicarán en Clientes.

## 21. Búsquedas y filtros

### Búsqueda

- Código de cliente.
- Razón social.
- Nombre comercial.
- NIF.
- VAT.
- Teléfono.
- Correo.
- Código o nombre de tienda.

### Filtros

- Tipo de cliente.
- Estado.
- País.
- Tratamiento fiscal.
- Forma de pago.
- Con suscripciones activas.
- Con saldo pendiente.
- Con riesgo superado.

## 22. Historial y auditoría

Toda modificación relevante conservará:

- Acción.
- Valor anterior.
- Valor nuevo.
- Motivo.
- Usuario.
- Fecha y hora.

Se auditarán:

- Datos fiscales.
- Direcciones.
- Contactos.
- Tiendas.
- Estados.
- Condiciones de pago.
- Cuenta bancaria.
- Mandato.
- Límite de crédito.
- Excepciones de riesgo.
- Inactivaciones.
- Reactivaciones.
- Fusiones.

Los clientes y tiendas no se eliminan definitivamente.

## 23. Pantallas mínimas

- Listado de clientes.
- Alta y edición de cliente.
- Ficha unificada.
- Gestión de tiendas.
- Condiciones comerciales.
- Cuenta bancaria y mandato.
- Inactivación y reactivación.
- Fusión de clientes.
- Historial.

## 24. Criterios generales de aceptación

1. Todo cliente tiene código, tipo, estado e identificador fiscal.
2. No pueden existir dos clientes no fusionados con el mismo NIF o VAT.
3. El NIF no se modifica cuando existen facturas emitidas.
4. Un cliente puede tener varias tiendas y una principal.
5. Cada tienda tiene como máximo un contacto.
6. Solo clientes activos pueden recibir nuevas facturas o presupuestos.
7. Los clientes y tiendas inactivos pueden recibir incidencias.
8. La domiciliación exige IBAN válido y mandato activo.
9. Cambiar el IBAN invalida el mandato anterior.
10. El límite de crédito genera un aviso, pero puede ignorarse con auditoría.
11. Inactivar un cliente conserva cobros realizados y deuda existente.
12. La inactivación cancela suscripciones y domiciliaciones futuras.
13. La reactivación no reactiva automáticamente suscripciones.
14. Los clientes duplicados pueden fusionarse sin eliminar registros.
15. Las facturas emitidas conservan su titular original tras una fusión.
16. La ficha unificada consulta datos de todos los módulos relacionados.
17. Toda modificación relevante queda auditada.

## 25. Decisiones pendientes para el diseño técnico

- Longitud definitiva de los correlativos de cliente y tienda.
- Servicio de validación de VAT internacional.
- Reglas exactas para NIE y otros identificadores extranjeros.
- Datos fiscales que deben congelarse en documentos emitidos.
- Comportamiento transaccional de la fusión.
- Tratamiento de presupuestos abiertos durante la inactivación o fusión.
- Coordinación con cancelaciones de Suscripciones.
- Coordinación con domiciliaciones y remesas SEPA.
- Modelo común de direcciones.
- Permisos detallados de consulta económica.
- Política de protección y cifrado de IBAN.
- Requisitos legales de conservación y acceso a datos personales.
