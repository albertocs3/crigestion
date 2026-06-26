# Especificación funcional: Configuración General

## 0. Contexto

Configuración General centraliza los valores compartidos por todos los módulos.

Incluye:

- Datos de la empresa.
- Cuenta bancaria común.
- Ejercicios.
- Impuestos y retenciones.
- Certificado VeriFactu.
- Correo electrónico.
- Plantillas.
- Numeraciones.
- Validación de configuración.

La aplicación gestiona una única empresa.

## 1. Acceso

Solo el administrador puede modificar la configuración.

Otros usuarios podrán consultar, según sus permisos:

- Datos públicos de la empresa.
- Tipos de impuestos.
- Plantillas aplicables.

Los cambios se aplicarán después de reiniciar la aplicación.

## 2. Datos de la empresa

### Datos

- Razón social.
- Nombre comercial.
- NIF.
- Dirección fiscal.
- Código postal.
- Localidad.
- Provincia o región.
- País.
- Prefijo telefónico.
- Teléfono.
- Correo electrónico.
- Sitio web.
- Texto de registro mercantil.
- Logotipo.
- IBAN.
- BIC opcional.
- Idioma.
- Moneda.
- Zona horaria.

### Valores generales

- Idioma: español.
- Moneda: euro.
- Zona horaria: `Europe/Madrid`.

### Logotipo

- Formatos: PNG y JPG.
- Tamaño máximo: 5 MB.

### Reglas

- Solo existe una dirección fiscal.
- El NIF no puede modificarse después de emitir facturas.
- La razón social y dirección pueden cambiar para documentos futuros.
- Los cambios no alteran documentos ya emitidos.
- El texto de registro mercantil se utiliza en pies de documentos.
- Toda modificación queda auditada.

## 3. Cuenta bancaria común

El IBAN configurado será la única cuenta utilizada por:

- Facturación.
- Tesorería.
- Contabilidad.
- Remesas SEPA.

### Reglas

- El IBAN debe validarse.
- El BIC es opcional.
- No puede existir una cuenta diferente en cada módulo.
- Los cambios requieren revisar configuración contable y bancaria.
- El historial de modificaciones queda auditado.

## 4. Ejercicios

Los ejercicios se administran desde Configuración General y se cierran desde Contabilidad.

### Datos

- Año.
- Fecha inicial.
- Fecha final.
- Estado.

### Reglas

- Solo el administrador crea ejercicios.
- Se proponen del 1 de enero al 31 de diciembre.
- Las fechas pueden modificarse.
- Al crear un ejercicio se generan sus contadores anuales.
- Se copia la configuración vigente de impuestos y plantillas.
- Contabilidad ejecuta el proceso de cierre.
- Las reglas de apertura, cierre y reapertura se definen en Contabilidad.

## 5. Impuestos

### Tipos iniciales de IVA

- General: 21 %.
- Reducido: 10 %.
- Superreducido: 4 %.

### Datos

- Código.
- Nombre.
- Porcentaje.
- Fecha inicial de vigencia.
- Fecha final opcional.
- Estado.

### Reglas

- Solo el administrador puede modificarlos.
- Un tipo ya utilizado no se modifica retroactivamente.
- Los cambios de porcentaje crean una nueva vigencia.
- No se elimina un tipo utilizado.
- Puede desactivarse para operaciones futuras.

## 6. Recargo de equivalencia

El recargo se configura asociado al tipo de IVA correspondiente.

Datos:

- Tipo de IVA.
- Porcentaje de recargo.
- Vigencia.
- Estado.

No se aplicará como recargo comercial independiente.

## 7. Retención

El sistema tendrá un único porcentaje de retención configurado.

### Reglas

- No tendrá varias vigencias simultáneas.
- Solo el administrador puede modificarlo.
- Las facturas emitidas conservan el porcentaje aplicado.
- Los cambios afectan únicamente a documentos futuros.

## 8. Exenciones y no sujeción

Existirá un catálogo de causas legales para:

- Operaciones exentas.
- Operaciones no sujetas.

Cada causa tendrá:

- Código.
- Descripción.
- Tipo.
- Estado.

Una causa utilizada no se elimina; podrá desactivarse.

No habrá una herramienta de simulación fiscal dentro de Configuración.

## 9. Certificado VeriFactu

Solo puede existir un certificado activo.

### Importación

- Formato: `.pfx`.
- Requiere contraseña.
- Debe probarse antes de activarlo.

### Metadatos

