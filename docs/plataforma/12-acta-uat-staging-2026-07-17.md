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
