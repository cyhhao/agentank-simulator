import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgenTankSimulator,
  IsolatedBotRunner,
  createRandomScenario,
  loadBotFromCode,
  loadIsolatedBotFromFile,
  mapFromRows,
  openMap,
  parseRawMap,
  serializeRawMap
} from "../src/index.js";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIMULATE_LOCAL_CLI = fileURLToPath(new URL("../bin/simulate-local.mjs", import.meta.url));

testFrameOrderMovesPlayersBeforeBullets();
testMovingIntoOccupiedCellIsBlockedEvenIfOpponentWouldLeave();
testSwapMoveIsBlockedForBothTanks();
testBulletMovesTwoCellsAndBreaksDirt();
testReplayExportKeepsInitialMapAfterDirtBreak();
testThrowBombPlacesVisibleBombAndCooldown();
testGrassBombHiddenFromEnemySnapshot();
testBombExplosionDestroysDirtStopsAtStoneAndHitsTanks();
await testBotRunnerExposesThrowBombAsCommonAction();
testTeleportMovesImmediatelyAndStartsCooldown();
testInvalidTeleportConsumesCooldown();
testTeleportCannotLandOnEnemyBullet();
testTeleportToStarLandsOnAdjacentCell();
testTeleportStarPickupWaitsTwoFrames();
testTeleportNearEnemyFireLocksForTwoFrames();
testSnapshotMatchesDocumentedRuntimeShape();
await testBotOnlyExposesOwnedSkillMethod();
await testAgentSpeakPrintUseLogsWithoutConsumingAction();
await testBotTimeoutDoesNotHang();
testAsyncBotTimeoutDoesNotHang();
await testAsyncBotRejectionReturnsErrorDecision();
testCloakHidesEnemyTankFromOpponent();
testTeleportLandingRevealsTankInGrass();
testCloakedTankCanStillBeShot();
testFreezeControlsEnemyForTwoFrames();
testGlobalDebuffSkillsApplyThroughDistanceAndWalls();
testStunRandomizesControlsAndExposesStatus();
testPoisonSlowsActionCadenceForFourFrames();
testShieldBlocksOneBulletAndExpires();
testBoostMovesUpToTwoTilesPerGo();
testOverloadStatusDurationAndExpiry();
testOverloadFireCreatesTwoBulletsAndExpires();
testVisibleBulletCanExposeOverloadSpreadBullet();
testEnemyBulletVisibilityUsesForwardCone();
testEnemyBulletVisibilityIsBlockedByTerrain();
testSeededStarSpawnIsDeterministic();
testDefaultStarCollectionDoesNotEndMatch();
testConfiguredWinningStarDoesNotSpawnReplacement();
testDoubleKillTieBreaksByStarsThenRuntime();
testDoubleKillTieBreaksByRuntimeWhenStarsTie();
testCrashResultIsNotOverriddenByStarLimit();
testStarProviderSeesCurrentPlayerStatus();
testRawMapParsingKeepsStartsAndTerrain();
testRandomScenarioGenerationIsSeeded();
testSimulatorRejectsMapsWithMissingTankStart();
testSimulateLocalPassesConfiguredBotTimeout();
testSimulateLocalRandomMapMode();
await testIsolatedBotRunnerBlocksHostFileAccess();
await testIsolatedBotRunnerClosesWorkerAfterInitError();

console.log("simulator check passed");

function testFrameOrderMovesPlayersBeforeBullets() {
  const map = openMap(7, 5);
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [4, 2], direction: "left", skillType: "overload" }
    ]
  });
  sim.bullets.push({
    objectId: "shot",
    ownerIndex: 1,
    ownerObjectId: "b",
    position: [3, 2],
    direction: "left",
    crashed: false
  });
  const events = sim.step([{ type: "go" }, { type: "turn", side: "right" }]);
  assert.deepEqual(events.slice(0, 2).map((event) => event.type + ":" + event.action), ["tank:go", "tank:turn"]);
  assert.equal(events[2].type, "bullet");
  assert.equal(sim.players[0].crashed, false, "player should move before the old bullet advances");
}

function testBulletMovesTwoCellsAndBreaksDirt() {
  const map = openMap(8, 5);
  map[4][2] = "m";
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [6, 3], direction: "left", skillType: "overload" }
    ]
  });
  const events = sim.step([{ type: "fire" }, null]);
  assert.equal(events.filter((event) => event.type === "bullet" && event.action === "go").length, 2);
  assert.deepEqual(events.find((event) => event.type === "map"), { type: "map", action: "destroyed", position: [4, 2] });
  assert.equal(sim.map[4][2], ".");
}

