# ADR-0011: Persistir instantes en UTC y presentar fechas en Europe/Madrid

## Estado

Aceptada.

## Contexto

La aplicación operará en España, pero debe evitar ambigüedades por horario de verano, auditoría, caducidades, sesiones, notificaciones y procesos programados.

## Decisión

Los instantes se persistirán en UTC.

La presentación al usuario usará la zona `Europe/Madrid`. Las fechas puras, como fechas de factura, vencimientos o periodos, se modelarán como fecha sin hora cuando funcionalmente corresponda.

## Alternativas consideradas

- Guardar hora local: puede crear ambigüedad en cambios horarios.
- Guardar todo como texto: dificulta ordenación y consultas.
- Usar solo fecha y hora local sin zona: insuficiente para auditoría técnica.

## Consecuencias

- El dominio distinguirá entre instante y fecha pura.
- Los procesos programados deberán definir si se disparan por fecha local o instante UTC.
- La API documentará el formato de fechas.
- Las pruebas incluirán casos cercanos a cambios de horario.

