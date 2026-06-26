---
name: performance
description: Performance guidance for CriGestión. Use when optimizing React cache, memoization, Suspense, Server Components, images, bundle size, Prisma queries, Prisma Optimize, database round-trips, dashboards, reports, and perceived loading speed.
---

# Performance

Use this skill after correctness, security, and clarity are preserved.

## Measure First

- Identify the slow path.
- Use browser profiling for client performance.
- Use database query plans for database performance.
- Avoid premature memoization.

## Server Components

- Prefer Server Components for data-heavy screens.
- Do not ship large data transformation logic to the client.
- Keep permission checks before expensive reads.

## React Cache

- Cache stable reference data carefully.
- Do not cache user-specific sensitive data globally.
- Invalidate cached data when configuration or permissions change.

## Memo

- Use `memo`, `useMemo`, and `useCallback` only for measured client bottlenecks or stable APIs passed to expensive children.

## Suspense

- Use Suspense for slow independent panels.
- Keep primary page structure fast.
- Do not delay authorization checks into suspended children.

## Images

- Use Next image handling for product/place/user-visible images.
- Avoid huge unoptimized uploads.
- Keep operational UI iconography lightweight.

## Bundle

- Lazy-load charts, editors, and heavy widgets.
- Keep shadcn/ui imports narrow.
- Avoid clientifying whole pages unnecessarily.

## Prisma

- Select only required fields.
- Avoid accidental large `include` trees.
- Batch or restructure N+1 query patterns.
- Use Prisma Optimize or query logging when investigating hot paths.

## Dashboards and Reports

- Pre-aggregate when reports become expensive.
- Paginate operational lists.
- Stream independent read-only widgets when useful.
