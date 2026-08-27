# Guion de presentación de CriGestión

## 1. Objetivo de esta entrega

La versión de presentación demuestra un circuito empresarial integrado y
trazable. No pretende declarar finalizadas todas las ampliaciones del producto
ni habilitar operaciones fiscales en producción.

El recorrido principal cubre:

- acceso autenticado y permisos;
- clientes y catálogo;
- factura, PDF, vencimiento y cobro;
- asiento contable y trazabilidad;
- suscripciones;
- atención al cliente;
- tesorería y conciliación;
- VeriFactu únicamente en TEST.

## 2. Preparación segura

1. Usar exclusivamente staging o una base local independiente llamada
   `crigestion_demo`.
2. Utilizar empresa, NIF, usuarios, direcciones e importes sintéticos.
3. Mantener `VERIFACTU_ENVIRONMENT=TEST` o VeriFactu desactivado.
4. No importar certificados reales para una demostración básica.
5. No ejecutar Playwright contra la base de demostración: sus suites reinician
   deliberadamente `crigestion_test`.
6. Comprobar que el banner identifica claramente el entorno no productivo.

Para preparar el dataset local reproducible:

```powershell
Copy-Item .env.demo.example .env.demo.local
# Sustituir APP_SESSION_SECRET y DEMO_ADMIN_PASSWORD en el fichero local ignorado.
npm run db:up
npm run prisma:deploy
npm run demo:prepare
npm run build
npm run demo:start
```

`demo:prepare` solo acepta `APP_ENV=development`, VeriFactu desactivado, la
confirmación exacta `crigestion_demo` y una conexión local a esa base. Puede
repetirse sin duplicar el dataset.

## 3. Datos mínimos antes de presentar

- Un usuario Administrador de demostración.
- Una empresa configurada y un ejercicio abierto.
- Un cliente activo con dirección y contacto.
- Un servicio activo con IVA general.
- Una factura emitida con su PDF y vencimiento.

El script `demo:prepare` deja listo este núcleo. Si la presentación va a cubrir
más de diez minutos, conviene preparar además desde la interfaz:

- un cobro registrado para enseñar el cambio de estado;
- una suscripción activa;
- una incidencia con una actuación y una notificación;
- un movimiento bancario sintético, preferiblemente ya conciliado.

No guardar la contraseña de demostración en el repositorio ni reutilizar las
credenciales de las pruebas automatizadas.

## 4. Recorrido recomendado (10-12 minutos)

### 1. Contexto y acceso — 1 minuto

- Mostrar el banner de STAGING/TEST.
- Iniciar sesión y explicar que la navegación depende de permisos de servidor.

### 2. Panel de control — 1 minuto

- Presentar las áreas operativas desde el panel.
- Señalar notificaciones y utilidades administrativas sin abrir configuración
  sensible.

### 3. Ciclo de venta — 4 minutos

- Abrir el cliente de demostración.
- Mostrar sus datos y el concepto de catálogo.
- Abrir una factura ya emitida.
- Enseñar numeración, impuestos, PDF, vencimiento, cobro y asiento.
- Mostrar el estado VeriFactu TEST sin ejecutar una comunicación nueva.

### 4. Operación recurrente y soporte — 3 minutos

- Abrir una suscripción activa y explicar su próxima renovación.
- Abrir una incidencia con actuación e historial.
- Mostrar que las correcciones conservan evidencia en vez de reescribirla.

### 5. Tesorería y cierre — 2 minutos

- Mostrar previsión o vencimientos.
- Abrir un movimiento bancario y su conciliación.
- Terminar en auditoría para cerrar el relato de trazabilidad.

## 5. Funciones que se presentan como evolución

- Presupuestos y conversión a factura.
- Informes contables avanzados.
- Edición económica avanzada de renovaciones.
- Perfiles bancarios adicionales.
- Correo SMTP operativo.
- Habilitación fiscal y despliegue de producción.

Estas funciones no deben ocultarse ni describirse como terminadas. La versión
actual se presenta como MVP operativo avanzado en staging.

## 6. Checklist inmediato

- [ ] Health público y local en estado correcto.
- [ ] Login, logout y segundo login comprobados.
- [ ] Banner de STAGING/TEST visible.
- [ ] Credenciales de demo disponibles fuera del repositorio.
- [ ] Datos sintéticos mínimos preparados.
- [ ] Factura y PDF abiertos previamente para comprobar el recorrido.
- [ ] Navegación del Administrador revisada.
- [ ] VeriFactu PRODUCCIÓN bloqueado.
- [ ] Pestañas, notificaciones y aplicaciones ajenas cerradas.
- [ ] Capturas o PDF de respaldo disponibles si falla la conexión.

## 7. Mensaje de cierre

CriGestión integra en una única fuente de verdad el ciclo comercial, contable y
de soporte, protege las operaciones críticas con permisos y mantiene evidencia
auditable. La siguiente etapa se centra en completar funciones de ampliación y
las puertas necesarias para producción, no en rehacer el núcleo presentado.
