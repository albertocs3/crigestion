# Estado de implementacion

## 1. Proposito

Este documento resume el estado verificable del producto y complementa el
backlog historico de la primera rebanada vertical. No sustituye las
especificaciones funcionales, los contratos HTTP ni los ADR vigentes.

Fecha de corte: 2026-08-20.

## 2. Rebanadas disponibles

| Area | Estado | Alcance verificado |
|---|---|---|
| Plataforma | Operativa | Inicializacion, login/logout, sesiones, permisos, auditoria, copias, restauracion y mantenimiento controlado. |
| Adjuntos seguros | Operativa inicial | Primera rebanada de logotipo empresarial desplegada en staging: cuarentena, ClamAV fail-closed, normalizacion, almacenamiento privado, integridad, RBAC, auditoria y bundle cifrado con drill de coherencia. |
| Clientes | Operativa inicial | Maestro fiscal, direcciones, tiendas, condiciones comerciales y cuentas contables de cliente. |
| Proveedores | Operativa inicial | Maestro fiscal desplegado y aceptado en staging: alta, edicion, baja logica, subcuenta 400, idempotencia, concurrencia optimista, RBAC, auditoria y datos sensibles cifrados. |
| Compras | Operativa inicial en staging | Borradores, lineas, vencimientos, registro contable, IVA soportado, stock, pagos, rectificación total y devoluciones parciales acumulables. Las rectificativas crean crédito append-only, compensable o reembolsable por banco/caja con maker-checker. |
| Catalogo | Operativo inicial | Categorias, articulos, impuestos y movimientos de stock. |
| Facturacion | Operativa inicial | Borradores, lineas, emision, vencimientos, cobros, devoluciones, impagos, rectificativas y PDF. |
| Contabilidad | Operativa inicial en staging | PGC PYMES, cuentas, asientos manuales, ejercicios y ciclo maker-checker de cierre y reapertura mediante contraasientos append-only. |
| Tesoreria y SEPA | Operativa inicial | Vencimientos, previsiones de cobro, remesas, SEPA, respuestas bancarias controladas, devoluciones, saldos a favor, compensaciones y reembolsos segregados. |
| Conciliacion bancaria | Operativa inicial | Cuentas y movimientos bancarios, Norma 43 AEB 2012, propuestas, conciliacion parcial o total y deshacer con auditoria. |
| VeriFactu TEST | Operativa controlada | Instalacion SIF, custodia cifrada y versionada de PFX, prueba mTLS, envio TEST, outbox conservador, worker con heartbeat y panel operativo. PRODUCCION permanece bloqueada. |
| Suscripciones | Operativa inicial local | Ciclo contractual, reactivacion inmediata, programada supervisada y automatizada con worker monitorizado, y runner manual: vista previa agrupada, exclusion explicita, pendientes all-or-none por bloqueos estables, ledger append-only de preparacion/confirmacion, reintento seleccionado, reserva, liberacion y confirmacion atomica con factura, asiento, VeriFactu/outbox, avance de periodos, RBAC, idempotencia, concurrencia, auditoria y defensas PostgreSQL. |
| Atencion al cliente | Parcial | Incidencias con ciclo completo, cambio posterior de prioridad, corrección administrativa de cliente y fusión de duplicadas con evidencia append-only, actuaciones con corrección versionada de texto, categorías administrables con edición y estado versionados, participantes, comunicaciones teléfono/WhatsApp, contacto maestro, conversión atómica, adjuntos seguros, notificaciones persistentes e indicadores propios/globales con tiempos activos. La entrega de avisos se refresca al navegar según ADR-0016. |
| Presupuestos | No implementada | El motor de facturacion no incluye todavia presupuesto ni conversion a factura. |

`Operativa inicial` significa que existe una rebanada integrada y probada, no
que todo el alcance funcional del modulo este terminado.

## 3. Corte bancario vigente

El primer corte bancario incluye:

- Cuentas bancarias de empresa con IBAN enmascarado en contratos y UI.
- Movimientos manuales e importados.
- Vista previa e importacion idempotente de Norma 43 AEB 2012, una cuenta y EUR.
- Rechazo de ficheros duplicados y periodos solapados.
- Propuestas puntuadas contra cobros de clientes ya registrados.
- Conciliacion manual parcial o total y operacion de deshacer.
- Aislamiento de lecturas y mutaciones por empresa.
- Auditoria sin exponer IBAN completo ni contenido bancario sensible.
- Restricciones PostgreSQL para ownership compuesto y no solapamiento de extractos.

Los contratos autoritativos estan en
[Contratos HTTP de Tesoreria](tesoreria/02-contratos-api.md), y las reglas
funcionales en [Tesoreria y SEPA](tesoreria/01-especificacion-funcional.md).

## 4. Evidencia de validacion

La release inmutable `staging-2026.07.23-rc6`, commit
`e65657550aa7ff02dee422e73d143f7b9aa527a6`, constituye la evidencia integrada
mas reciente de staging:

- 96 migraciones aplicadas y verificadas.
- Vitest: 73 archivos y 635 pruebas superadas.
- TypeScript, ESLint, build optimizado de Next.js y auditoria npm completados.
- Health local y publico con base de datos, VeriFactu TEST y worker en `ok`.
- UAT aislada del cierre y reapertura maker-checker, incluidos rechazo,
  caducidad, idempotencia e inmutabilidad de evidencia terminal.

La reactivacion local del 5 de agosto de 2026 actualizo Next.js 15 dentro de su
misma major, corrigio los advisories de PostCSS y `brace-expansion`, y separo el
Compose base del perfil VeriFactu para poder arrancar PostgreSQL sin exigir las
credenciales del worker. Sobre una base desechable restablecida desde cero se
aplicaron las 96 migraciones y pasaron 73 archivos con 635 pruebas. TypeScript,
ESLint, build optimizado con Next.js 15.5.22 y `npm audit --audit-level=high`
tambien finalizaron correctamente. No se ejecuto Playwright porque el entorno
local no dispone todavia de `.env.e2e.local`.

