import {
  BOMB_BLAST_RANGE,
  BOMB_COOLDOWN_FRAMES,
  BOMB_FUSE_FRAMES,
  BULLET_STEPS_PER_FRAME,
  DEFAULT_MAX_FRAMES,
  DEFAULT_STAR_LIMIT,
  SKILL_COOLDOWN_FRAMES,
  SKILL_DURATION_FRAMES,
  TELEPORT_STAR_PICKUP_LOCK_FRAMES,
  directionDelta,
  turnDirection
} from "./constants.js";
import {
  blocksMovement,
  blocksProjectile,
  cloneMap,
  inBounds,
  isGrass,
  isSamePoint,
  normalizeMap,
  parseRawMap,
  setTerrain,
  terrainAt
} from "./map.js";

// 2026-06-18 teleport landing visibility: after a successful teleport, the landing spot is
// briefly revealed to the enemy script even in grass (so grass ambushes have a readable
// counterplay window). Duration is "briefly" on the platform; we model one enemy decision
// frame, which is all the opponent needs to read the position. Tune if platform data differs.
const TELEPORT_REVEAL_FRAMES = 1;

export class AgenTankSimulator {
  constructor(options = {}) {
    const parsed = typeof options.map === "string" ? parseRawMap(options.map) : normalizeMap(options.map || []);
    const map = parsed.map;
    const tanks = options.tanks || parsed.tanks;
    validateTankStarts(tanks);

    this.initialMap = cloneMap(map);
    this.map = cloneMap(map);
    this.frame = 0;
    this.maxFrames = options.maxFrames || DEFAULT_MAX_FRAMES;
    this.starLimit = normalizeStarLimit(options.starLimit);
    this.starProvider = options.starProvider || null;
    this.rng = options.seed == null ? Math.random : seededRandom(options.seed);
    this.initialStar = options.star ? options.star.slice() : null;
    this.star = this.initialStar ? this.initialStar.slice() : null;
    this.nextObjectId = 1;
    this.records = [];
    this.result = null;
    this.players = [0, 1].map((index) => createPlayer(index, tanks[index], options.skills?.[index] || tanks[index]?.skillType));
    this.bullets = [];
    this.bombs = [];
    this.pendingStarEvents = [];
    if (this.star) this.pendingStarEvents.push({ type: "star", action: "created", position: this.star.slice() });
  }

  clone(options = {}) {
    const copy = Object.create(AgenTankSimulator.prototype);
    copy.initialMap = cloneMap(this.initialMap);
    copy.map = cloneMap(this.map);
    copy.frame = this.frame;
    copy.maxFrames = this.maxFrames;
    copy.starLimit = this.starLimit;
    copy.starProvider = options.starProvider === undefined ? this.starProvider : options.starProvider;
    copy.rng = options.rng || (() => 0.5);
    copy.initialStar = this.initialStar ? this.initialStar.slice() : null;
    copy.star = this.star ? this.star.slice() : null;
    copy.nextObjectId = this.nextObjectId;
    copy.records = [];
    copy.result = this.result ? { ...this.result } : null;
    copy.players = this.players.map((player) => clonePlayer(player));
    copy.bullets = this.bullets.map((bullet) => ({ ...bullet, position: bullet.position.slice() }));
    copy.bombs = this.bombs.map((bomb) => ({ ...bomb, position: bomb.position.slice() }));
    copy.pendingStarEvents = this.pendingStarEvents.map((event) => cloneEvent(event));
    return copy;
  }

  snapshotFor(playerIndex) {
    const me = this.players[playerIndex];
    const enemy = this.players[playerIndex === 0 ? 1 : 0];
    return {
      me: this.agentSnapshot(me, me),
      enemy: this.agentSnapshot(enemy, me),
      game: {
        frames: this.frame,
        star: this.star ? this.star.slice() : null,
        map: cloneMap(this.map),
        bombs: this.visibleBombsFor(me)
      }
    };
  }

  agentSnapshot(player, observer) {
    const visibleTank = this.visibleTankFor(player, observer);
    return {
      tank: visibleTank,
      stars: player.stars,
      bullet: this.visibleBulletFor(player, observer),
      skill: player.skillType ? {
        type: player.skillType,
        cooldownFrames: player.skillCooldownFrames,
        remainingCooldownFrames: Math.max(0, player.skillCooldownUntil - this.frame),
        activeRemainingFrames: player.effects.self ? Math.max(0, player.effects.self.expiresAt - this.frame) : 0
      } : null,
      status: {
        ...statusFor(player, this.frame),
        bombActive: this.bombs.some((bomb) => bomb.ownerIndex === player.index && !bomb.exploded)
      },
      effects: effectsFor(player, this.frame)
    };
  }

