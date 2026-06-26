# ADR-0018: Aislar VeriFactu detras de un adaptador versionado

## Estado

Aceptada.

## Contexto

VeriFactu es un requisito legal relevante para facturacion, pero sus detalles pueden cambiar. La integracion afecta emision, conservacion, certificados, errores, reintentos, auditoria y trazabilidad.

La arquitectura vigente de CriGestión es web, con Next.js en servidor y jobs para tareas diferidas. Por tanto, los envios no deben depender del navegador ni del equipo fisico del usuario.

## Decision

VeriFactu se implementara detras de un adaptador aislado, con contratos versionados, Outbox, idempotencia y conservacion de solicitud/respuesta.

El certificado digital utilizado para la remision se custodiara server-side, cifrado y fuera del repositorio. No se instalara ni se usara desde el navegador o PC del usuario para operar la aplicacion web.

Si CriGestión remite registros en nombre del obligado tributario, el adaptador solo podra activarse cuando exista representacion o colaboracion social valida segun el procedimiento aplicable.

## Alternativas consideradas

- Certificado en el equipo del usuario: solo encaja en una aplicacion local pura; dificulta reintentos, jobs, soporte multiusuario y operacion web.
- Integrar llamadas directamente en Facturacion: acopla reglas legales cambiantes al dominio principal.
- Usar una dependencia externa sin encapsular: rapido, pero introduce dependencia tecnica fuerte.
- Posponer toda estructura de integracion: reduce trabajo inicial, pero dificulta disenar emision e inmutabilidad.

## Consecuencias

- Facturacion dependera de un puerto, no de detalles tecnicos de AEAT.
- Los cambios normativos se concentraran en el adaptador y contratos.
- El almacenamiento y uso de certificados sera responsabilidad de infraestructura segura server-side.
- Los jobs podran reintentar envios sin requerir un PC de usuario encendido.
- Cada uso del certificado debera quedar auditado sin exponer secretos.
- Las pruebas usaran dobles del adaptador.
- La validacion legal definitiva seguira pendiente hasta confirmar requisitos vigentes.