El corte local de Suscripciones del 5 de agosto de 2026 anadio las migraciones
97 a 101 y supero 75 archivos con 653 pruebas. Incluye alta, edicion de
borradores, activacion, cancelacion inmediata, preparacion o revocacion de una
baja futura y una barrera interna que aplica una orden vencida antes de dejar
continuar una renovacion. El runner y la facturacion todavia no existen. Tambien
finalizaron correctamente TypeScript, ESLint, el build optimizado de Next.js 15.5.22,
`npm audit --audit-level=high`, `prisma validate` y la aplicacion desde cero de
todas las migraciones sobre la base desechable. La revision independiente de
seguridad y datos no encontro riesgos P0; sus hallazgos P1 de aislamiento por
empresa, idempotencia de UI y trazabilidad se corrigieron antes de esta
validacion.

El corte local del 6 de agosto de 2026 anade la migracion 102 y la frontera
interna Suscripciones-Facturacion. El orquestador aplica primero bajas vencidas,
reserva de forma idempotente un borrador completo y conserva
`nextRenewalDate`. PostgreSQL exige identidad unica del periodo, correspondencia
completa de lineas, estados homogeneos por factura e inmutabilidad economica.
La emision generica de facturas de suscripcion queda bloqueada: el siguiente
corte debe realizar `RESERVED -> BILLED`, emision y avance del periodo de forma
atomica. La regresion completa supero 75 archivos y 657 pruebas; tambien
finalizaron correctamente la migracion desde cero, Prisma Validate, TypeScript,
ESLint y el build optimizado de Next.js 15.5.22.

El segundo corte local del 6 de agosto de 2026 anade la migracion 103 y la
confirmacion interna de renovaciones. La emision reutiliza el nucleo de
Facturacion dentro de la transaccion `Serializable` propietaria de
Suscripciones. Factura, asiento, preparacion VeriFactu, reservas `BILLED`,
periodos, versiones, auditoria e idempotencia confirman juntos. Los triggers
diferidos impiden emitir sin ledger o avanzar una suscripcion sin evidencia
facturada, asiento contabilizado y, cuando aplica, registro fiscal con outbox.
La evidencia de auditoria e idempotencia y el asiento con sus lineas quedan
ademas protegidos contra mutacion una vez facturada la renovacion.
La regresion completa supero 75 archivos y 662 pruebas; tambien finalizaron
correctamente la migracion desde cero, Prisma Validate, TypeScript, ESLint, el
build optimizado de Next.js 15.5.22 y `npm audit --audit-level=high` sin
vulnerabilidades.

El tercer corte local del 6 de agosto de 2026 anade las migraciones 104 a 106 y
expone el runner manual supervisado. La UI y los contratos HTTP permiten
consultar hasta 25 grupos elegibles, reservar con las versiones observadas,
confirmar solo con permisos segregados de renovacion y emision, o liberar con
motivo. La empresa y fecha de negocio se derivan en servidor; las mutaciones
incorporan CSRF, origen, cuerpos acotados, idempotencia y rate limit persistente.
La liberacion conserva el borrador y sus detalles como evidencia inmutable y
se serializa contra la confirmacion.

El cuarto corte local del 6 de agosto de 2026 anade la migracion 107 y la
gestion explicita de exclusiones manuales. Cada exclusion abre un expediente
durable por suscripcion y periodo, proyecta `RENEWAL_PENDING`, conserva motivo
y evidencia de actor sin filtrarlos a auditoria, y exige seleccion posterior
mediante el identificador exacto del expediente. Facturar o cancelar cierra el
expediente en la misma transaccion; liberar una reserva lo mantiene abierto.
Un permiso separado segrega la exclusion del operador que solo ejecuta
renovaciones, y constraints diferidas mantienen bilateralmente estado y
evidencia.

El quinto corte local del 6 de agosto de 2026 anade las migraciones 108 y 109.
Un ledger append-only agrupa cada preparacion o confirmacion y enlaza sus
miembros con suscripciones, expedientes, reservas y factura sin conservar
datos fiscales ni claves idempotentes en claro. Los bloqueos estables por
cliente inactivo o ejercicio cerrado materializan todo el grupo como pendiente
en una transaccion compensatoria que revalida versiones, periodos, bajas y
reservas; los errores de seguridad, seleccion o concurrencia no tienen efecto
contractual. Los fallos contables y VeriFactu de confirmacion conservan el
borrador y las reservas reintentables y solo incorporan evidencia al ledger.

El sexto corte local incorpora una cola independiente y paginada de expedientes
de renovacion abiertos. Distingue casos listos, bloqueados y ya reservados,
sella el cursor contra los filtros, aplica redaccion por permiso, desactiva la
cache compartida y audita cada pagina sin motivos libres ni texto de busqueda.

El septimo corte local anade las migraciones 110, 111 y 112 y la condonacion
administrativa individual de un periodo pendiente. Un permiso exclusivo del
administrador, evidencia de motivo y versiones, idempotencia, rate limit y
constraints bilaterales permiten avanzar exactamente un periodo sin factura,
asiento ni VeriFactu, rechazando reservas y bajas pendientes. El expediente
terminal conserva ademas subtotal, descuento, base, IVA, total y version de
calculo como snapshot economico inmutable.

El octavo corte local anade la migracion 113 y un informe paginado de periodos
condonados, con resumen economico de todo el filtro y cursor firmado congelado
por secuencia monotónica coordinada con la escritura. Permisos separados protegen consulta y exportacion; el CSV exige
POST con origen y CSRF, rango anual, rate limit, limites de filas y bytes,
neutralizacion de formulas y auditoria previa a la descarga. La pantalla y el
archivo advierten que son control interno y no documentacion fiscal o contable.

El noveno corte local anade la migracion 114 y completa la evidencia economica
de cada condonacion con un snapshot operativo del cliente y un desglose teorico
por codigo y porcentaje impositivo. No se copian NIF, domicilio, contacto ni
datos bancarios. La procedencia distingue captura contemporanea y maestro
actual recuperado para historicos; constraints diferidos comprueban presencia,
empresa, cliente, inmutabilidad y suma exacta contra los totales terminales. El
informe y el CSV consumen esta evidencia persistida sin crear factura, asiento,
libro de IVA ni registro VeriFactu.

