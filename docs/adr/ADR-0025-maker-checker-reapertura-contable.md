# ADR-0025: Maker-checker y contraasientos para la reapertura contable

## Estado

Aceptada.

## Contexto

El cierre contable genera regularizacion, cierre, apertura y un ejercicio
sucesor. Corregir un cierre completado no puede borrar esos asientos, alterar su
historia ni dejar simultaneamente operativos los ejercicios origen y sucesor.
Tampoco es suficiente cambiar el estado del ejercicio: deben conservarse
evidencias relacionales verificables y segregacion de funciones.

## Decision

La anulacion formal del cierre usa una solicitud de reapertura independiente.
Una persona con `Accounting.RequestExerciseReopenings` indica un motivo
clasificado y una justificacion. Otra persona distinta, con
`Accounting.ApproveExerciseReopenings`, repite el preflight y aprueba la
operacion. Solicitud, aprobacion y cancelacion tienen CSRF, control de origen,
idempotencia, bloqueos y auditoria.

La solicitud de cierre original permanece `COMPLETED`. Sus referencias al
ejercicio sucesor y a los asientos de regularizacion, cierre y apertura son
relaciones persistentes. Al aprobar la reapertura se crean asientos
append-only de origen `FISCAL_YEAR_CLOSE_REVERSAL`, con importes y lineas
invertidos y enlace `reversesEntryId` al asiento original. El ejercicio origen
vuelve a `OPEN`; el sucesor pasa a `REVERSED`, estado no operativo que conserva
su plan, asientos e identidad.

El preflight solo permite reabrir si el sucesor exacto sigue abierto y no tiene
actividad ajena al historial estructural del cierre: documentos, remesas,
cobros, pagos, aplicaciones de credito, devoluciones, movimientos bancarios,
asientos no vinculados, cierre propio, ejercicio hijo o alteraciones del plan
copiado. PostgreSQL refuerza estados terminales,
maker-checker, referencias exactas y equivalencia de los contraasientos.

Si el ejercicio reabierto vuelve a cerrarse, se reutiliza el mismo sucesor
`REVERSED`: se incorporan las cuentas nuevas del origen sin modificar las ya
referenciadas por asientos historicos, se conservan aperturas y contraasientos
y se crea una nueva apertura. Nunca se crea un segundo ejercicio con el mismo
año.

## Consecuencias

- La reapertura requiere dos identidades autorizadas y no se ofrece una via
  directa de un solo actor.
- El motivo completo queda en la solicitud protegida; la auditoria registra el
  codigo de motivo, identificadores, actores, preflight y asientos, sin texto
  libre ni datos personales.
- La historia contable es append-only y puede reconstruirse mediante claves
  foraneas, no solo desde JSON de auditoria.
- Una vez que el sucesor contiene actividad real, la reapertura se bloquea y la
  correccion debe realizarse mediante el procedimiento contable aplicable.
- La habilitacion en produccion sigue siendo una decision operativa separada.
