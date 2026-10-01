import { Actor, Game, ObjectReference, storage } from "skyrimPlatform";
import { gmDebugOn, gmTrace } from "../debugTrace";
import { localIdToRemoteId, remoteIdToLocalId } from "../view/worldViewMisc";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { NiPoint3 } from "./movement";

// ia-forge (BUG-048, 1er/10): the horse a player rides is thrown into the air when another player's character is
// loaded nearby, and our 2-second traces could not show by what. While the player is in the saddle, the horse and
// the player are sampled every 100 ms, every action this client takes on an actor is kept for a few seconds, and a
// sudden jump dumps all of it ("JUMP"): no need to press /marque at the right moment.

const SAMPLE_MS = 100;
const REPORT_MS = 1000;
const KEEP_SAMPLES = 25;
const KEEP_ACTIONS_MS = 3000;
const JUMP_SPEED = 2000; // units per second, horizontal (a gallop stays well under)
const JUMP_DZ = 120; // units per sample, vertical
const JUMP_COOLDOWN_MS = 3000;
const NEAR_RADIUS = 2048;

interface Sample {
  t: number;
  hp: number[]; // horse pos
  haz: number; // horse angle z
  pp: number[]; // player pos
  v: number; // horse horizontal speed, units/s
  dz: number; // horse vertical move since the last sample
  ridden: boolean;
  dis: boolean; // disabled
  del: boolean; // deleted
  d3: boolean; // 3D loaded
  ai: boolean;
  sm: number; // SpeedMult
  spd: number; // SpeedSampled
  sit: number;
  onMount: boolean;
  combat: boolean;
  graph?: Record<string, number | boolean>;
}

interface Action {
  t: number;
  k: string;
  refr: string;
  srv: string;
  d?: number; // distance from the horse at that moment
  x?: Record<string, unknown>;
}

const samples: Sample[] = [];
const actions: Action[] = [];
let lastSampleAt = 0;
let lastReportAt = 0;
let lastJumpAt = 0;
let horseLocal = 0;

const myHorse = (player: Actor): number => {
  try {
    const m = storage["gmMounts"] as Record<string, number> | undefined;
    if (m && typeof m === "object") {
      const me = localIdToRemoteId(0x14, true);
      for (const k in m) if (m[k] === me) return remoteIdToLocalId(Number(k));
    }
  } catch (e) {
    // fall through
  }
  // No registry (or not ours): the ridden horse next to the player.
  const seen = new Set<number>();
  for (let i = 0; i < 12; i++) {
    const a = Game.findRandomActor(player.getPositionX(), player.getPositionY(), player.getPositionZ(), 300);
    if (!a) break;
    const id = a.getFormID();
    if (seen.has(id)) continue;
    seen.add(id);
    if (id !== 0x14 && a.isBeingRidden()) return id;
  }
  return 0;
};

const horsePos = (): NiPoint3 | null => {
  if (!horseLocal) return null;
  const h = ObjectReference.from(Game.getFormEx(horseLocal));
  return h ? ObjectReferenceEx.getPos(h) : null;
};

/** Called by the code that moves, deletes or animates actors: kept while a ride is watched. */
export const recordAction = (kind: string, refr: ObjectReference | null, extra?: Record<string, unknown>): void => {
  if (!horseLocal || !gmDebugOn("mount")) return;
  try {
    const now = Date.now();
    const a: Action = { t: now, k: kind, refr: refr ? refr.getFormID().toString(16) : "-", srv: "-" };
    if (refr) {
      const srv = localIdToRemoteId(refr.getFormID());
      a.srv = srv ? srv.toString(16) : "-";
      const hp = horsePos();
      if (hp) a.d = Math.round(ObjectReferenceEx.getDistance(hp, ObjectReferenceEx.getPos(refr)));
    }
    if (extra) a.x = extra;
    actions.push(a);
    while (actions.length && now - actions[0].t > KEEP_ACTIONS_MS) actions.shift();
    if (actions.length > 400) actions.splice(0, actions.length - 400);
  } catch (e) {
    // trace only
  }
};

const nearbyActors = (center: NiPoint3): Record<string, unknown>[] => {
  const seen = new Map<number, Record<string, unknown>>();
  let hosted: unknown = null;
  try {
    hosted = storage["hosted"];
  } catch (e) {
    hosted = null;
  }
  for (let i = 0; i < 30; i++) {
    const a = Game.findRandomActor(center[0], center[1], center[2], NEAR_RADIUS);
    if (!a) break;
    const id = a.getFormID();
    if (seen.has(id) || id === 0x14) continue;
    const srv = localIdToRemoteId(id);
    const pos = ObjectReferenceEx.getPos(a);
    seen.set(id, {
      id: id.toString(16),
      srv: srv ? srv.toString(16) : "-",
      base: (a.getBaseObject()?.getFormID() ?? 0).toString(16),
      d: Math.round(ObjectReferenceEx.getDistance(center, pos)),
      pos: pos.map(Math.round),
      mine: Array.isArray(hosted) && (hosted.includes(srv) || hosted.includes(srv + 0x100000000)),
      dis: a.isDisabled(),
      ai: a.isAIEnabled(),
      ridden: a.isBeingRidden(),
    });
  }
  const out: Record<string, unknown>[] = [];
  seen.forEach((v) => out.push(v));
  return out;
};

