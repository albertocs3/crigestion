# Guion de vídeo TFM de CriGestión

## 1. Entregable

El punto 5 exige un vídeo accesible mediante una URL pública y con captura de
pantalla. La grabación propuesta dura entre 10 y 12 minutos y combina las
slides con una demostración real de CriGestión en staging.

Formato recomendado:

- resolución horizontal de 1920 x 1080;
- 30 fotogramas por segundo;
- salida MP4 con vídeo H.264 y audio AAC;
- voz clara, sin música y con el cursor visible;
- al menos cinco minutos mostrando la aplicación real;
- publicación en YouTube como `Oculto` o en otro servicio que permita abrir el
  enlace sin solicitar permiso al evaluador.

Un vídeo oculto de YouTube no aparece normalmente en búsquedas, pero cualquier
persona que tenga el enlace puede verlo y compartirlo. No debe considerarse un
almacenamiento privado.

## 2. Preparación antes de grabar

1. Reiniciar el navegador y cerrar correo, mensajería y aplicaciones ajenas.
2. Activar `No molestar` en Windows.
3. Usar una ventana del navegador limpia, sin marcadores ni pestañas privadas.
4. Abrir previamente:
   - `docs/presentacion/CriGestion-TFM-2026.pptx`;
   - `https://gestion-test.crisoft.es/app`;
   - `https://gestion-test.crisoft.es/api/health`.
5. Iniciar sesión antes de comenzar la grabación con la cuenta de evaluación.
   No es necesario mostrar ni teclear la contraseña en el vídeo.
6. Confirmar que el banner indica `ENTORNO STAGING` y `AEAT TEST`.
7. Ajustar el navegador al 100 % o 110 % y comprobar que las tablas son
   legibles a pantalla completa.
8. Hacer una prueba de audio de 30 segundos y escucharla con auriculares.
9. Grabar una toma de prueba del cambio entre PowerPoint y navegador.
10. Mantener una copia local del MP4 original hasta finalizar la evaluación.

## 3. Configuración sencilla de grabación

Sin instalar herramientas adicionales en Windows 11:

1. Pulsar `Windows + Mayús + R` para abrir la grabación de Recortes.
2. Seleccionar toda el área útil de la pantalla y comenzar la grabación.
3. Al terminar, guardar el vídeo y elegir `Editar en Clipchamp` para añadir o
   ajustar la narración, recortar los extremos y generar subtítulos.
4. Exportar el resultado final a 1080p.

En el equipo usado para preparar el proyecto se han detectado Recortes y
Clipchamp instalados. OBS Studio no está instalado en su ruta estándar, por lo
que esta opción permite comenzar inmediatamente.

Para disponer de más control sobre el micrófono y las fuentes, puede instalarse
OBS Studio y usar esta configuración:

Con OBS Studio:

1. Crear una escena llamada `TFM CriGestión`.
2. Añadir `Captura de pantalla` para garantizar que se vean PowerPoint y el
   navegador al alternar entre ellos.
3. Añadir el micrófono y comprobar que la voz alcanza la zona amarilla sin
   llegar de forma continua a la roja.
4. Desactivar el audio del escritorio si no se necesita.
5. Seleccionar 1920 x 1080, 30 FPS y formato de grabación MKV.
6. Al terminar, usar `Archivo > Remultiplexar grabaciones` para obtener MP4.

Si se graba directamente en MP4, una interrupción del equipo puede dejar el
archivo inutilizable. La grabación en MKV y su posterior conversión reduce ese
riesgo.

## 4. Guion cronometrado

### 0:00-0:25 — Portada

**Pantalla:** slide 1.

**Texto sugerido:**

> Hola, mi nombre es Alberto Cantarero y voy a presentar mi Trabajo Fin de Máster,
> El proyecto que he desarrollado se llama CriGestión, una aplicación web de gestión empresarial integrada. 
> Su objetivo principal es unificar en una misma plataforma las distintas áreas de gestión de una empresa, 
> conectando el ciclo comercial, la tesorería y la contabilidad sobre una única fuente de información, e 
> incorporando desde el diseño aspectos fundamentales como la seguridad y la trazabilidad.

> A lo largo de la presentación veremos las necesidades que dieron origen al proyecto, la solución 
> propuesta, su arquitectura y desarrollo y, finalmente, los resultados obtenidos y las principales conclusiones.


