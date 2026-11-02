# DLFI — Damned Lucky Foundry Import

Foundry VTT module that loads **DLCE Session Packages** into a world.

Design: [`gazoir/DLCE` → `docs/FOUNDRY_SYNC.md`](https://github.com/gazoir/DLCE/blob/main/docs/FOUNDRY_SYNC.md).

## Status (`0.1.6`)

Working in this slice:

- **Damned Lucky** top-level scene control (+ Configure Settings menu) → modal tabs Sessions | Import | Pack
- **Import**: scan `Data/dlce-inbox` (setting), list sessions by latest export date, version dropdown, Load
- **Choose zip…** for a local DLCE export without the inbox
- Creates world folders `{DisplayCode} · {Session Name}` for Actors / Items / Scenes / Journals
- Uploads package assets under `Data/dlfi/…`
- Location / Landing / Battlemap / Inbox scenes (duplicates configured templates when set; accepts Scene id or UUID)
- NPC actors mapped from DLCE check_*/creature_*/combat_* fields (abilities, size, walk/fly/swim, senses, CR, attacks/actions); items + “Items by location” journal; MSD journal
- Exclusive scene navigation; Landing activated

Still stubbed: Pack-to-Archive, Sessions activate/bulk-delete, richer attack activities/conditions, spell-pack lookup, full PC DDB matching polish.

## Install

1. Clone or copy into Foundry `Data/modules/dlfi`.
2. Enable **Damned Lucky Foundry Import** for the world.
3. (Optional) Set template Scene ids in module settings.
4. In DLCE: **Foundry** → zip lands in `DLCE/Exports/`.
5. Copy the zip into `Data/dlce-inbox/` (or use **Choose zip…**).
6. Open Damned Lucky → Import → Refresh → Load.

## Package contract

`schemas/dlce-session-package.schema.json` mirrors DLCE. `packageFormatVersion` must be `1`.