const sample = (player: Actor, horse: Actor, now: number): Sample => {
  const hp = ObjectReferenceEx.getPos(horse);
  const prev = samples.length ? samples[samples.length - 1] : null;
  let v = 0;
  let dz = 0;
  if (prev && now > prev.t) {
    v = Math.round((Math.sqrt((hp[0] - prev.hp[0]) ** 2 + (hp[1] - prev.hp[1]) ** 2) * 1000) / (now - prev.t));
    dz = Math.round(hp[2] - prev.hp[2]);
  }
  let spd = 0;
  try {
    spd = Math.round(horse.getAnimationVariableFloat("SpeedSampled"));
  } catch (e) {
    spd = -1;
  }
  let graph: Record<string, number | boolean> | undefined;
  try {
    graph = {
      Speed: Math.round(horse.getAnimationVariableFloat("Speed")),
      HorseSpeedSampled: Math.round(horse.getAnimationVariableFloat("HorseSpeedSampled")),
      Direction: Math.round(horse.getAnimationVariableFloat("Direction") * 100) / 100,
      TurnDelta: Math.round(horse.getAnimationVariableFloat("TurnDelta") * 100) / 100,
      isMoving: horse.getAnimationVariableBool("isMoving"),
      IsSprinting: horse.getAnimationVariableBool("IsSprinting"),
      bAnimationDriven: horse.getAnimationVariableBool("bAnimationDriven"),
      iState: horse.getAnimationVariableInt("iState"),
      iState_HorseDefault: horse.getAnimationVariableInt("iState_HorseDefault"),
      iState_HorseSprint: horse.getAnimationVariableInt("iState_HorseSprint"),
      iSyncIdleLocomotion: horse.getAnimationVariableInt("iSyncIdleLocomotion"),
      iSyncForwardState: horse.getAnimationVariableInt("iSyncForwardState"),
      iSyncSprintState: horse.getAnimationVariableInt("iSyncSprintState"),
      iSyncTurnDirection: horse.getAnimationVariableInt("iSyncTurnDirection"),
    };
  } catch (e) {
    graph = undefined;
  }
  return {
    t: now,
    graph,
    hp: hp.map(Math.round),
    haz: Math.round(horse.getAngleZ()),
    pp: ObjectReferenceEx.getPos(player).map(Math.round),
    v,
    dz,
    ridden: horse.isBeingRidden(),
    dis: horse.isDisabled(),
    del: horse.isDeleted(),
    d3: horse.is3DLoaded(),
    ai: horse.isAIEnabled(),
    sm: Math.round(horse.getActorValue("SpeedMult")),
    spd,
    sit: horse.getSitState(),
    onMount: player.isOnMount(),
    combat: horse.isInCombat(),
  };
};

/** Once per frame. */
export const rideWatchTick = (): void => {
  const now = Date.now();
  if (now - lastSampleAt < SAMPLE_MS) return;
  lastSampleAt = now;
  if (!gmDebugOn("mount")) {
    horseLocal = 0;
    return;
  }
  const player = Game.getPlayer();
  if (!player) return;
  const wasHorse = horseLocal;
  horseLocal = player.isOnMount() ? myHorse(player) : 0;
  if (!horseLocal) {
    if (wasHorse) {
      gmTrace("mount", "ride watch off", { horse: wasHorse.toString(16), samples: samples.length });
      samples.length = 0;
      actions.length = 0;
    }
    return;
  }
  const horse = Actor.from(Game.getFormEx(horseLocal));
  if (!horse) {
    gmTrace("mount", "ride watch: horse form missing", { horse: horseLocal.toString(16) });
    horseLocal = 0;
    return;
  }
  if (!wasHorse) gmTrace("mount", "ride watch on", { horse: horseLocal.toString(16) });

  const s = sample(player, horse, now);
  samples.push(s);
  if (samples.length > KEEP_SAMPLES) samples.shift();

  if (now - lastReportAt >= REPORT_MS) {
    lastReportAt = now;
    gmTrace("mount", "ride", s as unknown as Record<string, unknown>);
  }

  if ((s.v > JUMP_SPEED || Math.abs(s.dz) > JUMP_DZ) && now - lastJumpAt > JUMP_COOLDOWN_MS) {
    lastJumpAt = now;
    gmTrace("mount", "JUMP", {
      horse: horseLocal.toString(16),
      v: s.v,
      dz: s.dz,
      samples: samples.slice(),
      actions: actions.slice(),
      near: nearbyActors([s.hp[0], s.hp[1], s.hp[2]]),
    });
  }
};