  visibleTankFor(player, observer) {
    if (!player || player.crashed) return null;
    if (player !== observer && player.effects.self?.type === "cloak") {
      return null;
    }
    if (player !== observer && isGrass(this.map, player.position[0], player.position[1])) {
      // Teleport landing visibility (2026-06-18): a successful teleport briefly reveals the
      // landing spot to the enemy even in grass; otherwise grass hides the tank as before.
      const revealed = player.teleportRevealUntil != null && this.frame <= player.teleportRevealUntil;
      if (!revealed) return null;
    }
    return {
      id: player.objectId,
      position: player.position.slice(),
      direction: player.direction,
      crashed: player.crashed
    };
  }

  visibleBulletFor(player, observer) {
    for (const bullet of this.bullets) {
      if (bullet.ownerIndex !== player.index || bullet.crashed) continue;
      if (player === observer || visibleEnemyBullet(this.map, observer, bullet)) {
        return { position: bullet.position.slice(), direction: bullet.direction };
      }
    }
    return null;
  }

  run(botA, botB) {
    while (!this.result && this.frame < this.maxFrames) {
      const decisions = [botA, botB].map((bot, index) => {
        const player = this.players[index];
        if (!bot || player.crashed || !canActThisFrame(player, this.frame)) return { action: null, logs: [], runtimeMs: 0 };
        return bot.decide(this.snapshotFor(index));
      });
      this.step(decisions.map((item) => item.action), decisions);
    }
    if (!this.result) this.finishByScore();
    return this.toReplayData();
  }

  async runAsync(botA, botB) {
    while (!this.result && this.frame < this.maxFrames) {
      const decisions = await Promise.all([botA, botB].map((bot, index) => {
        const player = this.players[index];
        if (!bot || player.crashed || !canActThisFrame(player, this.frame)) return { action: null, logs: [], runtimeMs: 0 };
        return bot.decide(this.snapshotFor(index));
      }));
      this.step(decisions.map((item) => item.action), decisions);
    }
    if (!this.result) this.finishByScore();
    return this.toReplayData();
  }

  step(actions = [], decisions = []) {
    if (this.result) return [];
    const frameEvents = [];
    frameEvents.push(...this.pendingStarEvents);
    this.pendingStarEvents = [];

    this.expireEffects(frameEvents);
    this.explodeDueBombs(frameEvents);
    if (this.result) {
      this.records.push(frameEvents);
      this.frame += 1;
      return frameEvents;
    }

    const startPositions = this.players.map((player) => player.position.slice());
    const moveIntentByIndex = new Map();
    for (const index of [0, 1]) {
      const player = this.players[index];
      const action = normalizedActionForPlayer(player, actions[index], this.frame, this.rng);
      actions[index] = action;
      if (!player.crashed && (action?.type === "go" || action?.type === "turnGo")) {
        const moveDirection = action.type === "turnGo"
          ? turnDirection(player.direction, action.side === "left" ? "left" : "right")
          : player.direction;
        const delta = directionDelta(moveDirection);
        moveIntentByIndex.set(index, boostedDestination(this.map, player, delta, this.players));
      }
    }

    for (const index of [0, 1]) {
      const decision = decisions[index] || {};
      for (const log of decision.logs || []) {
        if (log.type === "speak") {
          frameEvents.push({
            type: "speech",
            action: "speak",
            by: index,
            objectId: this.players[index].objectId,
            text: log.data
          });
        }
      }
      const player = this.players[index];
      if (player.crashed || !canActThisFrame(player, this.frame)) continue;
      player.runTimeMs += Number(decision.runtimeMs || 0);
      this.applyPlayerAction(player, actions[index], frameEvents, moveIntentByIndex, startPositions);
      this.collectStar(player, frameEvents);
      this.checkTankCollision(frameEvents);
      if (this.result) break;
    }

    if (!this.result) {
      this.moveBullets(frameEvents);
      if (!this.result) {
        for (const player of this.players) this.collectStar(player, frameEvents);
        this.checkWin();
        if (!this.result) this.ensureStar(frameEvents);
      }
    }

    this.records.push(frameEvents);
    this.frame += 1;
    return frameEvents;
  }

