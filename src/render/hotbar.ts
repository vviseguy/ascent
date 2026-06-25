// ============================================================================
// src/render/hotbar.ts — the INVENTORY HOTBAR + contextual HINT prompts (DOM HUD).
// ============================================================================
//
// A PURE READER of the deterministic sim (CLAUDE.md / renderer contract): it reads the
// local player's inventory (inv0..inv4 + selSlot) and targeting (targetEntity +
// targetActions) from WorldState and draws:
//   - a 5-slot Minecraft-style HOTBAR, bottom-center, with the selected slot ringed;
//   - contextual PRIMARY / SECONDARY HINT prompts (Minecraft-Dungeons-clean: a button
//     glyph + verb + item name), shown only while the sim reports an available action.
//
// It NEVER writes the sim. It is a separate DOM overlay (kept out of renderer.ts so the
// renderer edit stays minimal — renderer.ts only constructs + ticks this). Style matches
// the app HUD: dark blurred-glass cells, system-ui, a crew-color accent, soft glow.
//
// DETERMINISM: the hotbar contents + the available actions are SIM state (hashed,
// rollback-safe). This file only renders the locally-predicted target/inventory; if a
// rollback corrects them, the next read shows the corrected values — no UI state to sync.
// ============================================================================

import { type WorldState, BodyFlag, NO_ENTITY } from '../sim/world/state.ts';
import { ItemKind, InteractAction } from '../sim/interact/model.ts';
import { NUM_SLOTS } from '../sim/world/input.ts';
import { CREW_COLORS } from './character.ts';

/** Glyph + short label for each ItemKind (the hotbar cell content). */
const ITEM_GLYPH: Record<number, { icon: string; name: string }> = {
  [ItemKind.Empty]: { icon: '', name: '' },
  [ItemKind.Generic]: { icon: '◆', name: 'Item' },
  [ItemKind.Bottle]: { icon: '🜺', name: 'Bottle' },
  [ItemKind.Key]: { icon: '⚷', name: 'Key' },
  [ItemKind.Coin]: { icon: '◉', name: 'Coin' },
};

/** A '#rrggbb' string from a 0xRRGGBB hex int. */
const hex = (c: number): string => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

export class Hotbar {
  /** Root container (bottom-center stack: hint line above, hotbar row below). */
  private root: HTMLElement;
  /** The 5 slot cells + their inner icon/number elements. */
  private cells: { cell: HTMLElement; icon: HTMLElement; num: HTMLElement }[] = [];
  /** The contextual hint line (one PRIMARY + one SECONDARY chip). */
  private hintLine: HTMLElement;
  private primaryChip: HTMLElement;
  private secondaryChip: HTMLElement;
  /** Accent color (the local crew's color). */
  private accent: string;

  constructor(app: HTMLElement, localCrew: number) {
    this.accent = hex(CREW_COLORS[localCrew % CREW_COLORS.length] ?? 0x2fa8ff);

    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:6;' +
      'display:flex;flex-direction:column;align-items:center;gap:10px;' +
      'pointer-events:none;font-family:system-ui';
    this.root = root;

    // --- contextual HINT line (sits just above the hotbar) ---
    const hintLine = document.createElement('div');
    hintLine.style.cssText = 'display:flex;gap:10px;align-items:center;min-height:26px;transition:opacity .18s';
    this.primaryChip = this.makeChip();
    this.secondaryChip = this.makeChip();
    hintLine.append(this.primaryChip, this.secondaryChip);
    this.hintLine = hintLine;

    // --- the 5-slot hotbar row ---
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;gap:7px;padding:7px;border-radius:14px;' +
      'background:rgba(10,10,22,0.72);backdrop-filter:blur(8px);box-shadow:0 4px 20px rgba(0,0,0,.4)';
    for (let s = 0; s < NUM_SLOTS; s++) {
      const cell = document.createElement('div');
      cell.style.cssText =
        'position:relative;width:48px;height:48px;border-radius:10px;' +
        'background:rgba(255,255,255,0.05);border:2px solid rgba(255,255,255,0.10);' +
        'display:flex;align-items:center;justify-content:center;transition:border-color .12s,box-shadow .12s';
      const icon = document.createElement('div');
      icon.style.cssText = 'font-size:24px;line-height:1;color:#ffe9b0;text-shadow:0 0 8px rgba(255,200,90,.5)';
      const num = document.createElement('div');
      num.textContent = String(s + 1);
      num.style.cssText = 'position:absolute;top:2px;left:4px;font-size:9px;font-weight:700;color:#ffffff66';
      cell.append(num, icon);
      row.appendChild(cell);
      this.cells.push({ cell, icon, num });
    }

    root.append(hintLine, row);
    app.appendChild(root);
  }

