---
name: typescript-style
description: TypeScript coding style for CriGestión. Use when writing or reviewing strict TypeScript, Zod schemas, DTOs, Result Pattern, discriminated unions, utility types, naming, module boundaries, or typed application services.
---

# TypeScript Style

Use this skill to keep TypeScript strict, explicit, and boring in the best way.

## Strictness

- Keep `strict` TypeScript assumptions.
- Avoid `any`; use `unknown` at boundaries and narrow it.
- Prefer explicit return types for exported functions.
- Keep domain/application types independent from framework request/response types.

## Zod

- Use Zod at external boundaries: HTTP, forms, env, imports, webhooks.
- Convert Zod output to internal command/query DTOs.
- Do not let Zod schemas become the domain model.

## DTOs

- Use DTOs for API responses and UI data.
- Do not return Prisma models directly from API handlers.
- Avoid leaking internal fields: password hashes, token hashes, certificate paths, secret metadata.

## Result Pattern

Use a Result type for expected business failures:

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

- Use exceptions for unexpected technical failures.
- Map business errors to stable API error codes.

## Discriminated Unions

Use discriminated unions for states and events:

```ts
type InstallationState =
  | { status: "notInitialized" }
  | { status: "initialized"; completedAt: string };
```

## Naming

- Types/interfaces: PascalCase.
- Functions/variables: camelCase.
- Constants: camelCase unless truly global static constants.
- Permission codes: `Module.Action`.
- Database fields through Prisma: camelCase in code, snake_case in table names.

## Utilities

- Keep utilities small and colocated until reuse is real.
- Do not create `helpers` or `utils` dumping grounds.
- Prefer module-specific helpers inside `modules/<module>`.