  applyPlayerAction(player, action, events, moveIntentByIndex = new Map(), startPositions = []) {
    if (!action) return;
    if (action.type === "print" || action.type === "speak") return;
    if (action.type === "turn") {
      const side = action.side === "left" ? "left" : "right";
      player.direction = turnDirection(player.direction, side);
      events.push({ type: "tank", action: "turn", direction: side, objectId: player.objectId, stunReversed: Boolean(action.stunReversed) });
      return;
    }
    if (action.type === "go") {
      const next = moveIntentByIndex.get(player.index) || player.position;
      if (this.canTankMoveTo(next, player, moveIntentByIndex, startPositions)) {
        player.position = next;
        events.push({ type: "tank", action: "go", objectId: player.objectId, position: next.slice(), reverse: false });
      }
      return;
    }
    if (action.type === "turnGo") {
      const side = action.side === "left" ? "left" : "right";
      player.direction = turnDirection(player.direction, side);
      events.push({ type: "tank", action: "turn", direction: side, objectId: player.objectId, free: true });
      const next = moveIntentByIndex.get(player.index) || player.position;
      if (this.canTankMoveTo(next, player, moveIntentByIndex, startPositions)) {
        player.position = next;
        events.push({ type: "tank", action: "go", objectId: player.objectId, position: next.slice(), reverse: false });
      }
      return;
    }
    if (action.type === "turnFire") {
      const side = action.side === "left" ? "left" : "right";
      player.direction = turnDirection(player.direction, side);
      events.push({ type: "tank", action: "turn", direction: side, objectId: player.objectId, free: true });
      this.applyPlayerAction(player, { type: "fire" }, events, moveIntentByIndex, startPositions);
      return;
    }
    if (action.type === "back") {
      const delta = directionDelta(player.direction);
      const next = [player.position[0] - delta.x, player.position[1] - delta.y];
      if (this.canTankMoveTo(next, player, moveIntentByIndex, startPositions)) {
        player.position = next;
        events.push({ type: "tank", action: "go", objectId: player.objectId, position: next.slice(), reverse: true });
      }
      return;
    }
    if (action.type === "fire") {
      if (!this.isFireLocked(player) && !this.bullets.some((bullet) => bullet.ownerIndex === player.index && !bullet.crashed)) {
        if (player.effects.self?.type === "overload") {
          this.createOverloadBullets(player, events);
          player.effects.self = null;
          events.push({
            type: "skill",
            action: "expired",
            by: player.index,
            skillType: "overload",
            sourceObjectId: player.objectId,
            targetObjectId: player.objectId
          });
        } else {
          this.createBullet(player, events);
        }
      }
      return;
    }
    if (action.type === "throwBomb") {
      this.placeBomb(player, events);
      return;
    }
    if (isSkillAction(action)) {
      this.applySkill(player, action, events);
    }
  }

  placeBomb(player, events) {
    if (player.bombCooldownUntil > this.frame) return;
    if (this.bombs.some((bomb) => bomb.ownerIndex === player.index && !bomb.exploded)) return;
    const bomb = {
      objectId: this.createObjectId("bomb"),
      ownerIndex: player.index,
      ownerObjectId: player.objectId,
      position: player.position.slice(),
      createdAt: this.frame,
      explodesAt: this.frame + BOMB_FUSE_FRAMES,
      exploded: false
    };
    this.bombs.push(bomb);
    events.push({
      type: "bomb",
      action: "created",
      objectId: bomb.objectId,
      by: player.index,
      position: bomb.position.slice(),
      hidden: isGrass(this.map, bomb.position[0], bomb.position[1])
    });
  }

  explodeDueBombs(events) {
    const remaining = [];
    for (const bomb of this.bombs) {
      if (bomb.exploded) continue;
      if (bomb.explodesAt > this.frame) {
        remaining.push(bomb);
        continue;
      }
      this.explodeBomb(bomb, events);
    }
    this.bombs = remaining;
    this.resolveCrashResult();
  }