El decimo corte local anade la migracion 115 y una revision fiscal posterior
para cada condonacion. Se abre atomicamente, requiere un revisor distinto del
usuario que condono, conserva un ledger por version y permite clasificar el
caso como cerrado sin accion, escalado o con actuacion pendiente. Los permisos,
idempotencia, CSRF, rate limit y auditoria son independientes. La clasificacion
no altera la condonacion ni crea efectos de Facturacion, Contabilidad o
VeriFactu; el cierre acreditado de actuaciones queda para el siguiente corte.

El undecimo corte local añade las migraciones 116 y 117. Separa la expansión de
enums de la estructura y permite cerrar únicamente actuaciones contables con
evidencia causal: un asiento `WAIVER_REGULARIZATION` contabilizado, único y
vinculado a la revisión. El revisor asignado acredita la evidencia y produce
atómicamente la versión 4 y el evento `COMPLETED`. El flujo fiscal no calcula
ni crea el asiento, no expone el detalle de comprobación y no permite usar una
factura manual o una referencia externa como prueba sustitutiva.

El duodécimo corte local añade las migraciones 118 y 119 y la corrección
contable de esa evidencia mediante una solicitud maker-checker independiente.
La aprobación genera una reversión exacta línea a línea dentro del mismo
ejercicio abierto, sin editar el asiento, la evidencia ni la revisión `CLOSED
v4`. Solicitud, aprobación, rechazo y cancelación tienen permisos, CSRF,
idempotencia, rate limit, auditoría y ledger propios. Tras completarse, el
informe marca la evidencia histórica como revertida y exige seguimiento; no se
producen efectos en facturación o VeriFactu.

El decimotercer corte local añade las migraciones 120 a 125 y la sustitución
controlada de una evidencia contable ya revertida. La propuesta queda separada
de sus efectos, se revisa mediante huella canónica y solo un aprobador
independiente puede crear el asiento sustitutivo y la siguiente evidencia
append-only. Reintentos serializables, idempotencia, rate limits, auditoría de
denegaciones y constraints PostgreSQL protegen la causalidad y la concurrencia.
La bandeja de Contabilidad muestra únicamente propuestas pendientes con un DTO
reducido y cursor HMAC ligado a usuario y empresa; el motivo libre, el concepto
y las líneas solo se entregan en el detalle protegido y auditado. Playwright
cubre la bandeja y las dos decisiones terminales: la aprobación crea asiento y
evidencia, mientras el rechazo no produce efectos contables. La regresión E2E
completa posterior superó sus 13 escenarios en Chromium, incluida la
importación Norma 43 con la precondición vigente de ejercicio abierto.

El candidato local del 7 de agosto de 2026 superó además la regresión Vitest
completa: 76 archivos y 684 pruebas ejecutadas de forma serial contra
PostgreSQL. TypeScript, ESLint, Prisma Validate, el build optimizado de Next.js
15.5.22 y `npm audit --audit-level=high` finalizaron correctamente, sin
vulnerabilidades. El wrapper monolítico `verify:release` excede la ventana de
15 minutos del ejecutor por la duración serial; las mismas fases se completaron
en lotes sin cambiar configuración, orden interno ni base de pruebas.

La verificación operativa posterior recreó desde cero la base desechable
`crigestion_ci_test`, aplicó consecutivamente las 125 migraciones y confirmó
con Prisma que el esquema quedó actualizado. El artefacto optimizado arrancó
con `next start` mediante `npm run release:smoke-local`; `/api/health` respondió
HTTP 200 con PostgreSQL disponible, VeriFactu desactivado y worker no requerido.
El smoke usa el perfil local sobre la base CI para no eludir la identidad
canónica que el runtime exige cuando `APP_ENV=test`, y termina siempre el
proceso que inicia.

El decimocuarto corte local añade las migraciones 126 y 127 y la anulación
interna de compras ordinarias completamente impagadas. Una operación append-only
agrupa el contraasiento exacto, los ajustes inversos de IVA y los movimientos
inversos de stock sin simular una rectificativa del proveedor ni reescribir el
histórico. El endpoint exige permiso específico, CSRF, confirmación explícita,
idempotencia, versión visible, rate limit y ejercicio abierto; las denegaciones
se auditan con códigos estables. Las 127 migraciones se aplicaron desde cero y
las pruebas dirigidas de persistencia y contrato HTTP finalizaron correctamente.

El siguiente corte inicia la sustitución interna versionada con las migraciones
128 y 129. Cada factura de proveedor queda enlazada a una identidad documental
única por empresa, proveedor y número normalizado; el histórico podrá conservar
versiones `SUPERSEDED` sin liberar el número para otra factura independiente y
un índice parcial impide más de una versión borrador o registrada. El endpoint
`REPLACE` queda completado en la migración 130 y en el caso de uso serializable:
contraasienta la versión origen, crea y contabiliza la versión sustituta,
revierte y regenera IVA y stock, cancela y recrea vencimientos y valida toda la
cadena mediante constraints diferidas antes del commit. La primera versión
conserva proveedor y número documental y limita el cuerpo HTTP a 256 KiB.
Las 130 migraciones se aplicaron desde cero; las 19 pruebas dirigidas cubren
VOID, REPLACE, replay HTTP, sustituciones sucesivas, carrera simultánea,
agotamiento forzado de reintentos serializables y pago posterior de la versión
vigente. Prisma, TypeScript, ESLint, build, auditoría npm y smoke local
HTTP 200 finalizaron correctamente. Las revisiones independientes de datos y
seguridad no dejaron hallazgos P0/P1 abiertos.

