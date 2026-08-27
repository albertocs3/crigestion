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

> CriGestión es una aplicación web de gestión empresarial integrada. El
> objetivo del proyecto es conectar el ciclo comercial, la tesorería y la
> contabilidad sobre una única fuente de verdad, incorporando seguridad y
> trazabilidad desde el diseño.

### 0:25-1:10 — Problema y propuesta

**Pantalla:** slide 2.

**Texto sugerido:**

> El problema que aborda es la fragmentación habitual de la información entre
> hojas de cálculo y aplicaciones independientes. Esto provoca duplicidades,
> conciliaciones manuales y poca evidencia ante un error. La propuesta es que
> cada dato tenga un único propietario y que los módulos compartan el mismo
> flujo transaccional.

### 1:10-2:00 — Alcance funcional

**Pantalla:** slide 3.

**Texto sugerido:**

> El producto se organiza en cuatro capacidades conectadas: el ciclo comercial,
> el control financiero, los ingresos recurrentes y la operación con gobierno.
> La navegación depende del rol, pero las reglas y los permisos siempre se
> validan en el servidor.

### 2:00-3:00 — Arquitectura

**Pantalla:** slides 4 y 5.

**Texto sugerido:**

> La solución utiliza Next.js con App Router, TypeScript estricto, PostgreSQL y
> Prisma. Es un monolito modular: reduce la complejidad de despliegue y conserva
> transacciones ACID en operaciones económicas. Los procesos externos se
> desacoplan mediante workers y outbox. Si una comunicación con VeriFactu TEST
> falla, la factura no se deshace; el envío queda pendiente de un reintento
> controlado e idempotente.

### 3:00-3:35 — Acceso y panel

**Pantalla:** cambiar al navegador y mostrar `/app`.

**Acciones:**

1. Señalar el banner de staging y AEAT TEST.
2. Mostrar el nombre del rol de tribunal en solo lectura.
3. Recorrer visualmente las nueve áreas disponibles.

**Texto sugerido:**

> Esta es la aplicación desplegada en el entorno de evaluación. La banda
> superior evita confundirla con producción y la cuenta utilizada solo dispone
> de permisos de consulta. En este caso aparecen nueve áreas funcionales.

### 3:35-4:20 — Clientes y catálogo

**Pantalla:** `/app/customers` y `/app/catalog`.

**Acciones:**

1. Abrir el listado de clientes.
2. Mostrar búsqueda y datos maestros sin abrir información innecesaria.
3. Cambiar al catálogo y señalar productos, servicios e impuestos.

**Texto sugerido:**

> Clientes y catálogo actúan como maestros del ciclo comercial. Los módulos que
> facturan los referencian y no mantienen copias editables independientes.

### 4:20-6:20 — Facturación: núcleo de la demostración

**Pantalla:** `/app/invoices` y una factura ya emitida.

**Acciones:**

1. Mostrar filtros y estados de la lista.
2. Señalar por separado el estado documental, el cobro y VeriFactu.
3. Abrir una factura emitida.
4. Mostrar número, fechas, cliente, impuestos, total y vencimiento.
5. Enseñar el estado VeriFactu TEST sin iniciar un envío nuevo.

**Texto sugerido:**

> La factura concentra el flujo principal. El estado documental es independiente
> del estado de cobro y del estado VeriFactu. Esta separación evita deducir una
> situación financiera o fiscal a partir de un único indicador. La emisión
> consolida numeración, vencimientos y evidencia, y prepara sus efectos
> contables y fiscales de manera trazable.

### 6:20-7:05 — Contabilidad

**Pantalla:** `/app/accounting`.

**Acciones:**

1. Mostrar ejercicio y diario.
2. Señalar el equilibrio entre Debe y Haber.
3. Mencionar el control maker-checker de cierres sin ejecutar operaciones.

**Texto sugerido:**

> Contabilidad recibe los efectos del ciclo comercial mediante reglas de
> aplicación. Las operaciones críticas son transaccionales y los cierres
> requieren separación entre solicitud y aprobación.

### 7:05-7:45 — Suscripciones

**Pantalla:** `/app/subscriptions`.

**Acciones:**

1. Mostrar contratos y próxima renovación.
2. Señalar que las reactivaciones y renovaciones pueden quedar supervisadas.

**Texto sugerido:**

> Suscripciones reutiliza el mismo motor de facturación. Los trabajos
> recurrentes se ejecutan mediante procesos monitorizados, con reservas,
> idempotencia y evidencia de cada intento.

### 7:45-8:25 — Atención al cliente

**Pantalla:** `/app/support` y, opcionalmente, `/app/support/indicators`.

**Acciones:**

1. Mostrar incidencias y estados.
2. Señalar indicadores y trazabilidad de actuaciones.

**Texto sugerido:**

> Atención al cliente integra incidencias, actuaciones e indicadores. Las
> correcciones relevantes conservan historial y no sobrescriben silenciosamente
> la evidencia anterior.

### 8:25-9:05 — Tesorería

**Pantalla:** `/app/treasury` y `/app/treasury/banking`.

**Acciones:**

1. Mostrar vencimientos y previsión.
2. Mostrar movimientos bancarios y conciliación sin modificar datos.

**Texto sugerido:**

> Tesorería conecta vencimientos, cobros, pagos y movimientos bancarios. La
> conciliación registra qué importe se ha aplicado y conserva cualquier exceso
> disponible para usos posteriores.

### 9:05-9:50 — Seguridad

**Pantalla:** volver a PowerPoint, slide 7.

**Texto sugerido:**

> La seguridad no depende de ocultar botones. Las sesiones usan cookies
> HttpOnly, los permisos se comprueban en servidor y las mutaciones incorporan
> protección CSRF, validación y cuotas. Los certificados VeriFactu permanecen
> cifrados en el servidor y las acciones críticas dejan evidencia sin incluir
> secretos.

### 9:50-10:30 — Evidencia

**Pantalla:** slide 8 y, brevemente, `/api/health`.

**Texto sugerido:**

> La release de evaluación tiene 159 migraciones aplicadas. La última regresión
> completa registrada ejecutó 813 pruebas. El health público comprueba
> aplicación, PostgreSQL, VeriFactu TEST y worker, que en este momento se
> encuentran operativos.

### 10:30-11:10 — Límites y trabajo posterior

**Pantalla:** slide 9.

**Texto sugerido:**

> La entrega se presenta como un MVP operativo avanzado. Permanecen para etapas
> posteriores los presupuestos, informes y comunicaciones avanzadas, una
> recuperación integral desde custodia externa y la revisión independiente
> necesaria antes de habilitar producción fiscal. VeriFactu permanece limitado
> deliberadamente a TEST.

### 11:10-11:35 — Cierre

**Pantalla:** slide 10.

**Texto sugerido:**

> En resumen, CriGestión convierte operaciones dispersas en un sistema integrado
> y auditable. El núcleo presentado ya conecta negocio, seguridad y trazabilidad;
> la evolución posterior ampliará funcionalidades sin rehacer esa base.

## 5. Elementos que no deben mostrarse

- Contraseñas mientras se escriben.
- Archivos `.env` o variables de entorno.
- Consolas con cookies, tokens o cabeceras de autorización.
- Certificados, PFX, claves o identificadores internos de credenciales.
- Paneles del servidor, SSH, Plesk, copias de seguridad o rutas privadas.
- Datos que no sean claramente sintéticos.
- Pestañas personales, correo, notificaciones o nombres de archivos privados.
- Una acción de emisión, cobro, conciliación o envío fiscal realizada solo para
  el vídeo. La cuenta de evaluación debe permanecer en modo lectura.

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
