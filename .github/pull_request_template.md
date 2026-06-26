## Resumen

- 

## Tipo de cambio

- [ ] Funcionalidad
- [ ] Correccion
- [ ] Refactor
- [ ] Documentacion
- [ ] Seguridad
- [ ] Infraestructura

## Areas afectadas

- [ ] Next.js / App Router
- [ ] API / Route Handlers
- [ ] Prisma / PostgreSQL
- [ ] UI
- [ ] Seguridad / RBAC / sesiones
- [ ] VeriFactu / certificados
- [ ] Documentacion

## Checklist OWASP

- [ ] Identifique las categorias OWASP Top 10 afectadas.
- [ ] Valide todas las entradas externas con Zod o mecanismo equivalente.
- [ ] Comprobe permisos en servidor, no solo en UI.
- [ ] Evite exponer secretos en respuestas, logs o auditoria.
- [ ] Evite SQL o comandos interpolados con entrada de usuario.
- [ ] Protegi mutaciones con cookie frente a CSRF cuando aplica.
- [ ] Aplique rate limiting a endpoints sensibles cuando aplica.
- [ ] Registre auditoria si afecta a seguridad, datos sensibles o negocio critico.
- [ ] Inclui pruebas proporcionales al riesgo.
- [ ] Pedi revision especializada o subagente en cambios de seguridad no triviales.

## Base de datos

- [ ] No aplica.
- [ ] Incluye cambios en `prisma/schema.prisma`.
- [ ] Incluye migracion revisada.
- [ ] Incluye seed idempotente o ajuste de datos.
- [ ] Revise indices, restricciones y transacciones.

## Validacion

Comandos ejecutados:

```bash

```

## Notas de despliegue

- 
