---
name: testing
description: Testing strategy for CriGestión. Use when adding or reviewing Vitest, Playwright, Testing Library, mocks, fixtures, contract tests, integration tests, E2E flows, or test coverage for Next.js, Prisma, PostgreSQL, and UI behavior.
---

# Testing

Use this skill when planning or writing tests.

## Test Pyramid

- Unit tests: pure domain and application logic.
- Integration tests: Prisma + PostgreSQL + transactions.
- Contract tests: Route Handlers and HTTP error contracts.
- E2E tests: critical browser workflows with Playwright.

## Vitest

- Use for fast unit and integration tests.
- Keep domain tests independent of Next.js.
- Mock ports, not internals.

## PostgreSQL Integration

- Test persistence rules against real PostgreSQL.
- Do not rely on SQLite for PostgreSQL-specific behavior.
- Cover migrations, constraints, transactions, and partial indexes.

## Playwright

- Use for user journeys:
  - initialization,
  - login,
  - permission denial,
  - invoice emission,
  - VeriFactu pending/retry views.
- Assert visible outcomes and backend state when needed.

## Testing Library

- Test UI behavior through accessible roles and labels.
- Avoid brittle CSS-selector assertions.

## Fixtures

- Keep fixtures minimal.
- Avoid real personal, fiscal, banking, certificate, or credential data.
- Use builders only when they cannot create impossible states accidentally.

## Mocks

- Mock external services: AEAT, SMTP, antivirus, bank imports.
- Do not mock the database in integration tests.

## Security Tests

Cover:

- Unauthorized endpoint access.
- Forbidden permission access.
- CSRF protection.
- Password not logged or audited.
- Session revocation.
- Rate limiting for login and initialization.
