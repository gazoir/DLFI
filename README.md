# DLFI — Damned Lucky Foundry Import

Foundry VTT module that loads **DLCE Session Packages** into a world.

Design: [`gazoir/DLCE` → `docs/FOUNDRY_SYNC.md`](https://github.com/gazoir/DLCE/blob/main/docs/FOUNDRY_SYNC.md).

## Status (`0.1.11`)

Working in this slice:

- **Damned Lucky** top-level scene control (+ Configure Settings menu) → modal tabs Sessions | Import | Pack
- **Import**: scan `Data/dlce-inbox` (setting), list sessions by latest export date, version dropdown, Load
- **Choose zip…** for a local DLCE export without the inbox
- Creates world folders `{DisplayCode} · {Session Name}` for Actors / Items / Scenes / Journals
- Uploads package assets under `Data/dlfi/…`
- Location / Landing / Battlemap / Leftovers scenes (configured templates, or bundled Expo/Landing/Battlemap defaults when unset)
- **DLCE inbox** (`Data/dlce-inbox`): zip-only, auto-created, Browse… picker, nested as `Session Code · Session Name`, keeps 3 newest zips per session
- **DLFI imports** (`Data/dlfi-imports`): separate tree mirroring the Session Package zip layout under `assets/` (ready for DLCE WD-type folders)
- Template placement: fill Description 1 (or appearance), put location POIs as a bullet list in another Description box, bind NPCs to `1A#` slots (actor + token art) including reverse location→NPC links, PCs to `3P#`–`6P#` on Landing, delete unused placeholders
- Battlemaps use the colour (non-grid) combat art and place unlinked enemy tokens from the encounter
- Leftovers holds NPCs/items not placed on any location or battlemap
- NPC actors mapped from DLCE check_*/creature_*/combat_* fields; weapon damage strips ability mod for Foundry’s auto-`@mod`; items + “Items by location” journal; MSD journal
- Exclusive scene navigation; Landing activated

Still stubbed: Pack-to-Archive, Sessions activate/bulk-delete, spell-pack lookup, full PC DDB matching polish.

## Install

1. Clone or copy into Foundry `Data/modules/dlfi`.
2. Enable **Damned Lucky Foundry Import** for the world.
3. (Optional) Set template Scene ids in module settings.
4. In DLCE: **Foundry** → zip lands in `DLCE/Exports/`.
5. Copy the zip into `Data/dlce-inbox/` (or use **Choose zip…**).
6. Open Damned Lucky → Import → Refresh → Load.

## Package contract

`schemas/dlce-session-package.schema.json` mirrors DLCE. `packageFormatVersion` must be `1`.
