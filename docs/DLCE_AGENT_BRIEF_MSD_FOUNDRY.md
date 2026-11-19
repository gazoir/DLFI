# DLCE agent brief — MSD order + Foundry journal package

DLFI **0.1.15+** imports location and combat-battlemap scenes in **MSD appearance order**, and converts package `msd/msd.html` into a single-column Foundry journal with real headings, portraits, and `@UUID` links.

This brief is for the **DLCE** export side. Keep package contract changes additive.

## 1. Export unified `msdOrder` from `buildMsdFlow`

Today `sessionPackage.ts` assigns `documents[].msdOrder` only for **locations**, using an active-document location-only ordinal (first active location = 1, …). That is **not** MSD narrative order and leaves combat challenges without an order.

**Needed:** one shared 1-based `msdOrder` across:

- every **location** section in `buildMsdFlow` order, and
- every **combat** challenge child that appears under a location in that flow

Interleave them in appearance order, for example:

`LocA → combat@A → LocB → LocC`

Non-combat challenges (dialogue, etc.) must **not** receive a scene `msdOrder` (DLFI excludes them from the scene sequence).

When every location + combat challenge entry has `msdOrder`, DLFI sorts the combined list by that field. If any of those entries lack it, DLFI falls back to: locations by `msdOrder`, then each location’s linked combats immediately after it.

Prefer deriving the unified sequence from `buildMsdFlow` (sections + combat children), not from “active docs, locations only.”

## 2. Package MSD HTML must ship usable image URLs

`buildSessionPackage` currently calls `buildMsdDocumentModel` with `artworkUrlById: options.artworkUrlById ?? {}`. When that map is empty (the default in `sessionPackage.ts`), the packaged MSD uses placeholders and **no** package-relative `<img src="assets/…">` paths.

For Foundry journals, either:

- pass a package-relative `artworkUrlById` (and battle-map URLs) when rendering MSD HTML for the zip, **or**
- emit a Foundry single-column MSD variant that already uses package paths under `assets/…`

DLFI rewrites `img` `src` through the uploaded-asset map and can inject portraits from `documents[].portrait` when a section has no nearby `<img>`, but empty artwork URLs in the HTML still leave the journal weaker than the print MSD.

## 3. Keep `data-msd-*` anchors; `session_note` already exported

Do **not** strip these anchors from packaged MSD HTML — DLFI depends on them:

| Attribute | Role |
|-----------|------|
| `data-msd-location-id` / `data-msd-host-id` | Location (and note) section → scene `@UUID` on first heading |
| `data-msd-wd-id` | Child WD section (challenge, NPC, …) → document `@UUID` |
| `data-msd-related-id` | Inline mentions → `@UUID` |
| `data-msd-label` | Link label text |

Also keep exporting per-document `session_note` on document JSON (already done via `readSessionNote` in `sessionPackage.ts`) so location **Session Notes** drawings stay filled.

## DLFI behaviour (reference)

- Scene DM names: `01. Location Name`, `02. Battle — Challenge Name` (zero-padded, sequential).
- Landing and Leftovers are created **after** the MSD-ordered location/battlemap loop.
- MSD journal conversion lives in `scripts/import/msdJournal.mjs` (`convertMsdHtmlForFoundry`).