- Alias.
- Titular.
- NIF.
- Fecha de emisión.
- Fecha de caducidad.
- Huella.
- Estado.

### Seguridad

- Solo el administrador consulta los metadatos.
- La contraseña se almacena cifrada.
- Nunca se muestra completa después de guardarse.
- El archivo debe almacenarse protegido.
- El certificado se utiliza únicamente para la conexión con VeriFactu.
- En la arquitectura web, el certificado se custodia en servidor y no en el equipo del usuario.
- El certificado no se expone al navegador ni se descarga desde la interfaz.
- La clave de descifrado se guarda en un proveedor seguro de secretos o mecanismo equivalente.
- Cada uso del certificado queda auditado.

### Representacion

Si el envio a AEAT lo realiza CriGestión o su proveedor tecnico en nombre del obligado tributario, debera registrarse la representacion o colaboracion social aplicable antes de activar la remision.

### Sustitución

- Al activar uno nuevo se sustituye el anterior.
- No se conserva el archivo anterior.
- Se conserva en auditoría la operación y sus metadatos necesarios.

### Caducidad

- Se avisa diariamente desde un mes antes.
- El aviso aparece en el panel y como notificación interna.
- Un certificado caducado impide enviar a VeriFactu.

## 10. Correo electrónico

El sistema tendrá una única cuenta SMTP remitente.

### Datos

- Servidor.
- Puerto.
- Modo de seguridad.
- Usuario.
- Contraseña.
- Dirección remitente.
- Nombre visible.
- Estado habilitado o deshabilitado.

### Seguridad admitida

- SSL/TLS.
- STARTTLS.

### Reglas

- La contraseña se almacena cifrada.
- No se muestra completa después de guardarse.
- El envío puede desactivarse sin borrar la configuración.
- Si no está configurado o está desactivado, se permite emitir documentos, pero no enviarlos.
- Los reintentos de envíos fallidos son manuales.

## 11. Prueba SMTP

El administrador indicará una dirección de destino.

La prueba:

- Verifica conexión.
- Verifica autenticación.
- Envía un mensaje de prueba.
- Muestra resultado.
- Muestra diagnóstico técnico si falla.

Nunca mostrará ni registrará la contraseña.

Los envíos reales conservan su resultado y detalle de error.

## 12. Plantillas

Existirá una única plantilla activa por tipo.

### Tipos

- Factura ordinaria.
- Factura rectificativa.
- Presupuesto.
- Correo de factura.
- Correo de presupuesto.
- Avisos y notificaciones generales.

Los avisos internos no tendrán plantillas distintas por cada evento.

## 13. Plantillas PDF

Podrán editarse:

- Visualmente.
- Mediante campos configurables.

Elementos:

- Logotipo.
- Colores.
- Cabecera.
- Pie.
- Textos legales.
- Condiciones.
- Distribución de datos.

Admitirán variables, por ejemplo:

- `{NumeroFactura}`
- `{Cliente}`
- `{Fecha}`
- `{Total}`

### Vista previa

- Utiliza datos de ejemplo.
- Puede generarse sin guardar previamente los cambios.

### Regeneración

- No se conserva una versión de la plantilla por documento.
- Los cambios también afectan a PDF regenerados posteriormente.
- Un PDF regenerado puede diferir visualmente del enviado originalmente.
- Los datos económicos y fiscales del documento emitido no cambian.
- Se conserva la versión o hash de plantilla y el hash del PDF enviado.

## 14. Plantillas de correo

Cada plantilla tendrá:

- Asunto.
- Cuerpo HTML.
- Variables.
- Indicador de adjuntar PDF.

El PDF se adjuntará automáticamente según el tipo de envío.

El usuario podrá editar destinatario, asunto y mensaje antes de enviar, según lo definido en Facturación.

## 15. Numeraciones

Los formatos son fijos y no configurables.

### Anuales

- Factura: `F2600001`.
- Rectificativa: `R2600001`.
- Presupuesto: `P2600001`.
- Incidencia: `INC-2026-00001`.
- Suscripción: `SUS-2026-00001`.
- Remesa: `REM-2026-00001`.
- Gasto: `GAS-2026-00001`.
- Asiento: `2026/000001`.

Se reinician al crear el nuevo ejercicio.

### Globales

- Cliente: `CLI00001`.
- Tienda: `T00001`.
- Proveedor: `PROV00001`.
- Catálogo: código de categoría más correlativo.

No se reinician anualmente.

## 16. Reglas de numeración

