# Guia de contribucion

## Flujo de trabajo

1. Actualiza `main`.
2. Crea una rama descriptiva.
3. Implementa cambios pequeños y revisables.
4. Ejecuta validaciones locales.
5. Abre un pull request usando la plantilla.
6. Completa la checklist OWASP si el cambio toca entradas, permisos, sesiones, datos o despliegue.

Ejemplo:

```bash
git checkout main
git pull
git checkout -b feature/bootstrap-login
```

## Convenciones de ramas

- `feature/...` para funcionalidad.
- `fix/...` para correcciones.
- `security/...` para mejoras o correcciones de seguridad.
- `docs/...` para documentacion.
- `infra/...` para Docker, CI/CD y despliegue.

## Validaciones antes de PR

Ejecuta, cuando el entorno este disponible:

```bash
npm run prisma:generate
npm run typecheck
npm run lint
npm run audit
```

Si el cambio afecta a base de datos:

```bash
npm run prisma:migrate -- --name nombre_descriptivo
npm run db:seed
```

## Cambios en base de datos

- Todo cambio de modelo debe pasar por `prisma/schema.prisma`.
- Las migraciones deben ser revisables y no destructivas salvo decision explicita.
- Los seeds deben ser idempotentes y no contener datos reales.
- Revisar indices, claves unicas, relaciones y transacciones.

## Cambios de seguridad

Requieren revision especial los cambios que toquen:

- Login, logout o sesiones.
- Cookies, CSRF, CSP o cabeceras.
- Roles, permisos o RBAC.
- Datos sensibles, exportaciones o auditoria.
- Certificados digitales, VeriFactu o secretos.
- SQL crudo, comandos del sistema o integraciones externas.

## Documentacion

Actualiza documentacion cuando cambie:

- Arquitectura.
- Contratos API.
- Modelo Prisma.
- Controles OWASP.
- Flujo de instalacion.
- Requisitos de despliegue.

## Commits

Usa mensajes claros y accionables:

```text
Add initial login route
Fix installation idempotency check
Document VeriFactu certificate custody
```

## Uso de Codex

Cuando trabajes con Codex:

- Mantén `AGENTS.md` como instrucciones de proyecto.
- Usa skills especializadas para arquitectura, Prisma, seguridad, UI, testing y despliegue.
- Pide revision especializada en cambios criticos.
- No pegues secretos, certificados ni datos reales en prompts o issues.