  /** A single calm hint chip (hidden until update fills it). */
  private makeChip(): HTMLElement {
    const chip = document.createElement('div');
    chip.style.cssText =
      'display:none;align-items:center;gap:7px;padding:4px 11px 4px 5px;border-radius:9px;' +
      'background:rgba(10,10,22,0.78);backdrop-filter:blur(8px);' +
      'font-size:13px;color:#e7ecf3;box-shadow:0 2px 10px rgba(0,0,0,.4)';
    return chip;
  }

  /** Fill a chip with a button glyph + verb (+ optional item name), or hide it. */
  private setChip(chip: HTMLElement, glyph: string, verb: string, item: string): void {
    if (!verb) { chip.style.display = 'none'; return; }
    chip.style.display = 'flex';
    chip.innerHTML = '';
    const g = document.createElement('span');
    g.textContent = glyph;
    g.style.cssText =
      `display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;` +
      `padding:0 6px;border-radius:6px;font-size:11px;font-weight:800;color:#0a0a12;` +
      `background:${this.accent};box-shadow:0 0 10px ${this.accent}88`;
    const t = document.createElement('span');
    t.innerHTML = `<b>${verb}</b>${item ? ` <span style="opacity:.7">${item}</span>` : ''}`;
    chip.append(g, t);
  }

  /**
   * Refresh from the sim. Pure reader of WorldState for the local player. Hides itself
   * if the local player is dead / out of range. Call once per rendered frame.
   */
  update(w: WorldState, localId: number): void {
    if (localId < 0 || localId >= w.count || (w.flags[localId]! & BodyFlag.Alive) === 0) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = 'flex';

    const sel = w.selSlot[localId]!;
    // --- hotbar cells ---
    for (let s = 0; s < NUM_SLOTS; s++) {
      const kind = this.readSlot(w, localId, s);
      const { cell, icon } = this.cells[s]!;
      const meta = ITEM_GLYPH[kind] ?? ITEM_GLYPH[ItemKind.Generic]!;
      icon.textContent = meta.icon;
      const selected = s === sel;
      cell.style.borderColor = selected ? this.accent : 'rgba(255,255,255,0.10)';
      cell.style.boxShadow = selected ? `0 0 0 2px ${this.accent}, 0 0 14px ${this.accent}66` : 'none';
      cell.style.background = kind === ItemKind.Empty ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.10)';
    }

    // --- contextual hints (from the sim's targetActions for the local player) ---
    const actions = w.targetActions[localId]!;
    const target = w.targetEntity[localId]!;
    const activeKind = this.readSlot(w, localId, sel);
    const itemName = (ITEM_GLYPH[activeKind] ?? ITEM_GLYPH[ItemKind.Generic]!).name;
    const targetName = this.nameOf(w, target);

    // PRIMARY chip: first primary-tier action present (left-tap glyph "LMB").
    let pVerb = '', pItem = '';
    if ((actions & InteractAction.Pickup) !== 0) { pVerb = 'Pick up'; pItem = targetName; }
    else if ((actions & InteractAction.Grab) !== 0) { pVerb = 'Grab'; pItem = targetName; }
    else if ((actions & InteractAction.PlaceUse) !== 0) { pVerb = 'Place'; pItem = itemName; }
    else if ((actions & InteractAction.DropBody) !== 0) { pVerb = 'Drop'; pItem = ''; }
    else if ((actions & InteractAction.Open) !== 0) { pVerb = 'Open'; pItem = targetName; }
    this.setChip(this.primaryChip, 'LMB', pVerb, pItem);

    // SECONDARY chip: first secondary-tier action present (right glyph "RMB").
    let sVerb = '', sItem = '';
    if ((actions & InteractAction.ThrowBody) !== 0) { sVerb = 'Throw'; sItem = ''; }
    else if ((actions & InteractAction.ThrowItem) !== 0) { sVerb = 'Throw'; sItem = itemName; }
    else if ((actions & InteractAction.Open) !== 0) { sVerb = 'Open'; sItem = targetName; }
    this.setChip(this.secondaryChip, 'RMB', sVerb, sItem);

    this.hintLine.style.opacity = (pVerb || sVerb) ? '1' : '0';
  }

  /** Read inventory slot `s` (ItemKind) of body `id`. */
  private readSlot(w: WorldState, id: number, s: number): number {
    const arr = s === 0 ? w.inv0 : s === 1 ? w.inv1 : s === 2 ? w.inv2 : s === 3 ? w.inv3 : w.inv4;
    return arr[id] ?? 0;
  }

  /** A short readable name for a targeted body (for the hint), or ''. */
  private nameOf(w: WorldState, id: number): string {
    if (id < 0 || id >= w.count) return '';
    const f = w.flags[id]!;
    if ((f & BodyFlag.Pickup) !== 0) return 'Item';
    if ((f & BodyFlag.Anchor) !== 0) return 'Anchor';
    if ((f & BodyFlag.Player) !== 0) return 'Ally';
    if ((f & BodyFlag.Throwable) !== 0) return 'Object';
    return '';
  }
}