function testReplayExportKeepsInitialMapAfterDirtBreak() {
  const map = openMap(8, 5);
  map[4][2] = "m";
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [6, 3], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "fire" }, null]);
  const replay = sim.toReplayData();
  assert.equal(sim.map[4][2], ".");
  assert.equal(replay.replayData.map.map[4][2], "m");
}

function testThrowBombPlacesVisibleBombAndCooldown() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  let events = sim.step([{ type: "throwBomb" }, null]);
  assert.equal(events.some((event) => event.type === "bomb" && event.action === "created"), true);
  assert.equal(sim.snapshotFor(0).me.status.bombActive, true);
  assert.equal(sim.snapshotFor(0).game.bombs.length, 1);
  assert.equal(sim.snapshotFor(1).game.bombs.length, 1);
  for (let i = 0; i < 10; i += 1) events = sim.step([null, null]);
  assert.equal(events.some((event) => event.type === "bomb" && event.action === "exploded"), true);
  assert.equal(sim.snapshotFor(0).me.status.bombActive, false);
  assert.equal(sim.snapshotFor(0).me.status.bombCooldownFrames, 10);
}

function testGrassBombHiddenFromEnemySnapshot() {
  const map = openMap(9, 7);
  map[2][2] = "o";
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "throwBomb" }, null]);
  assert.equal(sim.snapshotFor(0).game.bombs.length, 1);
  assert.equal(sim.snapshotFor(1).game.bombs.length, 0);
}

function testBombExplosionDestroysDirtStopsAtStoneAndHitsTanks() {
  const map = openMap(9, 7);
  map[4][2] = "m";
  map[5][2] = "m";
  map[1][2] = "x";
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [3, 2], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "throwBomb" }, null]);
  let events = [];
  for (let i = 0; i < 10; i += 1) events = sim.step([null, null]);
  assert.equal(events.some((event) => event.type === "map" && event.action === "destroyed" && event.position[0] === 4 && event.position[1] === 2), true);
  assert.equal(sim.map[4][2], ".");
  assert.equal(sim.map[5][2], "m");
  assert.equal(sim.players[0].crashed, true);
  assert.equal(sim.players[1].crashed, true);
}

async function testBotRunnerExposesThrowBombAsCommonAction() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  const bot = loadBotFromCode(`
    function onIdle(me) {
      me.throwBomb();
    }
  `);
  const decision = bot.decide(sim.snapshotFor(0));
  assert.deepEqual(decision.action, { type: "throwBomb" });
}

function testMovingIntoOccupiedCellIsBlockedEvenIfOpponentWouldLeave() {
  const sim = new AgenTankSimulator({
    map: openMap(8, 5),
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [3, 2], direction: "right", skillType: "overload" }
    ]
  });
  sim.step([{ type: "go" }, { type: "go" }]);
  assert.deepEqual(sim.players[0].position, [2, 2]);
  assert.deepEqual(sim.players[1].position, [4, 2]);
}

function testSwapMoveIsBlockedForBothTanks() {
  const sim = new AgenTankSimulator({
    map: openMap(8, 5),
    tanks: [
      { id: "a", position: [2, 2], direction: "right", skillType: "teleport" },
      { id: "b", position: [3, 2], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "go" }, { type: "go" }]);
  assert.deepEqual(sim.players[0].position, [2, 2]);
  assert.deepEqual(sim.players[1].position, [3, 2]);
}

function testTeleportMovesImmediatelyAndStartsCooldown() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  const events = sim.step([{ type: "teleport", x: 4, y: 4 }, null]);
  assert.deepEqual(sim.players[0].position, [4, 4]);
  assert.equal(sim.snapshotFor(0).me.skill.remainingCooldownFrames, 40);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "applied" && event.skillType === "teleport"), true);
}

function testInvalidTeleportConsumesCooldown() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "teleport", x: 7, y: 5 }, null]);
  assert.deepEqual(sim.players[0].position, [1, 1]);
  assert.equal(sim.snapshotFor(0).me.skill.remainingCooldownFrames, 40);
}

function testTeleportCannotLandOnEnemyBullet() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  sim.bullets.push({ objectId: "enemy-shot", ownerIndex: 1, ownerObjectId: "b", position: [4, 4], direction: "up", crashed: false });
  sim.step([{ type: "teleport", x: 4, y: 4 }, null]);
  assert.deepEqual(sim.players[0].position, [1, 1]);
  assert.equal(sim.snapshotFor(0).me.skill.remainingCooldownFrames, 40);
}

