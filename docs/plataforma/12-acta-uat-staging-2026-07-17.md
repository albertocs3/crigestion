# Acta de aceptacion UAT de staging 2026-07-17

## 1. Decision

La release `staging-2026.07.17-rc2`, commit
`ddfc6ce037b68683755d160d53b79fbadab0a011`, queda **ACEPTADA PARA STAGING**
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

La evidencia detallada y el procedimiento operativo se conservan en
`docs/plataforma/11-despliegue-staging-plesk.md`.

## 3. Estado final del entorno

- Release activa: `staging-2026.07.17-rc2`.
- Web, PostgreSQL, worker y VeriFactu: estado `ok` en la verificacion posterior
  al despliegue.
- Rol `UAT_RESTRICTED`: restaurado con `Billing.View` como unico permiso.
- Cuentas `uat_restricted`, `uat_unlock_rc2` y `uat_session_rc2`: `INACTIVE`.
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
de regresion. Este ajuste debe desplegarse y verificarse en staging antes de
cerrar la candidata que lo contenga.

La candidata corregida supero localmente TypeScript, 56 archivos con 524
pruebas Vitest, ESLint, el build optimizado de Next.js y
`npm audit --audit-level=high` sin vulnerabilidades. Tambien supero la prueba
E2E dirigida al vencimiento impagado con parametros opcionales vacios.

## 7. Limites de la aceptacion

Los datos sinteticos financieros se mantienen en staging como evidencia
trazable del ensayo. La cuenta bancaria de prueba se muestra enmascarada en la
interfaz. Esta ampliacion del acta no autoriza ni prepara produccion.
