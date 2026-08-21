# Acta de aceptacion UAT de staging 2026-07-17

## 1. Decision

La release `staging-2026.07.17-rc5`, commit
`1cda851e83d6e31b9bbdb9938028f33a21e47bff`, queda **ACEPTADA PARA STAGING**
en el alcance descrito en este documento.

Esta aceptacion no autoriza ni prepara un despliegue en produccion. VeriFactu
permanece limitado a AEAT TEST y los bloqueos productivos siguen cerrados.

## 2. Alcance aceptado

- Factura y ciclo VeriFactu AEAT TEST, incluida subsanacion y anulacion.
- Backup, restauracion ensayada y continuidad posterior de los servicios.
- Health, worker, alertas, reinicio y persistencia operativa.
- Login, logout, bloqueo, desbloqueo por expiracion y respuesta publica
  indistinguible ante credenciales invalidas.
- Roles, usuarios, permisos server-side, CSRF y origen permitido.
- Revocacion remota y revocacion inmediata por cambio de rol o permisos.
- Auditoria de operaciones funcionales y de seguridad sin contrasenas,
  certificados, claves, cookies, tokens, XML completos ni otros secretos.
- Cabeceras HTTP de seguridad y redireccion de paginas privadas anonimas.
- Saldos a favor de clientes, compensacion de vencimientos y reembolsos con
  segregacion entre solicitud, aprobacion y contabilizacion.

La evidencia detallada y el procedimiento operativo se conservan en
`docs/plataforma/11-despliegue-staging-plesk.md`.

## 3. Estado final del entorno

- Release activa: `staging-2026.07.17-rc5`.
- Web, PostgreSQL, worker y VeriFactu: estado `ok` en la verificacion posterior
  al despliegue.
- Rol `UAT_RESTRICTED`: restaurado con `Billing.View` como unico permiso.
- Cuentas `uat_restricted`, `uat_unlock_rc2` y `uat_session_rc2`: `INACTIVE`.
- Cuenta `uat_credit_approver`: `INACTIVE`; su sesion fue revocada al terminar
  la prueba.
- Sesiones UAT: ninguna activa; solo permanece la sesion administradora usada
  para el cierre.
- Desactivacion final auditada mediante `USER_DEACTIVATED` con identificadores
  tecnicos y sin secretos.

## 4. Validacion de la rama candidata

Antes de integrar la linea de staging en `main` se ejecuto:

```powershell
npm run verify:release
```

Resultado del cierre:

- 56 archivos y 524 pruebas Vitest superadas;
- TypeScript y ESLint completados correctamente;
- Prisma Client generado y build optimizado de Next.js completado;
- `npm audit --audit-level=high`: 0 vulnerabilidades detectadas.

## 5. Riesgos que no bloquean esta aceptacion

- Las copias permanecen en el mismo VPS y falta una copia externa cifrada.
- Falta custodiar fuera del VPS el material completo necesario para una
  recuperacion, incluidos los keyrings historicos.
- No existe monitor externo para detectar la caida total del VPS.
- Los artefactos operativos versionados deben sincronizarse y revalidarse en
  staging cuando vuelvan a cambiar.

Estos riesgos impiden interpretar esta acta como autorizacion de produccion.

## 6. Ciclo financiero completado en staging

El 2026-07-17 se completo desde navegador el ciclo financiero previsto, sin
preparar produccion:

1. vencimientos y registro de cobros;
2. creacion, proceso y generacion SEPA de una remesa de prueba;
3. respuesta bancaria controlada, devolucion y cierre de la remesa;
4. reflejo contable y trazabilidad de asientos;
5. importacion bancaria de prueba, propuesta, conciliacion y deshacer;
6. permisos y auditoria del ciclo sin IBAN completo, ficheros bancarios ni
   secretos en los eventos.

La prueba utilizo exclusivamente datos sinteticos de staging. La factura
`F2600002`, por 121 EUR, recibio un cobro manual parcial de 40 EUR. Los 81 EUR
restantes se incluyeron en la remesa `RC2026/000001`, que recorrio generacion
SEPA, envio, respuesta bancaria, devolucion total y cierre. El resultado final
fue un vencimiento pendiente de 81 EUR y un cobro manual vigente de 40 EUR.

Se importo un extracto Norma 43 sintetico con un movimiento de 40 EUR. La
aplicacion genero una propuesta de conciliacion con la factura, permitio
conciliar el movimiento y deshacer la conciliacion. El estado final del
movimiento quedo pendiente, con 0 EUR conciliados y 40 EUR disponibles.

La auditoria confirmo, entre otros, `BANK_STATEMENT_IMPORTED`,
`BANK_RECONCILIATION_CREATED` y `BANK_RECONCILIATION_UNDONE`. Los payloads
contienen fechas, importes, hashes e identificadores tecnicos, pero no incluyen
el contenido del extracto, IBAN completo, ficheros SEPA, contrasenas,
certificados, claves ni secretos.

Durante la prueba se detecto que los parametros opcionales vacios enviados por
el formulario de vencimientos se validaban como filtros invalidos. La rama
candidata normaliza esos valores a ausencia de filtro y aporta una prueba E2E
de regresion. El ajuste se desplego como `staging-2026.07.17-rc3` despues de
verificar backup, build, unidad migradora sin migraciones pendientes y salud
interna y externa. El smoke final desde navegador cargo la factura `F2600002`
con parametros opcionales vacios sin mostrar el error de filtro invalido.

La candidata corregida supero localmente TypeScript, 56 archivos con 524
pruebas Vitest, ESLint, el build optimizado de Next.js y
`npm audit --audit-level=high` sin vulnerabilidades. Tambien supero la prueba
E2E dirigida al vencimiento impagado con parametros opcionales vacios.

## 7. Limites de la aceptacion

Los datos sinteticos financieros se mantienen en staging como evidencia
trazable del ensayo. La cuenta bancaria de prueba se muestra enmascarada en la
interfaz. Esta ampliacion del acta no autoriza ni prepara produccion.

## 8. Prevision de cobros y saldos a favor

La prevision de cobros se valido con la factura sintetica `F2600002`. Con fecha
de referencia 2026-07-18 muestra un vencimiento por 81 EUR, previsto y
atrasado en julio. La exportacion CSV se ejecuto desde navegador y genero
`CUSTOMER_COLLECTION_FORECAST_EXPORTED` con ejercicio, fecha, limite,
indicadores de filtro, actor y numero de resultados, sin contenido CSV ni datos
bancarios sensibles.

Durante el ensayo se detecto el mismo tratamiento incorrecto de campos vacios
en los filtros opcionales de la prevision. La correccion y su regresion E2E se
desplegaron como `staging-2026.07.17-rc4`; el smoke posterior confirmo la
simulacion sin `Filtro de prevision invalido` y health completo en estado `ok`.

El ciclo de saldos a favor se ejecuto a continuacion tras obtener mediante
AEAT TEST la precondicion fiscal necesaria, como recoge la seccion siguiente.

## 9. Saldos a favor, compensacion y reembolso

La precondicion se obtuvo posteriormente mediante un ciclo fiscal real en AEAT
TEST con datos sinteticos. La factura `F2600003`, por 121 EUR, y su
rectificativa total `R2600001` fueron subsanadas y aceptadas. El credito se
mantuvo retenido mientras la rectificativa no estaba aceptada y paso a
disponible tras la aceptacion fiscal, sin crear ni forzar manualmente el saldo.

Se emitio despues la factura `F2600004`, por 60,50 EUR, aceptada directamente
en AEAT TEST. Se compenso por completo con 60,50 EUR del credito, dejando la
factura saldada sin registrar un cobro bancario. Los 60,50 EUR restantes
recorrieron solicitud, cancelacion de control, nueva solicitud, aprobacion por
un usuario distinto y contabilizacion del reembolso.

La segregacion de funciones se valido con el rol temporal
`UAT_CREDIT_APPROVER`, limitado a ver saldos, aprobar reembolsos y
contabilizarlos. El solicitante no pudo autoaprobar. El aprobador pudo actuar
sobre el reembolso, pero el servidor le denego usuarios, roles, configuracion,
auditoria, credenciales VeriFactu y contabilidad. Al terminar, la cuenta
temporal quedo inactiva y sin sesiones vigentes.

El asiento `2026/000011`, por 60,50 EUR, carga la cuenta de cliente y abona la
cuenta bancaria. La auditoria conserva
`CUSTOMER_CREDIT_APPLIED`, `CUSTOMER_CREDIT_REFUND_REQUESTED`,
`CUSTOMER_CREDIT_REFUND_CANCELLED`, `CUSTOMER_CREDIT_REFUND_APPROVED`,
`CUSTOMER_CREDIT_REFUND_POSTED` y `USER_DEACTIVATED`. Sus payloads contienen
importes e identificadores tecnicos, sin IBAN completo, contrasenas,
certificados, claves, XML ni secretos.

Durante el cierre se detecto que un reembolso ya contabilizado seguia
mostrandose tambien como reservado. La correccion separa la reserva pendiente
del importe reembolsado y mantiene ambos conceptos en el calculo del saldo. Se
anadio una regresion que exige, tras contabilizar, reserva `0.00`, reembolsado
`71.00` y disponible `0.00` en el escenario automatizado. La prueba dirigida
de facturacion supero 21 casos, y TypeScript y ESLint finalizaron sin errores.

La correccion se desplego como `staging-2026.07.17-rc5` tras backup verificado,
build optimizado, migrador sin migraciones pendientes y health local y publico
en estado `ok`. El smoke final desde navegador confirmo para el credito UAT:
121 EUR originales, 60,50 EUR aplicados, 60,50 EUR reembolsados, 0 EUR
reservados y 0 EUR disponibles.

## 10. Regresion complementaria y ensayo de cierre 2026

El 2026-07-20 se completo una regresion local posterior a rc5 sobre la copia de
trabajo que incorpora los ultimos ajustes aun no consolidados como una nueva
release inmutable. `npm run verify:release` supero TypeScript, 56 archivos con
536 pruebas Vitest, ESLint, el build optimizado de Next.js y
`npm audit --audit-level=high` sin vulnerabilidades. La regresion E2E completa
supero tambien sus 12 casos.

