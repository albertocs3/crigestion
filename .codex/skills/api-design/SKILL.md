---
name: api-design
description: API design guidance for CriGestión. Use when designing REST endpoints, Route Handlers, validations, errors, pagination, filters, sorting, authentication, permissions, idempotency, rate limiting, or public HTTP contracts.
---

# API Design

Use this skill for HTTP contracts and Route Handlers.

## REST Shape

- Use nouns for resources.
- Use actions only for domain actions that are not CRUD.
- Keep versioning strategy explicit when contracts become external.
- Prefer `GET` for reads, `POST` for creation/actions, `PATCH` for partial updates.
- Avoid physical delete for historical business records.

## Validation

- Validate request bodies, query params, and route params with Zod.
- Reject unsupported content types.
- Return stable error codes.
- Do not echo secrets or sensitive submitted values in errors.

## Errors

Use stable functional codes:

```json
{
  "code": "PLATFORM_ALREADY_INITIALIZED",
  "message": "La plataforma ya esta inicializada."
}
```

- `400`: malformed request.
- `401`: unauthenticated.
- `403`: authenticated but not allowed.
- `404`: not found or intentionally hidden.
- `409`: conflict.
- `422`: validation/business input error.
- `429`: rate limited.

## Pagination

- Use cursor pagination for large mutable lists.
- Use offset only for small admin lists where count matters.
- Always bound `limit`.

## Filters and Sorting

- Whitelist filter fields.
- Whitelist sort fields.
- Validate date ranges.
- Do not pass raw client sort/filter strings into Prisma.

## Authentication and Permissions

For each endpoint define:

- Public or authenticated.
- Required permission.
- CSRF requirement.
- Audit event.
- Rate limit bucket.

## Idempotency

- Require `Idempotency-Key` for retryable mutations that create business effects.
- Store request hash and response for safe replay.
- Reject same key with different request body.