El siguiente corte añade las migraciones 131 a 133 y la devolución parcial de
compras por cantidad de línea. Una compra puede recibir varias rectificativas `PARTIAL`; el
servidor reutiliza precio, descuentos, cuenta e IVA históricos, limita de forma
transaccional el acumulado y el prorrateo, vincula cada parcial a la versión
exacta del original, enlaza cada ajuste contable y salida de stock con su
origen y crea un crédito de proveedor. El crédito compensa primero vencimientos
pendientes y deja disponible cualquier exceso, por lo que el flujo admite
compras impagadas, parcialmente pagadas o pagadas sin reescribir evidencias.
La cadena completa de 133 migraciones se aplicó desde cero y las 27 pruebas
dirigidas cubren el límite transaccional del backfill, acumulación, carrera,
redondeo, contrato HTTP, replay, cuota, auditoría opaca y agotamiento de
reintentos serializables.
La regresión completa terminó con 77 archivos y 700 pruebas; Prisma Validate,
TypeScript, ESLint, build optimizado y `npm audit` sin vulnerabilidades también
finalizaron correctamente. Las revisiones independientes de datos y seguridad
no dejaron hallazgos P0/P1/P2 abiertos.

El siguiente corte añade la migración 134 y la reactivación inmediata de
suscripciones canceladas. Un permiso específico combinado con consulta de
suscripciones, versión optimista, idempotencia y cuota persistente protege el
endpoint. Cada ciclo archiva la baja previa en historial append-only, conserva
facturas, reservas, exclusiones y bajas programadas históricas, exige cliente y
configuración vigentes y fija una nueva renovación sin recuperar periodos
omitidos. PostgreSQL refuerza la transición, el reloj de negocio, las versiones
y la inmutabilidad del historial. La cadena de 134 migraciones se aplicó desde
cero; la regresión completa terminó con 78 archivos y 708 pruebas. TypeScript,
ESLint, build optimizado y `npm audit` sin vulnerabilidades finalizaron
correctamente, y las revisiones independientes de datos y seguridad no dejaron
hallazgos P0/P1 abiertos.

La aceptacion funcional acumulada, incluidas las pruebas de autenticacion,
RBAC, sesiones, tesoreria, compras, contabilidad y auditoria, se conserva en el
[acta UAT de staging](plataforma/12-acta-uat-staging-2026-07-17.md).

El build y las pruebas automatizadas forman parte de `verify:release`; deben
repetirse sobre cada nuevo artefacto candidato antes de desplegarlo.

La release inmutable `staging-2026.07.21-rc17`, commit
`fa070e7d12287b411a8d6efd09b8caec3f8aac75`, desplego y acepto la primera
rebanada de adjuntos seguros. El smoke de navegador guardo un logotipo
sintetico; la verificacion server-side confirmo estado `AVAILABLE`, resultado
ClamAV `CLEAN`, integridad de tamano y hash, propietario runtime, modo `0600`,
cuarentena vacia y auditoria sin rutas, hashes ni contenido del fichero. Tras
crear un dump PostgreSQL actualizado, el paquete integral cifrado supero su
checksum y el drill aislado termino con `RECOVERY_DRILL_OK attachments=1`, sin
bases temporales residuales. VeriFactu permanecio en `TEST` y produccion no se
toco.

La release inmutable `staging-2026.07.22-rc2`, commit
`d51a0ca8561a259cf226eeaaff687f8baf429591`, desplego y acepto el maestro de
proveedores. La UAT tecnica cubrio alta idempotente, rechazo de identificador
fiscal duplicado, listado, detalle, edicion y baja logica. Confirmo la
subcuenta `400000001` en el ejercicio 2026 abierto, cifrado de identificador
fiscal, correo, telefono e IBAN, enmascarado en contratos y auditoria sin esos
valores en claro. Los controles de base impidieron consultar migraciones,
alterar la secuencia fuera de sus invariantes y borrar auditoria.

Durante la comprobacion de runtime se detecto un aviso nuevo de severidad alta
en `sharp` anterior a 0.35. Se fijo `sharp 0.35.3`, la regresion completa volvio
a superar 69 archivos y 611 pruebas y la candidata se valido en Ubuntu con
`libvips 8.18.3` y auditoria sin vulnerabilidades. Tras la UAT se creo un dump
actualizado y un bundle cifrado; el drill aislado termino con
`RECOVERY_DRILL_OK attachments=1`, sin bases temporales residuales. VeriFactu
permanecio en `TEST` y produccion no se toco.

La cobertura bancaria incluye importacion, propuesta, conciliacion y deshacer
desde navegador, contratos HTTP, concurrencia e invariantes PostgreSQL.

La release inmutable `staging-2026.08.12-rc1`, commit
`bb95ab194eb4be036c986a502f5de2a91fde5dab`, desplego la fusión segura de
incidencias. La migracion elevo el catalogo de staging a 150 migraciones,
incluida `20260812030000_add_support_incident_merges`, y termino con
`Result=success` y `ExecMainStatus=0`. Antes de migrar se creo y verifico el
dump `crigestion_staging-pre-staging-2026.08.12-rc1-20260812T072734Z.dump`.
La aplicacion, el worker VeriFactu TEST y los timers de reactivacion, health y
backup quedaron activos; health local y publico respondieron `ok` para base,
VeriFactu y worker. Produccion no se consulto ni modifico.

La validacion local aplico desde cero las 150 migraciones y supero 52 pruebas
dirigidas de Soporte sobre tres archivos, ademas de Prisma Validate,
TypeScript, ESLint, build optimizado y `npm audit` sin vulnerabilidades. La
suite global no dio una señal valida: un deadlock de limpieza en Compras dejo
fixtures residuales y produjo fallos en cascada por claves foraneas ajenas;
tras recrear la base, la regresion proporcional de Soporte volvio a quedar
verde.

