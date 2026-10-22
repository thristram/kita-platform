# ADR 0002: keep one Console design system and own the event media picker

Status: accepted, 2026-10-08

## Context

The Console needs consistent tables, dropdowns, dialogs, animation, pagination, and an event-scoped image chooser. Migrating the whole UI to Bootstrap would provide mature primitives, but it would also introduce a second token system and component language beside the existing Radix/shadcn primitives, TanStack Table, Lucide icons, and KitaCon CSS. The current defects are missing reusable behavior and inconsistent composition, not a lack of CSS framework.

Available open-source media tools solve adjacent problems:

- [Uppy](https://github.com/transloadit/uppy) is a mature MIT-licensed uploader with React/headless APIs, Dashboard UI, metadata editing, thumbnails, and dark mode. It is a good future upload surface, but it is not a persistent event-asset library by itself.
- [Damask](https://github.com/vincent/damask) is an Apache-2.0 self-hosted DAM with search, tags, pagination, and versioning. It is a separate product/service rather than an embeddable picker.
- [BlitheForge Media Library](https://github.com/blitheforge/Media-Library) is an embeddable React picker with dark mode and a configurable API, but it is currently small and lacks the maturity, pagination, and asset-governance guarantees required here.

## Decision

Do not migrate the Console to Bootstrap. Continue with the existing React stack and consolidate behavior into reusable KitaCon primitives:

- sortable table headers, search, filters, and pagination from `ConsoleTableControls`;
- Radix/shadcn for new accessible overlays and controls where appropriate;
- Lucide for interface icons;
- one KitaCon token and dark-mode system in `globals.css`;
- restrained state transitions rather than decorative animation.

Implement an owned `MediaAssetField`/picker for Candidate editing. Its first release is scoped to media discovered by the Candidate's crawl, supports search, classification-tag filtering, dimensions, preview, an automatic default-art option, and assignment to event hero, session, exhibitor, or update fields. Selection is saved in the versioned Event Content Bundle draft.

Uppy is the preferred future upload primitive if direct uploads are added. Persisted editorial tags, a global default-art catalog, and cross-event asset reuse require their own media API and schema; they must not be simulated as browser-only state.

## Consequences

- The Console keeps one visual language and avoids a high-risk rewrite.
- Table and worker pages share interaction behavior.
- Candidate image selection works now with auditable crawler media IDs.
- Custom tag authoring and global default assets remain an explicit follow-up, not misleading transient UI.