function testTeleportToStarLandsOnAdjacentCell() {
  const sim = new AgenTankSimulator({
    seed: 7,
    star: [4, 4],
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  const events = sim.step([{ type: "teleport", x: 4, y: 4 }, null]);
  assert.notDeepEqual(sim.players[0].position, [4, 4]);
  assert.equal(manhattan(sim.players[0].position, [4, 4]), 1);
  const applied = events.find((event) => event.type === "skill" && event.action === "applied" && event.skillType === "teleport");
  assert.deepEqual(applied.requestedTo, [4, 4]);
  assert.deepEqual(applied.to, sim.players[0].position);
  assert.equal(sim.players[0].stars, 0);
  assert.deepEqual(sim.star, [4, 4]);
}

function testTeleportStarPickupWaitsTwoFrames() {
  const sim = new AgenTankSimulator({
    star: [4, 4],
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "teleport", x: 4, y: 4 }, null]);
  sim.players[0].position = [4, 4];
  let events = sim.step([null, null]);
  assert.equal(events.some((event) => event.type === "star" && event.action === "collected"), false);
  events = sim.step([null, null]);
  assert.equal(events.some((event) => event.type === "star" && event.action === "collected"), false);
  events = sim.step([null, null]);
  assert.equal(events.some((event) => event.type === "star" && event.action === "collected" && event.by === 0), true);
  assert.equal(sim.players[0].stars, 1);
}

function testTeleportNearEnemyFireLocksForTwoFrames() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [8, 5], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "teleport", x: 5, y: 5 }, null]);
  assert.equal(sim.snapshotFor(0).me.status.fireLocked, true);
  let events = sim.step([{ type: "fire" }, null]);
  assert.equal(events.some((event) => event.type === "bullet" && event.action === "created" && event.tank.id === "a"), false);
  events = sim.step([{ type: "fire" }, null]);
  assert.equal(events.some((event) => event.type === "bullet" && event.action === "created" && event.tank.id === "a"), false);
  events = sim.step([{ type: "fire" }, null]);
  assert.equal(events.some((event) => event.type === "bullet" && event.action === "created" && event.tank.id === "a"), true);
}

function testSnapshotMatchesDocumentedRuntimeShape() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "overload" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  sim.step([{ type: "overload" }, null]);
  const snap = sim.snapshotFor(0).me;
  assert.equal(snap.skill.cooldownFrames, 32);
  assert.equal(snap.skill.activeRemainingFrames, 9);
  assert.equal(snap.effects.self.remainingFrames, 9);
  assert.equal(snap.status.actionSpeed, 1);
  assert.equal(snap.status.canActThisFrame, true);
}

async function testBotOnlyExposesOwnedSkillMethod() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  const seen = [];
  const bot = loadBotFromCode(`
    function onIdle(me) {
      print(typeof me.teleport + "," + typeof me.cloak + "," + typeof me.overload);
    }
  `);
  const decision = bot.decide(sim.snapshotFor(0));
  seen.push(decision.logs[0].data);
  assert.deepEqual(seen, ["function,undefined,undefined"]);

  const freezeSim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "freeze" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  const freezeBot = loadBotFromCode(`
    function onIdle(me) {
      print(typeof me.freeze + "," + typeof me.teleport + "," + typeof me.cloak + "," + typeof me.overload);
    }
  `);
  const freezeDecision = freezeBot.decide(freezeSim.snapshotFor(0));
  assert.equal(freezeDecision.logs[0].data, "function,undefined,undefined,undefined");

  const poisonSim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "poison" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  const poisonBot = loadBotFromCode(`
    function onIdle(me) {
      print(typeof me.poison + "," + typeof me.stun + "," + typeof me.shield + "," + typeof me.boost);
    }
  `);
  const poisonDecision = poisonBot.decide(poisonSim.snapshotFor(0));
  assert.equal(poisonDecision.logs[0].data, "function,undefined,undefined,undefined");
}

async function testAgentSpeakPrintUseLogsWithoutConsumingAction() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport", stars: 2 },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  const bot = loadBotFromCode(`
    function onIdle(me) {
      me.speak("hello");
      me.print("stars", me.stars);
      me.go();
    }
  `);
  const decision = bot.decide(sim.snapshotFor(0));
  assert.deepEqual(decision.action, { type: "go" });
  assert.deepEqual(decision.logs, [
    { type: "speak", data: "hello" },
    { type: "print", data: "stars 2" }
  ]);
}

async function testBotTimeoutDoesNotHang() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  const bot = loadBotFromCode(`
    function onIdle() {
      while (true) {}
    }
  `, { timeoutMs: 5 });
  const decision = bot.decide(sim.snapshotFor(0));
  assert.equal(decision.action.type, "timeout");
  assert.equal(decision.runtimeMs < 100, true);
}

function testAsyncBotTimeoutDoesNotHang() {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AgenTankSimulator, loadBotFromCode, openMap } from "./src/index.js";
    const sim = new AgenTankSimulator({
      map: openMap(10, 7),
      tanks: [
        { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
        { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
      ]
    });
    const bot = loadBotFromCode(\`
      async function onIdle() {
        await Promise.resolve();
        while (true) {}
      }
    \`, { timeoutMs: 5 });
    const decision = bot.decide(sim.snapshotFor(0));
    console.log(decision.action.type);
  `], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    timeout: 500
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), "timeout");
}