### 0:25-1:10 — Problema y propuesta

**Pantalla:** slide 2.

**Texto sugerido:**

> El problema que aborda CriGestión es la fragmentación habitual de la información entre hojas de cálculo, 
> documentos y aplicaciones independientes. En este escenario, un mismo dato puede introducirse varias veces 
> y acabar presentando valores diferentes según el lugar donde se consulte.
> Esto provoca duplicidades, conciliaciones manuales, pérdida de tiempo y poca capacidad para reconstruir qué 
> ocurrió cuando aparece un error. Además, dificulta conocer quién realizó cada cambio y cuál es la información realmente válida.
> La propuesta es centralizar los procesos en una única plataforma, de forma que cada dato tenga un propietario 
> claro y se registre una sola vez. Así, los distintos módulos comparten el mismo flujo transaccional, mantienen 
> la información sincronizada y conservan una trazabilidad completa de las operaciones.
> El resultado es una gestión más coherente, verificable y segura, con menos tareas manuales y una base común para automatizar los procesos de la empresa.

### 1:10-2:00 — Alcance funcional

**Pantalla:** slide 3.

**Texto sugerido:**

> El producto se organiza en cuatro grandes capacidades conectadas entre sí. La primera cubre el ciclo comercial, 
> desde la gestión de clientes y presupuestos hasta la emisión de facturas y el seguimiento de su estado.
> La segunda se centra en el control financiero: cobros, pagos, vencimientos y conciliación de movimientos, 
> ofreciendo una visión actualizada de la situación económica de la empresa.
> La tercera capacidad gestiona los ingresos recurrentes. Permite definir servicios periódicos, automatizar 
> su facturación y controlar renovaciones, incidencias o cambios en las condiciones acordadas.
> Por último, la operación con gobierno incorpora usuarios, roles, permisos y auditoría. Su finalidad es asegurar 
> que cada persona pueda acceder únicamente a las funciones y a la información que necesita.
> Estas áreas no funcionan como herramientas aisladas, sino que comparten datos y procesos. La navegación se 
> adapta al rol de cada usuario para simplificar el trabajo, pero las reglas de negocio y los permisos siempre 
> se validan en el servidor. De esta forma, ocultar una opción en la interfaz nunca sustituye a un control de seguridad real.

### 2:00-3:00 — Arquitectura

**Pantalla:** slides 4 y 5.

**Texto sugerido:**

> La solución se construye con Next.js y App Router, utilizando TypeScript estricto en toda la aplicación. PostgreSQL 
> actúa como fuente principal de verdad y Prisma proporciona un acceso tipado y controlado a los datos.
>La arquitectura elegida es un monolito modular. Esto significa que los distintos ámbitos funcionales están claramente 
> separados, pero forman parte de una única aplicación. Así se reduce la complejidad operativa y de despliegue, sin 
> renunciar a una estructura mantenible que pueda evolucionar con el producto.
> Esta decisión también permite conservar transacciones ACID en las operaciones económicas. Por ejemplo, al emitir una 
> factura, todos los cambios relacionados deben completarse correctamente o revertirse como una sola unidad, evitando estados parciales e inconsistencias.
> Las comunicaciones con servicios externos se ejecutan fuera de estas transacciones mediante workers y un patrón outbox. 
> La operación se registra primero de forma segura en la base de datos y después se procesa de manera asíncrona.
> Por tanto, si una comunicación con VeriFactu TEST falla, la factura ya emitida no se elimina ni se deshace. El envío 
>permanece pendiente y el sistema programa un reintento controlado. Además, cada operación es idempotente: aunque se 
>procese varias veces por un error de red, no debe generar envíos ni efectos duplicados.
> Con este enfoque, la aplicación mantiene la integridad de los datos internos y, al mismo tiempo, tolera fallos temporales de servicios externos.

### 3:00-3:35 — Acceso y panel

**Pantalla:** cambiar al navegador y mostrar `/app`.

**Acciones:**

1. Señalar el banner de staging y AEAT TEST.
2. Mostrar el nombre del rol de tribunal para evaluación funcional.
3. Recorrer visualmente las nueve áreas disponibles.

**Texto sugerido:**

