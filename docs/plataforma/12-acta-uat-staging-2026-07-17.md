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
Produccion no se consulto ni se modifico.