async function testAsyncBotRejectionReturnsErrorDecision() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const bot = loadBotFromCode(`
      async function onIdle() {
        await Promise.resolve();
        throw new Error("async boom");
      }
    `, { timeoutMs: 50 });
    const decision = await bot.decide(sim.snapshotFor(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(decision.action.type, "error");
    assert.match(decision.action.message, /async boom/);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

function testCloakHidesEnemyTankFromOpponent() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "cloak" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "cloak" }, null]);
  assert.equal(sim.snapshotFor(1).enemy.tank, null);
  assert.notEqual(sim.snapshotFor(0).me.tank, null);
}

function testTeleportLandingRevealsTankInGrass() {
  const map = openMap(9, 7);
  map[4][3] = "o"; // grass landing spot
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [7, 5], direction: "left", skillType: "overload" }
    ]
  });
  sim.step([{ type: "teleport", x: 4, y: 3 }, null]);
  const revealed = sim.snapshotFor(1).enemy.tank;
  assert.notEqual(revealed, null, "teleport landing in grass should be briefly revealed to the enemy");
  assert.deepEqual(revealed.position, [4, 3], "revealed position is the teleport landing spot");
  sim.step([null, null]);
  assert.equal(sim.snapshotFor(1).enemy.tank, null, "after the reveal window grass hides the tank again");
}

function testCloakedTankCanStillBeShot() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "teleport" },
      { id: "b", position: [4, 3], direction: "left", skillType: "cloak" }
    ]
  });
  sim.step([null, { type: "cloak" }]);
  assert.equal(sim.snapshotFor(0).enemy.tank, null);
  sim.step([{ type: "fire" }, null]);
  sim.step([null, null]);
  assert.equal(sim.players[1].crashed, true);
  assert.equal(sim.result.winner, 0);
}

function testFreezeControlsEnemyForTwoFrames() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "freeze" },
      { id: "b", position: [5, 3], direction: "left", skillType: "cloak" }
    ]
  });
  let events = sim.step([{ type: "freeze" }, { type: "go" }]);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "applied" && event.skillType === "freeze"), true);
  assert.deepEqual(sim.players[1].position, [5, 3]);
  assert.equal(sim.snapshotFor(1).me.status.frozen, true);

  events = sim.step([null, { type: "go" }]);
  assert.deepEqual(sim.players[1].position, [5, 3]);
  assert.equal(events.some((event) => event.type === "tank" && event.objectId === "b" && event.action === "go"), false);

  events = sim.step([null, { type: "go" }]);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "expired" && event.skillType === "freeze"), true);
  assert.deepEqual(sim.players[1].position, [4, 3]);
}

function testGlobalDebuffSkillsApplyThroughDistanceAndWalls() {
  const cases = [
    { skill: "freeze", status: "frozen" },
    { skill: "stun", status: "stunned" },
    { skill: "poison", status: "poisoned" }
  ];
  for (const { skill, status } of cases) {
    const map = openMap(18, 9);
    map[8][4] = "x";
    const sim = new AgenTankSimulator({
      map,
      tanks: [
        { id: "a", position: [1, 4], direction: "up", skillType: skill },
        { id: "b", position: [16, 4], direction: "left", skillType: "cloak" }
      ]
    });
    const events = sim.step([{ type: skill }, null]);
    assert.equal(events.some((event) => event.type === "skill" && event.action === "applied" && event.skillType === skill), true);
    assert.equal(sim.snapshotFor(1).me.status[status], true);
  }
}

function testStunRandomizesControlsAndExposesStatus() {
  const sim = new AgenTankSimulator({
    seed: 1,
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "stun" },
      { id: "b", position: [4, 3], direction: "up", skillType: "cloak" }
    ]
  });
  let events = sim.step([{ type: "stun" }, { type: "turn", side: "left" }]);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "applied" && event.skillType === "stun"), true);
  assert.equal(sim.snapshotFor(0).me.skill.remainingCooldownFrames, 20);
  assert.equal(sim.snapshotFor(1).me.status.stunned, true);
  let firstTurn = null;
  for (let i = 0; i < 6; i += 1) {
    events = sim.step([null, { type: "turn", side: "left" }]);
    const turn = events.find((event) => event.type === "tank" && event.objectId === "b" && event.action === "turn");
    if (!firstTurn) firstTurn = turn;
    assert.equal(sim.snapshotFor(1).me.status.stunned, true);
  }
  assert.equal(firstTurn.direction, "left");
  assert.equal(firstTurn.stunReversed, false);
  sim.step([null, { type: "turn", side: "left" }]);
  assert.equal(sim.snapshotFor(1).me.status.stunned, false);
}

