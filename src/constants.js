export const DIRECTIONS = ["up", "right", "down", "left"];

export const DELTA = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 }
};

export const SKILL_COOLDOWN_FRAMES = {
  overload: 32,
  cloak: 35,
  teleport: 40,
  freeze: 29,
  shield: 25,
  stun: 20,
  poison: 25,
  boost: 26
};

export const SKILL_DURATION_FRAMES = {
  overload: 10,
  cloak: 6,
  freeze: 2,
  shield: 4,
  stun: 6,
  poison: 4,
  boost: 6
};

export const DEFAULT_MAX_FRAMES = 300;
export const DEFAULT_STAR_LIMIT = null;
export const BULLET_STEPS_PER_FRAME = 2;
export const BOMB_FUSE_FRAMES = 10;
export const BOMB_COOLDOWN_FRAMES = 10;
export const BOMB_BLAST_RANGE = 2;
export const TELEPORT_STAR_PICKUP_LOCK_FRAMES = 2;
export const SHIELD_BULLET_HITS = 2;

export function turnDirection(direction, side) {
  const index = DIRECTIONS.indexOf(direction);
  const safeIndex = index >= 0 ? index : 0;
  return side === "left"
    ? DIRECTIONS[(safeIndex + 3) % 4]
    : DIRECTIONS[(safeIndex + 1) % 4];
}

export function directionDelta(direction) {
  return DELTA[direction] || DELTA.up;
}

export function isCardinalDirection(direction) {
  return direction === "up" || direction === "right" || direction === "down" || direction === "left";
}

export function oppositeDirection(direction) {
  const index = DIRECTIONS.indexOf(direction);
  return DIRECTIONS[((index >= 0 ? index : 0) + 2) % 4];
}
