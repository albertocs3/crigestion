# Estado de implementacion

## 1. Proposito

Este documento resume el estado verificable del producto y complementa el
backlog historico de la primera rebanada vertical. No sustituye las
especificaciones funcionales, los contratos HTTP ni los ADR vigentes.

Fecha de corte: 2026-07-22.

## 2. Rebanadas disponibles

| Area | Estado | Alcance verificado |
|---|---|---|
| Plataforma | Operativa | Inicializacion, login/logout, sesiones, permisos, auditoria, copias, restauracion y mantenimiento controlado. |
| Adjuntos seguros | Operativa inicial | Primera rebanada de logotipo empresarial desplegada en staging: cuarentena, ClamAV fail-closed, normalizacion, almacenamiento privado, integridad, RBAC, auditoria y bundle cifrado con drill de coherencia. |
| Clientes | Operativa inicial | Maestro fiscal, direcciones, tiendas, condiciones comerciales y cuentas contables de cliente. |
| Proveedores | Operativa inicial | Maestro fiscal desplegado y aceptado en staging: alta, edicion, baja logica, subcuenta 400, idempotencia, concurrencia optimista, RBAC, auditoria y datos sensibles cifrados. |
| Compras | Operativa local pendiente de UAT | Borradores, lineas, vencimientos, registro contable, IVA soportado, entradas de stock, pagos de proveedor y rectificacion total sin pagos con contraasiento, IVA y stock append-only. |
| Catalogo | Operativo inicial | Categorias, articulos, impuestos y movimientos de stock. |
| Facturacion | Operativa inicial | Borradores, lineas, emision, vencimientos, cobros, devoluciones, impagos, rectificativas y PDF. |
| Contabilidad | Operativa inicial | PGC PYMES, cuentas, asientos manuales, ejercicios, regularizacion, cierre y apertura. |
| Tesoreria y SEPA | Operativa inicial | Vencimientos, previsiones de cobro, remesas, SEPA, respuestas bancarias controladas, devoluciones, saldos a favor, compensaciones y reembolsos segregados. |
| Conciliacion bancaria | Operativa inicial | Cuentas y movimientos bancarios, Norma 43 AEB 2012, propuestas, conciliacion parcial o total y deshacer con auditoria. |
| VeriFactu TEST | Operativa controlada | Instalacion SIF, custodia cifrada y versionada de PFX, prueba mTLS, envio TEST, outbox conservador, worker con heartbeat y panel operativo. PRODUCCION permanece bloqueada. |

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

Evidencia actualizada el 22 de julio de 2026 sobre PostgreSQL desechable:

- El repositorio contiene 87 migraciones; la base desechable las aplica desde cero antes de validar.
- Vitest: 71 archivos y 619 pruebas superadas.
- TypeScript, ESLint y build optimizado de Next.js completados correctamente.
- `npm audit --audit-level=high`: sin vulnerabilidades detectadas.

La aceptacion funcional de `staging-2026.07.17-rc5`, incluidas las pruebas de
autenticacion, RBAC, sesiones, tesoreria y auditoria desde navegador, se conserva en el
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
4. Completar el ciclo avanzado de proveedor: credito/reembolso para rectificativas pagadas, rectificacion parcial, anulacion y correccion interna versionada. La rectificacion total impagada ya esta implementada localmente, pendiente de candidata y UAT de staging.
5. Ampliar perfiles bancarios solo cuando exista un requisito confirmado:
   multicuenta, moneda distinta de EUR u otros perfiles Norma 43.
6. Refinar el backlog por rebanadas posteriores; [el backlog inicial](07-backlog-tecnico-primera-rebanada.md) se conserva como trazabilidad historica de plataforma.

Existe una divergencia contable conocida: la especificacion admite coexistencia
temporal de ejercicios abiertos, mientras la base vigente mantiene un indice
parcial de un unico ejercicio `OPEN` por empresa. Su revision pertenece al
proximo corte de cierre contable y no se ha mezclado con el maestro de proveedores.
