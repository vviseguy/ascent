// ============================================================================
// src/net/room-code.ts — deterministic room code ↔ PeerJS id (reused from Frequency).
// ============================================================================
//
// Grafted from frequency/src/net/roomCode.ts (05-netcode §0 "REUSE verbatim"). The
// COORDINATOR peer's id is fully determined by the room code + generation, so any
// device reaches the current coordinator with NO directory service; migration just
// increments the generation. Rebranded namespace `ascv1-`. The coordinator is the
// signaling pivot / player-id assigner — NOT the simulation owner (we're peer-
// symmetric rollback, §6).
// ============================================================================

const NS = 'ascv1';
// Ambiguity-free alphabet (no I/O/0/1) → codes are easy to read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Generate a fresh 4-letter room code. (Uses Math.random — NOT sim code; lobby only.) */
export function genRoomCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export function isValidCode(code: string): boolean {
  return /^[A-Z]{4}$/.test(code) && [...code].every((c) => ALPHABET.includes(c));
}

/** The canonical COORDINATOR peer id for a code at a given migration generation. */
export function coordinatorPeerId(code: string, generation = 0): string {
  return `${NS}-${code.toUpperCase()}-g${generation}`;
}

/** A member peer's id (coordinator + assigned slot), so the mesh can dial directly. */
export function memberPeerId(code: string, generation: number, slot: number): string {
  return `${NS}-${code.toUpperCase()}-g${generation}-p${slot}`;
}

export function shareLink(code: string): string {
  const base = `${location.origin}${import.meta.env.BASE_URL}`;
  return `${base}?room=${code}`;
}

export function roomFromUrl(): string | null {
  const p = new URLSearchParams(location.search).get('room');
  return p && isValidCode(normalizeCode(p)) ? normalizeCode(p) : null;
}

/** Derive a deterministic session seed (bigint) from a room code — same on all peers. */
export function seedFromCode(code: string): bigint {
  // FNV-1a over the code bytes → 64-bit-ish seed. Deterministic, no Math.random.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const ch of code.toUpperCase()) {
    h = (h ^ BigInt(ch.charCodeAt(0))) & mask;
    h = (h * prime) & mask;
  }
  return h;
}