La UAT funcional de fusión quedo cerrada en staging con `INC-2026-00001` como
principal e `INC-2026-00002` como duplicada. La interfaz agrego en la principal
la actuacion, comunicacion y adjunto historicos con indicacion de procedencia,
y dejo la duplicada cerrada, enlazada y sin controles de mutacion. La carga
segura rechazo un PDF malformado antes de aceptar el adjunto valido. PostgreSQL
confirmo una relacion, dos eventos de fusion, una auditoria y una notificacion
deduplicada, conservando el contenido en su incidencia de origen. Los triggers
rechazaron modificar la evidencia, alterar la duplicada y añadirle una nueva
comunicacion. El health y las unidades de staging permanecieron correctos;
VeriFactu continuo en `TEST`, no se toco produccion y el acceso SSH temporal se
mantuvo activo.

La release inmutable `staging-2026.08.12-rc2`, commit
`c3dd44e3effdef9e3fa4fba14e9b0d7c3420b883`, incorpora indicadores de
Atención al cliente con dos
permisos separados: consulta propia y consulta global. La foto actual agrupa
incidencias canónicas abiertas por estado, prioridad y responsable vigente. El
histórico atribuye la primera actuación a su autor y las resoluciones/cierres al
responsable capturado en el evento; las reaperturas generan episodios
independientes y el tiempo de resolución descuenta intervalos pendientes. El
endpoint y la pantalla no exponen clientes ni textos, usan lectura sin caché y
auditan alcance y periodo. La migración 151 añadió los permisos sin modificar
el modelo económico ni VeriFactu. La UAT comprobó vista propia, vista global y
filtro por técnico; la foto mostró una única incidencia canónica abierta y la
cabecera conservó `STAGING`, `crigestion_staging` y `AEAT TEST`. Health local y
público respondieron íntegramente `ok` tras la promoción.

La release inmutable `staging-2026.08.12-rc3`, commit
`825cfc7b48a90f7bc1095c6cc02315a14d4d5567`, completa el panel principal de Atención al cliente
sin alterar persistencia. Una lectura `REPEATABLE READ` reúne contadores de
incidencias canónicas abiertas, incidencias propias, avisos no leídos, carga por
técnico condicionada a permiso global y últimas comunicaciones condicionadas a
su permiso específico. Las proyecciones omiten textos y teléfonos, el contrato
HTTP no admite parámetros y una única auditoría opaca registra cada foto.
La promoción conservó 151 migraciones, VeriFactu TEST y health íntegro. La UAT
visual autenticada queda pendiente porque la sesión disponible expiró y el
servidor redirigió correctamente a login; no se introdujeron credenciales.

La release inmutable `staging-2026.08.20-rc1`, commit
`723cf4a45770da75d1b5363ee3873fec476b4142`, integra Atención al cliente en la
ficha del cliente sin modificar persistencia. Añade una proyección mínima y
consistente de incidencias abiertas, finalizadas y comunicaciones condicionadas
por RBAC,
con auditoría única y contrato HTTP sin caché. Las duplicadas permanecen
visibles en el histórico con enlace a su principal; no se recuperan ni exponen
resúmenes, teléfonos, correcciones ni descripciones. Los enlaces de alta
reutilizan las mutaciones existentes y solo preseleccionan un `customerId`
presente en las referencias autorizadas. La promoción dejó 153 migraciones y
cero incompletas, la aplicación, el worker VeriFactu y los timers operativos
activos, y health local y público íntegramente en `ok`. El worker de
reactivación terminó con `SUBSCRIPTION_REACTIVATION_AUTOMATION_OK`; VeriFactu
permaneció en `TEST`, producción no se consultó ni modificó y el acceso SSH
temporal continuó activo.

Durante la verificación se corrigió el empaquetador de recuperación para
admitir también la raíz segura `support-incident`, coherente con sus rutas de
archivo y validaciones de base ya existentes. El script operativo se actualizó
después del tag de la release y queda versionado en el commit de evidencia
posterior. Se generó y verificó el paquete cifrado
`crigestion-staging-20260820T070551Z.cgrb`, tras lo cual el health-check systemd
volvió a `Result=success`; no se ejecutó un drill completo de restauración de
este paquete durante el corte. La validación local pasó typecheck, lint, build,
58 pruebas de Soporte y 30 pruebas aisladas de Clientes. La ejecución paralela
conjunta de Clientes y Soporte no fue una señal válida: dos suites antiguas de
direcciones intentaron
eliminar clientes mientras otras conservaban contactos y fallaron por la FK
`customer_contacts_customerId_fkey`; aisladas, las suites proporcionales
quedaron verdes. `npm audit --audit-level=high` continúa señalando cuatro
vulnerabilidades transitivas ya presentes en `deepmerge-ts`/Prisma y `nanoid`;
no se alteraron dependencias dentro de esta rebanada.

La UAT autenticada de Administrador del 20/08/2026 comprobó en la ficha del
cliente la incidencia principal abierta, la duplicada cerrada con enlace a su
principal y el historial mínimo de comunicaciones. Los accesos de alta
preseleccionaron el cliente autorizado sin registrar datos; un `customerId`
desconocido dejó el formulario deshabilitado y no seleccionó silenciosamente
otro cliente. La vista móvil a 390 x 844 mantuvo la sección visible y sin
desbordamiento horizontal de página. PostgreSQL registró
`SUPPORT_CUSTOMER_CONTEXT_VIEWED` con identificadores, capacidades y conteos,
sin título, descripción, resumen, teléfono, IBAN, NIF ni motivo.

La UAT autenticada de Técnico del mismo día utilizó el rol mínimo
`TECNICO_SOPORTE`, con doce permisos operativos de Soporte y sin
`Customers.View` ni permisos económicos, fiscales o de plataforma. El inicio
mostró únicamente Atención al cliente; el panel omitió carga global y gestión de
categorías, las comunicaciones permanecieron disponibles y los indicadores
ofrecieron solo el alcance propio. El listado y la ficha fiscal de Clientes
respondieron con denegación completa. El detalle de una incidencia ajena fue
consultable, incluido el contenido histórico agregado de su duplicada, pero no
mostró controles de mutación. Con estas comprobaciones queda cerrada la UAT
autenticada de esta rebanada.

