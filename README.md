# DLFI — Damned Lucky Foundry Import

Foundry VTT module that loads **DLCE Session Packages** into a world.

Design: [`gazoir/DLCE` → `docs/FOUNDRY_SYNC.md`](https://github.com/gazoir/DLCE/blob/main/docs/FOUNDRY_SYNC.md).

## Status (`0.1.42`)

- **0.1.42:** Monk's Active Tile Triggers scene nav on Location/Landing/Outro (left: Landing→locations→Outro with rolling window; right: battlemaps); Outro Page Template setting
- **0.1.41:** Location POI drawings: strip `[[wikilinks]]`, 📍 bullets, blank line between entries
- **0.1.40:** Health Estimate: hide on Location NPCs + Landing; show on all battlemap tokens
- **0.1.39:** Item Piles no longer double-add the same item; GG/custom NPC HP = (8 + Con mod) × CR
- **0.1.38:** Import tab **New** badge when inbox zip is newer than the Sessions list copy
- **0.1.37:** Player login gate toolbar 🔒/🔓 (Player → None + `_` name when locked; session players restored when unlocked; Trusted Player untouched); blank passwords on create; hide Active Effect icons on Landing scenes


Working in this slice:

- **Damned Lucky** top-level scene control (+ Configure Settings menu) → modal tabs Sessions (default) | Import | Pack, plus **Players**
- **Sessions**: 4-column artwork grid (Landing Clean / session art), Activate soft-seats players, select/delete from tiles
- **Soft-seat Players**: on Activate / Import, upsert Foundry Users from `flags.dlfi.playerId` / `playerName` (blank password, managed flag — never delete); toolbar **🔒/🔓** locks all Player-role accounts (None + `_` name) or unlocks Live-session players; Trusted Player untouched; Players UI assigns PC + Show/Hide
- **Import**: scan `Data/dlce-inbox` (setting), list sessions by latest export date with Landing/session thumbnails, version dropdown, Load; path frames below the list; modal ~960px
- **Choose zip…** for a local DLCE export without the inbox
- Creates world folders `{DisplayCode} · {Session Name}` for Actors / Items / Scenes / Journals
- Uploads package assets under `Data/dlfi-imports/…` (plus top-level `Landing Page/` slides)
- Location / Landing / Outro / Battlemap / Leftovers scenes (configured templates, or bundled Expo/Landing/Battlemap defaults when unset; Outro uses the **Outro page scene template** setting)
- **MATT scene nav** (requires Monk's Active Tile Triggers): on Location / Landing / Outro, left padding tiles → Landing → locations → Outro (rolling window from Scene 7 when >14); right portrait tiles → battlemaps (prefer location-linked); unused placeholders deleted
- **MSD scene order:** location + combat battlemap scenes share one sequence (`01. 📍 Name`, `02. ⚔️ Name`) from unified `msdOrder` when present, else locations then linked combats (including reverse location→challenge hosts); non-combat challenges excluded
- **Battlemap backgrounds:** resolve colour maps from `assets/location/battlemaps/{locationId}` (DLCE v2) via host location, not only legacy `assets/battlemaps/`
- **MSD journal:** package HTML → Foundry single-column page (location + challenge `<h2>` for ToC, `../assets/…` → uploaded world paths, `@UUID` links); see `docs/DLCE_AGENT_BRIEF_MSD_FOUNDRY.md`
- **Landing Page art:** DLCE exports Clean / Logo_Burn / Logo_Only / Title_Only under `Landing Page/`; DLFI uses **Clean** as the Landing scene background and swaps template tiles named **Logo Only** / **Title Only** with those PNGs (Logo_Burn kept on disk / BG fallback)
- **DLCE inbox** (`Data/dlce-inbox`): zip-only, auto-created, Browse… picker, nested as `Session Code · Session Name`, keeps 3 newest zips per session
- **DLFI imports** (`Data/dlfi-imports`): separate tree mirroring the Session Package zip layout under `assets/` (ready for DLCE WD-type folders)
- Template placement: fill dedicated Location drawings — **Description** (description/appearance), **POIs** (bullet list), **Session Notes** — delete empty/unused boxes (incl. legacy Description 4); bind NPCs to `1A#` slots (actor + token art) including reverse location→NPC links; Landing PCs only on `{partySize}P{seat}` placeholders (keep template x/y/scale; 2→`4P2`+`4P3`, 3–6→that row, 7+→`6P*` + overflow; delete unused `nPm` rows; ignore non-`nPm` tokens)
- Battlemaps use the colour (non-grid) combat art; place unlinked enemies then linked PCs+pets in two footprint-spaced rows flush to the canvas bottom (below map art), with correct token size
- PCs: match by DDB id/name or clone the bundled Player Character template into a stub under the shared **Damned Lucky** Actor folder (Actor name = Known as, full name in `flags.dlfi.fullName`, Known as on the prototype token, DDB Beyond URL flags, package portrait/token); fill-only on re-import always applies package art + Known as (over DDB/default); DialogV2 when stubs are created without a DDB URL; pets from `pcs[].pets` become NPC actors with combat stats
- Import console progress: numbered step logs with timings so long imports do not look hung
- Leftovers holds NPCs/items not placed on any location or battlemap
- NPC actors mapped from DLCE check_*/creature_*/combat_* fields; weapon damage strips ability mod for Foundry’s auto-`@mod`; items + “Items by location” journal; MSD journal
- Exclusive scene navigation; Landing activated
- **Sessions tab:** lists imported sessions (by `sessionCode`, with scene/actor/item/journal counts and a Live badge); **Activate** flips exclusive navigation + Landing + live-session setting without re-importing; **bulk delete** removes the selected sessions' world folders, scenes, actors, items and journals (PC actors are kept) and, when Foundry allows file deletion, `Data/dlfi-imports/{sessionCode}__*`
- **Replace on re-import** (world setting, default on): loading a session code that is already imported first removes its previous import so re-syncs do not pile up
- **NPC prototype tokens:** Lock Artwork Rotation on, name display = Hovered by Anyone (`30`); enemies that appear in combat encounters are **unlinked** (`actorLink: false`), other NPCs and PCs stay linked; NPCs with several token art slots get `randomImg: true` and a `*` wildcard `texture.src` (see below)
- **0.1.20:** format v3 accepted without warning; FilePicker resolved via `foundry.applications.apps.FilePicker.implementation` (V13+/V15-safe); battlemap enemy collect/placement logged (counts + npc ids, warnings when empty); 404 on asset purge treated as already deleted
- **0.1.21:** battlemap party placement logs skipped PC/pet ids and reasons when `manifest.pcs` is non-empty but tokens are not placed
- **0.1.22:** Landing PC placement picks the party-size `{n}P*` row from the world Landing template (2→centred `4P2`/`4P3`; 7+ overflows past `6P6`); keeps template position/scale; PCs only
- **0.1.23:** Landing background = Clean; Logo Only / Title Only art replace named template tiles
- **0.1.24:** PC tokens Friendly; location NPC tokens Neutral (combat enemies stay Hostile)
- **0.1.25:** Melee attacks pick DEX when to-hit matches DEX+prof (fixes Imp Sting +10); warn when to-hit is wild for CR
- **0.1.26:** Battlemap PC tokens use Known as + Hovered by Anyone (default prototype too)
- **0.1.36:** Soft-seat player accounts on Activate/Import; Players UI; Sessions default tab + 4-wide art grid; inbox Landing Clean thumbs; Import paths below list; modal ~960px; store `pcs[].playerId` on Actor flags
- **0.1.35:** Damned Lucky modal 1200px + row overflow fixes; PC Actor name = Known as; fill-only always applies package portrait/token over DDB art
- **0.1.34:** Widen Damned Lucky modal (960px) so Import path/session rows fit without scrollbars
- **0.1.33:** DialogV2 when Session Package has 0 seated PCs (empty Damned Lucky / no Landing party tokens) with re-export instructions
- **0.1.32:** Remove Expo Item 1–N placeholders from location scenes; Item Pile actors live under `{Session}/Item Piles` with the package item embedded + item portrait; Token Vision disabled on pile tokens
- **0.1.31:** Fix Item Piles detection (`item-piles` module id); PC stubs go in shared Actor folder **Damned Lucky**; step-by-step import console progress with timings; warn when `manifest.pcs` is empty
- **0.1.30:** PC stubs clone bundled `templates/actors/player-character.json` (name / DDB flags / portrait / Known-as token); fill-only updates for existing PCs; DialogV2 when created stubs lack a D&D Beyond URL
- **0.1.29:** Location scenes place related Items as Item Piles in the lower-right padding (Expo template layout); bidirectional item↔location links; sort by plot/magic/consumable/cash/gold/mundane; DialogV2 when Item Piles is inactive
- **0.1.28:** Stop POSTing removed Foundry V14 `/filesystem` on asset purge/inbox prune (no public Data/ delete API); one quiet skip instead of console 404 spam; verified on Foundry 14

Still stubbed: Pack-to-Archive, spell-pack lookup, full PC DDB matching polish.

## Install

1. Clone or copy into Foundry `Data/modules/dlfi`.
2. Enable **Damned Lucky Foundry Import** for the world.
3. (Optional) Set template Scene ids in module settings.
4. In DLCE: **Foundry** → zip lands in `DLCE/Exports/`.
5. Copy the zip into `Data/dlce-inbox/` (or use **Choose zip…**).
6. Open Damned Lucky → Import → Refresh → Load.

## Package contract

`schemas/dlce-session-package.schema.json` mirrors DLCE. `packageFormatVersion` `1`, `2`, or `3` is accepted (v3 = Landing Page assets).

### Landing Page slides

DLCE may include a `Landing Page/` folder (also listed under `manifest.landingPage` / `assets.landingPage`):

| File | Role |
|------|------|
| `*_Clean.*` | Raw session image → **Landing scene background** |
| `*_Logo_Burn.*` | Logo + title burned in (on disk; BG fallback if Clean missing) |
| `*_Logo_Only.*` | Full 16:9 logo → template tile named **Logo Only** |
| `*_Title_Only.*` | Full 16:9 title → template tile named **Title Only** |

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