  explodeBomb(bomb, events) {
    bomb.exploded = true;
    const owner = this.players[bomb.ownerIndex];
    if (owner) owner.bombCooldownUntil = Math.max(owner.bombCooldownUntil || 0, this.frame + BOMB_COOLDOWN_FRAMES + 1);
    const cells = this.bombBlastCells(bomb.position);
    events.push({
      type: "bomb",
      action: "exploded",
      objectId: bomb.objectId,
      by: bomb.ownerIndex,
      position: bomb.position.slice(),
      cells: cells.map((cell) => cell.slice())
    });
    for (const cell of cells) {
      if (terrainAt(this.map, cell[0], cell[1]) === "m") {
        setTerrain(this.map, cell[0], cell[1], ".");
        events.push({ type: "map", action: "destroyed", position: cell.slice() });
      }
    }
    for (const player of this.players) {
      if (player.crashed || !cells.some((cell) => isSamePoint(cell, player.position))) continue;
      if (player.effects.self?.type === "shield") {
        player.effects.self = null;
        events.push({
          type: "skill",
          action: "expired",
          by: player.index,
          skillType: "shield",
          sourceObjectId: player.objectId,
          targetObjectId: player.objectId
        });
        continue;
      }
      this.crashTank(player, events, { deferResult: true });
    }
  }

  bombBlastCells(position) {
    const cells = [position.slice()];
    for (const direction of ["up", "right", "down", "left"]) {
      const delta = directionDelta(direction);
      for (let distance = 1; distance <= BOMB_BLAST_RANGE; distance += 1) {
        const cell = [position[0] + delta.x * distance, position[1] + delta.y * distance];
        if (!inBounds(this.map, cell[0], cell[1])) break;
        const terrain = terrainAt(this.map, cell[0], cell[1]);
        if (terrain === "x") break;
        cells.push(cell);
        if (terrain === "m") break;
      }
    }
    return cells;
  }

  createBullet(player, events) {
    const bullet = {
      objectId: this.createObjectId("b"),
      ownerIndex: player.index,
      ownerObjectId: player.objectId,
      position: player.position.slice(),
      direction: player.direction,
      crashed: false
    };
    this.bullets.push(bullet);
    events.push({
      type: "bullet",
      action: "created",
      objectId: bullet.objectId,
      direction: bullet.direction,
      tank: tankEventSnapshot(player)
    });
  }

  createOverloadBullets(player, events) {
    this.createBullet(player, events);
    const offset = overloadSpreadOffset(player.direction);
    this.createBulletAt(player, [player.position[0] + offset.x, player.position[1] + offset.y], events);
  }

  createBulletAt(player, position, events) {
    const bullet = {
      objectId: this.createObjectId("b"),
      ownerIndex: player.index,
      ownerObjectId: player.objectId,
      position: position.slice(),
      direction: player.direction,
      crashed: false
    };
    this.bullets.push(bullet);
    events.push({
      type: "bullet",
      action: "created",
      objectId: bullet.objectId,
      direction: bullet.direction,
      tank: tankEventSnapshot(player)
    });
  }

  applySkill(player, action, events) {
    const type = action.type;
    if (player.skillType !== type || player.skillCooldownUntil > this.frame) return;
    player.skillCooldownFrames = SKILL_COOLDOWN_FRAMES[type] || 32;
    player.skillCooldownUntil = this.frame + player.skillCooldownFrames + 1;
    events.push({ type: "skill", action: "cast", by: player.index, skillType: type, sourceObjectId: player.objectId });

    if (type === "teleport") {
      const requestedTarget = [Number(action.x), Number(action.y)];
      const target = this.resolveTeleportTarget(requestedTarget, player);
      if (!target) return;
      const from = player.position.slice();
      player.position = target;
      player.teleportRevealUntil = this.frame + TELEPORT_REVEAL_FRAMES;
      player.starPickupLockedUntil = Math.max(
        player.starPickupLockedUntil || 0,
        this.frame + TELEPORT_STAR_PICKUP_LOCK_FRAMES + 1
      );
      const enemy = this.players[player.index === 0 ? 1 : 0];
      if (!enemy.crashed && manhattan(player.position, enemy.position) <= 4) {
        player.fireLockedUntil = Math.max(player.fireLockedUntil || 0, this.frame + 3);
      }
      events.push({
        type: "skill",
        action: "applied",
        by: player.index,
        skillType: "teleport",
        sourceObjectId: player.objectId,
        targetObjectId: player.objectId,
        from,
        to: target.slice(),
        requestedTo: requestedTarget.slice()
      });
      return;
    }

    if (type === "freeze" || type === "stun" || type === "poison") {
      const enemy = this.players[player.index === 0 ? 1 : 0];
      const duration = SKILL_DURATION_FRAMES[type] || 0;
      if (!duration || enemy.crashed) return;
      const expiresAt = this.frame + duration + (type === "stun" ? 1 : 0);
      enemy.effects.debuff = { type, expiresAt };
      events.push({
        type: "skill",
        action: "applied",
        by: player.index,
        durationFrames: duration,
        skillType: type,
        sourceObjectId: player.objectId,
        targetObjectId: enemy.objectId
      });
      return;
    }

    const duration = SKILL_DURATION_FRAMES[type] || 0;
    if (!duration) return;
    player.effects.self = { type, expiresAt: this.frame + duration };
    events.push({
      type: "skill",
      action: "applied",
      by: player.index,
      durationFrames: duration,
      skillType: type,
      sourceObjectId: player.objectId,
      targetObjectId: player.objectId
    });
  }