La release inmutable `staging-2026.08.20-rc2`, commit
`d8488eab4c9498c00d8908c1a9b7e85a52e76b47`, desplegó la primera rebanada de filtros
avanzados de Soporte. Incidencias incorpora cliente, responsable, colaborador
activo, categoría y rango de creación; comunicaciones incorpora contacto,
incidencia, dirección, resultado y rango de ocurrencia. Los rangos son
inclusivos en `Europe/Madrid`, las queries HTTP rechazan parámetros desconocidos
o repetidos y la paginación usa cursores HMAC ligados a los filtros. Se añadieron
índices compuestos y trigram para los nuevos patrones, con cuota persistente de
búsqueda. Antes de migrar se verificó el dump
`crigestion_staging-auto-20260820T090708Z.dump`, de 1.463.188 bytes. La unidad
controlada aplicó `20260820010000_add_support_list_filter_indexes`; el primer
arranque no llegó a PostgreSQL porque la normalización prematura retiró el bit
ejecutable de `esbuild`, y la repetición terminó correctamente después de
restaurar `node_modules` desde el lockfile. La UAT autenticada comprobó filtros
combinados y búsqueda de incidencias y comunicaciones. Health local y público
quedaron íntegramente en `ok`, VeriFactu permaneció en `TEST` y una ejecución
posterior del timer de reactivación terminó con
`SUBSCRIPTION_REACTIVATION_AUTOMATION_OK` y cero cambios. Sobre esa base local,
la búsqueda de incidencias se amplió también al contenido de actuaciones con
índice trigram propio, timeout PostgreSQL local de 3 segundos y error HTTP 503
estable. Una medición desechable con 20.000 actuaciones confirmó que el
predicado selectivo usa `Bitmap Index Scan` sobre el GIN (0,64 ms); el `EXISTS`
correlacionado inicial no lo hacía, por lo que la implementación final separa
una preselección SQL parametrizada `DISTINCT ... LIMIT 10001` y rechaza con 422
los términos que superen 10.000 incidencias.

La ampliación se desplegó primero como `staging-2026.08.20-rc3`, commit
`92e08be9e49166b070330b7f44c852c1caa8386f`, build ID
`GDuqrY9XKiCGwD8mu7aaK`. El artefacto, de 1.479.343 bytes y SHA-256
`7DA016FFB90C8C2987E2ED325D917E924C449D7BD6881872E88AFCF7999C29DC`, se
compiló de forma aislada. Antes de la migración se verificó por checksum y
catálogo de `pg_restore` el dump
`crigestion_staging-auto-20260820T094947Z.dump`, de 1.468.017 bytes. La unidad
controlada aplicó `20260820020000_add_support_action_search_index` en 2.474 ms;
PostgreSQL quedó con 153 migraciones y el índice GIN válido.

La primera UAT de `rc3` detectó que el envío HTML incluía controles opcionales
vacíos y una fecha vacía podía provocar `RangeError` durante la validación. No
hubo mutación de datos. El hotfix normaliza únicamente controles conocidos,
conserva parámetros desconocidos o repetidos para rechazo estricto y valida las
fechas sin excepciones. Se publicó como `staging-2026.08.20-rc4`, commit
`2802a62746463c62af6208e15cca084c511d740b`, build ID
`HBkVfrR-0WDoYinMVz2sY`; su artefacto mide 1.479.728 bytes y tiene SHA-256
`E858E074C6065E2C6A34C2A531C207A3FBF2D808D9F40D438F0A00884CB17B57`.
Al no contener cambios de persistencia, no ejecutó una nueva migración y
conservó el backup predeploy ya verificado.

La UAT autenticada final buscó `Actuación sintética previa` mediante el envío
real del formulario y devolvió únicamente `INC-2026-00002`, la incidencia donde
la actuación permanece almacenada físicamente. El mismo envío con controles
vacíos funcionó en comunicaciones. Health local y público respondieron HTTP 200
con todos los componentes en `ok`; aplicación, worker VeriFactu TEST y timers de
reactivación y health quedaron activos, y los dos one-shot informaron su último
`Result=success`. Producción no se consultó ni modificó y el acceso SSH temporal
permanece activo.

La release inmutable `staging-2026.08.20-rc5`, commit
`307793852bd44de8cc17f8ba0a7c79cb8ee2949f`, integra la edición
versionada de los datos principales de una incidencia. El responsable vigente
o un Administrador con `Support.ManageAssigned` puede corregir título,
descripción, categoría y tienda indicando un motivo. La operación usa bloqueo,
control optimista, idempotencia, cuota persistente y transacción serializable;
PostgreSQL exige una evidencia append-only y un evento `DETAILS_CHANGED` por
versión y rechaza una proyección incompleta. La duplicada fusionada continúa en
solo lectura y la auditoría omite los textos y el motivo. El cambio de cliente
queda fuera de esta rebanada porque la relación vigente con comunicaciones usa
cascada y modificarla sin un flujo específico alteraría historia ya registrada.
La migración `20260820030000_add_support_incident_details_changes` se aplicó
desde cero en la base desechable y mediante la unidad controlada en staging,
que quedó con 154 migraciones completas y cero incompletas.
La regresión completa de Soporte superó 69 pruebas y la suite de aplicación,
incluidos replay tras reasignación, carrera serializable, referencias inactivas,
incidencia finalizada, duplicada fusionada y bypasses SQL, superó 26 pruebas.
Prisma Validate, TypeScript, ESLint y el build optimizado quedaron verdes. La
auditoría npm conserva las cuatro vulnerabilidades altas transitivas ya
documentadas de `deepmerge-ts`/Prisma y `nanoid`; no se modificaron dependencias.

El artefacto aislado de `rc5` tiene build ID `Hueffmisi15U2jaSfDISL`. Antes de
migrar se generó y verificó por SHA-256 y catálogo `pg_restore` el backup
`crigestion_staging-auto-20260820T104620Z.dump`, de 1.469.110 bytes. El primer
intento del migrador terminó antes de conectar por faltar ejecución en el
`schema-engine`; tras restaurar su modo, la unidad aplicó la única migración y
terminó con `Result=success`. Después de `npm prune`, esbuild quedó también sin
ejecución y afectó brevemente al arranque de los dos workers. Se corrigió a
`0750`, el worker VeriFactu volvió a `TEST: idle` y la ejecución repetida del
one-shot de reactivación terminó `SUBSCRIPTION_REACTIVATION_AUTOMATION_OK` con
cero cambios. Health local y público respondieron HTTP 200 con todos los
componentes en `ok`, los timers permanecieron activos y no quedaron unidades
fallidas. Producción no se consultó ni modificó; el acceso SSH temporal sigue
activo.