function testPoisonSlowsActionCadenceForFourFrames() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 9),
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "poison" },
      { id: "b", position: [4, 3], direction: "down", skillType: "cloak" }
    ]
  });
  let events = sim.step([{ type: "poison" }, { type: "go" }]);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "applied" && event.skillType === "poison"), true);
  assert.equal(sim.snapshotFor(1).me.status.poisoned, true);
  assert.equal(sim.snapshotFor(1).me.status.actionSpeed, 0.5);

  events = sim.step([null, { type: "go" }]);
  assert.equal(events.some((event) => event.type === "tank" && event.objectId === "b" && event.action === "go"), false);
  assert.equal(sim.snapshotFor(1).me.status.canActThisFrame, true);

  events = sim.step([null, { type: "go" }]);
  assert.equal(events.some((event) => event.type === "tank" && event.objectId === "b" && event.action === "go"), true);
  assert.equal(sim.snapshotFor(1).me.status.canActThisFrame, false);

  events = sim.step([null, { type: "go" }]);
  assert.equal(events.some((event) => event.type === "tank" && event.objectId === "b" && event.action === "go"), false);
  assert.equal(sim.snapshotFor(1).me.status.canActThisFrame, true);

  events = sim.step([null, { type: "go" }]);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "expired" && event.skillType === "poison"), true);
  assert.equal(events.some((event) => event.type === "tank" && event.objectId === "b" && event.action === "go"), true);
  assert.equal(sim.snapshotFor(1).me.status.poisoned, false);
}

function testShieldBlocksOneBulletAndExpires() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "overload" },
      { id: "b", position: [4, 3], direction: "left", skillType: "shield" }
    ]
  });
  sim.step([null, { type: "shield" }]);
  assert.equal(sim.snapshotFor(1).me.status.shielded, true);
  sim.step([{ type: "fire" }, null]);
  const events = sim.step([null, null]);
  assert.equal(sim.players[1].crashed, false);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "expired" && event.skillType === "shield"), true);
  assert.equal(sim.snapshotFor(1).me.status.shielded, false);
}

function testBoostMovesUpToTwoTilesPerGo() {
  const map = openMap(10, 7);
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "boost" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  sim.step([{ type: "boost" }, null]);
  assert.equal(sim.snapshotFor(0).me.status.boosted, true);
  assert.equal(sim.snapshotFor(0).me.skill.remainingCooldownFrames, 26);
  sim.step([{ type: "go" }, null]);
  assert.deepEqual(sim.players[0].position, [3, 3]);

  const blockedMap = openMap(10, 7);
  blockedMap[3][3] = "m";
  const blocked = new AgenTankSimulator({
    map: blockedMap,
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "boost" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  blocked.step([{ type: "boost" }, null]);
  blocked.step([{ type: "go" }, null]);
  assert.deepEqual(blocked.players[0].position, [2, 3]);

  const freeTurn = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [1, 3], direction: "right", skillType: "boost" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  freeTurn.step([{ type: "boost" }, null]);
  const events = freeTurn.step([{ type: "turnGo", side: "left" }, null]);
  assert.equal(freeTurn.players[0].direction, "up");
  assert.deepEqual(freeTurn.players[0].position, [1, 1]);
  assert.equal(events.some((event) => event.type === "tank" && event.action === "turn" && event.free), true);
}

function testOverloadStatusDurationAndExpiry() {
  const sim = new AgenTankSimulator({
    map: openMap(9, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "overload" },
      { id: "b", position: [7, 5], direction: "left", skillType: "cloak" }
    ]
  });
  let events = sim.step([{ type: "overload" }, null]);
  assert.equal(sim.snapshotFor(0).me.status.overloaded, true);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "applied" && event.durationFrames === 10), true);
  for (let i = 0; i < 9; i += 1) sim.step([null, null]);
  events = sim.step([null, null]);
  assert.equal(sim.snapshotFor(0).me.status.overloaded, false);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "expired" && event.skillType === "overload"), true);
}

function testOverloadFireCreatesTwoBulletsAndExpires() {
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "overload" },
      { id: "b", position: [8, 5], direction: "left", skillType: "cloak" }
    ]
  });
  sim.step([{ type: "overload" }, null]);
  const events = sim.step([{ type: "fire" }, null]);
  assert.equal(events.filter((event) => event.type === "bullet" && event.action === "created").length, 2);
  assert.deepEqual(sim.bullets.map((bullet) => bullet.position), [[3, 1], [3, 2]]);
  assert.equal(events.some((event) => event.type === "skill" && event.action === "expired" && event.skillType === "overload"), true);
  assert.equal(sim.snapshotFor(0).me.status.overloaded, false);
}