> Esta es la aplicación desplegada en el entorno de evaluación. En la parte
> superior se muestra de forma permanente que estamos trabajando en staging y
> conectados con AEAT TEST. Esta señalización permite diferenciar claramente el
> entorno de pruebas del sistema de producción y reduce el riesgo de realizar
> operaciones en el lugar equivocado.
> La sesión corresponde al rol de tribunal, configurado para una evaluación
> funcional controlada. Además de recorrer la aplicación y revisar la
> información, permite trabajar con clientes, borradores e incidencias sobre
> datos sintéticos. Las operaciones económicas, contables, fiscales y
> administrativas permanecen bloqueadas.
> Desde este panel se accede a las nueve áreas funcionales disponibles. Todas
> mantienen una navegación común y presentan únicamente las opciones
> correspondientes al rol autenticado, facilitando una revisión ordenada del
> conjunto de la solución.

### 3:35-4:20 — Clientes y catálogo

**Pantalla:** `/app/customers` y `/app/catalog`.

**Acciones:**

1. Abrir el listado de clientes.
2. Mostrar búsqueda y datos maestros sin abrir información innecesaria.
3. Cambiar al catálogo y señalar productos, servicios e impuestos.

**Texto sugerido:**

> Comenzamos por los clientes y el catálogo, que actúan como datos maestros de todo el ciclo comercial. En el listado de clientes 
> podemos localizar rápidamente cada registro mediante la búsqueda y consultar de forma ordenada la información necesaria para las operaciones posteriores.
> Estos datos se mantienen en un único punto. Cuando un presupuesto, una factura o una suscripción necesita identificar a un cliente, 
> referencia este registro maestro en lugar de crear una copia editable e independiente. Así se evitan duplicidades y diferencias entre módulos.
> El catálogo aplica el mismo principio a los productos y servicios ofrecidos por la empresa. Cada elemento centraliza su descripción, 
> clasificación, precio y configuración fiscal, incluidos los impuestos aplicables.
> De esta forma, los documentos comerciales parten de información coherente y reutilizable. Cualquier cambio queda controlado en su 
> área correspondiente, mientras que las operaciones ya formalizadas conservan los datos históricos necesarios para no alterar documentos anteriores.

### 4:20-6:20 — Facturación: núcleo de la demostración

**Pantalla:** `/app/invoices` y una factura ya emitida.

**Acciones:**

1. Mostrar filtros y estados de la lista.
2. Señalar por separado el estado documental, el cobro y VeriFactu.
3. Abrir una factura emitida.
4. Mostrar número, fechas, cliente, impuestos, total y vencimiento.
5. Enseñar el estado VeriFactu TEST sin iniciar un envío nuevo.

**Texto sugerido:**

> La facturación concentra uno de los flujos principales de CriGestión. En este
> listado podemos filtrar los documentos y distinguir rápidamente su situación.
>
> El sistema separa tres dimensiones que a menudo se mezclan. La primera es el
> estado documental, que indica si la factura continúa como borrador o ya ha
> sido emitida. La segunda refleja su situación de cobro y permite saber si
> existen vencimientos pendientes, cobros o impagos. La tercera corresponde a
> VeriFactu y muestra la comunicación fiscal con AEAT TEST. Por tanto, una
> factura emitida puede continuar pendiente de cobro o de envío fiscal.
>
> Al abrir una factura emitida vemos su número definitivo, las fechas de emisión
> y vencimiento, el cliente, los impuestos y el total. Estos datos quedan
> consolidados al emitir para conservar la evidencia histórica aunque después
> cambien los maestros. La factura emitida ya no se edita como un borrador:
> cualquier corrección debe realizarse mediante una operación trazable.
>
> La emisión consolida el calendario de vencimientos y prepara los efectos
> contables y fiscales. Cada paso conserva quién lo realizó, cuándo y con qué
> resultado.
>
> Por último, aquí se muestra el estado de VeriFactu en el entorno de pruebas.
> No iniciaremos un envío nuevo. Si AEAT TEST falla, la factura no se revierte:
> la comunicación queda pendiente para un reintento controlado e idempotente,
> sin producir duplicados.

### 6:20-7:05 — Contabilidad

**Pantalla:** `/app/accounting`.

