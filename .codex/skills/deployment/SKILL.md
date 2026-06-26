---
name: deployment
description: Deployment and operations guidance for CriGestión. Use when working on Docker, PostgreSQL deployment, environment variables, secrets, backups, migrations, CI/CD, production build, health checks, logging, restore procedures, or release workflows.
---

# Deployment

Use this skill for production and environment work.

## Environments

Maintain separate:

- Development.
- Test.
- Staging if needed.
- Production.

Each environment has its own database, secrets, file storage, SMTP, certificate configuration, and external integration credentials.

## Docker

- Use a reproducible Node image.
- Do not bake `.env` or secrets into images.
- Run `prisma generate` during build or install phase.
- Run migrations as a controlled release step, not from arbitrary app instances.

## Environment Variables

Required baseline:

- `DATABASE_URL`.
- `APP_BASE_URL`.
- Session secret.
- CSRF secret if separate.
- Storage paths/providers.
- SMTP secrets.
- Certificate encryption secrets.

Validate env at startup with a schema.

## Migrations

- Use `prisma migrate deploy` in production.
- Review generated SQL before release.
- Backup before risky migrations.
- Use staged migrations for destructive changes.

## Backups

Back up:

- PostgreSQL.
- Uploaded files.
- Certificate metadata and encrypted certificate store.
- Key material needed to decrypt backups/certificates.
- Configuration required for restore.

Test restore regularly.

## CI/CD

Pipeline should run:

- Install.
- Lint.
- Typecheck.
- Tests.
- Prisma validation.
- Build.
- Migration dry review where possible.

## Health Checks

Expose health that checks:

- App liveness.
- PostgreSQL connectivity.
- Storage reachability.
- Job processor health where applicable.

Do not expose secrets or detailed internal topology publicly.

## Release Safety

- Apply maintenance mode for risky releases.
- Run migrations once.
- Deploy app.
- Verify health.
- Keep rollback and restore steps documented.
