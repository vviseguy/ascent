// ============================================================================
// src/render/first-person.test.ts — the eye's INPUT half.
// ============================================================================
//
// `npm run fp:snap` photographs what the eye SEES; nothing there can press Escape or
// move a locked pointer, so this covers the other half: look signs, the pitch clamp,
// the two-stage Escape, and the guarantee that a stray mousemove with the pointer FREE
// never swings the view.
//
// The suite runs on `environment: 'node'` and the project has no jsdom, so the handful
// of DOM calls the class makes are stubbed here rather than dragging in a dependency for
// four methods. The stub is deliberately dumb: it records listeners so the test can fire
// them, and nothing else.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { InputController } from './input-controller.ts';

const DEG = Math.PI / 180;

interface StubEl {
  style: Record<string, string>;
  innerHTML: string;
  tagName: string;
  listeners: Map<string, ((e: unknown) => void)[]>;
  addEventListener(t: string, f: (e: unknown) => void): void;
  appendChild(c: StubEl): void;
  remove(): void;
  requestPointerLock(): void;
}

function el(tagName = 'DIV'): StubEl {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  return {
    style: {}, innerHTML: '', tagName, listeners,
    addEventListener(t, f) { (listeners.get(t) ?? listeners.set(t, []).get(t)!).push(f); },
    appendChild() { /* the host only needs to accept the nodes */ },
    remove() { /* dispose() only needs this to exist */ },
    requestPointerLock() { /* the veil's click; locking is faked via `lock()` below */ },
  };
}

/** Global listeners the class installs on `document` / `window`, so a test can fire them. */
const globals = new Map<string, ((e: unknown) => void)[]>();
function fire(type: string, ev: unknown): void {
  for (const f of globals.get(type) ?? []) f(ev);
}

let canvas: StubEl;
let host: StubEl;
let input: InputController;
let saved: { document: unknown; window: unknown };

