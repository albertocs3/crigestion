# Documentacion funcional y tecnica de CriGestión

## 1. Proposito

Este directorio contiene la especificacion funcional y tecnica de CriGestión.

La base tecnologica vigente es:

- Next.js.
- TypeScript.
- PostgreSQL.
- Prisma.

## 2. Orden de lectura

1. [Vision general](00-vision-general.md)
2. [Requisitos compartidos](00-requisitos-compartidos.md)
3. [Integraciones transversales](01-integraciones-transversales.md)
4. [Mapa de modulos](02-mapa-modulos.md)
5. [Glosario comun](03-glosario.md)
6. [Alcance y fases del MVP](04-alcance-mvp.md)
7. [Arquitectura tecnica](05-arquitectura-tecnica.md)
8. [Estructura de la solucion Next.js](06-estructura-solucion-dotnet.md)
9. [Registro de decisiones arquitectonicas](adr/README.md)
10. [Backlog tecnico de la primera rebanada vertical](07-backlog-tecnico-primera-rebanada.md)
11. [Plan de creacion fisica de la solucion](08-plan-creacion-fisica-solucion.md)
12. [Preparacion del entorno en macOS](setup-mac.md)
13. Especificaciones funcionales y tecnicas de cada modulo.

## 3. Documentos transversales

| Documento | Contenido |
|---|---|
| [Vision general](00-vision-general.md) | Objetivos, alcance global, usuarios y principios del producto. |
| [Requisitos compartidos](00-requisitos-compartidos.md) | Auditoria, notificaciones, adjuntos, fechas, importes, conservacion y proteccion de datos. |
| [Integraciones transversales](01-integraciones-transversales.md) | Motor unico de facturacion, contabilidad, anticipos, rectificaciones, VeriFactu e inmutabilidad. |
| [Mapa de modulos](02-mapa-modulos.md) | Responsabilidades, propietarios de datos y dependencias. |
| [Glosario comun](03-glosario.md) | Definiciones compartidas y terminos que no deben confundirse. |
| [Alcance y fases del MVP](04-alcance-mvp.md) | Priorizacion, entregas, exclusiones y criterios de finalizacion. |
| [Arquitectura tecnica](05-arquitectura-tecnica.md) | Aplicacion Next.js, modulos, persistencia, seguridad, despliegue e integraciones. |
| [Estructura de la solucion Next.js](06-estructura-solucion-dotnet.md) | Carpetas, dependencias, composicion, pruebas y orden inicial de creacion. |
| [Registro de decisiones arquitectonicas](adr/README.md) | ADR iniciales, alternativas consideradas y consecuencias aceptadas. |
| [Backlog tecnico primera rebanada vertical](07-backlog-tecnico-primera-rebanada.md) | Tareas tecnicas trazables para implementar `PLT-CU-001`. |
| [Checklist de release de Plataforma](plataforma/09-release-checklist.md) | Pasos de validacion, migracion, despliegue y rollback para releases. |
| [Plan de creacion fisica de la solucion](08-plan-creacion-fisica-solucion.md) | Secuencia de comandos, estructura y validaciones para crear la solucion real. |
| [Preparacion del entorno en macOS](setup-mac.md) | Herramientas, variables de entorno y comandos para arrancar el desarrollo en Mac. |

## 4. Especificaciones por modulo

| Modulo | Especificacion |
|---|---|
| Clientes y Tiendas | [Especificacion funcional](clientes/01-especificacion-funcional.md), [Contratos HTTP](clientes/02-contratos-api.md), [Modelo fisico](clientes/03-modelo-fisico-datos.md) |
| Catalogo e Inventario | [Especificacion funcional](catalogo/01-especificacion-funcional.md), [Contratos HTTP](catalogo/02-contratos-api.md), [Modelo fisico](catalogo/03-modelo-fisico-datos.md) |
| Suscripciones | [Especificacion funcional](suscripciones/01-especificacion-funcional.md) |
| Facturacion | [Especificacion funcional](facturacion/01-especificacion-funcional.md) |
| Atencion al Cliente | [Especificacion funcional](atencion-cliente/01-especificacion-funcional.md) |
| Contabilidad, Compras y Proveedores | [Especificacion funcional](contabilidad/01-especificacion-funcional.md) |
| Tesoreria y SEPA | [Especificacion funcional](tesoreria/01-especificacion-funcional.md) |
| Usuarios, Roles y Seguridad | [Especificacion funcional](seguridad/01-especificacion-funcional.md) |
| Configuracion General | [Especificacion funcional](configuracion/01-especificacion-funcional.md) |
| Plataforma - Fase 0 | [Casos de uso](plataforma/02-casos-de-uso.md) |
| Plataforma - Fase 0 | [Reglas de negocio](plataforma/03-reglas-de-negocio.md) |
| Plataforma - Fase 0 | [Modelo de dominio](plataforma/04-modelo-de-dominio.md) |
| Plataforma - Fase 0 | [Modelo fisico de datos](plataforma/05-modelo-fisico-datos.md) |
| Plataforma - Fase 0 | [Contratos HTTP](plataforma/06-contratos-api.md) |
| Plataforma - Fase 0 | [Diseno de pantallas](plataforma/07-diseno-pantallas.md) |
| Plataforma - Fase 0 | [Plan de pruebas](plataforma/08-plan-de-pruebas.md) |
| Seguridad | [OWASP Top 10:2025](seguridad/02-owasp-top-10.md) |

## 5. Estado documental

| Area | Estado |
|---|---|
| Recopilacion funcional por modulos | Completada inicialmente |
| Arquitectura tecnica | Adaptada a Next.js + TypeScript + PostgreSQL + Prisma |
| Estructura de solucion | Adaptada inicialmente |
| Registro de decisiones arquitectonicas | Adaptado inicialmente |
| Plan de creacion fisica | Adaptado inicialmente |
| Backlog tecnico primera rebanada vertical | Pendiente de refinamiento completo al nuevo stack |

## 6. Precedencia

En caso de contradiccion:

1. La normativa vigente prevalece sobre la documentacion.
2. Las integraciones transversales prevalecen en operaciones entre modulos.
3. Los requisitos compartidos prevalecen en reglas generales.
4. La especificacion modular prevalece para reglas propias de su ambito.
5. Las ADR vigentes prevalecen sobre documentos tecnicos antiguos.
