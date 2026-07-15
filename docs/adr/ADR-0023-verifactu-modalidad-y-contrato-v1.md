# ADR-0023: Adoptar modalidad VERI*FACTU y contrato fiscal V1

## Estado

Aceptada.

## Contexto

ADR-0018 aisla la integracion tras un adaptador, pero no decide modalidad,
cadena, persistencia ni semantica de entrega. El placeholder actual por factura
no constituye todavia un registro fiscal conforme ni un historial de remision.

La base normativa revisada a 2026-07-12 es:

- [Real Decreto 1007/2023, texto consolidado](https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840).
- [Orden HAC/1177/2024](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138).
- [Real Decreto-ley 15/2025](https://www.boe.es/buscar/doc.php?id=BOE-A-2025-24446), que fija los plazos de 2027.
- [Informacion tecnica AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica.html).

Los detalles WSDL, XSD, validaciones, errores, algoritmo de huella y URL QR son
un contrato tecnico vivo publicado por la AEAT.

## Decision

1. CriGestion soportara inicialmente solo la modalidad `VERIFACTU` con remision efectiva a AEAT.
2. No se implementara inicialmente el modo no verificable ni su firma XAdES y registro local de eventos.
3. Cada obligado tributario e instalacion SIF mantendra una cadena independiente, ordenada e inmutable de registros `ALTA` y `ANULACION`.
4. La expedicion persistira atomicamente factura, registro fiscal preparado y mensaje Outbox. La remision se ejecutara fuera de la transaccion por un job ordenado.
5. Los registros fiscales y los intentos de remision seran append-only. Los estados visibles de factura seran una proyeccion y no la fuente de verdad.
6. Un timeout o respuesta indeterminada producira estado `UNKNOWN`; se conciliara antes de reenviar para evitar duplicidades.
7. El QR y la leyenda se generaran desde datos fiscales congelados y configuracion oficial del entorno. El placeholder grafico actual no se habilitara en produccion.
8. En modalidad VERI*FACTU no se firmaran electronicamente los registros, sin perjuicio de la autenticacion y certificado admitido para el transporte a AEAT.
9. Cada version desplegable conservara su declaracion responsable de productor y un manifiesto de dependencias normativas.
10. El transporte real no se implementara hasta fijar y verificar WSDL, XSD, catalogo de errores, algoritmo de huella, QR y fixtures contra el portal oficial de pruebas.

El contrato funcional estable se define en
[Contrato VeriFactu V1](../facturacion/06-contrato-verifactu-v1.md).

## Consecuencias

- La emision no depende de disponibilidad sincrona de AEAT.
- La cola debe conservar orden por obligado e instalacion y aplicar el control de flujo comunicado por AEAT.
- La persistencia necesitara multiples registros e intentos por factura; el placeholder actual sera reemplazado mediante migracion nueva.
- Rectificar una factura y anular tecnicamente un registro de alta son operaciones diferentes.
- La custodia server-side protege el certificado de transporte; no se expone material criptografico al navegador.
- Antes de cada release fiscal se revisaran norma consolidada y artefactos tecnicos AEAT.

## Alternativas descartadas

- Soportar ambas modalidades inicialmente: duplica firma, eventos, operacion y pruebas.
- Enviar dentro de la transaccion de emision: introduce una llamada externa y no resuelve lotes, espera ni reintentos.
- Usar el estado de factura como registro fiscal: no conserva cadena, anulaciones ni intentos.
- Codificar directamente contra un WSDL sin contrato interno: dispersa cambios normativos por el dominio.