Esta evidencia local no se atribuye al commit rc5 desplegado: antes de llevar
esos ajustes a staging deben recibir una identidad de release y commit propios.

En el VPS se valido ademas el procedimiento canonico de restauracion de
staging, que termino con `RESTORE_DRILL_OK`. A continuacion se ejecuto el ciclo
de cierre sobre una copia persistente y aislada del backup automatico
`crigestion_staging-auto-20260720T002559Z.dump`, cuya suma SHA-256 y catalogo de
`pg_restore` se verificaron antes de crear la copia.

La aplicacion temporal uso exclusivamente el artefacto inmutable
`staging-2026.07.17-rc5`, build ID `809M0YDu_pQ1vAZxKMkIl`, y una base llamada
`crigestion_test` con 79 de 79 migraciones terminadas. Escucho solo en
`127.0.0.1:3102`, utilizo usuario, rol, cookie y secretos efimeros, mantuvo
VeriFactu desactivado, no arranco ningun worker y no tuvo permiso de conexion
sobre `crigestion_staging`.

Antes del cierre se comprobo:

- ejercicio 2026 abierto y ausencia del ejercicio 2027;
- 11 asientos contabilizados, con 1.044,16 EUR tanto al debe como al haber;
- ningun descuadre entre cabeceras, lineas, debe y haber;
- 792 cuentas en el ejercicio 2026.

Un usuario restringido sin `Accounting.CloseExercises` recibio
`403 FORBIDDEN`; el servidor genero `ACCESS_DENIED` y mantuvo 2026 abierto sin
crear 2027. El administrador ejecuto despues el cierre con respuesta HTTP 200.
La operacion genero:

| Origen | Asiento | Fecha | Debe | Haber | Lineas |
|---|---|---|---:|---:|---:|
| `REGULARIZATION` | `2026/000012` | 2026-12-31 | 150,00 EUR | 150,00 EUR | 2 |
| `CLOSING` | `2026/000013` | 2026-12-31 | 181,50 EUR | 181,50 EUR | 4 |
| `OPENING` | `2027/000001` | 2027-01-01 | 181,50 EUR | 181,50 EUR | 4 |

El resultado dejo 2026 cerrado y 2027 abierto, con las 792 cuentas copiadas y
enlazadas a su cuenta origen. No hubo descuadres ni diferencias entre las
lineas de cierre y apertura. La auditoria genero un unico
`ACCOUNTING_FISCAL_YEAR_CLOSED` con 2 lineas de regularizacion, 4 de cierre y 4
de apertura. El rol runtime podia insertar auditoria, pero no modificarla ni
borrarla, y no podia consultar `_prisma_migrations`.

Al terminar se detuvo la instancia temporal y se eliminaron la base, el rol,
el usuario de sistema, la unidad, la cache, las cookies y los secretos
efimeros. Tambien se retiro la clave SSH temporal usada para la operacion. La
verificacion final confirmo staging en estado `ok`, incluidos PostgreSQL,
VeriFactu y worker, y su ejercicio principal 2026 permanecio abierto.

Este ensayo no cerro ni modifico el ejercicio de la base principal de staging
y no accedio a produccion. Tampoco constituye una autorizacion de despliegue
productivo.

## 11. Adjuntos seguros y recuperacion integral

El 2026-07-21 se desplego en staging la primera rebanada de adjuntos seguros
mediante la release inmutable `staging-2026.07.21-rc17`, commit
`fa070e7d12287b411a8d6efd09b8caec3f8aac75`. La candidata supero TypeScript,
66 archivos con 596 pruebas Vitest, ESLint, build optimizado de Next.js y
`npm audit --audit-level=high` sin vulnerabilidades.

Durante el smoke del logotipo empresarial, ClamAV fallo inicialmente de forma
segura: no publico el archivo y devolvio `ANTIVIRUS_UNAVAILABLE`. El diagnostico
reprodujo que `clamdscan --fdpass` no podia tratar el descriptor como archivo
regular dentro del espacio de nombres de `ProtectSystem=strict`. La correccion
usa `clamdscan --stream`, mantiene el aislamiento systemd y el comportamiento
fail-closed, y fue revisada de forma independiente antes del despliegue.

El reintento con la misma imagen sintetica termino correctamente. La
verificacion server-side confirmo:

- adjunto `AVAILABLE`, escaneo `CLEAN` y motor `clamdscan`;
- tamano y SHA-256 coherentes entre PostgreSQL y el fichero privado;
- propietario `crigestion-staging`, modo `0600` y cuarentena vacia;
- evento `COMPANY_LOGO_UPLOADED` y rechazos previos auditados sin ruta, hash,
  bytes ni contenido del fichero.

Se genero despues un dump PostgreSQL actualizado para alinear el RPO con la
subida. El paquete cifrado
`crigestion-staging-20260721T171412Z.cgrb` supero su checksum y el simulacro
aislado termino con `RECOVERY_DRILL_OK attachments=1`. Las bases snapshot y de
drill se eliminaron, el health local y publico permanecio en `ok`, VeriFactu
continuo en `TEST` y produccion quedo fuera de alcance.

## 12. Maestro de proveedores y parche de imagenes

El 2026-07-22 se desplego el maestro de proveedores mediante la release
inmutable `staging-2026.07.22-rc2`, commit
`d51a0ca8561a259cf226eeaaff687f8baf429591`, build ID
`3aBnufJCqalWTzYv_HXda`. La migracion
`20260721193000_add_supplier_master` ya aplicada quedo verificada y el
migrador de rc2 termino sin migraciones pendientes.

La candidata supero `npm run verify:release`: TypeScript, 69 archivos con 611
pruebas Vitest, ESLint, build optimizado de Next.js y
`npm audit --audit-level=high` sin vulnerabilidades. La primera rc1 revelo en
el host un aviso nuevo de severidad alta para `sharp 0.34.5`; antes de cerrar
la UAT se preparo rc2 con `sharp 0.35.3`, revisada de forma independiente. En
Ubuntu se comprobo carga nativa con `libvips 8.18.3`, build correcto y
auditoria runtime sin vulnerabilidades.

La UAT tecnica genero exclusivamente datos sinteticos y dejo el proveedor
`PROV00001` inactivo para conservar trazabilidad. Se verifico:

- alta y replay idempotente sin duplicar filas;
- rechazo de un segundo proveedor con el mismo identificador fiscal;
- listado, detalle, edicion y baja logica;
- subcuenta `400000001` vinculada al ejercicio 2026 abierto;
- identificador fiscal e IBAN enmascarados y campos sensibles cifrados en base;
- eventos `SUPPLIER_CREATED`, `SUPPLIERS_VIEWED`, `SUPPLIER_VIEWED`,
  `SUPPLIER_UPDATED` y `SUPPLIER_DEACTIVATED` sin datos sensibles en claro;
- denegacion al rol runtime de lectura de `_prisma_migrations`, ruptura de la
  secuencia protegida y borrado de auditoria.

Tras la UAT se creo y verifico el dump
`crigestion_staging-auto-20260722T080422Z.dump`. El bundle cifrado
`crigestion-staging-20260722T080441Z.cgrb`, de 229.653.125 bytes, supero su
checksum y el simulacro aislado termino con
`RECOVERY_DRILL_OK database=crigestion_recovery_drill_20260722t080610z
attachments=1`. La base temporal fue descartada y no quedaron bases snapshot,
de drill ni de restore.

Al cierre, la release rc2, la aplicacion y el worker estaban activos, y los
health local y publico devolvian `database`, `verifactu` y `worker` en `ok`.
VeriFactu mantuvo entorno `TEST` y ambos permisos de produccion en `false`.
Produccion no se consulto ni se modifico.

## 13. Compras, vencimientos y pagos de proveedor

El 2026-07-22 se desplego la primera rebanada de compras mediante
`staging-2026.07.22-rc3`, commit
`c700751b96a533280129f2d0233cc0b8fd5090f1`. Antes de migrar se creo y
verifico el dump `crigestion_staging-auto-20260722T095606Z.dump`. Las
migraciones `20260722122900_add_supplier_purchase_enum_values` y
`20260722123000_add_supplier_purchases` terminaron correctamente mediante el
rol migrador controlado. La aplicacion y el worker permanecieron detenidos
durante el cambio de esquema.

La UAT uso la factura sintetica `UAT-RC3-20260722-01`, con 30,00 EUR de base,
6,30 EUR de IVA y 36,30 EUR de total. Se verifico:

- registro definitivo y estado final `REGISTERED`;
- asiento de compra `2026/000013`, cuadrado por 36,30 EUR;
- un registro de IVA soportado;
- entrada de 3 unidades, stock final 3 y ultimo coste 10,00 EUR;
- dos vencimientos de 18,15 EUR;
- transicion de pago `PENDING` a `PARTIALLY_PAID` y despues a `PAID`;
- dos pagos y asientos `2026/000014` y `2026/000015`, cuadrados por 18,15 EUR;
- los cinco permisos nuevos asignados al rol `Administrador` y rechazo HTTP
  401 para una consulta de compras sin autenticar;
- eventos de borrador, lineas, vencimientos, registro y dos pagos, sin claves
  de contrasena, token, cookie, IBAN, identificador fiscal ni certificado.

La UAT detecto que la pantalla mostraba `Pendientes` como filtro seleccionado
sin aplicarlo cuando faltaba el parametro de URL. Se corrigio en
`staging-2026.07.22-rc4`, commit
`b05c2d7a7fc30cdc37543195fcf4d1ef95b3bf11`, build ID
`CRYB3BmtMKA4MxrLrlpry`. La candidata supero `npm run verify:release`: 71
archivos con 616 pruebas, TypeScript, ESLint, build optimizado y auditoria npm
sin vulnerabilidades. La comprobacion final mostro cero vencimientos bajo el
filtro pendiente y los dos vencimientos bajo el filtro pagado.