La comprobación autenticada con `TECNICO_SOPORTE` confirmó que una incidencia
ajena no muestra la edición de datos y que la duplicada fusionada continúa
identificando su principal sin exponer controles de mutación. Este usuario no
tenía incidencias propias en staging, por lo que se creó expresamente la
incidencia sintética `INC-2026-00003` (`bd490c41-d61a-4886-8ba8-b77228f4c39c`),
asignada a `TECNICO_SOPORTE`, sin modificar las dos incidencias históricas de la
UAT de fusión. Desde el formulario autenticado se corrigieron título y
descripción con motivo y confirmación explícitos. La pantalla mostró el estado
`Datos principales actualizados`, el cambio OLD→NEW y el evento homónimo en el
historial. PostgreSQL confirmó la proyección en versión 2, exactamente una fila
append-only en `support_incident_details_changes`, un evento `DETAILS_CHANGED`
y una auditoría `SUPPORT_INCIDENT_DETAILS_CHANGED`; evidencia y evento comparten
actor y versión, el actor era el responsable y la auditoría no contiene título,
descripción ni motivo. Tras la UAT, la release activa seguía siendo
`staging-2026.08.20-rc5`, aplicación y worker estaban activos, VeriFactu
continuaba en `TEST: idle`, los cuatro timers estaban programados, no había
unidades fallidas y el health público devolvía todos los componentes en `ok`.
Producción no se consultó ni modificó y el acceso SSH temporal permanece activo.

El siguiente corte local incorpora la corrección versionada del texto de las
actuaciones y endurece el replay de su alta. El endpoint nuevo exige
`Support.CorrectActions` y `Support.View`; solo el autor que continúe como
responsable o colaborador activo puede corregir, con bypass explícito de
Administrador. `performedAt` permanece inmutable. La actuación original no se
reescribe: PostgreSQL conserva una cadena append-only OLD→NEW, exige un evento
`ACTION_CORRECTED` y una única versión de incidencia por corrección, y rechaza
evidencia incompleta. El detalle deriva el texto vigente de la última
corrección, muestra el historial y la búsqueda deja de considerar textos
superados. La auditoría omite texto y motivo. La regresión dirigida cubre
replay tras reasignación, autoría y pertenencia, Administrador, incidencia
resuelta, duplicada fusionada, carrera concurrente, búsqueda vigente y barreras
SQL. La base desechable aplicó las 155 migraciones desde cero; la regresión de
Soporte pasó 74/74, junto con `typecheck`, `lint` y el build de producción. Dos
revisiones independientes cerraron sin P0/P1 antes del despliegue aislado.

La release inmutable `staging-2026.08.20-rc6`, commit
`c19a3b7bb952f55b9899fb050af534bf65624591`, desplegó esta rebanada con build ID
`TWmNWxY0XgilYh4e9IDC9`. El backup previo
`crigestion_staging-auto-20260820T113145Z.dump`, de 1.498.164 bytes y SHA-256
`a61743089abdc5dc1d4c501906cc43acbf12374f710356c44ab72a20ed18806a`, superó
su catálogo `pg_restore`. La unidad migradora aplicó únicamente
`20260820040000_add_support_action_corrections`, terminó con `Result=success` y
dejó 155 migraciones completas y cero incompletas activas. El rol UAT
`TECNICO_SOPORTE` recibió el permiso nuevo con auditoría `SYSTEM` opaca.

La UAT autenticada sobre `INC-2026-00003` registró una actuación sintética y
la corrigió desde el formulario. La pantalla mostró la versión 2, el texto
vigente, OLD→NEW, motivo y el evento `Actuación corregida`. PostgreSQL confirmó
la incidencia en versión 4, exactamente una corrección append-only, un evento
`ACTION_CORRECTED` y una auditoría `SUPPORT_INCIDENT_ACTION_CORRECTED` sin texto
ni motivo. La búsqueda devolvió la incidencia con el texto corregido y una
lista vacía con el texto superado. Aplicación, worker VeriFactu TEST y los
timers quedaron activos; el one-shot de reactivación terminó sin cambios y los
health local y público devolvieron todos los componentes en `ok`. Producción no
se consultó ni modificó y el acceso SSH temporal permanece activo.

La release inmutable `staging-2026.08.20-rc7`, commit
`55f5399131443a8984858ab1d8e70e2ef0e77bc0`, desplegó la administración
versionada de categorías de Atención al cliente con build ID
`KJp61ASjsqvq5vwJwWE3o`. El backup previo
`crigestion_staging-auto-20260820T121739Z.dump`, de 1.519.061 bytes y SHA-256
`f6450b03e3be55954a1e25883b9b15031e750d504c8a84f2ae3af85d66bb8e7a`,
superó la verificación de checksum y su catálogo `pg_restore`. La unidad
migradora aplicó únicamente
`20260820050000_add_support_category_changes`, terminó con `Result=success` y
dejó 156 migraciones completas y cero incompletas. El preflight transaccional
instaló `unaccent`, detectó cero colisiones bajo la normalización canónica y
quedaron presentes los cinco triggers de integridad de la categoría y su
evidencia append-only.

Tras la conmutación atómica, aplicación, worker VeriFactu TEST y timers de
reactivación, backup, health y recovery bundle quedaron activos; no había
unidades fallidas y los health local y público devolvieron todos los
componentes en `ok`. El smoke autenticado con `TECNICO_SOPORTE` confirmó la
denegación server-side de la administración de categorías, coherente con la
ausencia de `Support.ManageCategories`. La UAT de edición, activación y
desactivación queda pendiente de una sesión Administrador y no se alteraron
datos durante este smoke. Producción no se consultó ni modificó y el acceso SSH
temporal permanece activo.

