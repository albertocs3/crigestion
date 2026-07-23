# ADR-0024: Maker-checker para el cierre contable

## Estado

Aceptada.

## Contexto

El cierre de ejercicio crea asientos de regularizacion, cierre y apertura,
cierra el ejercicio origen y crea el siguiente. El contrato anterior permitia
que una unica persona con `Accounting.CloseExercises` ejecutara toda la
operacion, lo que no aportaba segregacion de funciones y bloqueaba su futura
habilitacion en produccion.

## Decision

Se adopta un circuito de dos actores:

1. Una persona solicita el cierre tras superar un preflight inicial.
2. Otra persona distinta aprueba la solicitud. La aprobacion repite el
   preflight y ejecuta el cierre completo de forma atomica.

Solicitud y aprobacion tienen permisos e idempotencia separados. Solo existe
una solicitud `REQUESTED` por ejercicio. La persona solicitante puede cancelar
su solicitud pendiente, pero no aprobarla. PostgreSQL refuerza la unicidad, la
coherencia de estados, el alcance empresa-ejercicio y la diferencia entre maker
y checker.

No se introduce un estado `APPROVED` separado de la ejecucion. La aprobacion y
el cierre comparten transaccion para evitar que la contabilidad cambie entre la
decision y la generacion de asientos. El preflight guardado al solicitar es
evidencia, no una autorizacion reutilizable.

El endpoint historico de cierre directo permanece como compatibilidad segura y
devuelve un conflicto estable sin mutar datos. `Accounting.CloseExercises`
queda como permiso legado sin capacidad ejecutora.

## Consecuencias

- Se necesitan dos usuarios distintos incluso si ambos tienen rol Administrador.
- Cada paso queda auditado y usa una clave idempotente propia.
- La aprobacion revalida documentos, diario, VeriFactu, saldos y siguiente
  ejercicio bajo los mismos bloqueos que el cierre.
- Un fallo funcional mantiene la solicitud pendiente para poder corregir la
  causa y reintentar; un fallo tecnico revierte toda la transaccion.
- La anulacion formal del cierre sigue siendo un requisito independiente antes
  de habilitar el proceso en produccion.