beforeEach(() => {
  globals.clear();
  canvas = el('CANVAS');
  host = el();
  const bus = {
    addEventListener(t: string, f: (e: unknown) => void) { (globals.get(t) ?? globals.set(t, []).get(t)!).push(f); },
    removeEventListener(t: string, f: (e: unknown) => void) {
      const a = globals.get(t); if (a) a.splice(a.indexOf(f), 1);
    },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  saved = { document: g['document'], window: g['window'] };
  g['document'] = {
    ...bus,
    createElement: () => el(),
    pointerLockElement: null as unknown,
    exitPointerLock() { (g['document'] as { pointerLockElement: unknown }).pointerLockElement = null; },
  };
  g['window'] = bus;
  // only `focusYaw` is ever touched; the rest of InputController is irrelevant here.
  input = { focusYaw: 0 } as unknown as InputController;
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g['document'] = saved.document;
  g['window'] = saved.window;
});

/** Fake the browser acquiring / releasing the pointer, change event included. */
function lock(on: boolean): void {
  const d = (globalThis as unknown as Record<string, unknown>)['document'] as { pointerLockElement: unknown };
  d.pointerLockElement = on ? canvas : null;
  fire('pointerlockchange', {});
}

async function make(): Promise<{ fp: import('./first-person.ts').FirstPersonView }> {
  const { FirstPersonView } = await import('./first-person.ts');
  return { fp: new FirstPersonView(canvas as unknown as HTMLElement, input, host as unknown as HTMLElement) };
}

describe('first-person inspection camera — the input half', () => {
  it('holds no pose until enabled, and gives one up again on disable', async () => {
    const { fp } = await make();
    expect(fp.pose()).toBeNull();
    fp.enable();
    expect(fp.pose()).toEqual({ yaw: 0, pitch: 0 });
    fp.disable();
    expect(fp.pose()).toBeNull();
  });

  it('IGNORES the mouse while the pointer is free', async () => {
    // The window-level mousemove fires constantly during normal play. If it moved the view
    // without the lock, merely opening the mode would send the camera spinning.
    const { fp } = await make();
    fp.enable();
    fire('mousemove', { movementX: 400, movementY: 400 });
    expect(fp.pose()).toEqual({ yaw: 0, pitch: 0 });
  });

  it('turns RIGHT when the mouse goes right, and UP when it goes up', async () => {
    /* The sign is the easy thing to get backwards and the hard thing to notice in a still
       screenshot. Camera forward is (−sin yaw, −cos yaw), so d(forward)/d(yaw) = −right:
       INCREASING yaw turns LEFT. A rightward mouse must therefore DECREASE it. */
    const { fp } = await make();
    fp.enable();
    lock(true);
    fire('mousemove', { movementX: 100, movementY: 0 });
    expect(fp.pose()!.yaw).toBeLessThan(0);          // mouse right → turn right
    fire('mousemove', { movementX: -200, movementY: 0 });
    expect(fp.pose()!.yaw).toBeGreaterThan(0);       // ...and back past centre, to the left
    fire('mousemove', { movementX: 0, movementY: -100 });
    expect(fp.pose()!.pitch).toBeGreaterThan(0);     // mouse up (negative Y) → look up
  });

  it('clamps pitch just short of vertical, from the mouse and from look()', async () => {
    const { fp } = await make();
    fp.enable();
    lock(true);
    fire('mousemove', { movementX: 0, movementY: -100000 });
    expect(fp.pose()!.pitch).toBeCloseTo(88 * DEG, 6);
    fire('mousemove', { movementX: 0, movementY: 200000 });
    expect(fp.pose()!.pitch).toBeCloseTo(-88 * DEG, 6);
    fp.look(1, 99);
    expect(fp.pose()).toEqual({ yaw: 1, pitch: 88 * DEG });
  });

  it('ESCAPE is two-stage: the browser takes the first press, we take the second', async () => {
    /* While locked the browser consumes Escape to release the pointer and never dispatches
       the keydown — so a keydown that DOES reach us while locked would be some other Escape,
       and must not drop the mode out from under a user who only wanted their cursor back. */
    const { fp } = await make();
    fp.enable();
    lock(true);
    fire('keydown', { key: 'Escape', preventDefault() { /* noop */ } });
    expect(fp.pose()).not.toBeNull();                // still in the eye
    lock(false);                                     // ...browser released the pointer
    fire('keydown', { key: 'Escape', preventDefault() { /* noop */ } });
    expect(fp.pose()).toBeNull();                    // second press leaves the mode
  });

  it('V toggles both ways and re-levels the pitch on the way in', async () => {
    const { fp } = await make();
    fp.enable();
    lock(true);
    fire('mousemove', { movementX: 0, movementY: -300 });
    expect(fp.pose()!.pitch).toBeGreaterThan(0);
    fire('keydown', { key: 'v' });
    expect(fp.pose()).toBeNull();
    fire('keydown', { key: 'V' });                   // capitalised (shift held) works too
    expect(fp.pose()!.pitch).toBe(0);                // looking at the horizon, which is the point
  });

  it('writes yaw onto the shared view-only focus, so WASD stays camera-relative', async () => {
    // The one field it touches outside itself. If this stopped happening, the eye and the
    // control frame would silently disagree and W would walk sideways.
    const { fp } = await make();
    fp.enable();
    lock(true);
    fire('mousemove', { movementX: 250, movementY: 0 });
    expect(input.focusYaw).toBeLessThan(0);
    expect(fp.pose()!.yaw).toBe(input.focusYaw);
  });

  it('dispose() unhooks everything, so a torn-down eye cannot still be steering', async () => {
    const { fp } = await make();
    fp.enable();
    lock(true);
    fp.dispose();
    fire('mousemove', { movementX: 500, movementY: 500 });
    fire('keydown', { key: 'v' });
    expect(input.focusYaw).toBe(0);
  });
});