**Acciones:**

1. Mostrar ejercicio y diario.
2. Señalar el equilibrio entre Debe y Haber.
3. Mencionar el control maker-checker de cierres sin ejecutar operaciones.

**Texto sugerido:**

> El módulo contable recibe los efectos generados por los procesos comerciales
> dentro de cada ejercicio. En el diario podemos consultar los asientos y
> comprobar el equilibrio entre el Debe y el Haber.
>
> Cada asiento conserva su origen para relacionarlo con la operación que lo
> produjo, sin perder la trazabilidad.
>
> Los cierres y reaperturas aplican un control *maker-checker*: una persona
> solicita la operación y otra distinta debe aprobarla. Así, una sola cuenta no
> puede completar una acción contable crítica.

### 7:05-7:45 — Suscripciones

**Pantalla:** `/app/subscriptions`.

**Acciones:**

1. Mostrar contratos y próxima renovación.
2. Señalar que las reactivaciones y renovaciones pueden quedar supervisadas.

**Texto sugerido:**

> Suscripciones gestiona contratos recurrentes vinculados a clientes y
> servicios del catálogo. El listado muestra su estado, las fechas principales
> y la próxima renovación.
>
> El módulo reutiliza el mismo motor de facturación para no crear un circuito
> económico paralelo. Determinados cambios, bajas y reactivaciones pueden
> programarse o quedar supervisados para no alterar periodos consolidados.
>
> Las renovaciones se ejecutan mediante procesos monitorizados: las reservas
> controlan la concurrencia, la idempotencia evita facturas duplicadas y cada
> intento deja evidencia para su revisión.

### 7:45-8:25 — Atención al cliente

**Pantalla:** `/app/support` y, opcionalmente, `/app/support/indicators`.

**Acciones:**

1. Mostrar incidencias y estados.
2. Abrir una incidencia preparada y señalar sus actuaciones.
3. Mostrar brevemente los indicadores.

**Texto sugerido:**

> Atención al cliente reúne las incidencias y su seguimiento dentro de la misma
> plataforma. Cada caso muestra su estado, prioridad, responsable y actuaciones,
> evitando que la información quede dispersa.
>
> Las actuaciones forman un historial ordenado. Si se corrige información
> relevante, el sistema conserva el valor anterior, la corrección y su motivo,
> en lugar de sobrescribir la evidencia.
>
> Los indicadores resumen los casos abiertos por estado y prioridad, además del
> rendimiento histórico. Su alcance depende siempre de los permisos del usuario.

### 8:25-9:05 — Tesorería

**Pantalla:** `/app/treasury` y `/app/treasury/banking`.

**Acciones:**

1. Mostrar vencimientos y previsión.
2. Mostrar movimientos bancarios y conciliación sin modificar datos.

**Texto sugerido:**

> Tesorería conecta los vencimientos de clientes y proveedores con los cobros,
> pagos y movimientos bancarios. La previsión muestra los importes pendientes y
> sus fechas previstas.
>
> En el área bancaria se consultan las cuentas, los extractos y la conciliación
> de cada movimiento. El proceso registra el importe aplicado y la operación
> relacionada.
>
> Cuando una conciliación es parcial, se conservan tanto el importe aplicado
> como el saldo pendiente del movimiento. Durante esta demostración solo
> consultamos información y no modificamos datos financieros.

### 9:05-9:50 — Seguridad

**Pantalla:** volver a PowerPoint, slide 7.

**Texto sugerido:**

> La seguridad se aplica en todas las capas y no depende simplemente de ocultar
> botones. La autenticación utiliza sesiones de servidor con
> tokens opacos en cookies *HttpOnly*, *Secure* y *SameSite*. Solo se conserva
> el hash del token, lo que permite revocar cada sesión.
>
> Los permisos se validan en el servidor para cada operación. Las mutaciones
> incorporan protección CSRF, validación, idempotencia y límites de uso.
>
> Una vez almacenados, los certificados de VeriFactu no se devuelven al
> navegador y permanecen cifrados en el servidor. Las acciones críticas generan
> auditoría sin registrar contraseñas, tokens ni otros secretos.

### 9:50-10:30 — Evidencia

**Pantalla:** slide 8 y, brevemente, `/api/health`.

**Texto sugerido:**