  moveBullets(events) {
    const active = [];
    for (const bullet of this.bullets) {
      if (bullet.crashed) continue;
      const owner = this.players[bullet.ownerIndex];
      let alive = true;
      for (let order = 0; order < BULLET_STEPS_PER_FRAME; order += 1) {
        const delta = directionDelta(bullet.direction);
        const next = [bullet.position[0] + delta.x, bullet.position[1] + delta.y];
        if (!inBounds(this.map, next[0], next[1])) {
          events.push(this.bulletCrashEvent(bullet, owner));
          alive = false;
          break;
        }
        const shieldedTank = this.players.find((player) => (
          !player.crashed &&
          player.index !== bullet.ownerIndex &&
          player.effects.self?.type === "shield" &&
          isSamePoint(player.position, next)
        ));
        if (shieldedTank) {
          bullet.position = next;
          events.push(this.bulletGoEvent(bullet, owner, order));
          shieldedTank.effects.self = null;
          events.push({
            type: "skill",
            action: "expired",
            by: shieldedTank.index,
            skillType: "shield",
            sourceObjectId: shieldedTank.objectId,
            targetObjectId: shieldedTank.objectId
          });
          events.push(this.bulletCrashEvent(bullet, owner));
          alive = false;
          break;
        }
        const hitTank = this.players.find((player) => !player.crashed && isSamePoint(player.position, next));
        if (hitTank) {
          bullet.position = next;
          events.push(this.bulletGoEvent(bullet, owner, order));
          this.crashTank(hitTank, events, { deferResult: true });
          events.push(this.bulletCrashEvent(bullet, owner));
          alive = false;
          break;
        }
        if (blocksProjectile(this.map, next[0], next[1])) {
          bullet.position = next;
          events.push(this.bulletGoEvent(bullet, owner, order));
          if (this.map[next[0]][next[1]] === "m") {
            setTerrain(this.map, next[0], next[1], ".");
            events.push({ type: "map", action: "destroyed", position: next.slice() });
          }
          events.push(this.bulletCrashEvent(bullet, owner));
          alive = false;
          break;
        }
        bullet.position = next;
        events.push(this.bulletGoEvent(bullet, owner, order));
      }
      if (alive) active.push(bullet);
    }
    this.bullets = active;
    this.resolveCrashResult();
  }

  bulletGoEvent(bullet, owner, order) {
    return {
      type: "bullet",
      action: "go",
      objectId: bullet.objectId,
      order,
      position: bullet.position.slice(),
      direction: bullet.direction,
      tank: tankEventSnapshot(owner)
    };
  }

  bulletCrashEvent(bullet, owner) {
    bullet.crashed = true;
    return {
      type: "bullet",
      action: "crashed",
      objectId: bullet.objectId,
      direction: bullet.direction,
      tank: tankEventSnapshot(owner)
    };
  }

  canTankMoveTo(position, actor, moveIntentByIndex = new Map(), startPositions = []) {
    if (!Array.isArray(position) || !Number.isInteger(position[0]) || !Number.isInteger(position[1])) return false;
    if (blocksMovement(this.map, position[0], position[1])) return false;
    for (const player of this.players) {
      if (player === actor || player.crashed) continue;
      if (isSamePoint(player.position, position)) return false;
      const otherIntent = moveIntentByIndex.get(player.index);
      const actorStart = startPositions[actor.index];
      const otherStart = startPositions[player.index];
      if (otherIntent && actorStart && otherStart && isSamePoint(position, otherStart) && isSamePoint(otherIntent, actorStart)) {
        return false;
      }
    }
    return true;
  }