La UAT Administrador de categorías de `rc7` quedó cerrada sobre la categoría
sintética `UAT Categorias RC7 20260820 VALIDADA`
(`cce2c110-c0ca-4f69-9667-17e4baa3e34e`). Desde la interfaz autenticada se
creó la categoría, se editaron sus datos, se desactivó, se reactivó y se dejó
finalmente inactiva para excluirla de nuevas altas sin borrar su historia. La
pantalla confirmó cada transición y mostró la progresión de versión 1→5.
PostgreSQL confirmó exactamente cuatro evidencias append-only para las
versiones 2, 3, 4 y 5, sin rupturas OLD→NEW, y cuatro auditorías
`SUPPORT_INCIDENT_CATEGORY_CHANGED`. Sus payloads contienen solo
identificadores, versiones, tipo, campos cambiados y estados; no contienen
nombre, descripción, color ni ninguno de los motivos UAT. La categoría
inactiva continúa disponible en filtros históricos con etiqueta explícita. El
health permaneció completo en `ok`, VeriFactu continuó en TEST, producción no
se consultó ni modificó y el acceso SSH temporal permanece activo.

La release `staging-2026.08.20-rc8`, commit
`c6590fd5e15e7dc155bda1d401bf5c6076968502`, desplegó el cambio
administrativo y versionado del cliente de una incidencia. El contrato separado
exige rol Administrador y los permisos `Support.View`,
`Support.ChangeIncidentCustomer` y `Customers.View`, además de Origin/CSRF,
confirmación, cliente esperado, idempotencia, cuota y versión optimista. La
operación queda bloqueada si existe tienda o si la incidencia participa en una
fusión. PostgreSQL exige una evidencia append-only y un evento
`CUSTOMER_CHANGED` por versión. La FK de comunicaciones dejó de cascadear el
cliente: cada comunicación histórica conserva cliente, contacto, número y
correcciones, mientras los enlaces nuevos siguen exigiendo el cliente vigente
de la incidencia.

La UAT Administrador de `rc8` cambió la incidencia sintética
`INC-2026-00003` (`bd490c41-d61a-4886-8ba8-b77228f4c39c`) del cliente 3 al
cliente de pruebas 2. La interfaz confirmó el cambio, mostró la evidencia y el
evento en el historial y dejó la incidencia en versión 5, sin tienda y sin
fusión. PostgreSQL confirmó exactamente una evidencia, un evento
`CUSTOMER_CHANGED` y una auditoría `SUPPORT_INCIDENT_CUSTOMER_CHANGED`; el
payload de auditoría no contiene motivo, título ni descripción. El permiso
nuevo está asignado únicamente al rol Administrador y la FK de comunicaciones
vigente usa `ON UPDATE RESTRICT`. El health público permaneció completo en
`ok`, VeriFactu continuó en TEST, producción no se consultó ni modificó y el
acceso SSH temporal permanece activo.

El siguiente corte local completa la lectura del historial de correcciones de
comunicaciones. El read model pagina el historial en bloques de hasta cien versiones,
con cursor firmado y ligado a la comunicación para recuperar las anteriores; limita la carga inicial a las cien versiones más
recientes, señala si existe historia anterior y resuelve las incidencias
anterior y corregida únicamente por identificadores exactos dentro de la
empresa. La ficha muestra solo los campos modificados y conserva la semántica
OLD→NEW incluso después de un cambio administrativo de cliente. Esta rebanada
todavía no se ha desplegado; `rc8` continúa activa en staging, producción sigue
fuera de alcance y el acceso SSH temporal permanece activo.

## 5. Riesgos y trabajo posterior

Prioridades pendientes despues de este corte:

1. Mantener PRODUCCION deshabilitada hasta completar revision fiscal, operativa
   y de despliegue independiente.
2. Preparar el supervisor equivalente del entorno de despliegue definitivo; en
   Windows TEST ya existe una tarea de instancia unica con reinicio automatico.
3. Replicar el paquete integral cifrado ya ensayado a una custodia externa e
   inmutable y repetir el drill desde esa copia. El drill local no sustituye
   todavia un runner de aplicacion total que reinstale release, configuracion,
   base y adjuntos ante perdida completa.
4. Ampliar el ciclo avanzado de proveedor con rectificaciones parciales por
   importe, portes o descuentos cuando exista un requisito funcional confirmado;
   la devolución parcial por cantidad ya está implementada.
5. Ampliar perfiles bancarios solo cuando exista un requisito confirmado:
   multicuenta, moneda distinta de EUR u otros perfiles Norma 43.
6. Ampliar los cambios programados de Suscripciones mas alla de la primera
   rebanada de cantidades `PER_LICENSE`, ya integrada con vista previa,
   reserva y evidencia append-only. La vista previa ya permite personalizar
   descripciones solo para el borrador; queda definir e implementar la edicion
   economica de cantidades, precios, descuentos o recargos. La vista previa ya
   muestra en lote la falta de ejercicio o cuentas contables de las reservas y
   dispone de paginacion navegable mediante
   cursor firmado ligado a filtros. La reactivacion
   programada ya dispone de aplicacion supervisada y de un worker one-shot
   monitorizado con autoridad diferida, cooldown y ledger append-only de
   intentos. Despues, abordar Atencion al
   cliente y Presupuestos.
7. Ampliar la primera rebanada de notificaciones aceptada en ADR-0016 con los
   eventos funcionales todavía pendientes y, solo si se confirma necesidad crítica,
   evaluar outbox y canal web casi inmediato sin cambiar PostgreSQL como verdad.

Existe una divergencia contable conocida: la especificacion admite coexistencia
temporal de ejercicios abiertos, mientras la base vigente mantiene un indice
parcial de un unico ejercicio `OPEN` por empresa. Su revision pertenece al
proximo corte de cierre contable y no se ha mezclado con el maestro de proveedores.