> La solución se acompaña de evidencia técnica verificable. La release de
> evaluación tiene 159 migraciones aplicadas, sin cambios pendientes sobre la
> base de datos de staging. La última regresión completa registrada ejecutó 813
> pruebas automatizadas.
>
> El endpoint de *health* comprueba la aplicación, PostgreSQL, la coherencia de
> la configuración VeriFactu TEST y el *heartbeat* del worker. Si durante la
> grabación todos aparecen en estado correcto, no solo vemos una interfaz
> accesible, sino también sus componentes internos operativos.

### 10:30-11:10 — Límites y trabajo posterior

**Pantalla:** slide 9.

**Texto sugerido:**

> La entrega es un MVP operativo avanzado, no un producto completamente
> cerrado. El núcleo está integrado, pero quedan ampliaciones posteriores.
>
> El trabajo futuro incluye presupuestos, informes avanzados, nuevos perfiles
> bancarios y la configuración del correo. También debe replicarse el paquete de
> recuperación en una custodia externa e inmutable y ensayar la restauración
> desde ella.
>
> VeriFactu permanece limitado a AEAT TEST. Habilitar producción exigiría una
> validación normativa, una revisión de seguridad independiente y una
> autorización expresa. Estos límites separan lo demostrado de lo todavía
> planificado.

### 11:10-11:35 — Cierre

**Pantalla:** slide 10.

**Texto sugerido:**

> En resumen, CriGestión transforma procesos empresariales dispersos en un
> sistema integrado, seguro y auditable. El proyecto conecta clientes,
> facturación, contabilidad, tesorería y servicios recurrentes sobre una misma
> base transaccional. El núcleo presentado permite seguir ampliando
> funcionalidades sin perder coherencia ni rehacer la arquitectura. Muchas
> gracias por vuestra atención.

## 5. Elementos que no deben mostrarse

- Contraseñas mientras se escriben.
- Archivos `.env` o variables de entorno.
- Consolas con cookies, tokens o cabeceras de autorización.
- Certificados, PFX, claves o identificadores internos de credenciales.
- Paneles del servidor, SSH, Plesk, copias de seguridad o rutas privadas.
- Datos que no sean claramente sintéticos.
- Pestañas personales, correo, notificaciones o nombres de archivos privados.
- Una acción de emisión, cobro, conciliación o envío fiscal realizada solo para
  el vídeo. La cuenta de evaluación no dispone de permisos para esas operaciones.

## 6. Revisión de la toma

Antes de publicar, comprobar el vídeo completo a velocidad normal:

- [ ] La captura de pantalla se mantiene durante toda la presentación.
- [ ] El texto principal puede leerse a 1080p.
- [ ] La voz se escucha sin saturación, eco ni ruido constante.
- [ ] No aparecen contraseñas, secretos ni información personal.
- [ ] El banner de staging y AEAT TEST es visible durante la demo.
- [ ] No se presentan como terminadas funciones pendientes.
- [ ] El vídeo empieza y termina sin varios segundos de silencio.
- [ ] El archivo local se reproduce hasta el final.

## 7. Publicación y entrega

Vídeo de presentación publicado en YouTube:

https://youtu.be/nHA9s-sUqCA?is=H0R5YUPV4f7kXzXZ

Título sugerido:

`CriGestión — Presentación y demostración del TFM`

Descripción sugerida:

```text
Presentación de CriGestión, aplicación web de gestión empresarial desarrollada
como Trabajo Fin de Máster.

Código y documentación:
https://github.com/albertocs3/crigestion

Entorno de evaluación:
https://gestion-test.crisoft.es/login

La demostración utiliza datos sintéticos y VeriFactu exclusivamente en TEST.
```

Publicación recomendada:

1. Subir el MP4 mediante YouTube Studio.
2. Seleccionar visibilidad `Oculto`, no `Privado`.
3. Esperar a que finalice el procesamiento HD.
4. Abrir el enlace en una ventana privada donde no exista sesión de Google.
5. Confirmar que el vídeo se reproduce a 1080p y que el audio está disponible.
6. Sustituir `Pendiente de publicar` en el apartado 11 del `README.md` por la
   URL definitiva.
7. Publicar el cambio en GitHub y volver a probar el enlace desde el README.
