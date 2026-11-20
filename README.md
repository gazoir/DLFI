# DLFI — Damned Lucky Foundry Import

Foundry VTT module that loads **DLCE Session Packages** into a world.

Design: [`gazoir/DLCE` → `docs/FOUNDRY_SYNC.md`](https://github.com/gazoir/DLCE/blob/main/docs/FOUNDRY_SYNC.md).

## Status (`0.1.19`)

Working in this slice:

- **Damned Lucky** top-level scene control (+ Configure Settings menu) → modal tabs Sessions | Import | Pack
- **Import**: scan `Data/dlce-inbox` (setting), list sessions by latest export date, version dropdown, Load
- **Choose zip…** for a local DLCE export without the inbox
- Creates world folders `{DisplayCode} · {Session Name}` for Actors / Items / Scenes / Journals
- Uploads package assets under `Data/dlfi-imports/…` (plus top-level `Landing Page/` slides)
- Location / Landing / Battlemap / Leftovers scenes (configured templates, or bundled Expo/Landing/Battlemap defaults when unset)
- **MSD scene order:** location + combat battlemap scenes share one sequence (`01. 📍 Name`, `02. ⚔️ Name`) from unified `msdOrder` when present, else locations then linked combats (including reverse location→challenge hosts); non-combat challenges excluded
- **Battlemap backgrounds:** resolve colour maps from `assets/location/battlemaps/{locationId}` (DLCE v2) via host location, not only legacy `assets/battlemaps/`
- **MSD journal:** package HTML → Foundry single-column page (location + challenge `<h2>` for ToC, `../assets/…` → uploaded world paths, `@UUID` links); see `docs/DLCE_AGENT_BRIEF_MSD_FOUNDRY.md`
- **Landing Page art:** DLCE exports Clean / Logo_Burn / Logo_Only / Title_Only under `Landing Page/`; DLFI uses **Logo_Burn** as the Landing scene background and keeps the other slides in the import tree for manual placement
- **DLCE inbox** (`Data/dlce-inbox`): zip-only, auto-created, Browse… picker, nested as `Session Code · Session Name`, keeps 3 newest zips per session
- **DLFI imports** (`Data/dlfi-imports`): separate tree mirroring the Session Package zip layout under `assets/` (ready for DLCE WD-type folders)
- Template placement: fill dedicated Location drawings — **Description** (description/appearance), **POIs** (bullet list), **Session Notes** — delete empty/unused boxes (incl. legacy Description 4); bind NPCs to `1A#` slots (actor + token art) including reverse location→NPC links, PCs to `3P#`–`6P#` on Landing, delete unused placeholders
- Battlemaps use the colour (non-grid) combat art; place unlinked enemies then linked PCs+pets in two footprint-spaced rows flush to the canvas bottom (below map art), with correct token size
- PCs: match by DDB id/name or create a character stub with DDB Beyond URL flags + package portrait/token; pets from `pcs[].pets` become NPC actors with combat stats
- Leftovers holds NPCs/items not placed on any location or battlemap
- NPC actors mapped from DLCE check_*/creature_*/combat_* fields; weapon damage strips ability mod for Foundry’s auto-`@mod`; items + “Items by location” journal; MSD journal
- Exclusive scene navigation; Landing activated
- **Sessions tab:** lists imported sessions (by `sessionCode`, with scene/actor/item/journal counts and a Live badge); **Activate** flips exclusive navigation + Landing + live-session setting without re-importing; **bulk delete** removes the selected sessions' world folders, scenes, actors, items and journals (PC actors are kept) and, when Foundry allows file deletion, `Data/dlfi-imports/{sessionCode}__*`
- **Replace on re-import** (world setting, default on): loading a session code that is already imported first removes its previous import so re-syncs do not pile up
- **NPC prototype tokens:** Lock Artwork Rotation on, name display = Hovered by Anyone (`30`); enemies that appear in combat encounters are **unlinked** (`actorLink: false`), other NPCs and PCs stay linked; NPCs with several token art slots get `randomImg: true` and a `*` wildcard `texture.src` (see below)

Still stubbed: Pack-to-Archive, spell-pack lookup, full PC DDB matching polish.

## Install

1. Clone or copy into Foundry `Data/modules/dlfi`.
2. Enable **Damned Lucky Foundry Import** for the world.
3. (Optional) Set template Scene ids in module settings.
4. In DLCE: **Foundry** → zip lands in `DLCE/Exports/`.
5. Copy the zip into `Data/dlce-inbox/` (or use **Choose zip…**).
6. Open Damned Lucky → Import → Refresh → Load.

## Package contract

`schemas/dlce-session-package.schema.json` mirrors DLCE. `packageFormatVersion` `1` or `2` is accepted.

### Landing Page slides

DLCE may include a `Landing Page/` folder (also listed under `manifest.landingPage` / `assets.landingPage`):

| File | Role |
|------|------|
| `*_Clean.*` | Raw session image |
| `*_Logo_Burn.*` | Logo + title burned in → **Landing scene background** |
| `*_Logo_Only.*` | Full 16:9 logo on transparency (drop onto scenes) |
| `*_Title_Only.*` | Full 16:9 title on transparency (drop onto scenes) |

Legacy `manifest.sessionArt` still works as a Clean/background fallback.

### NPC token art slots (wildcards)

For NPCs with more than one VTT token, DLCE should export sequentially numbered files and list them on the NPC document entry:

```json
{
  "id": "npc_goblin",
  "type": "npc",
  "token": "assets/npc/tokens/npc_goblin_1.webp",
  "tokens": [
    "assets/npc/tokens/npc_goblin_1.webp",
    "assets/npc/tokens/npc_goblin_2.webp",
    "assets/npc/tokens/npc_goblin_3.webp"
  ],
  "tokenWildcard": "assets/npc/tokens/npc_goblin_*.webp"
}
```

- `tokens` and/or `tokenWildcard` are optional; without them DLFI auto-detects two or more `assets/npc(s)/…/tokens/{id}_{n}.{ext}` files.
- The wildcard must match **only** that NPC's slots (do not leave another `{id}_*` file such as `{id}_token.webp` in the same folder).
- DLFI sets `prototypeToken.texture.src` to the world path with `*` (e.g. `dlfi-imports/…/assets/npc/tokens/npc_goblin_*.webp`) and `prototypeToken.randomImg: true`. Scene placement picks a concrete slot per token.
- `tokenScale` still applies to the wildcard texture.
