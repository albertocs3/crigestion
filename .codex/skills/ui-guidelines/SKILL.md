---
name: ui-guidelines
description: UI implementation guidance for CriGestión using shadcn/ui, Tailwind, and Radix UI. Use when building or reviewing accessible responsive UI, forms, tables, dialogs, themes, dashboards, operational backoffice screens, and interaction states.
---

# UI Guidelines

Use this skill for CriGestión UI work.

## Product Feel

CriGestión is an operational business application, not a marketing site.

- Prefer dense, calm, scannable layouts.
- Avoid oversized hero sections, decorative cards, or ornamental backgrounds.
- Optimize for repeated daily work: search, filter, edit, review, confirm.

## Stack

- Use shadcn/ui where useful.
- Use Radix primitives through shadcn/ui.
- Use Tailwind for layout and styling.
- Keep components accessible by default.

## Accessibility

- Labels for every form control.
- Keyboard navigation for dialogs, menus, tables, and destructive actions.
- Visible focus states.
- Correct `aria-*` only when semantic HTML is insufficient.
- Do not rely on color alone for status.

## Responsive

- Desktop-first density is acceptable, but mobile must not break.
- Tables may become horizontal scroll regions for complex data.
- Critical actions must remain reachable on small screens.

## Forms

- Show validation near fields.
- Keep server validation authoritative.
- Prevent double submit.
- Preserve user input after validation errors.
- Mark destructive or irreversible operations clearly.

## Tables

- Include search/filter affordances for operational lists.
- Use stable columns.
- Avoid hidden business-critical data.
- Support empty, loading, error, and no-results states.

## Dialogs

- Use dialogs for focused confirmation or short forms.
- Avoid nesting dialogs.
- Require explicit confirmation for destructive actions.

## Themes

- Keep a restrained professional palette.
- Ensure contrast.
- Do not use one-note palettes dominated by a single hue.