- El administrador no puede modificar el siguiente número.
- No puede cambiar el formato.
- No puede reducir ni adelantar manualmente un contador.
- La asignación es transaccional.
- No se permiten duplicados.
- Los documentos fiscales siguen sus reglas de correlación.
- Se permiten huecos en incidencias, suscripciones y otros documentos no fiscales.

Existirá una pantalla de consulta con:

- Tipo de contador.
- Ejercicio, si procede.
- Último número.
- Siguiente número.
- Fecha de última asignación.

## 17. Validación de configuración

Existirá un panel que compruebe:

- Datos obligatorios de empresa.
- NIF.
- Dirección fiscal.
- IBAN.
- Cuenta contable bancaria.
- Ejercicio abierto.
- Impuestos vigentes.
- Retención.
- Causas fiscales.
- Certificado VeriFactu.
- Caducidad del certificado.
- Configuración SMTP.
- Plantillas.
- Cuentas contables predeterminadas.
- Contadores.

Cada problema indicará:

- Gravedad.
- Descripción.
- Módulo afectado.
- Enlace a la configuración correspondiente.

## 18. Historial y auditoría

Se auditarán:

- Datos de la empresa.
- Cuenta bancaria.
- Ejercicios.
- Impuestos y retención.
- Causas fiscales.
- Certificados.
- Correo.
- Plantillas.
- Numeraciones.

Cada evento conservará:

- Usuario.
- Fecha y hora.
- Acción.
- Valor anterior.
- Valor nuevo.
- Resultado.

Nunca se registran contraseñas ni secretos.

## 19. Aplicación de cambios

- Los cambios se guardan inmediatamente.
- Para aplicarlos operativamente se requiere reiniciar la aplicación.
- La interfaz deberá avisar de que existen cambios pendientes de reinicio.
- Las operaciones ya iniciadas deberán seguir utilizando una configuración coherente.

## 20. Copias de seguridad

El sistema incluirá copias de seguridad completas, pero se desarrollarán como un módulo técnico separado.

Configuración General podrá mostrar:

- Estado de la última copia.
- Fecha.
- Resultado.
- Enlace al módulo de copias.

No se exportará ni importará manualmente la configuración general.

## 21. Pantallas mínimas

- Datos de la empresa.
- Cuenta bancaria.
- Ejercicios.
- Impuestos.
- Retención.
- Exenciones y no sujeción.
- Certificado VeriFactu.
- Configuración SMTP.
- Prueba de correo.
- Plantillas PDF.
- Plantillas de correo.
- Consulta de numeraciones.
- Validación de configuración.

## 22. Criterios generales de aceptación

1. Solo el administrador modifica la configuración.
2. El NIF no cambia después de emitir facturas.
3. El IBAN es común a todos los módulos.
4. Crear un ejercicio genera los contadores anuales.
5. Los impuestos utilizados no se modifican retroactivamente.
6. El certificado debe probarse antes de activarse.
7. Un certificado caducado bloquea los envíos VeriFactu.
8. El certificado VeriFactu se custodia cifrado en servidor y no en el PC del usuario.
9. Las contraseñas quedan cifradas y ocultas.
10. El envío SMTP puede deshabilitarse sin borrar datos.
11. Sin SMTP se puede emitir, pero no enviar.
12. Existe una plantilla activa por tipo.
13. Las plantillas admiten variables y vista previa.
14. Los PDF regenerados usan la plantilla vigente.
15. Los formatos de numeración no pueden modificarse.
16. Los contadores se asignan transaccionalmente.
17. Los maestros usan numeración global.
18. Los documentos usan numeración anual.
19. Existe un panel de validación.
20. Los cambios requieren reiniciar la aplicación.
21. Toda modificación queda auditada sin exponer secretos.

## 23. Decisiones pendientes para el diseño técnico

- Campos legales exactos de la empresa.
- Almacenamiento cifrado del certificado y secretos.
- Proveedor seguro definitivo para custodiar claves de certificados.
- Mecanismo de prueba del certificado VeriFactu.
- Registro de representacion cuando el envio se haga en nombre de terceros.
- Biblioteca y formato de las plantillas visuales.
- Conjunto definitivo de variables.
- Estrategia de caché y reinicio de configuración.
- Consistencia durante operaciones simultáneas.
- Algoritmo transaccional de contadores.
- Catálogo fiscal oficial de exenciones y no sujeción.
- Implementación técnica del módulo de copias de seguridad.