El proveedor y el articulo sinteticos quedaron inactivos. La compra, sus
asientos, IVA, stock, vencimientos, pagos y auditoria se conservaron como
evidencia inmutable de staging. Al cierre, `rc4`, aplicacion y worker estaban
activos, y los health local y publico devolvian `database`, `verifactu` y
`worker` en `ok`. VeriFactu continuo en `TEST`; produccion quedo fuera de
alcance.

## 14. Rectificacion total de compras de proveedor

El 2026-07-22 se desplego la rectificacion total de compras mediante la
release inmutable `staging-2026.07.22-rc5`, commit
`0e630abe4ec6d09bb7693f4cc27a44605c2698fc`, build ID
`1oZdF87paTpJ-jMhgwsPT`. Antes de migrar se creo y verifico el dump
`crigestion_staging-auto-20260722T120105Z.dump`. Las migraciones
`20260722170000_add_purchase_rectification_enum_values` y
`20260722170100_add_purchase_rectifications` terminaron correctamente mediante
el rol migrador controlado, con la aplicacion y el worker detenidos durante el
cambio. El resultado dejo 87 migraciones terminadas y ninguna incompleta.

La candidata habia superado `npm run verify:release`: TypeScript, 71 archivos
con 619 pruebas Vitest, ESLint, build optimizado de Next.js y auditoria npm sin
vulnerabilidades. Tras el despliegue se comprobaron el SHA y build activos,
los privilegios endurecidos del runtime y migrador, los cuatro bloqueos
VeriFactu en `TEST`/`false`, los servicios y los health local y publico.

La UAT uso la compra sintetica `UAT-RC5-20260722-RECT-01`, con 10,00 EUR de
base, 2,10 EUR de IVA y 12,10 EUR de total. Se registro sin pagos y despues se
creo `UAT-RC5-20260722-RECT-01-R` como rectificacion total por devolucion. Se
verifico:

- original `RECTIFIED` y `NOT_APPLICABLE`, y rectificativa `REGISTERED` y
  `NOT_APPLICABLE` por -12,10 EUR;
- una unica rectificativa vinculada al original, sin duplicados;
- lineas e IVA exactamente opuestos a los originales;
- asiento original `2026/000016` y reverso `2026/000017`, con cuentas y debe y
  haber invertidos y enlace `reversesEntryId` correcto;
- entrada de una unidad de stock de 3 a 4 y salida enlazada de -1 unidad de 4
  a 3, dejando el stock final original en 3;
- el unico vencimiento original en `CANCELLED` y ningun vencimiento creado para
  la rectificativa;
- evento `PURCHASE_RECTIFICATION_CREATED` con identificadores tecnicos y
  conteos, sin secretos, credenciales ni datos fiscales en claro;
- permiso `Purchases.Rectify` asignado exclusivamente a `Administrador`;
- rechazo de la mutacion publica con `403 ORIGIN_NOT_ALLOWED` sin origen y
  `401 UNAUTHENTICATED` con origen valido pero sin sesion;
- bloqueo visible de la rectificacion sobre la compra UAT anterior ya pagada.

El proveedor y el articulo sinteticos se devolvieron a estado `INACTIVE`; la
compra, la rectificativa y sus historicos se conservaron como evidencia
inmutable. Despues se creo y verifico el dump
`crigestion_staging-auto-20260722T141138Z.dump`. El paquete cifrado
`crigestion-staging-20260722T141139Z.cgrb` supero su checksum y el simulacro
aislado termino con `RECOVERY_DRILL_OK
database=crigestion_recovery_drill_20260722t141233z attachments=1`. No quedaron
bases temporales.

Al cierre, `rc5`, aplicacion, worker y timers estaban activos, y el health
publico devolvia `database`, `verifactu` y `worker` en `ok`. VeriFactu continuo
en `TEST` con produccion bloqueada. Produccion no se consulto ni se modifico.

## 15. Cierre contable 2026 sobre copia aislada

El 2026-07-23 se desplego `staging-2026.07.23-rc2`, commit
`d156dff4542cdb8259bb6a0edc3b0444f5d59f6d`, build ID
`0T7SS-I9bJtr38rhU4vo5`. La candidata habia superado TypeScript, ESLint, build
optimizado, auditoria npm sin vulnerabilidades y 632 pruebas Vitest en 73
archivos. Una revision independiente no encontro ningun P0/P1 pendiente para
la UAT sobre copia aislada.

Antes del despliegue se creo y verifico el dump
`crigestion_staging-auto-20260723T095638Z.dump`, incluido su checksum y catalogo
`pg_restore`. El migrador controlado termino correctamente con 89 de 89
migraciones aplicadas. Tras el cambio, los health local y publico devolvieron
`database`, `verifactu` y `worker` en `ok`. El ejercicio 2026 de la base
principal de staging permanecio `OPEN` durante todo el ciclo.

El simulacro restauro ese dump en `crigestion_test`, con roles exclusivos,
usuario de sistema dedicado y una unidad transitoria limitada a
`127.0.0.1:3102`. VeriFactu estuvo deshabilitado, no se levanto worker y la
unidad no tuvo salida de red distinta de localhost. Los roles UAT no pudieron
conectarse a `crigestion_staging`.

El primer preflight rechazo correctamente el cierre con `409` porque la
factura sintetica `F2600002` conservaba VeriFactu en `REJECTED`. El diario
tenia 19 asientos, ninguno descuadrado, con 1.214,77 EUR tanto al Debe como al
Haber y sin diferencias entre cabeceras y lineas. Como VeriFactu estaba
deliberadamente deshabilitado en la copia, se simulo la aceptacion fiscal solo
en `crigestion_test` y se registro `UAT_FIXTURE_ADJUSTED`.

El segundo intento y su replay con la misma clave idempotente devolvieron el
mismo JSON y se verifico:

- 2026 `CLOSED` y 2027 `OPEN`, ambos con 793 cuentas;
- regularizacion `2026/000020`, por 151,00 EUR y dos lineas;
- cierre `2026/000021`, por 182,71 EUR y cinco lineas;
- apertura `2027/000001`, por 182,71 EUR y cinco lineas;
- saldos finales cero en grupos 6/7, cuentas patrimoniales y total de 2026;
- cinco correspondencias exactas e invertidas entre cierre y apertura;
- un unico evento de cierre con preflight y los tres identificadores de
  asiento, sin contrasenas, NIF, IBAN, notas ni conceptos;
- rechazo `403 FORBIDDEN` y evento `ACCESS_DENIED` al intentar cerrar con
  `uat_restricted`, que carecia de `Accounting.CloseExercises`.

Al terminar se detuvo y elimino la unidad transitoria, se descarto
`crigestion_test`, se eliminaron ambos roles, el usuario de sistema, el checkout
UAT y todas las credenciales efimeras. No quedaron listeners en 3102 ni
recursos UAT. La release `rc2`, la aplicacion y el worker de staging seguian
activos, el health completo permanecia en `ok` y el ejercicio 2026 principal
seguia `OPEN`. Produccion no se consulto ni se modifico.

La separacion maker-checker y la anulacion formal de un cierre siguen siendo
requisitos previos para habilitar esta operacion en produccion; este resultado
solo aprueba el flujo tecnico sobre copias aisladas y descartables.

## 16. Cierre contable maker-checker sobre copia aislada

El 2026-07-23 se desplego `staging-2026.07.23-rc3`, commit
`e97c5546f3bc9e220e7c2fa9e3d9f7c0b1ad6cca`, build ID
`NtbqHfsbS1aCbV6UB9mX9`. La candidata habia superado
`npm run verify:release`: 73 archivos con 634 pruebas Vitest, TypeScript,
ESLint, build optimizado y auditoria npm sin vulnerabilidades. Una revision
independiente detecto una carencia de evidencia terminal en base de datos; se
corrigio antes de rc3 y la revision posterior no encontro ningun P0/P1.

Antes del despliegue se creo y verifico el dump
`crigestion_staging-auto-20260723T111636Z.dump`, incluido su checksum y catalogo
`pg_restore`. Las migraciones de solicitudes, endurecimiento y evidencia
terminal de cierres terminaron correctamente mediante el rol migrador
controlado, dejando 92 de 92 migraciones aplicadas. Tras el cambio, la
aplicacion y el worker quedaron activos y los health local y publico
devolvieron `database`, `verifactu` y `worker` en `ok`.

La UAT restauro el dump en `crigestion_test` con dos roles PostgreSQL sin
privilegios elevados, un usuario de sistema dedicado y dos unidades
transitorias limitadas a loopback. La build rc3 se sirvio internamente en
`127.0.0.1:3103` y un proxy TLS efimero la expuso solo en
`127.0.0.1:3102`, para conservar las validaciones de origen HTTPS y cookie
segura. No se levanto un worker para la copia.

Se crearon dos identidades exclusivas en la copia:

- `uat_close_maker`, con `Accounting.View` y
  `Accounting.RequestExerciseClosures`;
- `uat_close_checker`, con `Accounting.View` y
  `Accounting.ApproveExerciseClosures`.

El primer preflight rechazo correctamente la solicitud con `409` porque la
factura sintetica `F2600002` conservaba VeriFactu en `REJECTED`. El informe
mostro 19 asientos, cero descuadres o diferencias entre cabeceras y lineas, y
un unico estado VeriFactu sin resolver. La aceptacion se simulo exclusivamente
en `crigestion_test` y quedo registrada como `UAT_FIXTURE_ADJUSTED`. El segundo
preflight quedo `ready=true`, con todos los contadores de bloqueo a cero.

La solicitud `0d573bf5-4ddc-4c53-8852-7f096a7c0486` se creo con HTTP 201. Se
verifico:

- rechazo `403 FORBIDDEN` cuando el checker intento solicitar el cierre;
- rechazo `403 FORBIDDEN` al intentar aprobar sin el permiso correspondiente;
- rechazo `409 FISCAL_YEAR_CLOSE_SELF_APPROVAL_FORBIDDEN` cuando el maker
  recibio temporalmente el permiso de aprobacion e intento aprobar su propia
  solicitud;