function testVisibleBulletCanExposeOverloadSpreadBullet() {
  const map = openMap(10, 7);
  map[4][1] = "x";
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "overload" },
      { id: "b", position: [7, 2], direction: "left", skillType: "cloak" }
    ]
  });
  sim.step([{ type: "overload" }, null]);
  sim.step([{ type: "fire" }, null]);
  assert.deepEqual(sim.snapshotFor(1).enemy.bullet.position, [3, 2]);
}

function testEnemyBulletVisibilityUsesForwardCone() {
  assert.deepEqual(visibleEnemyBulletSnapshot("up", [5, 2]), [5, 2], "straight ahead should be visible");
  assert.deepEqual(visibleEnemyBulletSnapshot("up", [3, 3]), [3, 3], "left 45 degree boundary should be visible");
  assert.deepEqual(visibleEnemyBulletSnapshot("up", [7, 3]), [7, 3], "right 45 degree boundary should be visible");
  assert.equal(visibleEnemyBulletSnapshot("up", [2, 4]), null, "outside the 90 degree cone should be hidden");
  assert.equal(visibleEnemyBulletSnapshot("up", [5, 7]), null, "behind the observer should be hidden");
  assert.equal(visibleEnemyBulletSnapshot("up", [2, 5]), null, "same-row side bullets should be hidden");

  assert.deepEqual(visibleEnemyBulletSnapshot("right", [8, 2]), [8, 2], "rotated cone boundary should be visible");
  assert.equal(visibleEnemyBulletSnapshot("right", [4, 5]), null, "rotated cone should still hide behind bullets");
}

function testEnemyBulletVisibilityIsBlockedByTerrain() {
  assert.deepEqual(visibleEnemyBulletSnapshot("right", [8, 5]), [8, 5], "open line should expose bullets inside the cone");
  assert.equal(visibleEnemyBulletSnapshot("right", [8, 5], { terrain: [[6, 5, "x"]] }), null, "stone blocks bullet sight");
  assert.equal(visibleEnemyBulletSnapshot("right", [8, 5], { terrain: [[6, 5, "m"]] }), null, "dirt blocks bullet sight");
  assert.equal(visibleEnemyBulletSnapshot("right", [8, 5], { terrain: [[6, 5, "o"]] }), null, "grass blocks bullet sight");
  assert.equal(visibleEnemyBulletSnapshot("right", [8, 7], { terrain: [[6, 5, "x"]] }), null, "off-axis sight checks every crossed cell");
}

function visibleEnemyBulletSnapshot(direction, bulletPosition, options = {}) {
  const map = openMap(11, 11);
  for (const [x, y, terrain] of options.terrain || []) {
    map[x][y] = terrain;
  }
  const sim = new AgenTankSimulator({
    map,
    tanks: [
      { id: "a", position: [5, 5], direction, skillType: "teleport" },
      { id: "b", position: [9, 9], direction: "left", skillType: "overload" }
    ]
  });
  sim.bullets.push({ objectId: "enemy-shot", ownerIndex: 1, ownerObjectId: "b", position: bulletPosition, direction: "left", crashed: false });
  const bullet = sim.snapshotFor(0).enemy.bullet;
  return bullet ? bullet.position : null;
}

function testSeededStarSpawnIsDeterministic() {
  const create = () => new AgenTankSimulator({
    seed: 123,
    map: openMap(7, 5),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [5, 3], direction: "left", skillType: "overload" }
    ]
  });
  const a = create();
  const b = create();
  a.step([null, null]);
  b.step([null, null]);
  assert.deepEqual(a.star, b.star);
}

function testDefaultStarCollectionDoesNotEndMatch() {
  let spawnCount = 0;
  const sim = new AgenTankSimulator({
    seed: 42,
    star: [2, 1],
    map: openMap(7, 5),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [5, 3], direction: "left", skillType: "overload" }
    ],
    starProvider() {
      spawnCount += 1;
      return [3, 1];
    }
  });
  const events = sim.step([{ type: "go" }, null]);
  assert.equal(sim.result, null);
  assert.equal(spawnCount, 1);
  assert.equal(events.some((event) => event.type === "star" && event.action === "collected"), true);
  assert.deepEqual(sim.star, [3, 1]);
}

