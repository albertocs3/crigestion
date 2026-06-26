# AGENTS.md

## Proposito

Este archivo guia a Codex al trabajar en CriGestión.

CriGestión es una aplicacion web de gestion empresarial construida con:

- Next.js App Router.
- TypeScript estricto.
- PostgreSQL.
- Prisma.
- UI operativa de backoffice.

El objetivo principal es construir una aplicacion segura, trazable, mantenible y preparada para procesos fiscales, contables y de facturacion.

## Principio De Trabajo

Codex debe actuar como integrador principal.

Puede y debe delegar en subagentes cuando el trabajo requiera investigacion especializada, revision independiente o ejecucion paralela razonable. La delegacion no transfiere la responsabilidad final: el agente principal debe revisar, integrar y verificar el resultado antes de responder.

## Skills Del Proyecto

Usar las skills locales de `.codex/skills/` cuando apliquen:

- `nextjs-architecture`: App Router, Server Components, Client Components, Route Handlers, Middleware, caching, streaming y estructura.
- `prisma-guidelines`: `schema.prisma`, relaciones, migraciones, transacciones, seeds, auditoria y consultas Prisma.
- `postgresql-best-practices`: indices, `EXPLAIN ANALYZE`, JSONB, FTS, UUID, particiones, backups y optimizacion.
- `typescript-style`: tipos estrictos, Zod, DTOs, Result Pattern, discriminated unions y naming.
- `api-design`: REST, validaciones, errores, paginacion, filtros, autenticacion y permisos.
- `ui-guidelines`: shadcn/ui, Tailwind, Radix UI, accesibilidad, formularios, tablas y dialogos.
- `testing`: Vitest, Playwright, Testing Library, mocks, fixtures e integracion.
- `security`: Auth.js, sesiones, RBAC, CSRF, XSS, SQL injection, rate limiting, headers, CSP y secretos.
- `performance`: React cache, memo, Suspense, Server Components, imagenes, bundle y Prisma Optimize.
- `deployment`: Docker, PostgreSQL, variables de entorno, backups, migraciones y CI/CD.

Si varias skills aplican, usar el conjunto minimo necesario.

## Politica De Delegacion

Delegar en subagentes siempre que sea util y seguro, especialmente en estos casos:

- Cambios de seguridad: autenticacion, sesiones, permisos, CSRF, certificados, datos sensibles o auditoria.
- Cambios de persistencia: Prisma schema, migraciones, indices, transacciones, datos fiscales o historicos.
- Cambios amplios de arquitectura: App Router, limites server/client, modulos o estructura de carpetas.
- Revision independiente antes de tocar flujos criticos: facturacion, contabilidad, VeriFactu, sesiones, permisos.
- Trabajo paralelo claro: documentacion, pruebas, modelo de datos, UI o busqueda de referencias.
- Investigacion de alternativas: Auth.js vs implementacion propia, colas/jobs, estrategia de backup, testing E2E.
- Auditorias o reviews: pedir a un subagente que busque riesgos, omisiones, regresiones o incoherencias.

No delegar cuando:

- La tarea sea trivial y local.
- La delegacion tarde mas que resolver directamente.
- Haya que preservar contexto sensible que no debe copiarse.
- El subagente necesite credenciales, secretos o acceso externo no autorizado.
- La decision requiera confirmacion del usuario antes de avanzar.

## Como Delegar

Al delegar:

1. Dar al subagente una tarea concreta.
2. Indicar archivos o areas a revisar.
3. Pedir hallazgos accionables con referencias a archivos.
4. Evitar pasar conclusiones esperadas.
5. Pedir riesgos, alternativas y pruebas recomendadas cuando proceda.
6. Revisar criticamente la respuesta antes de aplicarla.

Ejemplos de delegacion:

- "Revisa `prisma/schema.prisma` y detecta riesgos de integridad, indices faltantes y migraciones SQL necesarias."
- "Revisa los Route Handlers de instalacion y busca problemas de seguridad o contrato HTTP."
- "Analiza la documentacion de VeriFactu y comprueba si las decisiones tecnicas son coherentes entre ADR, arquitectura y facturacion."
- "Propon pruebas Vitest/Playwright para este flujo, sin modificar archivos."

## Reglas De Arquitectura