- rechazo `409 FISCAL_YEAR_CLOSE_APPROVAL_REQUIRED` del endpoint de cierre
  directo incluso con su permiso historico concedido temporalmente;
- aprobacion HTTP 200 por `uat_close_checker`, con solicitante y aprobador
  distintos, y replay idempotente con cuerpo JSON identico;
- estado final `COMPLETED`, 2026 `CLOSED` y 2027 `OPEN`, ambos con 793 cuentas;
- regularizacion `2026/000020`, por 151,00 EUR y dos lineas;
- cierre `2026/000021`, por 182,71 EUR y cinco lineas;
- apertura `2027/000001`, por 182,71 EUR y cinco lineas;
- importes de cabecera y lineas iguales y Debe igual a Haber en los tres
  asientos automaticos;
- eventos `ACCOUNTING_FISCAL_YEAR_CLOSE_REQUESTED`,
  `ACCOUNTING_FISCAL_YEAR_CLOSE_APPROVAL_DENIED` con motivo `SELF_APPROVAL` y
  `ACCOUNTING_FISCAL_YEAR_CLOSED`, este ultimo con solicitud, ambos actores y
  los tres asientos automaticos;
- denegacion de `UPDATE` sobre auditoria al rol runtime y rechazo por trigger
  al intentar retirar la evidencia terminal de la solicitud completada.

Los permisos temporales usados para las pruebas negativas se retiraron antes
de la comprobacion final. Al terminar se detuvieron y eliminaron ambas unidades,
se descarto `crigestion_test` y se eliminaron los dos roles PostgreSQL, el
usuario de sistema, el proxy TLS, el certificado y todas las credenciales
efimeras. No quedaron listeners en 3102/3103 ni recursos UAT. El backup se
conservo. La base principal de staging mantuvo 2026 `OPEN`, rc3 siguio activa
y el health completo permanecio en `ok`. Produccion no se consulto ni se
modifico.

## 17. Despliegue de la reapertura contable maker-checker

El 2026-07-23 se preparo la reapertura formal de ejercicios sobre el commit
`db1cf6eaf715ee8fdbf72cbf04e610fe40a24ecc`. Antes de promoverlo, la primera
migracion de enums se hizo atomica y se ejecuto un ensayo sobre una copia
aislada del dump verificado
`crigestion_staging-auto-20260723T141434Z.dump`. El ensayo aplico las
migraciones 93 y 94 en 2,2 segundos, sin migraciones incompletas, backfill
pendiente ni asientos automaticos legacy huerfanos. La copia se descarto y la
base principal no se modifico durante el ensayo.

La candidata supero `npm run verify:release`: 73 archivos con 635 pruebas
Vitest, TypeScript, ESLint, build optimizado y auditoria npm sin
vulnerabilidades. La migracion controlada se ejecuto con la aplicacion y el
worker detenidos y dejo 94 de 94 migraciones aplicadas. No se uso un despliegue
rolling ni se intento arrancar rc3 contra el nuevo esquema.

La primera build promovida, `staging-2026.07.23-rc4`, expuso al arrancar un
conflicto de Next.js entre los segmentos dinamicos `[requestId]` y
`[closeRequestId]`. Las migraciones habian finalizado correctamente, pero el
health devolvio HTTP 500. Se detuvo la aplicacion, se mantuvo el worker
compatible y no se revirtio el esquema. El hotfix unifico el segmento sin
cambiar el contrato HTTP y supero build limpio, typecheck, ESLint y las cuatro
pruebas dirigidas de rutas contables.

El estado terminal es `staging-2026.07.23-rc5`, commit
`8c1a51ae06d024df58ce78f9e713b093686fab50`, build ID
`gpxzTaU6pqJSW33NzNLVV`. La aplicacion y el worker estan activos; los health
local y publico devuelven `database`, `verifactu` y `worker` en `ok`. Los dos
permisos nuevos estan asignados a `Administrador`, existen siete triggers de
cierre/reapertura, no hay backfill pendiente, asientos legacy huerfanos ni
bases temporales. El ejercicio 2026 de staging principal permanece `OPEN` y
no se crearon solicitudes de cierre o reapertura. Produccion no se consulto ni
se modifico.

## 18. UAT aislada de cierre y reapertura contable

El 2026-07-23 se genero y verifico el backup
`crigestion_staging-auto-20260723T145041Z.dump`, con 94 migraciones terminadas.
Se restauro en una base efimera `crigestion_reopen_uat_*`, sin listener HTTP ni
worker adicional. La prueba uso la logica real de autenticacion, permisos,
casos de uso, Prisma, transacciones y triggers de la release rc5 con el rol
runtime endurecido.

Se crearon tres identidades exclusivas dentro de la copia:

- maker, con permisos para solicitar cierre y reapertura;
- checker, con permisos para aprobar cierre y reapertura;
- restricted, solo con acceso de lectura contable.

El preflight inicial detecto una factura sintetica con VeriFactu sin resolver.
Se comprobo que el resto de contadores de bloqueo estaba a cero y se ajusto un
unico estado a `ACCEPTED` exclusivamente en la copia, dejando el evento
`UAT_FIXTURE_ADJUSTED`. Despues se verifico:

- tres denegaciones `403` de permisos y tres eventos `ACCESS_DENIED`;
- rechazo de autoaprobacion en el cierre y en la reapertura;
- cierre maker-checker con solicitud
  `1d134e7a-67b5-4fb1-a934-8cc43751c5ec` y replay idempotente identico;
- reapertura maker-checker con solicitud
  `22c8dfee-3657-437e-9863-502955d1dd53` y replay idempotente identico;
- estado final 2026 `OPEN` y 2027 `REVERSED`, enlazado al ejercicio origen;
- tres asientos originales y tres contraasientos `POSTED` con origen
  `FISCAL_YEAR_CLOSE_REVERSAL`, importes Debe/Haber intercambiados y lineas
  exactamente invertidas por cuenta;
- eventos de solicitud, denegacion de autoaprobacion, cierre, solicitud de
  reapertura, denegacion y reapertura, sin contrasenas, tokens, secretos ni
  IBAN;
- denegacion PostgreSQL al intentar modificar auditoria y rechazo de una
  transicion directa no autorizada del ejercicio sucesor.

La base efimera se descarto automaticamente. No quedaron bases UAT, listeners
3102/3103 ni unidades transitorias. La base principal mantuvo 94 migraciones,
2026 `OPEN` y cero solicitudes de cierre o reapertura. La aplicacion rc5 y el
worker siguieron activos, y los health local y publico permanecieron en `ok`.

## 19. Preparacion aislada del ciclo terminal de reapertura

El 2026-07-23 se publico el tag inmutable `staging-2026.07.23-rc6` sobre el
commit `e65657550aa7ff02dee422e73d143f7b9aa527a6`. La candidata incorpora rechazo
maker-checker, caducidad a 168 horas, estados terminales inmutables e historial
relacional de cierres y reaperturas. La validacion completa paso 73 archivos y
635 pruebas Vitest en ejecucion determinista, TypeScript, ESLint, build
optimizado y auditoria npm sin vulnerabilidades.

La release se materializo sin activarla en
`/opt/crigestion-staging/releases/staging-2026.07.23-rc6`, con build ID
`Tz5nxI9_KSjMzr5wi2khl`, propiedad `root:crigestion-staging-release` y permisos
`0750` en la release y el motor Prisma. Se conservaron temporalmente las
dependencias de desarrollo necesarias para el migrador controlado; el prune se
reserva para despues de una eventual migracion de la base principal.

Antes del ensayo se verificaron checksum y catalogo del backup
`crigestion_staging-auto-20260723T145041Z.dump`. El dump, con 94 migraciones, se
restauro en una base efimera `crigestion_reopen_rc6_*`. Las migraciones 95 y 96
se aplicaron en 113 ms y dejaron:

- los estados `REQUESTED`, `COMPLETED`, `CANCELLED`, `REJECTED` y `EXPIRED`;
- las cinco columnas nuevas de caducidad y rechazo;
- cero restricciones sin validar y cero discrepancias en el backfill de 168
  horas;
- el trigger unico de reapertura con controles de checker distinto y
  caducidad no prematura.

La base y el dump temporales se descartaron automaticamente. El enlace
`/opt/crigestion-staging/current` permanecio en `staging-2026.07.23-rc5`, la
base principal mantuvo 94 migraciones y la aplicacion y el worker siguieron
activos con health completo. No se consulto ni modifico produccion.

Tras autorizar la promocion se creo y verifico el backup fresco
`crigestion_staging-auto-20260723T161844Z.dump`. Se detuvieron primero el worker
y la web, y la unidad controlada
`crigestion-staging-migrate@staging-2026.07.23-rc6.service` termino con
`Result=success` y `ExecMainStatus=0`. La base principal quedo con 96 de 96
migraciones, cero migraciones incompletas y todas las restricciones nuevas
validadas; el ejercicio 2026 permanecio `OPEN` y continuaron a cero las
solicitudes de cierre y reapertura.

Despues del prune de dependencias de desarrollo y la normalizacion de permisos,
`current` se cambio a `staging-2026.07.23-rc6`. La web arranco primero con el
estado degradado esperado por worker detenido; tras arrancar el worker, los
health local y publico devolvieron `database`, `verifactu` y `worker` en `ok`.
El rol migrador conserva todos los atributos elevados en `false`; el runtime no
puede leer `_prisma_migrations`, modificar `audit_events` ni obtener `UPDATE`
sobre secuencias. No quedaron bases, dumps ni listeners temporales y el journal
no registro errores durante la ventana. Produccion permanecio fuera de alcance.
Produccion no se consulto ni se modifico.

## 20. UAT aislada de rechazo y caducidad de reapertura en rc6

El 2026-07-23 se verificaron checksum y catalogo del backup
`crigestion_staging-auto-20260723T161844Z.dump`, se restauro en una base
efimera `crigestion_reopen_rc6_*` y se aplicaron las migraciones 95 y 96 de la
release activa. El ejecutor uso el codigo real de rc6, Prisma, transacciones,
triggers PostgreSQL y el rol runtime; no se levanto ningun listener ni worker
adicional.

