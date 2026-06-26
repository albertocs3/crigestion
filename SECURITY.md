# Politica de seguridad

## Alcance

Esta politica aplica a CriGestión y a su repositorio:

- Aplicacion Next.js.
- Route Handlers y Server Actions.
- Prisma y PostgreSQL.
- Autenticacion, sesiones, RBAC y auditoria.
- Gestion de certificados digitales y VeriFactu.
- Scripts, CI/CD, Docker y configuracion de despliegue.

## Como reportar una vulnerabilidad

No abras issues publicas con detalles explotables, secretos, certificados, credenciales, datos reales de clientes ni evidencias sensibles.

Para reportar un problema de seguridad:

1. Contacta al mantenedor del repositorio por un canal privado.
2. Incluye una descripcion del riesgo.
3. Indica pasos de reproduccion seguros, sin datos reales.
4. Indica impacto estimado y categorias OWASP si las conoces.
5. Adjunta logs solo si no contienen secretos ni datos personales.

## Manejo esperado

- Se clasificara la severidad como baja, media, alta o critica.
- Se creara una rama privada o PR con visibilidad controlada si procede.
- Los cambios de seguridad relevantes requeriran revision especializada.
- No se fusionaran cambios criticos sin tests proporcionales al riesgo.
- Se actualizara la documentacion si el control afecta al diseño del sistema.

## Reglas de seguridad del proyecto

- No versionar `.env`, `.env.local`, `.env.docker`, certificados, claves privadas ni backups.
- No guardar contrasenas, tokens ni certificados en logs.
- No exponer stack traces ni detalles internos en produccion.
- Validar entradas externas con Zod o mecanismo equivalente.
- Autorizar siempre en servidor, nunca solo en UI.
- Usar Prisma Client para consultas ordinarias y SQL parametrizado si se requiere SQL crudo.
- Proteger mutaciones con cookie frente a CSRF cuando aplique.
- Auditar acciones sensibles sin almacenar secretos.

## Referencias internas

- Controles OWASP: `docs/seguridad/02-owasp-top-10.md`.
- Seguridad funcional: `docs/seguridad/01-especificacion-funcional.md`.
- Autenticacion y sesiones: `docs/adr/ADR-0009-autenticacion-sesiones.md`.
- Autorizacion y permisos: `docs/adr/ADR-0010-autorizacion-permisos.md`.
- VeriFactu y certificados: `docs/adr/ADR-0018-verifactu-adaptador.md`.