  canTeleportTo(position, actor) {
    if (!this.canTankMoveTo(position, actor)) return false;
    return !this.bullets.some((bullet) => !bullet.crashed && isSamePoint(bullet.position, position));
  }

  resolveTeleportTarget(requestedTarget, actor) {
    if (this.star && isSamePoint(requestedTarget, this.star)) {
      const candidates = [];
      for (const direction of ["up", "right", "down", "left"]) {
        const delta = directionDelta(direction);
        const position = [this.star[0] + delta.x, this.star[1] + delta.y];
        if (this.canTeleportTo(position, actor)) candidates.push(position);
      }
      if (candidates.length === 0) return null;
      return candidates[Math.floor(this.rng() * candidates.length)].slice();
    }
    return this.canTeleportTo(requestedTarget, actor) ? requestedTarget : null;
  }

  checkTankCollision(events) {
    const [a, b] = this.players;
    if (!a.crashed && !b.crashed && isSamePoint(a.position, b.position)) {
      this.crashTank(a, events);
      this.crashTank(b, events);
    }
  }

  crashTank(player, events, options = {}) {
    if (player.crashed) return;
    player.crashed = true;
    events.push({ type: "tank", action: "crashed", objectId: player.objectId, index: player.index });
    if (options.deferResult) return;
    this.resolveCrashResult();
  }

  resolveCrashResult() {
    const crashed = this.players.filter((player) => player.crashed);
    if (crashed.length === 0) return;
    if (crashed.length === 2) {
      this.result = { winner: this.tieBreakWinner(), reason: "crashed" };
      return;
    }
    const survivor = this.players.find((player) => !player.crashed);
    this.result = { winner: survivor ? survivor.index : null, reason: "crashed" };
  }

  isFireLocked(player) {
    return (player.fireLockedUntil || 0) > this.frame;
  }

  collectStar(player, events) {
    if (!this.star || player.crashed || !isSamePoint(player.position, this.star)) return;
    if ((player.starPickupLockedUntil || 0) > this.frame) return;
    player.stars += 1;
    events.push({ type: "star", action: "collected", by: player.index, position: this.star.slice() });
    this.star = null;
  }

  ensureStar(events) {
    if (this.star) return;
    const next = this.starProvider
      ? this.starProvider({ frame: this.frame, map: this.map, players: this.players.map((player) => publicPlayerState(player, this.frame)) })
      : this.randomStar();
    if (!next) return;
    this.star = next.slice();
    events.push({ type: "star", action: "created", position: this.star.slice() });
  }

  checkWin() {
    if (!this.starLimit) return;
    for (const player of this.players) {
      if (player.stars >= this.starLimit) this.result = { winner: player.index, reason: "star" };
    }
  }

  finishByScore() {
    const [a, b] = this.players;
    const winner = this.tieBreakWinner();
    this.result = { winner, reason: "frameLimit" };
  }

  tieBreakWinner() {
    const [a, b] = this.players;
    if (a.stars !== b.stars) return a.stars > b.stars ? 0 : 1;
    const ar = a.runTimeMs || 0;
    const br = b.runTimeMs || 0;
    if (ar === br) return null;
    return ar < br ? 0 : 1;
  }