El preflight detecto una factura sintetica con VeriFactu sin resolver. Se
ajusto un unico estado a `ACCEPTED` exclusivamente en la copia y se registro
`UAT_FIXTURE_ADJUSTED`. A continuacion se comprobo:

- cierre maker-checker de 2026 y apertura de 2027;
- denegacion del autorrechazo por el maker;
- rechazo por un checker distinto y replay idempotente identico;
- inmutabilidad PostgreSQL de la evidencia terminal `REJECTED`;
- creacion de una nueva solicitud tras el rechazo;
- materializacion transaccional de `EXPIRED` al superar las 168 horas;
- denegacion de la aprobacion caducada con
  `FISCAL_YEAR_REOPEN_REQUEST_EXPIRED`;
- eventos unicos de denegacion, rechazo y caducidad `SYSTEM`, sin claves
  sensibles, contrasenas, tokens, secretos ni IBAN;
- denegacion del rol runtime al intentar modificar `audit_events`.

En la copia, el resultado anterior al descarte fue 2026 `CLOSED` y 2027
`OPEN`, sin ejecutar una reapertura. El `trap` elimino la base y el dump
temporales; la verificacion posterior confirmo ausencia de bases UAT, ficheros
y listeners 3102/3103. Staging principal permanecio con 96 migraciones, 2026
`OPEN` y cero solicitudes de cierre o reapertura. El health local mantuvo
`database`, `verifactu` y `worker` en `ok`. Produccion no se consulto ni se
modifico.

## 21. Devoluciones parciales de compras en staging

El 2026-08-08 se desplego la release inmutable
`staging-2026.08.08-rc3`, commit
`7d87c3f875898b398e8546d8094d854dcdf32b56`. El despliegue controlado dejo
133 migraciones terminadas, ninguna incompleta y los health local y publico
con `database`, `verifactu` y `worker` en estado `ok`. VeriFactu permanecio en
AEAT TEST y produccion quedo fuera de alcance.

La UAT desde navegador uso exclusivamente datos sinteticos. Se registro la
compra `UAT-PARTIAL-20260808-01`, con 10 unidades a 10,00 EUR, base de
100,00 EUR, IVA de 21,00 EUR y total de 121,00 EUR. El registro genero el
asiento `2026/000020`, una entrada de 10 unidades de stock y un vencimiento
pendiente por 121,00 EUR.

Se ejecutaron dos devoluciones parciales acumuladas:

| Documento | Unidades | Base | IVA | Total | Asiento |
|---|---:|---:|---:|---:|---|
| `UAT-PARTIAL-20260808-R1` | 4 | -40,00 EUR | -8,40 EUR | -48,40 EUR | `2026/000021` |
| `UAT-PARTIAL-20260808-R2` | 6 | -60,00 EUR | -12,60 EUR | -72,60 EUR | `2026/000022` |

Tras la primera devolucion se verifico que la compra original permanecia
`REGISTERED`, el pago pasaba a `PARTIALLY_SETTLED`, el vencimiento pendiente
quedaba en 72,60 EUR, la linea conservaba 6 unidades rectificables y el stock
quedaba en 6 unidades. Tras la segunda, la compra paso a `RECTIFIED`, el pago
a `SETTLED`, el vencimiento a cero y el stock a cero. La interfaz dejo de
ofrecer nuevas devoluciones parciales al agotarse toda la cantidad original.

El asiento `2026/000022` quedo cuadrado por 72,60 EUR: debe en la cuenta de
proveedor por 72,60 EUR y haber en compra e IVA soportado por 60,00 EUR y
12,60 EUR. Los dos creditos de proveedor se aplicaron completamente al
vencimiento original, sin saldo disponible ni movimiento bancario.

La auditoria genero dos eventos
`PURCHASE_PARTIAL_RECTIFICATION_CREATED`. Cada payload conserva los
identificadores tecnicos, el numero de lineas, un movimiento de stock y una
aplicacion de credito, pero no incluye numero fiscal, descripcion, notas ni
importes. No se observaron existencias negativas.

El articulo sintetico quedo inactivo con stock cero. Tras el smoke de cierre,
el proveedor sintetico `PROV00001` tambien quedo inactivo. La compra, sus dos
rectificativas, asientos, IVA, vencimiento, creditos, movimientos de stock y
auditoria se conservan como evidencia trazable de staging.

Durante la comprobacion de Tesoreria se detecto una regresion no bloqueante:
los filtros `Agotados` y `Todos` de saldos de proveedor enviaban tambien
`search=` y la pagina rechazaba el conjunto como invalido. La correccion
normaliza la busqueda vacia a ausencia de filtro y se aplica asimismo a la
pantalla equivalente de clientes.

El 2026-08-10 se promovio la release inmutable
`staging-2026.08.08-rc4`, commit
`979b08cc76459e643c4fca7a3620714e0b00cf30`, con BUILD_ID
`OJrzl8YQ92OZQf22UlN3c`. El migrador controlado encontro las 133 migraciones
terminadas y ninguna pendiente. Tras la conmutacion atomica, aplicacion,
worker y timers quedaron activos y el health publico devolvio `status`,
`database`, `verifactu` y `worker` en estado `ok`.

El smoke autenticado envio expresamente `search=` vacio y comprobo los filtros
`Agotados` y `Todos` tanto en saldos de proveedor como en saldos de cliente.
Los cuatro casos conservaron el estado seleccionado, mostraron sus resultados
y no presentaron el mensaje de filtros invalidos. La regresion queda cerrada
en staging. El archivo temporal de publicacion se elimino y la clave SSH
temporal se retiro; un intento posterior con esa identidad fue rechazado.

## 22. Reactivacion controlada de suscripciones en staging

El 2026-08-10 se promovio la release inmutable
`staging-2026.08.10-rc1`, commit
`a588f33d0f4cebc900c4a66316d4255900d4d6ec`, con BUILD_ID
`B9Aaq7PhN6ZHdB-pdh8Eb`. Antes del corte se genero y verifico el backup
`crigestion_staging-staging-2026.08.10-rc1-predeploy-20260810T160107Z.dump`,
SHA-256
`bdc4d58e45897f5f5c216f5b2e9fff9ecfcfa19a4f6a84d91fd13619c817bd02`.

Con aplicacion, worker y health timer detenidos se ejecuto una unica unidad
migradora controlada. La migracion
`20260810143000_add_subscription_reactivations` termino correctamente y el
catalogo quedo con 134 migraciones finalizadas y cero fallos activos. Se
comprobaron la tabla append-only, las funciones y triggers de consistencia y
el permiso `Subscriptions.Reactivate` antes de conmutar `current` de forma
atomica.

Tras el arranque, aplicacion, worker y health timer quedaron activos. La
unidad de health emitio `CRIGESTION_STAGING_HEALTH_OK` y la sonda publica
de cierre devolvio HTTP 200 con `status`, `database`, `verifactu` y `worker`
en estado `ok`. No aparecieron warnings en los journals desde la conmutacion
ni errores o warnings en la consola del navegador durante la UAT.

La prueba funcional uso exclusivamente datos sinteticos:

- servicio `Servicio UAT reactivacion RC1`, codigo interno `2`, por 10,00 EUR
  sin IVA;
- suscripcion `SUS-2026-00001`, UUID
  `f8c0cd7a-e70d-4006-9d4e-03e7506c76e2`, asociada al cliente de pruebas
  `CLIENTE PRUEBAS AEAT TEST`;
- motivo de baja y reactivacion `UAT reactivacion controlada RC1`.

Desde la interfaz se completo el ciclo
`DRAFT -> ACTIVE -> CANCELLED -> ACTIVE`. La baja inmediata quedo fechada el
2026-08-10 y conservada como evidencia. La reactivacion fijo la proxima
renovacion en 2026-08-11 y mostro en el historial la fecha efectiva, la fecha
anterior, el motivo y la baja previa. Una recarga completa confirmo la
persistencia del estado `ACTIVE`, la nueva fecha y el historial. El producto
auxiliar de compras usado durante la preparacion se devolvio a su estado
inactivo original; el servicio y la suscripcion permanecen identificados como
fixtures trazables de staging.

La suite previa a la publicacion completo 708 pruebas Vitest y 13 pruebas E2E,
ademas de typecheck, lint, build, smoke local y auditoria npm sin
vulnerabilidades. Esa suite cubre tenant isolation, RBAC, CSRF, idempotencia,
concurrencia, rate limiting y auditoria sin motivo ni claves sensibles. La UAT
de navegador no leyo directamente la tabla de auditoria.

Al terminar se retiro exclusivamente la clave SSH temporal con huella
`SHA256:pZR19luvoeYMqpXzlqbqmTXcESc+bye75Cv6ap3vdj0`; una conexion nueva con
esa identidad fue rechazada. Produccion no se modifico. El archivo de
publicacion sin secretos conservado en `incoming` puede eliminarse en la
proxima ventana operativa autorizada; no afecta a la release activa.

## 23. Reactivacion programada supervisada en staging

El 2026-08-10 se promovio la release inmutable
`staging-2026.08.10-rc2`, commit
`be74a54451714f9110e6f8c49c13099878ccab7c`, con BUILD_ID
`TaxBypqZfvbjjXynfOVRL`. El artefacto publicado se verifico con SHA-256
`61636554641e1bdaf7567a7e23f4f38bf8ce75f5b448d19484e90024c12a1d7d`.

Antes del corte se genero y valido con `pg_restore --list` el backup
`crigestion_staging-auto-20260810T192641Z.dump`. Se conservo la copia ligada a
la release
`crigestion_staging-pre-staging-2026.08.10-rc2-20260810T192641Z.dump`, con
SHA-256
`de56f491a8f8cacfc35443078efd0b1272dc07526588384711c430949b549cca`.
Aplicacion, worker y health timer se detuvieron antes de migrar y no quedaron
sesiones de aplicacion abiertas contra PostgreSQL.

