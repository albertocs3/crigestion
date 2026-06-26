---
name: security
description: Security guidance for CriGestión web application with Next.js, PostgreSQL, and Prisma. Use when working on authentication, Auth.js, sessions, cookies, CSRF, RBAC permissions, access control, sensitive data, audit logs, rate limiting, security headers, CSP, XSS, SQL injection, secrets, certificates, or any security-sensitive endpoint or workflow.
---

# Security

Use this skill for any security-sensitive work.

## Authentication

- Prefer server-side sessions with opaque tokens in `HttpOnly` cookies.
- Store only token hashes in PostgreSQL.
- Do not store tokens in `localStorage`.
- Validate session, user status, role status, permissions, and security version on the server.

## Auth.js

If Auth.js is adopted:

- Keep credentials provider logic server-only.
- Ensure session strategy supports immediate revocation or database-backed validation.
- Do not expose password hashes or token material through callbacks.

## RBAC

- Use permissions formatted as `Module.Action`.
- Assign permissions to roles, not directly to users.
- Hide UI actions, but always enforce permissions in Route Handlers/application services.
- Revoke sessions or bump security version after role/permission changes.

## CSRF

- Required for cookie-authenticated mutations.
- Verify `Origin`/`Host`.
- Use CSRF tokens for forms and Route Handlers.
- Treat `SameSite` as additional defense, not the only one.

## XSS

- Escape user content by default.
- Avoid `dangerouslySetInnerHTML`.
- Sanitize rich text if it is ever allowed.
- Use CSP in production.

## SQL Injection

- Use Prisma parameterization.
- For raw SQL, use parameterized Prisma APIs only.
- Never interpolate user input into SQL strings.

## Rate Limiting

Rate-limit:

- Login.
- Password reset.
- Initialization.
- Export/download endpoints.
- External integration triggers.

## Headers and CSP

Set security headers in deployment/middleware:

- `Content-Security-Policy`.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy`.
- `Permissions-Policy`.
- HSTS in production HTTPS.

## OWASP Top 10

- Map relevant changes to `docs/seguridad/02-owasp-top-10.md`.
- Treat OWASP Top 10:2025 as the project baseline.
- For non-trivial security changes, request independent review before closing.
- Cover at least access control, crypto, injection, insecure design, misconfiguration, supply chain, authentication, integrity, logging/alerting, and exceptional-condition handling.

## Secrets and Certificates

- Keep secrets outside the repo.
- Store certificates encrypted server-side.
- Never send certificate material to the browser.
- Audit certificate use without logging secrets.