  randomStar() {
    const candidates = [];
    for (let x = 0; x < this.map.length; x += 1) {
      for (let y = 0; y < this.map[x].length; y += 1) {
        const position = [x, y];
        if (blocksMovement(this.map, x, y)) continue;
        if (this.players.some((player) => !player.crashed && isSamePoint(player.position, position))) continue;
        candidates.push(position);
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(this.rng() * candidates.length)].slice();
  }

  expireEffects(events) {
    for (const player of this.players) {
      for (const slot of ["self", "debuff"]) {
        const effect = player.effects[slot];
        if (effect && effect.expiresAt <= this.frame) {
          player.effects[slot] = null;
          events.push({
            type: "skill",
            action: "expired",
            by: player.index,
            skillType: effect.type,
            sourceObjectId: slot === "self" ? player.objectId : undefined,
            targetObjectId: player.objectId
          });
        }
      }
    }
  }

  createObjectId(prefix) {
    const value = `${prefix}${String(this.nextObjectId).padStart(7, "0")}`;
    this.nextObjectId += 1;
    return value;
  }

  visibleBombsFor(observer) {
    return this.bombs
      .filter((bomb) => !bomb.exploded)
      .filter((bomb) => !isGrass(this.map, bomb.position[0], bomb.position[1]) || bomb.ownerIndex === observer.index)
      .map((bomb) => ({
        id: bomb.objectId,
        position: bomb.position.slice(),
        remainingFrames: Math.max(0, bomb.explodesAt - this.frame),
        ownerTankId: bomb.ownerObjectId
      }));
  }

  toReplayData() {
    return {
      replayData: {
        map: { map: cloneMap(this.initialMap), initialStar: this.initialStar ? this.initialStar.slice() : null },
        replay: {
          records: this.records,
          meta: {
            players: this.players.map((player) => ({
              tank: {
                id: player.objectId,
                position: player.startPosition.slice(),
                direction: player.startDirection
              },
              runTime: player.runTimeMs
            })),
            result: this.result
          }
        }
      },
      result: this.result
    };
  }
}

function normalizeStarLimit(value) {
  if (value == null || value === false) return DEFAULT_STAR_LIMIT;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STAR_LIMIT;
}

function clonePlayer(player) {
  return {
    ...player,
    startPosition: player.startPosition.slice(),
    position: player.position.slice(),
    effects: {
      self: player.effects.self ? { ...player.effects.self } : null,
      debuff: player.effects.debuff ? { ...player.effects.debuff } : null
    }
  };
}

function cloneEvent(event) {
  if (!event || typeof event !== "object") return event;
  const copy = { ...event };
  if (Array.isArray(event.position)) copy.position = event.position.slice();
  if (Array.isArray(event.from)) copy.from = event.from.slice();
  if (Array.isArray(event.to)) copy.to = event.to.slice();
  return copy;
}

function validateTankStarts(tanks) {
  if (!Array.isArray(tanks) || !isValidTankStart(tanks[0]) || !isValidTankStart(tanks[1])) {
    throw new Error("Simulator requires two tank start states");
  }
}

function isValidTankStart(tank) {
  return Boolean(tank && Array.isArray(tank.position) && tank.position.length >= 2);
}

function createPlayer(index, tank, skillType) {
  const position = tank.position ? tank.position.slice() : [0, 0];
  const direction = tank.direction || "up";
  return {
    index,
    objectId: tank.id || `tank${index + 1}`,
    startPosition: position.slice(),
    startDirection: direction,
    position,
    direction,
    stars: tank.stars || 0,
    skillType: skillType || tank.skillType || null,
    skillCooldownFrames: SKILL_COOLDOWN_FRAMES[skillType || tank.skillType] || 32,
    skillCooldownUntil: 0,
    bombCooldownUntil: 0,
    fireLockedUntil: 0,
    starPickupLockedUntil: 0,
    runTimeMs: 0,
    crashed: false,
    teleportRevealUntil: -1,
    effects: { self: null, debuff: null }
  };
}

function isControlled(player) {
  return player.effects.debuff?.type === "freeze";
}

function canActThisFrame(player, frame) {
  if (isControlled(player)) return false;
  if (player.effects.debuff?.type === "poison") return frame % 2 === 0;
  return true;
}

function normalizedActionForPlayer(player, action, frame, rng) {
  if (!action || player.crashed || !canActThisFrame(player, frame)) return null;
  if (player.effects.debuff?.type !== "stun") return action;
  if (action.type === "turn") {
    const side = rng() < 0.5 ? action.side : oppositeSide(action.side);
    return {
      ...action,
      side,
      stunReversed: side !== action.side
    };
  }
  if (action.type === "go") {
    return rng() < 0.5 ? action : { type: "back", stunReversed: true };
  }
  return action;
}

function isSkillAction(action) {
  return ["overload", "cloak", "teleport", "freeze", "shield", "stun", "poison", "boost"].includes(action?.type);
}

function boostedDestination(map, player, delta, players) {
  const first = [player.position[0] + delta.x, player.position[1] + delta.y];
  if (player.effects.self?.type !== "boost") return first;
  if (blocksMovement(map, first[0], first[1]) || occupiedByOther(players, player, first)) return first;
  const second = [first[0] + delta.x, first[1] + delta.y];
  if (blocksMovement(map, second[0], second[1]) || occupiedByOther(players, player, second)) return first;
  return second;
}

function occupiedByOther(players, actor, position) {
  return players.some((player) => player !== actor && !player.crashed && isSamePoint(player.position, position));
}

function oppositeSide(side) {
  return side === "left" ? "right" : "left";
}

function statusFor(player, frame = 0) {
  const poisoned = player.effects.debuff?.type === "poison";
  return {
    boosted: player.effects.self?.type === "boost",
    overloaded: player.effects.self?.type === "overload",
    fireLocked: (player.fireLockedUntil || 0) > frame,
    bombCooldownFrames: Math.max(0, (player.bombCooldownUntil || 0) - frame),
    bombActive: false,
    shielded: player.effects.self?.type === "shield",
    stunned: player.effects.debuff?.type === "stun",
    frozen: player.effects.debuff?.type === "freeze",
    poisoned,
    cloaked: player.effects.self?.type === "cloak",
    actionSpeed: poisoned ? 0.5 : 1,
    canActThisFrame: canActThisFrame(player, frame)
  };
}

function effectsFor(player, frame = 0) {
  return {
    self: player.effects.self ? {
      type: player.effects.self.type,
      remainingFrames: Math.max(0, player.effects.self.expiresAt - frame)
    } : null,
    debuff: player.effects.debuff ? {
      type: player.effects.debuff.type,
      remainingFrames: Math.max(0, player.effects.debuff.expiresAt - frame)
    } : null
  };
}

function tankEventSnapshot(player) {
  return {
    id: player.objectId,
    position: player.position.slice(),
    direction: player.direction
  };
}

function publicPlayerState(player, frame = 0) {
  return {
    index: player.index,
    objectId: player.objectId,
    position: player.position.slice(),
    direction: player.direction,
    stars: player.stars,
    skillType: player.skillType,
    status: statusFor(player, frame)
  };
}

function visibleEnemyBullet(map, observer, bullet) {
  return inForwardVisionCone(observer.position, observer.direction, bullet.position) &&
    clearBulletSight(map, observer.position, bullet.position);
}

function inForwardVisionCone(origin, direction, target) {
  if (!origin || !target) return false;
  const dx = target[0] - origin[0];
  const dy = target[1] - origin[1];
  if (dx === 0 && dy === 0) return true;
  if (direction === "up") return dy < 0 && Math.abs(dx) <= -dy;
  if (direction === "right") return dx > 0 && Math.abs(dy) <= dx;
  if (direction === "down") return dy > 0 && Math.abs(dx) <= dy;
  if (direction === "left") return dx < 0 && Math.abs(dy) <= -dx;
  return false;
}

function clearBulletSight(map, a, b) {
  if (!a || !b) return false;
  for (const [x, y] of gridLineCells(a, b)) {
    if (blocksBulletSight(map, x, y)) return false;
  }
  return true;
}

function gridLineCells(a, b) {
  const cells = [];
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);

  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      if (x === a[0] && y === a[1]) continue;
      if (segmentIntersectsCell(a, b, x, y)) cells.push([x, y]);
    }
  }

  return cells.sort((left, right) => {
    const leftDistance = (left[0] - a[0]) ** 2 + (left[1] - a[1]) ** 2;
    const rightDistance = (right[0] - a[0]) ** 2 + (right[1] - a[1]) ** 2;
    return leftDistance - rightDistance;
  });
}

function segmentIntersectsCell(a, b, x, y) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const xMin = x - 0.5;
  const xMax = x + 0.5;
  const yMin = y - 0.5;
  const yMax = y + 0.5;
  let tMin = 0;
  let tMax = 1;

  const clipAxis = (start, delta, min, max) => {
    if (delta === 0) return start >= min && start <= max;
    const first = (min - start) / delta;
    const second = (max - start) / delta;
    tMin = Math.max(tMin, Math.min(first, second));
    tMax = Math.min(tMax, Math.max(first, second));
    return tMin <= tMax;
  };

  return clipAxis(a[0], dx, xMin, xMax) &&
    clipAxis(a[1], dy, yMin, yMax) &&
    tMax - tMin > 1e-9;
}

function blocksBulletSight(map, x, y) {
  const terrain = terrainAt(map, x, y);
  return terrain === "x" || terrain === "m" || terrain === "o";
}

function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function overloadSpreadOffset(direction) {
  if (direction === "up" || direction === "down") return { x: 1, y: 0 };
  return { x: 0, y: 1 };
}

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