La unidad migradora controlada aplico
`20260810150000_add_subscription_reactivation_schedules`. El catalogo quedo
con 135 migraciones finalizadas y cero fallos activos. Se comprobaron la tabla,
los nueve indices validos, los triggers habilitados, el permiso
`Subscriptions.ScheduleReactivations` y el endurecimiento de los roles runtime
y migrador. La migracion tambien se habia validado previamente desde cero en
PostgreSQL 14 y PostgreSQL 16.

Hubo dos incidencias operativas antes del arranque, ambas sin impacto en datos:

- el primer intento de la unidad migradora no alcanzo Prisma porque `npm ci`
  habia recreado `node_modules` sin lectura para el grupo de release; se
  confirmo que no existia fila ni objeto parcial y se normalizo la propiedad;
- el primer arranque web no podia leer `.next/BUILD_ID` por el mismo patron de
  permisos; se normalizo toda la release a `root:crigestion-staging-release`
  con lectura y ejecucion para el grupo y sin acceso para otros usuarios.

La segunda ejecucion migradora termino con `Result=success` y
`ExecMainStatus=0`. Tras la conmutacion atomica, aplicacion, worker y health
timer quedaron activos. Los health local y publico devolvieron HTTP 200 con
`status`, `database`, `verifactu` y `worker` en `ok`; el journal no registro
errores durante la UAT.

La UAT de navegador uso la suscripcion sintetica `SUS-2026-00001`, UUID
`f8c0cd7a-e70d-4006-9d4e-03e7506c76e2`. Se completo este ciclo:

1. baja inmediata de la suscripcion activa;
2. programacion de reactivacion para el 2026-08-11, manteniendo el estado
   `CANCELLED`;
3. comprobacion de que la orden pendiente ocultaba y bloqueaba la reactivacion
   inmediata;
4. retirada supervisada de la programacion, conservandola como `REVOKED`;
5. reactivacion inmediata para devolver el fixture a `ACTIVE`, con proxima
   renovacion el 2026-08-11.

La lectura posterior en PostgreSQL confirmo una unica orden `REVOKED`, version
2, y la suscripcion `ACTIVE`, version 8. Los eventos
`SUBSCRIPTION_REACTIVATION_SCHEDULED`,
`SUBSCRIPTION_REACTIVATION_SCHEDULE_REVOKED` y
`SUBSCRIPTION_REACTIVATED` quedaron registrados; sus payloads no contenian las
claves `reason`, `idempotencyKey`, `token` ni `secret`. Una ultima sonda publica
mantuvo todos los componentes en `ok`. No se consulto ni modifico produccion.

El rollback exclusivamente de aplicacion a rc1 deja de considerarse seguro
despues de crear una orden programada. A partir de esta UAT, cualquier
incidencia requiere forward-fix, retirada mediante rc2 o restauracion del
backup aprobado; no basta con cambiar el symlink al binario anterior.

## 24. Reactivacion programada automatica en staging

El 2026-08-11 se promovio la release inmutable
`staging-2026.08.11-rc2`, commit
`c3f89c512406212f95e88dfe3fd4ebfe998e76d7`. El corte incorpora el worker
one-shot de reactivaciones, su timer de cinco minutos y la migracion
`20260811113000_add_subscription_reactivation_automation`. El catalogo quedo
con 136 migraciones finalizadas. Aplicacion, worker VeriFactu, timer de
reactivaciones y timers de backup, health y recovery quedaron activos. Los
health local y publico devolvieron estado `ok`; una ejecucion manual del worker
termino con `SUBSCRIPTION_REACTIVATION_AUTOMATION_OK applied=0 blocked=0
skipped=0`. Tambien se completo el simulacro de recovery bundle y restore.

La UAT funcional se divide en dos dias para no falsear el reloj de negocio ni
deshabilitar triggers en staging. El dia 1 uso exclusivamente la suscripcion
sintetica `SUS-2026-00001`, UUID
`f8c0cd7a-e70d-4006-9d4e-03e7506c76e2`, y completo desde la interfaz:

1. comprobacion del estado inicial `ACTIVE` y de los historiales anteriores;
2. baja inmediata con motivo UAT identificado, quedando `CANCELLED` con fecha
   efectiva 2026-08-11;
3. programacion de una reactivacion para el 2026-08-12, con proxima renovacion
   tambien el 2026-08-12;
4. comprobacion de una unica orden `Pendiente de aplicacion` y de que la UI
   oculta tanto una segunda programacion como la reactivacion inmediata.

El fixture queda intencionadamente `CANCELLED` y la orden `PENDING` al cerrar
el dia 1. El dia 2 debe confirmar, despues de una ejecucion ordinaria del
timer, que la suscripcion pasa a `ACTIVE`, la orden pasa a `APPLIED`, se crea
una unica evidencia de reactivacion y las ejecuciones posteriores no duplican
historial, auditoria ni version. Hasta completar esas comprobaciones, esta UAT
permanece abierta y no acredita todavia la aplicacion automatica end-to-end.

El 2026-08-12 se completo el dia 2 sin alterar el reloj ni ejecutar una
reactivacion manual. El timer aplico la orden a las 00:04:29 CEST y dejo la
suscripcion `ACTIVE`, proxima renovacion 2026-08-12 y version 11. La orden quedo
`APPLIED`, version 2, con `appliedAgainstVersion=10` y
`appliedSubscriptionVersion=11`. PostgreSQL confirmo exactamente una evidencia
de reactivacion, un intento automatico `APPLIED`, cero intentos bloqueados y un
evento `SUBSCRIPTION_REACTIVATION_SCHEDULE_APPLIED` de actor `SYSTEM`, sin las
claves `reason`, `idempotencyKey`, `token`, `secret` ni `iban`.

Durante la comprobacion se contabilizaron 101 ejecuciones correctas del worker
en el dia: una con `applied=1` y cien posteriores con `applied=0`; no hubo
eventos `FAILED`, ordenes vencidas pendientes ni cambios posteriores en la
version o en `updatedAt`. El timer permanecio habilitado y activo, y la ultima
unidad one-shot termino con `Result=success` y `ExecMainStatus=0`. La UI mostro
una sola orden aplicada y una sola reactivacion asociada, sin alertas ni errores
de consola. Los health local y publico mantuvieron `database`, `verifactu` y
`worker` en `ok`. La UAT automatica end-to-end queda cerrada y aceptada.

Como refuerzo de regresion se anadio una prueba aislada del clasificador de
conflictos del worker. Cubre `P2010` con SQLSTATE `40001`, agotamiento tras tres
`P2034` y ausencia de reintento para errores ajenos. TypeScript, ESLint dirigido,
la prueba de despliegue del worker y las tres pruebas de reintento finalizaron
correctamente.

## 25. Fusión segura de incidencias en staging

El 2026-08-12 se promovio la release inmutable
`staging-2026.08.12-rc1`, commit
`bb95ab194eb4be036c986a502f5de2a91fde5dab`. Antes de la ventana se materializo
y compilo la release en un directorio aislado. El backup automatico
`crigestion_staging-auto-20260812T072734Z.dump` supero checksum y catalogo de
`pg_restore`; se conservo como
`crigestion_staging-pre-staging-2026.08.12-rc1-20260812T072734Z.dump`.

Con web, worker VeriFactu y timer de reactivaciones detenidos, el migrador
controlado aplico las 14 migraciones pendientes de Atencion al cliente hasta
alcanzar 150 migraciones. La unidad
`crigestion-staging-migrate@staging-2026.08.12-rc1.service` termino con
`Result=success` y `ExecMainStatus=0`. Tras la conmutacion atomica quedaron
activos aplicacion, worker VeriFactu TEST, timer de reactivaciones y timers de
health y backup. La unidad de health y la ultima ejecucion del worker de
reactivaciones terminaron correctamente; health local y publico devolvieron
`status=ok`, `database=ok`, `verifactu=ok` y `worker=ok`.

Este corte despliega el contrato, persistencia, RBAC, CSRF, idempotencia,
auditoria, bloqueo bilateral, consistencia diferida y UI de la fusión.

La UAT funcional separada se completo el mismo 2026-08-12 con las incidencias
sinteticas `INC-2026-00001` (principal, UUID
`0d32b335-7ad3-47b9-9ef1-e4df7629f437`) e `INC-2026-00002` (duplicada, UUID
`f605e132-1852-4308-8c2f-4eb6187f2f3b`), ambas del mismo cliente y responsable.
Antes de fusionar se registraron en la duplicada una actuacion, una comunicacion
telefonica sintetica y un adjunto PDF analizado correctamente. La interfaz
rechazo previamente un PDF malformado sin persistirlo. Despues cerro la
duplicada con motivo `DUPLICATE`, retiro todos sus formularios de
mutacion y mantuvo el enlace a la principal. El detalle principal mostro los
tres contenidos agregados con procedencia `INC-2026-00002` y mantuvo tambien el
enlace al registro secundario.

PostgreSQL confirmo una unica relacion de fusion, exactamente dos eventos
`INCIDENT_MERGED` con roles `PRIMARY` y `DUPLICATE`, una auditoria y una
notificacion deduplicada porque ambos responsables eran el mismo usuario. Las
versiones avanzaron de 1 a 2 en la principal y de 2 a 3 en la duplicada; esta
ultima quedo `CLOSED`, enlazada a la principal, mientras actuacion,
comunicacion y adjunto conservaron fisicamente su incidencia de origen. Se
comprobaron tambien las barreras SQL: PostgreSQL rechazo modificar la evidencia
append-only, alterar la incidencia fusionada y crear una nueva comunicacion
enlazada a ella.

Al cerrar la UAT, aplicacion, worker VeriFactu TEST y timers de reactivacion,
health y backup seguian activos. Las ultimas ejecuciones one-shot de health y
reactivacion terminaron con `Result=success` y `ExecMainStatus=0`; health local
y publico conservaron todos los componentes en `ok`. La UAT funcional queda
cerrada satisfactoriamente. No se consulto ni modifico produccion y se conserva
el acceso SSH temporal conforme a la indicacion operativa vigente.

## 26. Indicadores operativos de Atención al cliente en staging

