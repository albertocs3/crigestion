# Estado de implementacion

## 1. Proposito

Este documento resume el estado verificable del producto y complementa el
backlog historico de la primera rebanada vertical. No sustituye las
especificaciones funcionales, los contratos HTTP ni los ADR vigentes.

Fecha de corte: 2026-08-08.

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
| Atencion al cliente | Parcial | Incidencias con ciclo completo, actuaciones, participantes y comunicaciones teléfono/WhatsApp corregibles con historial PostgreSQL. Pendientes contactos maestros, creación atómica desde comunicación, adjuntos, notificaciones e indicadores. |
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
7. Revisar ADR-0016 y sustituir los restos documentales de escritorio por una
   decision web explicita antes de implementar notificaciones.

Existe una divergencia contable conocida: la especificacion admite coexistencia
temporal de ejercicios abiertos, mientras la base vigente mantiene un indice
parcial de un unico ejercicio `OPEN` por empresa. Su revision pertenece al
proximo corte de cierre contable y no se ha mezclado con el maestro de proveedores.
