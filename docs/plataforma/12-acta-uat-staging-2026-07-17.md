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