- Server Components por defecto.
- Client Components solo para interaccion de navegador.
- Prisma, certificados, secretos y filesystem solo en server-side.
- Los Route Handlers deben ser delgados y delegar casos de uso.
- No devolver modelos Prisma como contrato publico.
- Validar entradas con Zod.
- Usar errores funcionales estables.
- Auditar acciones relevantes sin secretos.
- Mantener reglas de negocio fuera de componentes UI.

## Seguridad

La seguridad manda sobre comodidad.

Reglas:

- No guardar tokens en `localStorage`.
- Usar sesiones web con cookie `HttpOnly`, `Secure` y `SameSite`.
- Guardar solo hash de tokens de sesion.
- Proteger mutaciones contra CSRF.
- Validar permisos siempre en servidor.
- No confiar en ocultar botones como control de seguridad.
- No registrar contrasenas, tokens, certificados, IBAN completo ni secretos.
- Custodiar certificados VeriFactu server-side y cifrados.
- Auditar accesos, intentos fallidos, acciones denegadas, exportaciones, descargas y uso de certificados.
- Revisar y aplicar `docs/seguridad/02-owasp-top-10.md` en cambios que afecten a seguridad, API, persistencia, despliegue o datos sensibles.

Para cambios de seguridad no triviales, delegar revision a un subagente especializado antes de cerrar.

## Persistencia

Reglas:

- PostgreSQL es la fuente de verdad.
- Prisma modela el acceso ordinario.
- Las invariantes criticas deben reforzarse con restricciones o indices en PostgreSQL cuando sea posible.
- Las operaciones economicas criticas deben ser transaccionales.
- No realizar llamadas externas dentro de una transaccion.
- No editar migraciones ya aplicadas.
- No incluir datos reales sensibles en seeds o fixtures.
- Revisar indices para listas, busquedas, sesiones, auditoria y jobs.

Para cambios de `schema.prisma`, migraciones o consultas complejas, delegar revision a subagente de datos.

## API

Cada endpoint debe definir:

- Si es publico o autenticado.
- Permiso requerido.
- Validacion Zod.
- Proteccion CSRF si muta estado con cookies.
- Idempotencia si crea efectos repetibles.
- Rate limiting si es sensible.
- Auditoria.
- Codigos de error estables.

## UI

CriGestión es una herramienta operativa.

- Priorizar claridad, densidad y rapidez de uso.
- No crear landing pages salvo peticion explicita.
- Usar shadcn/ui, Tailwind y Radix UI cuando se incorporen.
- Cuidar accesibilidad, teclado, foco, labels y contraste.
- Formularios con validacion local orientativa y validacion final server-side.
- Tablas con estados de carga, vacio, error y filtros.

Para pantallas complejas, delegar una revision UI/accesibilidad.

## Testing

Agregar pruebas segun riesgo:

- Unitarias para dominio y aplicacion.
- Integracion para Prisma/PostgreSQL.
- Contrato para Route Handlers.
- E2E Playwright para flujos criticos.

Flujos P0:

- Inicializacion.
- Login/logout.
- Revocacion de sesion.
- Permisos denegados.
- Facturacion.
- VeriFactu pendiente/reintento.
- Auditoria sin secretos.

Si se toca un flujo critico, pedir a un subagente propuesta de pruebas o revision de cobertura.

## Documentacion

Actualizar documentacion cuando cambien decisiones, contratos o arquitectura:

- `docs/05-arquitectura-tecnica.md`.
- `docs/06-estructura-solucion-dotnet.md` aunque conserve nombre historico.
- `docs/adr/`.
- `docs/plataforma/`.
- Especificaciones funcionales del modulo afectado.

No dejar decisiones vigentes contradiciendo ADRs aceptadas.

## Validacion

Cuando el entorno lo permita, ejecutar:

```powershell
npm install
npm run prisma:generate
npm run prisma:migrate
npm run typecheck
npm run build
npm run audit
```

Si no se puede ejecutar por falta de Node, npm, Python, PostgreSQL u otra dependencia, indicarlo claramente en la respuesta final.

## Estilo De Cambios

- Mantener cambios pequenos y coherentes.
- No refactorizar areas no relacionadas.
- No revertir cambios del usuario.
- Preferir patrones existentes del repo.
- Usar nombres claros y estables.
- Mantener ASCII en archivos nuevos salvo que el archivo existente use otro criterio.

## Cierre De Tareas

Antes de responder:

1. Revisar los archivos tocados.
2. Confirmar que la documentacion relevante queda alineada.
3. Indicar validaciones ejecutadas.
4. Indicar validaciones no ejecutadas y por que.
5. Resumir riesgos pendientes si existen.