El 2026-08-12 se promovió la release inmutable
`staging-2026.08.12-rc2`, commit
`c3dd44e3effdef9e3fa4fba14e9b0d7c3420b883`. El candidato se instaló y compiló
en su directorio aislado antes de cambiar el enlace activo. El backup automático
`crigestion_staging-auto-20260812T104444Z.dump` superó checksum y catálogo de
`pg_restore`; se conservó como
`crigestion_staging-pre-staging-2026.08.12-rc2-20260812T104444Z.dump`, tamaño
1.459.867 bytes y SHA-256
`70bcaf56cdbc6226fdd19582dd10c7b75807f8c98efb00cb48a4b3a687762828`.

Los dos primeros arranques del migrador no llegaron a Prisma Migrate ni
alteraron la base: la normalización de permisos había retirado ejecución a
`esbuild` y a los motores Prisma. Tras restaurar únicamente esos permisos desde
el patrón de la release anterior, la unidad controlada aplicó
`20260812040000_add_support_indicator_permissions`, alcanzó 151 migraciones y
terminó con `Result=success` y `ExecMainStatus=0`. Solo entonces se conmutó
atómicamente `/opt/crigestion-staging/current` a `rc2`.

La UAT autenticada comprobó los indicadores propios, el alcance global y el
filtro por el técnico Alberto. La foto actual mostró una incidencia canónica
abierta en estado nueva y prioridad media, sin reintroducir la incidencia
duplicada fusionada. Las tablas de carga y desglose global conservaron la misma
cuenta y los periodos sin muestras se presentaron como tales, no como duración
cero. La interfaz identificó explícitamente `ENTORNO STAGING`, base
`crigestion_staging` y `AEAT TEST`.

Tras la promoción quedaron activos aplicación, worker VeriFactu, timer de
reactivaciones y timers de health y backup. Los health local y público
devolvieron `status=ok`, `database=ok`, `verifactu=ok` y `worker=ok`. El timer de
recuperación permaneció inactivo, igual que antes de esta release y sin formar
parte de la ventana. No se modificó producción y el acceso SSH temporal se
mantiene conforme a la indicación operativa vigente.

## 27. Panel operativo de Atención al cliente en staging

El 2026-08-12 se promovió la release inmutable
`staging-2026.08.12-rc3`, commit
`825cfc7b48a90f7bc1095c6cc02315a14d4d5567`. El artefacto se compiló en un
directorio aislado y el migrador controlado confirmó las 151 migraciones sin
pendientes, con `Result=success` y `ExecMainStatus=0`. Antes de la ventana se
creó y verificó por checksum y catálogo de `pg_restore` el dump
`crigestion_staging-pre-staging-2026.08.12-rc3-20260812T114705Z.dump`, tamaño
1.460.428 bytes y SHA-256
`9253f51db07fb2b836db5bbe7e5ebc5f8f56b4f4c035371ca4554845c0efb6ad`.

Tras la conmutación quedaron activos aplicación, worker VeriFactu, timer de
reactivaciones y timers de health y backup. VeriFactu permaneció en `TEST`; la
unidad one-shot de health terminó con `Result=success` y
`ExecMainStatus=0`, y los health local y público devolvieron todos los
componentes en `ok`. El nuevo endpoint respondió `401 UNAUTHENTICATED` sin
sesión, conforme al contrato.

La UAT visual autenticada del nuevo panel no se da todavía por cerrada: la
sesión disponible había expirado y la navegación redirigió correctamente a
`/login`. No se consultaron ni reutilizaron credenciales. Queda pendiente
comprobar con una sesión autorizada los contadores, carga por técnico, últimas
comunicaciones, avisos y enlaces del panel. No se modificó producción y se
mantiene el acceso SSH temporal.

## 28. Filtros avanzados de Atención al cliente en staging

El 2026-08-20 se promovió la release inmutable
`staging-2026.08.20-rc2`, commit
`d8488eab4c9498c00d8908c1a9b7e85a52e76b47`, con build ID
`ypgGmr40TfTtTzQCfVxxQ`. Antes de la ventana se creó y verificó por SHA-256 el
dump `crigestion_staging-auto-20260820T090708Z.dump`, de 1.463.188 bytes.

El primer arranque del migrador no llegó a Prisma Migrate ni alteró
PostgreSQL: una normalización prematura había retirado ejecución al binario de
`esbuild`. Se restauró `node_modules` exclusivamente desde `package-lock.json`,
se preservaron los ejecutables y la misma unidad controlada aplicó
`20260820010000_add_support_list_filter_indexes`. PostgreSQL confirmó la
extensión `pg_trgm`, los tres índices trigram, los cinco índices compuestos y
la migración en estado aplicado. Solo entonces se conmutó atómicamente
`/opt/crigestion-staging/current` a `rc2`.

La UAT autenticada verificó que la combinación cliente, responsable, categoría,
estado, prioridad y rango de creación devolvía únicamente la incidencia
principal esperada. La búsqueda por `DUPLICADA` devolvió solo la secundaria.
En comunicaciones, cliente, canal, dirección, resultado y rango de ocurrencia
devolvieron el único registro esperado. La UI expuso los nuevos controles con
labels y mantuvo el banner `ENTORNO STAGING`, base `crigestion_staging` y
`AEAT TEST`.

Tras la promoción, aplicación, worker VeriFactu, timer de reactivaciones y
timer de health quedaron activos. Health local y público devolvieron
`status=ok`, `database=ok`, `verifactu=ok` y `worker=ok`. La primera ejecución
programada de reactivación posterior al despliegue terminó con
`SUBSCRIPTION_REACTIVATION_AUTOMATION_OK`, sin aplicaciones, bloqueos ni
omisiones. Producción no se consultó ni modificó y el acceso SSH temporal se
mantiene conforme a la indicación operativa vigente.

## 29. Búsqueda de incidencias por actuaciones y hotfix de filtros

El 2026-08-20 se desplegó primero `staging-2026.08.20-rc3`, commit
`92e08be9e49166b070330b7f44c852c1caa8386f`, build ID
`GDuqrY9XKiCGwD8mu7aaK`. El dump predeploy
`crigestion_staging-auto-20260820T094947Z.dump`, de 1.468.017 bytes, superó
checksum y catálogo de `pg_restore`. La unidad migradora aplicó únicamente
`20260820020000_add_support_action_search_index` en 2.474 ms; PostgreSQL confirmó
153 migraciones y el nuevo índice GIN válido. El health posterior quedó
íntegramente en `ok`.

La UAT autenticada inicial descubrió un `RangeError` antes de ejecutar la
búsqueda: el formulario enviaba los selectores y fechas no elegidos como cadenas
vacías. La incidencia quedó limitada a presentación y no produjo escrituras. Se
añadió validación de fecha sin excepciones y compactación allowlist de controles
HTML, manteniendo el rechazo de parámetros desconocidos o repetidos. Las 65
pruebas de Soporte, typecheck, lint y build pasaron antes de publicar el hotfix.

La release final es `staging-2026.08.20-rc4`, commit
`2802a62746463c62af6208e15cca084c511d740b`, build ID
`HBkVfrR-0WDoYinMVz2sY`. El artefacto tiene 1.479.728 bytes y SHA-256
`E858E074C6065E2C6A34C2A531C207A3FBF2D808D9F40D438F0A00884CB17B57`.
Fue una promoción solo de código: no alteró el esquema y reutilizó el backup
predeploy verificado de la misma ventana.

La repetición autenticada introdujo `Actuación sintética previa` y pulsó
`Filtrar` con el resto de controles vacíos. El listado devolvió solo
`INC-2026-00002`, confirmando la semántica de registro físico de la actuación y
sin promover el resultado a la incidencia principal fusionada. El formulario de
comunicaciones también se envió con filtros vacíos y conservó su único registro
sin error. La UI mostró el placeholder actualizado, `ENTORNO STAGING`, base
`crigestion_staging` y `AEAT TEST`.

Tras la conmutación atómica, health local y público respondieron HTTP 200 con
`status`, `database`, `verifactu` y `worker` en `ok`. Aplicación, worker
VeriFactu TEST, timer de reactivaciones y timer de health quedaron activos; los
dos servicios one-shot conservan `Result=success` y `ExecMainStatus=0`.
Producción no se consultó ni modificó. El acceso SSH temporal se mantiene por
indicación expresa del usuario.

## 30. Corrección versionada de actuaciones

El 2026-08-20 se promovió la release inmutable
`staging-2026.08.20-rc6`, commit
`c19a3b7bb952f55b9899fb050af534bf65624591`, con build ID
`TWmNWxY0XgilYh4e9IDC9`. La candidata había aplicado desde cero las 155
migraciones en la base desechable, superado 74/74 pruebas de Soporte,
TypeScript, ESLint y el build optimizado, y cerrado dos revisiones
independientes sin P0/P1. La auditoría npm mantuvo las cuatro vulnerabilidades
altas transitivas ya conocidas de `deepmerge-ts`/Prisma y `nanoid`; no se
alteraron dependencias en esta rebanada.

Antes de la ventana se generó el dump
`crigestion_staging-auto-20260820T113145Z.dump`, de 1.498.164 bytes y SHA-256
`a61743089abdc5dc1d4c501906cc43acbf12374f710356c44ab72a20ed18806a`. El
checksum y el catálogo `pg_restore` fueron válidos. La unidad controlada aplicó
solo `20260820040000_add_support_action_corrections`, terminó con
`Result=success` y dejó 155 migraciones completas y cero incompletas activas.
Después de normalizar el artefacto se conmutó atómicamente `current` a `rc6`.

El permiso `Support.CorrectActions` quedó asignado por migración al
Administrador. Para la UAT se añadió también al rol exclusivo de staging
`TECNICO_SOPORTE`, registrando el evento opaco
`STAGING_UAT_ROLE_PERMISSION_GRANTED`. Con su sesión ya iniciada, el técnico
registró en `INC-2026-00003` la actuación sintética
`UAT-ACTION-CORRECTION-RC6 texto original sintético.` y la corrigió a
`UAT-ACTION-CORRECTION-RC6 texto corregido y vigente.` con confirmación y motivo
explícitos.

