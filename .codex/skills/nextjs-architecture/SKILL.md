---
name: nextjs-architecture
description: Next.js architecture guidance for CriGestión. Use when designing or editing App Router structure, Server Components, Client Components, Server Actions, Route Handlers, Middleware, caching, streaming, lazy loading, server-only boundaries, or folder organization in the Next.js TypeScript application.
---

# Next.js Architecture

Use this skill to keep CriGestión aligned with a server-first Next.js App Router architecture.

## Core Rules

- Prefer Server Components by default.
- Use Client Components only for browser state, event handlers, forms, dialogs, interactive tables, or browser APIs.
- Keep Prisma, secrets, filesystem access, certificate access, and privileged business logic in server-only code.
- Use Route Handlers for public or integration-facing HTTP contracts.
- Use Server Actions only for UI-owned mutations that do not need to be consumed externally.
- Keep route files thin; delegate business logic to module application services.
- Export `runtime = "nodejs"` for routes that use Prisma, crypto, filesystem, certificates, or Node APIs.
- Export `dynamic = "force-dynamic"` for pages/routes that read request-specific data, auth state, or mutable database state.

## Folder Shape

Use this shape unless the existing code already has a stronger local pattern:

```text
app/
  api/
  (protected)/
components/
lib/
modules/
  platform/
    domain/
    application/
    infrastructure/
    presentation/
prisma/
```

## Server and Client Boundaries

- Do not import `@/lib/prisma` from a file with `"use client"`.
- Do not pass secrets, certificate material, password hashes, or raw session tokens to Client Components.
- Pass plain DTOs from server to client.
- Keep validation schemas shared only when they do not expose server-only logic.

## Route Handlers

For each mutation Route Handler:

- Validate `Content-Type`.
- Validate `Origin` when cookie/session or browser-originated mutation is expected.
- Validate input with Zod.
- Check session and permission unless explicitly public.
- Apply CSRF protection for cookie-authenticated mutations.
- Return stable error codes.
- Audit sensitive or business-relevant actions.

## Caching

- Be explicit: use `dynamic`, `revalidate`, `fetch` cache options, or `unstable_noStore` according to data sensitivity.
- Do not cache per-user, permissioned, financial, audit, or session-derived data globally.
- Cache reference/catalog data only when invalidation is clear.

## Streaming and Suspense

- Use streaming for slow read-only dashboards and large reports.
- Keep critical permission checks outside late-streaming components.
- Never stream partial sensitive data before authorization completes.

## Lazy Loading

- Use dynamic imports for heavy client-only widgets, charts, rich editors, and rarely used dialogs.
- Do not lazy-load security checks or business invariants.