function testConfiguredWinningStarDoesNotSpawnReplacement() {
  const sim = new AgenTankSimulator({
    seed: 42,
    starLimit: 1,
    star: [2, 1],
    map: openMap(7, 5),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [5, 3], direction: "left", skillType: "overload" }
    ]
  });
  const events = sim.step([{ type: "go" }, null]);
  assert.equal(sim.result.reason, "star");
  assert.equal(events.filter((event) => event.type === "star" && event.action === "created").length, 1);
  assert.equal(events.some((event) => event.type === "star" && event.action === "collected"), true);
  assert.equal(sim.star, null);
  assert.deepEqual(sim.toReplayData().replayData.map.initialStar, [2, 1]);
}

function testDoubleKillTieBreaksByStarsThenRuntime() {
  const sim = new AgenTankSimulator({
    map: openMap(8, 5),
    tanks: [
      { id: "a", position: [1, 2], direction: "right", skillType: "overload", stars: 1 },
      { id: "b", position: [6, 2], direction: "left", skillType: "overload", stars: 2 }
    ]
  });
  sim.bullets.push(
    { objectId: "ba", ownerIndex: 0, ownerObjectId: "a", position: [4, 2], direction: "right", crashed: false },
    { objectId: "bb", ownerIndex: 1, ownerObjectId: "b", position: [3, 2], direction: "left", crashed: false }
  );
  sim.step([null, null]);
  assert.equal(sim.players[0].crashed, true);
  assert.equal(sim.players[1].crashed, true);
  assert.equal(sim.result.winner, 1);
}

function testDoubleKillTieBreaksByRuntimeWhenStarsTie() {
  const sim = new AgenTankSimulator({
    map: openMap(8, 5),
    tanks: [
      { id: "a", position: [1, 2], direction: "right", skillType: "overload", stars: 2 },
      { id: "b", position: [6, 2], direction: "left", skillType: "overload", stars: 2 }
    ]
  });
  sim.players[0].runTimeMs = 3;
  sim.players[1].runTimeMs = 7;
  sim.bullets.push(
    { objectId: "ba", ownerIndex: 0, ownerObjectId: "a", position: [4, 2], direction: "right", crashed: false },
    { objectId: "bb", ownerIndex: 1, ownerObjectId: "b", position: [3, 2], direction: "left", crashed: false }
  );
  sim.step([null, null]);
  assert.equal(sim.result.winner, 0);
}

function testCrashResultIsNotOverriddenByStarLimit() {
  const sim = new AgenTankSimulator({
    starLimit: 1,
    map: openMap(8, 5),
    tanks: [
      { id: "a", position: [1, 2], direction: "right", skillType: "overload", stars: 1 },
      { id: "b", position: [6, 2], direction: "left", skillType: "overload", stars: 0 }
    ]
  });
  sim.bullets.push({ objectId: "bb", ownerIndex: 1, ownerObjectId: "b", position: [3, 2], direction: "left", crashed: false });
  sim.step([null, null]);
  assert.equal(sim.players[0].crashed, true);
  assert.deepEqual(sim.result, { winner: 1, reason: "crashed" });
}

function testStarProviderSeesCurrentPlayerStatus() {
  const seen = [];
  const sim = new AgenTankSimulator({
    map: openMap(10, 7),
    tanks: [
      { id: "a", position: [1, 1], direction: "right", skillType: "teleport" },
      { id: "b", position: [8, 5], direction: "left", skillType: "overload" }
    ],
    starProvider({ frame, players }) {
      seen.push({ frame, fireLocked: players[0].status.fireLocked });
      return null;
    }
  });
  sim.step([{ type: "teleport", x: 5, y: 5 }, null]);
  sim.step([null, null]);
  sim.step([null, null]);
  sim.step([null, null]);
  assert.deepEqual(seen.map((item) => item.fireLocked), [true, true, true, false]);
}

function testRawMapParsingKeepsStartsAndTerrain() {
  const parsed = parseRawMap([
    "xxxxxx",
    "xa.omx",
    "x...Ax",
    "xxxxxx"
  ].join("|"));
  assert.deepEqual(parsed.tanks[0], { position: [1, 1], direction: "up" });
  assert.deepEqual(parsed.tanks[1], { position: [4, 2], direction: "up" });
  assert.equal(parsed.map[3][1], "o");
  assert.equal(parsed.map[4][1], "m");
  assert.deepEqual(mapFromRows(["xxx", "x.x", "xxx"])[1][1], ".");
}

function testRandomScenarioGenerationIsSeeded() {
  const first = createRandomScenario({ width: 11, height: 9, seed: 42 });
  const second = createRandomScenario({ width: 11, height: 9, seed: 42 });
  assert.equal(serializeRawMap(first.map, first.tanks), serializeRawMap(second.map, second.tanks));
  assert.deepEqual(first.star, second.star);
  assert.equal(first.tanks.length, 2);
  assert.equal(first.map.length, 11);
  assert.equal(first.map[0].length, 9);
  assert.notDeepEqual(first.tanks[0].position, first.tanks[1].position);
}

