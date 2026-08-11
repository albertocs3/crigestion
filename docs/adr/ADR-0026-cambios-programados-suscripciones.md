# ADR-0026: Cambios programados de cantidad en suscripciones

## Estado

Aceptada.

## Contexto

Las lineas de una suscripcion activa son inmutables y las reservas de
renovacion congelan su version y sus importes. La especificacion exige que los
cambios contractuales futuros entren en vigor en la siguiente renovacion, se
puedan retirar antes de aplicarse y conserven valor anterior, valor nuevo,
actor, fecha y motivo. Aplicar cambios durante una consulta de vista previa
introduciria efectos ocultos en una lectura y carreras con reservas, bajas,
exclusiones y reactivaciones.

El alcance completo incluye planes, periodicidad, conceptos y condiciones
economicas. Esos cambios requieren decisiones adicionales sobre prorrateo,
compatibilidad de periodos y autoridad economica. La primera rebanada debe ser
util por si sola y no anticipar esas decisiones.

## Decision

La primera rebanada permite programar exclusivamente cambios de cantidad sobre
lineas existentes de suscripciones `ACTIVE` con modalidad `PER_LICENSE`. No
permite anadir o retirar conceptos, cambiar periodicidad, modalidad, precios,
descuentos, impuestos, fechas, forma de pago ni textos contractuales.

Cada orden es un recurso versionado y append-only con estado `PENDING`,
`APPLIED` o `REVOKED`. Conserva la version de suscripcion de origen, la fecha
efectiva calculada por el servidor —la siguiente renovacion vigente—, el actor,
el motivo y, para cada linea, la cantidad anterior y la nueva. Solo puede
existir una orden pendiente por suscripcion. Las solicitudes repetidas usan
idempotencia y las terminales no se borran ni se editan.

La vista previa de renovaciones sigue siendo una lectura sin efectos. Cuando
existe una orden pendiente aplicable, proyecta sus cantidades y marca el
resultado como cambio pendiente. La aplicacion real ocurre dentro de la misma
transaccion serializable que reserva el borrador de renovacion: se bloquean la
suscripcion, la orden y las lineas; se revalidan versiones, fecha y ausencia de
bloqueos; la orden pasa a `APPLIED`; se actualizan las cantidades y la version
contractual; y solo entonces se congelan las lineas de la reserva. Si cualquier
paso falla, no cambia ni el contrato ni la orden.

Crear o retirar una orden incrementa la version de la suscripcion. No se puede
crear mientras exista una reserva `RESERVED`, una exclusion `OPEN`, una baja
pendiente o una reactivacion pendiente. La aplicacion compite bajo el mismo
orden de bloqueos que el runner de renovaciones; nunca modifica facturas ni
reservas historicas.

Los endpoints requieren `Subscriptions.ScheduleChanges`,
`Subscriptions.ManageEconomics` y `Subscriptions.View`. Validan sesion, origen,
CSRF, `Idempotency-Key`, cuerpo acotado, tenant, version y cuota persistente. La
auditoria registra identificadores, versiones, numero de lineas, fecha efectiva
y presencia de motivo, pero no cantidades, importes, motivo libre ni clave de
idempotencia.

PostgreSQL refuerza la unicidad de la orden pendiente, estados terminales,
snapshots inmutables y correspondencia entre `APPLIED`, la version resultante y
las actualizaciones de lineas realizadas en la misma transaccion. Una escritura
directa sobre cantidades de una suscripcion no borrador continua prohibida si
no existe esa evidencia.

## Consecuencias

- La primera entrega resuelve ampliaciones y reducciones de licencias sin abrir
  cambios de precio o catalogo.
- La vista previa puede mostrar el resultado futuro sin mutar datos.
- Reservar el borrador es el punto unico de aplicacion; no se necesita otro
  worker ni se aplican cambios por una mera lectura.
- Una retirada conserva el historial y obliga a crear otra orden para cambiar
  cantidades.
- Los cambios de plan, periodicidad, conceptos y condiciones economicas quedan
  para ADRs o ampliaciones posteriores con reglas funcionales confirmadas.