La ficha mostró versión lógica 2, el historial OLD→NEW, actor, fecha, motivo y
el evento `Actuación corregida`. PostgreSQL confirmó la incidencia en versión
4, exactamente una fila append-only en
`support_incident_action_corrections`, un evento `ACTION_CORRECTED` y una
auditoría `SUPPORT_INCIDENT_ACTION_CORRECTED`; evidencia, evento y proyección
comparten versiones coherentes. La auditoría no contiene texto anterior,
texto corregido ni motivo. El listado encontró la incidencia al buscar el
texto vigente y devolvió vacío al buscar el texto superado.

Aplicación, worker VeriFactu y timers de reactivación, health, backup y bundle
de recuperación quedaron activos. VeriFactu continuó en `TEST: idle`, el
one-shot de reactivación terminó con cero cambios, no quedaron unidades
fallidas y los health local y público respondieron HTTP 200 con todos los
componentes en `ok`. Producción no se consultó ni modificó y el acceso SSH
temporal permanece activo.

## 31. Cambio administrativo de cliente de incidencias

El 2026-08-20 se promovió la release inmutable
`staging-2026.08.20-rc8`, commit
`c6590fd5e15e7dc155bda1d401bf5c6076968502`, con build ID
`_Z4bsvZCigAT8knQkuZlW`. La candidata había aplicado desde cero las 157
migraciones, superado 59/59 pruebas dirigidas de Soporte, TypeScript, ESLint,
Prisma y el build optimizado, y cerrado dos revisiones independientes sin
P0/P1. La auditoría npm mantuvo cuatro vulnerabilidades altas transitivas ya
conocidas de `deepmerge-ts`/Prisma y `nanoid`; esta rebanada no modificó
dependencias.

El dump predeploy
`crigestion_staging-auto-20260820T131052Z.dump` quedó verificado por SHA-256 y
`pg_restore --list`. La unidad migradora aplicó únicamente
`20260820060000_add_support_incident_customer_changes`, terminó con
`Result=success` y dejó 157 migraciones finalizadas. La conmutación de
`current` a `rc8` fue atómica.

Con la sesión Administrador iniciada, se utilizó la incidencia sintética
`INC-2026-00003` (`bd490c41-d61a-4886-8ba8-b77228f4c39c`), sin tienda y sin
participación en fusiones. La interfaz cambió su cliente desde el código 3 al
cliente de pruebas con código 2 y confirmó la operación. La ficha mostró el
nuevo cliente, la evidencia OLD→NEW y el evento `Cliente corregido` en el
historial.

PostgreSQL confirmó que la incidencia terminó en versión 5, con exactamente
una evidencia en `support_incident_customer_changes`, un evento
`CUSTOMER_CHANGED` y una auditoría
`SUPPORT_INCIDENT_CUSTOMER_CHANGED`. El payload de auditoría no contiene
motivo, título ni descripción. El permiso nuevo quedó asignado solo al rol
Administrador. La FK de comunicaciones dejó de incluir `customerId`, pasó a
referenciar incidencia y empresa con `ON UPDATE RESTRICT`, y el trigger exige
el cliente vigente en enlaces nuevos o modificados; las comunicaciones ya
existentes conservan así su cliente histórico.

Aplicación y worker VeriFactu TEST quedaron activos; los timers operativos
permanecieron activos, no hubo unidades fallidas y el health público devolvió
todos los componentes en `ok`. Producción no se consultó ni modificó. El acceso
SSH temporal continúa activo por indicación expresa del usuario.

## 32. Historial de correcciones de comunicaciones

El 2026-08-20 se promovió la release inmutable
`staging-2026.08.20-rc9`, commit
`7c60f148dd20f1054182f0094dff4add2e0b7206`, con build ID
`4MyWWii4rPPVYcap2g2U5`. La candidata superó 61/61 pruebas dirigidas de
Soporte, TypeScript, ESLint, Prisma y el build optimizado, y cerró dos
revisiones independientes sin P0/P1 ni P2 bloqueante. La auditoría npm mantuvo
las cuatro vulnerabilidades altas transitivas ya conocidas de
`deepmerge-ts`/Prisma y `nanoid`; no hubo cambios de dependencias.

El dump predeploy
`crigestion_staging-auto-20260820T203738Z.dump` quedó verificado por SHA-256 y
`pg_restore --list`. No existían migraciones nuevas. La conmutación de
`current` desde `rc8` a `rc9` fue atómica y dejó aplicación, worker VeriFactu
TEST y timers operativos activos, sin unidades fallidas. El health canónico
terminó con `Result=success` y el público respondió HTTP 200 con todos los
componentes en `ok`.

La UAT autenticada del historial queda abierta: al reclamar la pestaña del
navegador incrustado, la aplicación mostró el formulario de login. No se usaron
credenciales ni se crearon o corrigieron datos durante el smoke. Producción no
se consultó ni modificó y el acceso SSH temporal permanece activo.

## 33. Cierre UAT del historial de correcciones de comunicaciones

Tras iniciar sesión como Administrador, la primera inspección de `rc9` detectó
que la comunicación `d30bbe43-81b2-4854-a432-977cd0afc434` conservaba
`INC-2026-00002`, pero el formulario no incluía esa opción porque la incidencia
había cambiado administrativamente de cliente. No se envió el formulario ni se
alteraron datos. El defecto se corrigió en la release inmutable
`staging-2026.08.21-rc10`, commit
`4f801521e1fb034caa3a554171d1f7784a5056cc`, build ID
`AWXlSVvkEJMQjZWYJzuJG`, después de TypeScript, ESLint, build, prueba dirigida y
dos revisiones independientes sin bloqueos.

La interfaz mostró `INC-2026-00002 · ... · vínculo histórico` seleccionada. Se
modificó únicamente el resumen y se registró el motivo de UAT. El detalle pasó
a versión 2, conservó el enlace, mostró la corrección con versión, autor, fecha,
motivo y la diferencia OLD→NEW del único campo cambiado. PostgreSQL confirmó
una evidencia `support_communication_corrections` de versión 2 y una auditoría
`SUPPORT_COMMUNICATION_CORRECTED`; el payload no contenía resumen, motivo ni
teléfono.

La aplicación, PostgreSQL, VeriFactu TEST y worker permanecieron en `ok`, el
health canónico terminó con `Result=success` y no hubo unidades fallidas.
Producción no se consultó ni modificó. El acceso SSH temporal continúa activo
por indicación expresa del usuario.

## 34. Marcado múltiple y atómico de notificaciones

El 2026-08-21 se promovió la release inmutable
`staging-2026.08.21-rc11`, commit
`adb54ff5fee6125a9dd91ef063bcc1cd0aab6e6b`, con build ID
`ifRQdqThGs5NVkA7ZT7oj`. La candidata superó 64/64 pruebas dirigidas de
aplicación y contrato, typecheck, ESLint, validación Prisma y build optimizado,
y cerró dos revisiones independientes sin P0/P1. La auditoría npm conservó
cuatro vulnerabilidades altas transitivas ya conocidas de
`deepmerge-ts`/Prisma y `nanoid`; no se modificaron dependencias.

Con una sesión Administrador se abrió el filtro de notificaciones sin leer. La
página mostraba tres elementos. Se usó «Seleccionar las 3 disponibles en esta
página» y después «Marcar como leídas». La operación se aplicó completa: el
contador pasó de tres a cero, el filtro sin leer quedó vacío y el filtro de
leídas mostró los tres elementos con estado `Leída`. No se archivó ninguna
notificación.

PostgreSQL confirmó exactamente tres filas nuevas en
`notification_state_changes`, todas con el mismo `occurredAt` y destino
`READ`. También confirmó una única auditoría
`NOTIFICATION_BULK_STATE_CHANGED`, con `affectedCount: 3`, destino `READ` y un
fingerprint de selección; el payload no contiene IDs de las notificaciones ni
mensajes. La aplicación, PostgreSQL, VeriFactu TEST y worker respondieron en
`ok`; los timers operativos permanecieron programados y no hubo unidades
fallidas. Producción no se consultó ni modificó. El acceso SSH temporal
continúa activo por indicación expresa del usuario.

## 35. Retención automática de notificaciones

El 2026-08-21 se aplicó en staging la migración
`20260821010000_add_notification_retention_purge` después del backup verificado
`crigestion_staging-auto-20260821T084003Z.dump` (SHA-256
`ba0a83ccefed34084eefa352eeabeae9d81c507fd2fbe6869a19c472e3af28fb`).
La release final fue `staging-2026.08.21-rc13`, commit
`cfb5add4a730788bfc7ecbc206952b130036890f`, build ID
`ssuEobydaIbb9yz44LZHr`.

La inspección con el rol runtime confirmó que no tiene `DELETE` sobre
`notifications` ni `notification_state_changes`, que sí puede ejecutar
`purge_expired_notifications(integer,integer,text)` y que la función es
`SECURITY DEFINER`, propiedad del migrador, con `search_path` fijo y UTC. La
ejecución manual terminó con `NOTIFICATION_PURGE_AUTOMATION_OK` y conteos cero,
coherentes con la ausencia de notificaciones que hubieran cumplido vencimiento
y un año calendario completo. No se generó contenido sensible en logs.

Durante la primera comprobación se detectó que el timestamp de proceso del
`oneshot` no persistía en la versión de systemd instalada. El candidato no se
aceptó con health fallido; `rc13` incorporó un sello persistente de éxito y la
repetición dejó servicio, timer y health en `Result=success`. El health público
respondió HTTP 200 con todos los componentes en `ok` y el bundle cifrado
`crigestion-staging-20260821T084752Z.cgrb` quedó verificado con SHA-256
`c5e931ff7519b173dab6df5d83f9c4b410d11d5da1e420c38fdac234daa6b4e7`.
VeriFactu continuó en TEST, producción no se consultó ni modificó y el acceso
SSH temporal permanece activo por indicación expresa del usuario.