function testSimulatorRejectsMapsWithMissingTankStart() {
  assert.throws(
    () => new AgenTankSimulator({ map: "xxx|xAx|xxx" }),
    /Simulator requires two tank start states/
  );
}

function testSimulateLocalPassesConfiguredBotTimeout() {
  const dir = mkdtempSync(join(tmpdir(), "agentank-sim-"));
  try {
    const slowBot = join(dir, "slow-bot.js");
    const idleBot = join(dir, "idle-bot.js");
    const replayFile = join(dir, "replay.json");
    writeFileSync(slowBot, `
      function onIdle(me) {
        const end = Date.now() + 25;
        while (Date.now() < end) {}
        me.go();
      }
    `);
    writeFileSync(idleBot, "function onIdle() {}");
    const baseArgs = [
      SIMULATE_LOCAL_CLI,
      "--bot-a", slowBot,
      "--bot-b", idleBot,
      "--map", "xxxxxx|xb..Ax|xxxxxx",
      "--max-frames", "1",
      "--out", replayFile
    ];
    const timedOut = spawnSync(process.execPath, [...baseArgs, "--bot-timeout-ms", "1"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8"
    });
    assert.equal(timedOut.status, 0);
    let replay = JSON.parse(readFileSync(replayFile, "utf8"));
    assert.equal(replay.replayData.replay.records[0].some((event) => event.type === "tank" && event.action === "go"), false);

    const completed = spawnSync(process.execPath, [...baseArgs, "--bot-timeout-ms", "100"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8"
    });
    assert.equal(completed.status, 0);
    replay = JSON.parse(readFileSync(replayFile, "utf8"));
    assert.equal(replay.replayData.replay.records[0].some((event) => event.type === "tank" && event.action === "go"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testSimulateLocalRandomMapMode() {
  const dir = mkdtempSync(join(tmpdir(), "agentank-random-sim-"));
  try {
    const bot = join(dir, "bot.js");
    const replayFile = join(dir, "nested", "replay.json");
    writeFileSync(bot, "function onIdle(me) { me.go(); }");
    const result = spawnSync(process.execPath, [
      SIMULATE_LOCAL_CLI,
      "--bot-a", bot,
      "--bot-b", bot,
      "--random-map",
      "--width", "11",
      "--height", "9",
      "--seed", "42",
      "--max-frames", "2",
      "--out", replayFile
    ], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8"
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /map=/);
    assert.match(result.stdout, /star=/);
    const replay = JSON.parse(readFileSync(replayFile, "utf8"));
    assert.equal(replay.replayData.replay.records.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testIsolatedBotRunnerBlocksHostFileAccess() {
  const dir = mkdtempSync(join(tmpdir(), "agentank-isolate-"));
  try {
    const evilBot = join(dir, "evil-bot.js");
    writeFileSync(evilBot, `
      function onIdle(me) {
        const proc = this.constructor.constructor("return process")();
        try {
          proc.getBuiltinModule("fs").readFileSync("/etc/passwd", "utf8");
          me.speak("fs:allowed");
        } catch (error) {
          me.speak("fs:" + error.code);
        }
        try {
          proc.getBuiltinModule("child_process").execFileSync("/bin/echo", ["owned"], { encoding: "utf8" });
          me.speak("child:allowed");
        } catch (error) {
          me.speak("child:" + error.code);
        }
      }
    `);
    const bot = await loadIsolatedBotFromFile(evilBot, { timeoutMs: 50 });
    try {
      const decision = await bot.decide({
        me: {
          tank: { id: "a", position: [1, 1], direction: "right" },
          stars: 0,
          bullet: null,
          skill: { type: "teleport" },
          status: {},
          effects: {}
        },
        enemy: {
          tank: { id: "b", position: [2, 1], direction: "left" },
          stars: 0,
          bullet: null,
          skill: null,
          status: {},
          effects: {}
        },
        game: { frames: 0, star: null, map: [] }
      });
      assert.deepEqual(decision.logs.map((log) => log.data), ["fs:ERR_ACCESS_DENIED", "child:ERR_ACCESS_DENIED"]);
    } finally {
      bot.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testIsolatedBotRunnerClosesWorkerAfterInitError() {
  const runner = new IsolatedBotRunner({ timeoutMs: 50, hostTimeoutMs: 500 });
  await assert.rejects(
    () => runner.init("function onIdle( {"),
    /Unexpected|Invalid|missing|Unexpected end/i
  );
  await waitForChildExit(runner.child);
  assert.equal(runner.closed, true);
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}
