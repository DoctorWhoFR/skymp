import { Actor, Debug, Game, Idle, storage, TESModPlatform, Utility } from "skyrimPlatform";
import * as skyrimPlatform from "skyrimPlatform";
import { remoteIdToLocalId } from "../view/worldViewMisc";
import { NiPoint3 } from "./movement";
import { gmDebugOn, gmTrace } from "../debugTrace";
import { recordAction } from "./rideWatch";

// ia-forge (mounts, docs/92 § 5): another player riding a horse. The gamemode keeps storage.gmMounts
// = { horse server id: rider server id } in every game that sees the horse. Here, in an observer's game, the remote
// rider is kept on the remote horse instead of being moved by translateTo next to it.
// storage.gmMountMethod picks how (prototype, set by the staff command /mountmethod):
//   1 = real saddle: the horse is activated by the rider actor (default);
//   3 = no saddle: HDN's kinematic pair puts the rider on the horse's back at every frame.
// HDN's pair only writes position and angles (ObjectReferenceApi.cpp, ApplyActorKinematicTransform): the clone's
// behavior graph stays on foot. Method 3 therefore puts the graph in the riding state itself (storage.gmMountPose).

const PROFILE_NONE = 0;
const PROFILE_MOUNTED_HORSE = 1;
const PROFILE_REMOTE_PROXY = 2;
const ACTIVATE_RETRY_MS = 800;
const POSE_RETRY_MS = 400;
const KIN_RENEW_MS = 250;
const HIDE_MAX_MS = 2500;
const HIDE_REASSERT_MS = 250;
// Skyrim.esm IDLE "EnterHorseInstant" (event HorseEnterInstant, 0_Master.hkx).
const IDLE_ENTER_HORSE_INSTANT = 0x0005701d;
// iState values tagged by the rider's HorseBehavior.hkx (BSiStateTaggingGenerator): default, sprint, fall, swim.
const ISTATE_RIDING_MIN = 60;
const ISTATE_RIDING_MAX = 63;
const RIDER_MIN_SPEED = 20;

/**
 * storage.gmMountPose (method 3), read at each frame:
 * 0 = none (the clone stays on foot, as in local-60);
 * 1 = event HorseEnterInstant (vanilla wildcard of 0_master.hkx to HorseRider_State), sent again whenever the graph
 *     leaves the riding state (default);
 * 2 = 1 + the rider's gait driven from the horse's graph (HorseSpeedSampled, moveStart/moveStop, SprintStart/Stop);
 * 3 = playIdle of the IDLE EnterHorseInstant (same event through the idle system; the record has conditions, the
 *     returned ok tells whether it was refused);
 * 4 = setVehicle(horse) + HorseEnterInstant (setVehicle(null) at release);
 * 5 = event HorseEnter (vanilla paired mount clip played without its horse partner).
 */
const POSE_NAMES = ["none", "HorseEnterInstant", "HorseEnterInstant+gait", "playIdle EnterHorseInstant", "setVehicle+HorseEnterInstant", "HorseEnter"];

interface RiderState {
  horse: number;
  method: number;
  since: number;
  triedAt: number;
  serial: number;
  traceAt: number;
  /** HDN lease of this pair; a new one when the native side revoked the pair (controller rebuilt, FormID reused). */
  lease: number;
  /** FormView spawn identity: a clone born again under the same FormID is a new pair. */
  view: number;
  kinOk: boolean;
  renewAt: number;
  renewals: number;
  glued: number;
  pose: number;
  poseAt: number;
  poseSends: number;
  posedAt: number;
  lost: number;
  vehicle: boolean;
  gaitMoving: boolean;
  gaitSprint: boolean;
  /** After a live switch of technique, the graph needs a moment to leave the riding state. */
  graceUntil: number;
}

const riders = new Map<number, RiderState>();
/** Clones kept invisible until they sit on their horse: local id -> since. */
const hidden = new Map<number, number>();
const hiddenAt = new Map<number, number>();
/** Shown after HIDE_MAX_MS without a seat: not hidden again until the pair forms or the rider gets off. */
const gaveUp = new Set<number>();

// ia-forge (BUG-048, 1er/10): the walking intent given to the seated rider did not move the horse's legs. The
// horse's animation graph is driven directly, every frame, from the gait its rider sends (as Skyrim Together syncs
// Speed / HorseSpeedSampled / IsSprinting / iSyncSprintState of HorseRootBehavior).
interface HorseGait {
  speed: number;
  sprint: boolean;
  moving: boolean;
  at: number;
  runMode: string;
  // Style 5 only: FormView re-applies the last movement every 2 s, recvAt moves only when a new one arrives.
  recvAt: number;
  pos?: NiPoint3;
  rotZ?: number;
  yawRate: number; // degrees per second, Skyrim's angle Z grows clockwise
}
const horseGaits = new Map<number, HorseGait>();
let gaitTraceAt = 0;

const wrap180 = (a: number): number => {
  let d = a % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
};

/** From applyMovement: the gait received for a remote horse that a remote rider drives in our game. */
export const setRiddenHorseGait = (
  horseLocal: number, speed: number, runMode: string, rotZ?: number, pos?: NiPoint3,
): void => {
  const now = Date.now();
  const prev = horseGaits.get(horseLocal);
  const same = !!prev && !!prev.pos && !!pos && prev.rotZ === rotZ &&
    prev.pos[0] === pos[0] && prev.pos[1] === pos[1] && prev.pos[2] === pos[2];
  let yawRate = 0;
  if (same && prev) {
    yawRate = prev.yawRate;
  } else if (prev && prev.rotZ !== undefined && rotZ !== undefined) {
    const dt = (now - prev.recvAt) / 1000;
    if (dt > 0.03 && dt < 1) yawRate = 0.5 * prev.yawRate + 0.5 * (wrap180(rotZ - prev.rotZ) / dt);
  }
  horseGaits.set(horseLocal, {
    speed,
    sprint: runMode === "Sprinting",
    moving: runMode !== "Standing",
    at: now,
    runMode,
    recvAt: same && prev ? prev.recvAt : now,
    pos: pos ? [pos[0], pos[1], pos[2]] : undefined,
    rotZ,
    yawRate,
  });
};

const driveHorseGraph = (horse: Actor, now: number): void => {
  const g = horseGaits.get(horse.getFormID());
  if (!g) return;
  // No movement for a while: the rider stopped sending (or left); stand still.
  const speed = now - g.at > 1500 ? 0 : g.speed;
  const moving = now - g.at > 1500 ? false : g.moving;
  const sprint = moving && g.sprint;
  horse.setAnimationVariableFloat("Speed", speed);
  horse.setAnimationVariableFloat("HorseSpeedSampled", speed);
  horse.setAnimationVariableFloat("Direction", 0);
  horse.setAnimationVariableFloat("TurnDelta", 0);
  horse.setAnimationVariableBool("isMoving", moving);
  horse.setAnimationVariableBool("IsSprinting", sprint);
  horse.setAnimationVariableInt("iSyncSprintState", sprint ? 1 : 0);
  // The graph's own state ids (constants of HorseRootBehavior), not guessed numbers.
  const stateDefault = horse.getAnimationVariableInt("iState_HorseDefault");
  const stateSprint = horse.getAnimationVariableInt("iState_HorseSprint");
  const engineState = horse.getAnimationVariableInt("iState");
  horse.setAnimationVariableInt("iState", sprint ? stateSprint : stateDefault);
  horse.setAnimationVariableInt("iSyncIdleLocomotion", moving ? 1 : 0);
  const style = animStyle();
  horse.setAnimationVariableInt("iSyncForwardState", style === 1 || style === 4 ? (moving ? 1 : 0) : 0);
  if (gmDebugOn("mount") && now - gaitTraceAt > 1000) {
    gaitTraceAt = now;
    gmTrace("mount", "ridden horse graph", {
      style,
      horse: horse.getFormID().toString(16),
      speed,
      sprint,
      moving,
      readBack: Math.round(horse.getAnimationVariableFloat("Speed")),
      sampled: Math.round(horse.getAnimationVariableFloat("HorseSpeedSampled")),
      stateDefault,
      stateSprint,
      engineState,
      idleLoco: horse.getAnimationVariableInt("iSyncIdleLocomotion"),
      forward: horse.getAnimationVariableInt("iSyncForwardState"),
      sprintState: horse.getAnimationVariableInt("iSyncSprintState"),
    });
  }
};

// gmMountAnim 5 (BUG-048, 2/10). The horse's behavior graph (meshes/actors/horse/behaviors/horsebehavior.hkx) leaves
// its idle only on events: moveStart / moveStop (StandingState <-> LocomotionState), SprintStart / SprintStop
// (gallop). IsMoving, iState and HorseSpeedSampled are written by the graph itself; its inputs are Speed, TurnDelta,
// Direction, IsSprinting, and iSyncIdleLocomotion / iSyncSprintState pick the start state on entry. The rider's game
// never sends moveStart (animation.ts ignores it) and styles 1-4 only write variables, so the remote horse walked
// only when our own engine happened to send it. Here the events are sent to the horse and to the seated rider (its
// riding graph has the same states) whenever a graph is not in the state the received gait asks for; the position
// stays kinematic (translateTo in movementApply.ts).
const DRIVE_STALE_MS = 1500;
const STAND_DEBOUNCE_MS = 250; // a single "Standing" packet in a slow walk must not stop the legs
const SPEED_ACCEL = 1000; // units/s per s: the real ridden horse's Speed goes from 0 to 450 in about 0.5 s
const SPEED_MAX = 750;
// The real horse: trot Speed 450, gallop 600 (iState 61). riddenGait() sends a gallop as "Running" (its Sprinting
// threshold is 650), so the gallop is read from the speed.
const SPRINT_ON = 530;
const SPRINT_OFF = 480;
const SPRINT_DEBOUNCE_MS = 250; // the rider's game also sends SprintStart / SprintStop: let them land first
const EVENT_RESEND_MS = 400;
const SEAT_SETTLE_MS = 800;
const REFIX_AFTER_MS = 1000;
const TURN_MAX = 135; // TurnDelta range of the turn blends

interface PairDrive {
  since: number;
  frameAt: number;
  speed: number;
  moving: boolean;
  movingSpeed: number;
  standingSince: number;
  want: Map<string, number>;
  wantAt: Map<string, number>;
  mismatch: Map<string, number>;
  sentAt: Map<string, number>;
  assumed: Map<string, boolean>;
  events: number;
  refixes: number;
  overwritten: number;
  frames: number;
  maxErr: number;
  sent: string[];
  traceAt: number;
}
const pairs = new Map<number, PairDrive>();

const setWant = (d: PairDrive, key: string, want: number, now: number) => {
  if (d.want.get(key) !== want) {
    d.want.set(key, want);
    d.wantAt.set(key, now);
  }
};

const reconcile = (
  d: PairDrive, a: Actor, key: string, wantOn: boolean, wantOff: boolean, have: boolean,
  onEvent: string, offEvent: string, debounceMs: number, now: number,
): void => {
  const mismatch = (wantOn && !have) || (wantOff && have);
  if (!mismatch) {
    d.mismatch.delete(key);
    return;
  }
  const since = d.mismatch.get(key) ?? now;
  d.mismatch.set(key, since);
  if (now - since < debounceMs || now - (d.sentAt.get(key) ?? 0) < EVENT_RESEND_MS) return;
  const ev = wantOn ? onEvent : offEvent;
  d.sentAt.set(key, now);
  d.assumed.set(key, wantOn);
  Debug.sendAnimationEvent(a, ev);
  // Long after our wish last changed: the graph left that state by itself (engine, network event).
  const ref = Math.max(d.wantAt.get(key) ?? 0, d.since + SEAT_SETTLE_MS);
  if (now - ref > REFIX_AFTER_MS) d.refixes++;
  else d.events++;
  if (d.sent.length < 12) d.sent.push(`${key}:${ev}`);
};

const driveRiddenPair = (horse: Actor, rider: Actor, now: number): void => {
  const horseId = horse.getFormID();
  const g = horseGaits.get(horseId);
  if (!g) return;
  let d = pairs.get(horseId);
  if (!d) {
    d = {
      since: now, frameAt: now, speed: 0, moving: false, movingSpeed: 0, standingSince: 0,
      want: new Map(), wantAt: new Map(), mismatch: new Map(), sentAt: new Map(), assumed: new Map(),
      events: 0, refixes: 0, overwritten: 0, frames: 0, maxErr: 0, sent: [], traceAt: now,
    };
    pairs.set(horseId, d);
    // A walking intent left by styles 1/3 (rider) or by the NPC path before the seat (horse) would make our engine
    // send its own moveStart / moveStop.
    rider.clearKeepOffsetFromActor();
    horse.clearKeepOffsetFromActor();
    gmTrace("mount", "ridden horse drive start", { horse: horseId.toString(16), rider: rider.getFormID().toString(16) });
  }

  const fresh = now - g.recvAt <= DRIVE_STALE_MS;
  if (fresh && g.moving) {
    d.moving = true;
    d.standingSince = 0;
  } else {
    if (!d.standingSince) d.standingSince = now;
    if (!fresh || now - d.standingSince >= STAND_DEBOUNCE_MS) d.moving = false;
  }
  const recvSpeed = fresh ? Math.max(0, Math.min(SPEED_MAX, g.speed)) : 0;
  // While a "Standing" packet is being debounced, the legs keep the last moving pace.
  if (fresh && g.moving) d.movingSpeed = recvSpeed;
  const dt = Math.max(0, Math.min(0.1, (now - d.frameAt) / 1000));
  d.frameAt = now;
  const step = SPEED_ACCEL * dt;
  const speedBefore = horse.getAnimationVariableFloat("Speed");
  if (d.frames > 0 && Math.abs(speedBefore - d.speed) > 1) d.overwritten++;
  d.speed += Math.max(-step, Math.min(step, (d.moving ? d.movingSpeed : 0) - d.speed));
  d.frames++;
  const sprintOn = d.moving && d.movingSpeed >= SPRINT_ON;
  const sprintOff = !d.moving || d.movingSpeed <= SPRINT_OFF;
  const turn = d.moving && now - g.recvAt < 400 ? Math.max(-TURN_MAX, Math.min(TURN_MAX, -g.yawRate)) : 0;
  setWant(d, "hmove", d.moving ? 1 : 0, now);
  setWant(d, "rmove", d.moving ? 1 : 0, now);
  setWant(d, "hsprint", sprintOn ? 1 : sprintOff ? 0 : -1, now);
  setWant(d, "rsprint", sprintOn ? 1 : sprintOff ? 0 : -1, now);

  const stateDefault = horse.getAnimationVariableInt("iState_HorseDefault") || 60;
  const stateSprint = horse.getAnimationVariableInt("iState_HorseSprint") || 61;
  const settling = now - d.since < SEAT_SETTLE_MS;
  const seen: Record<string, unknown> = {};
  const graphs: Array<[string, Actor]> = [["h", horse], ["r", rider]];
  for (const [tag, a] of graphs) {
    const iState = a.getAnimationVariableInt("iState");
    const inSprint = iState === stateSprint;
    a.setAnimationVariableFloat("Speed", d.speed);
    a.setAnimationVariableFloat("Direction", 0);
    a.setAnimationVariableFloat("TurnDelta", turn);
    a.setAnimationVariableBool("IsSprinting", sprintOn || (inSprint && !sprintOff));
    a.setAnimationVariableInt("iSyncIdleLocomotion", d.moving ? 1 : 0);
    a.setAnimationVariableInt("iSyncSprintState", sprintOn || (inSprint && !sprintOff) ? 1 : 0);
    const synced = a.getAnimationVariableBool("bIsSynced");
    // The rider's combat riding states do not set IsMoving: with a weapon out, trust the last event sent.
    const levelMove = tag === "h" || !a.isWeaponDrawn();
    const isMoving = levelMove ? a.getAnimationVariableBool("IsMoving") : d.assumed.get(tag + "move") === true;
    seen[tag] = { moving: isMoving, iState, synced };
    if (settling || synced || (iState !== stateDefault && iState !== stateSprint)) continue;
    reconcile(d, a, tag + "move", d.moving, !d.moving, isMoving, "moveStart", "moveStop", 0, now);
    if (isMoving && d.moving) {
      reconcile(d, a, tag + "sprint", sprintOn, sprintOff, inSprint, "SprintStart", "SprintStop", SPRINT_DEBOUNCE_MS, now);
    }
  }

  let err = -1;
  let dz = 0;
  if (g.pos) {
    err = Math.round(Math.sqrt((g.pos[0] - horse.getPositionX()) ** 2 + (g.pos[1] - horse.getPositionY()) ** 2));
    dz = Math.round(horse.getPositionZ() - g.pos[2]);
    if (err > d.maxErr) d.maxErr = err;
  }
  if (gmDebugOn("mount") && now - d.traceAt >= 1000) {
    d.traceAt = now;
    gmTrace("mount", "ridden horse drive", {
      style: 5,
      horse: horseId.toString(16),
      recv: { run: g.runMode, speed: Math.round(g.speed), age: now - g.recvAt, yaw: Math.round(g.yawRate) },
      want: { moving: d.moving, sprint: sprintOn ? 1 : sprintOff ? 0 : -1 },
      speed: Math.round(d.speed),
      speedBefore: Math.round(speedBefore),
      sampled: Math.round(horse.getAnimationVariableFloat("HorseSpeedSampled")),
      turn: Math.round(turn),
      overwritten: `${d.overwritten}/${d.frames}`,
      graph: seen,
      err,
      maxErr: d.maxErr,
      dz,
      events: d.events,
      refixes: d.refixes,
      sent: d.sent,
    });
    d.events = 0;
    d.refixes = 0;
    d.overwritten = 0;
    d.frames = 0;
    d.maxErr = 0;
    d.sent = [];
  }
};

/** gmMountAnim 5: the seated rider's riding graph is driven with its horse's (sprint included). */
export const isGraphDrivenRider = (rider: Actor): boolean => {
  const s = riders.get(rider.getFormID());
  return !!s && s.method === 1 && animStyle() === 5 && rider.isOnMount();
};

let lease = (Date.now() & 0x7fffffff) >>> 0 || 1;
let cachedRev = -1;
const horseByRider = new Map<number, number>();

const readStorage = (key: string): unknown => {
  try {
    return key in storage ? storage[key] : undefined;
  } catch (e) {
    return undefined;
  }
};

const refreshIndex = () => {
  const rev = readStorage("gmMountsRev");
  if (rev === cachedRev) return;
  cachedRev = typeof rev === "number" ? rev : -1;
  horseByRider.clear();
  const m = readStorage("gmMounts") as Record<string, number> | undefined;
  if (!m || typeof m !== "object") return;
  for (const k in m) horseByRider.set(m[k], Number(k));
};

/** Server id of the horse this remote actor rides, 0 if none. */
export const horseOfRider = (riderRemoteId: number | undefined): number => {
  if (!riderRemoteId) return 0;
  refreshIndex();
  return horseByRider.get(riderRemoteId) ?? 0;
};

const method = (): number => {
  const m = readStorage("gmMountMethod");
  return m === 3 ? 3 : 1;
};

const readInt = (key: string, def: number, min: number, max: number): number => {
  const v = readStorage(key);
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

/** Riding pose technique of method 3 (see POSE_NAMES), switched live by storage.gmMountPose. */
export const poseTechnique = (): number => readInt("gmMountPose", 1, 0, POSE_NAMES.length - 1);
/** At release: 0 = stand up at once (JumpLandEnd), 1 = vanilla dismount clip (HorseExit), 2 = nothing sent. */
const exitStyle = (): number => readInt("gmMountExit", 0, 0, 2);
const hideOn = (): boolean => readInt("gmMountHide", 1, 0, 1) === 1;
const blockOn = (): boolean => readInt("gmMountBlock", 1, 0, 1) === 1;

/** The clone's graph is in 0_master's HorseRider_State (its BSIsActiveModifier sets bIsRiding) or HorseBehavior. */
const graphRiding = (a: Actor): boolean => {
  if (a.getAnimationVariableBool("bIsRiding")) return true;
  const st = a.getAnimationVariableInt("iState");
  return st >= ISTATE_RIDING_MIN && st <= ISTATE_RIDING_MAX;
};

const hide = (a: Actor, why: string): void => {
  const id = a.getFormID();
  const now = Date.now();
  if (!hidden.has(id)) {
    hidden.set(id, now);
    gmTrace("mount", "remote rider hidden", { rider: id.toString(16), why });
  }
  hiddenAt.set(id, now);
  try {
    a.setAlpha(0, false);
  } catch (e) {
    gmTrace("mount", `remote rider hide failed: ${e}`);
  }
};

const reveal = (a: Actor | null, id: number, why: string): void => {
  const since = hidden.get(id);
  if (since === undefined) return;
  hidden.delete(id);
  hiddenAt.delete(id);
  try {
    a?.setAlpha(1, false);
  } catch (e) {
    gmTrace("mount", `remote rider show failed: ${e}`);
  }
  gmTrace("mount", "remote rider shown", { rider: id.toString(16), why, ms: Date.now() - since });
};

/** Hidden too long (horse never loaded, pose never taken): never leave a player invisible. */
const keepHiddenOrGiveUp = (a: Actor, now: number): void => {
  const id = a.getFormID();
  const since = hidden.get(id);
  if (since === undefined) return;
  if (now - since > HIDE_MAX_MS) {
    gaveUp.add(id);
    reveal(a, id, "timeout");
    return;
  }
  // Alpha is lost when the clone's 3D is rebuilt.
  if (now - (hiddenAt.get(id) ?? 0) > HIDE_REASSERT_MS) hide(a, "again");
};

/**
 * From FormView, when a remote player's clone is enabled at its birth (SpawnProcess): a rider that method 3 will
 * glue to its horse is born invisible, instead of standing at its server position until the pair forms.
 */
export const hideRiderAtBirth = (refrId: number, riderRemoteId: number | undefined): void => {
  if (method() !== 3 || !hideOn() || !horseOfRider(riderRemoteId)) return;
  const a = Actor.from(Game.getFormEx(refrId));
  if (a) hide(a, "birth");
};

/** From FormView for a clone that is not handled by applyMountedRider: never left invisible. */
export const revealIfHidden = (a: Actor): void => {
  const id = a.getFormID();
  if (hidden.has(id)) reveal(a, id, "not a rider");
};

/** True while this local actor is a remote rider held on its horse by HDN's kinematic pair (method 3). */
export const isKinematicRider = (localId: number): boolean => riders.get(localId)?.method === 3;

const niNodePending = new Set<number>();
/**
 * From niNodeSafe: may this clone's 3D be rebuilt now? A 3D reset of a glued rider rebuilds its graph (on foot again)
 * and its character controller (HDN revokes the pair). Out of sight (hidden) it is harmless, pose and pair are taken
 * again; in sight it waits for the release.
 */
export const riderNiNodeUpdateNow = (localId: number): boolean => {
  if (!isKinematicRider(localId) || hidden.has(localId)) return true;
  niNodePending.add(localId);
  return false;
};

/** From FormView.destroy: the clone is deleted, its pair (if any) is dropped without touching the actor. */
export const forgetMountedRider = (riderLocal: number): void => {
  niNodePending.delete(riderLocal);
  hidden.delete(riderLocal);
  hiddenAt.delete(riderLocal);
  gaveUp.delete(riderLocal);
  const s = riders.get(riderLocal);
  if (!s) return;
  riders.delete(riderLocal);
  horseGaits.delete(s.horse);
  if (s.method === 3) spFn("releaseMountedPairKinematicTransform")?.(s.horse, riderLocal, s.lease);
  setProfile(s.horse, PROFILE_NONE, s.lease);
  setProfile(riderLocal, PROFILE_NONE, s.lease);
  gmTrace("mount", "remote rider view gone", { rider: riderLocal.toString(16), method: s.method });
};

// Events that take a glued clone out of the riding state, or replay the rider's own (un)mounting on it.
// From 0_master.hkx (vanilla Skyrim - Animations.bsa): the root state machine's wildcard transitions without a
// riding condition, HorseRider_State's own transitions (HorseExit, HorseExitSwim) and the mount events; plus
// IdleForceDefaultState (stands a rider up, BStarRP) and the locomotion events: a glued clone's gait comes only from
// the pose technique. Ragdoll, GetUpBegin, attacks, bow and equip events are left as they are.
const BLOCKED_WHILE_HELD = new Set(
  [
    "HorseEnter", "HorseEnterInstant", "HorseEnterSwim", "HorseEnterOut", "HorseExit", "HorseExitOut", "HorseExitSwim",
    "NPCHorseExit", "NPCHorseExitOut", "pa_HorseEnter", "pa_HorseExit", "pa_HorseEnterSwim", "pa_HorseExitSwim",
    "pairedStop", "PairEnd", "IdleForceDefaultState",
    "staggerStart", "StaggerPlayer", "WardBreak", "bleedOutStart",
    "JumpDirectionalStart", "JumpStandingStart", "JumpFall", "JumpFallDirectional", "JumpLand", "JumpLandDirectional",
    "JumpLandEnd", "SwimStart", "SwimStartFromRagdoll", "SwimStop",
    "IdleHandCut", "IdlePresentSkeletonKey", "IdleReadElderScroll", "IdleReadElderScrollLonger", "IdleMesmerize",
    "DragonMountEnter", "DragonMountEnterInstant", "VampireLordChangePlayer",
    "pa_VampireFeedStanding_Front", "pa_VampireFeedStanding_Back", "VampireFeedStanding_Front",
    "VampireFeedStanding_Back", "KillMoveVampireLordFeedFront", "KillMoveVampireLordFeedBack",
    "pa_KillMoveDLC02RipHeartOut",
    "moveStart", "moveStop", "turnLeft", "turnRight", "turnStop", "SprintStart", "SprintStop",
  ].map((x) => x.toLowerCase()),
);

/**
 * From FormView, before an animation received from the server is applied to this clone: true when it must be
 * dropped because the clone is held on its horse by method 3, or is about to be (a clone born again replays the
 * last event it missed, often the rider's own HorseEnter). storage.gmMountBlock, default on.
 */
export const riderAnimBlocked = (riderLocal: number, riderRemoteId: number | undefined, animEventName: string): boolean => {
  const s = riders.get(riderLocal);
  const held = s ? s.method === 3 : method() === 3 && horseOfRider(riderRemoteId) !== 0;
  if (!held || !blockOn()) return false;
  if (!BLOCKED_WHILE_HELD.has(animEventName.toLowerCase())) return false;
  gmTrace("mount", "remote rider anim blocked", { rider: riderLocal.toString(16), anim: animEventName, paired: !!s });
  return true;
};

/**
 * How the observer animates a remote ridden horse (staff command /mountmethod n seat anim, live, no relaunch):
 * 1 = rider keeps a walking intent + iSyncForwardState follows (local-43); 2 = neither (local-44);
 * 3 = walking intent, forward 0; 4 = no walking intent, forward follows;
 * 5 = no walking intent, the horse's and the rider's graphs are put in the received gait's state by their own events
 * (driveRiddenPair).
 */
export const animStyle = (): number => {
  const a = readStorage("gmMountAnim");
  // Default 2 = local-44: the version Max saw as "tout est parfait" (1er/10, 02:19 UTC).
  return typeof a === "number" && a >= 1 && a <= 5 ? a : 2;
};

const spFn = (name: string): ((...args: number[]) => unknown) | undefined => {
  const f = (skyrimPlatform as unknown as Record<string, unknown>)[name];
  return typeof f === "function" ? (f as (...args: number[]) => unknown) : undefined;
};

// The native side ignores a clear made with another lease than the one that set the profile: always the pair's own.
const setProfile = (formId: number, profile: number, pairLease: number) => {
  try {
    spFn("setCharacterControllerCollisionProfile")?.(formId, profile, pairLease);
  } catch (e) {
    gmTrace("mount", `collision profile failed: ${e}`);
  }
};

const nextLease = (): number => {
  lease = (lease + 1) >>> 0 || 1;
  return lease;
};

/** Method 3: puts the clone's graph in the riding state (storage.gmMountPose) and keeps it there. */
const sendPose = (rider: Actor, horse: Actor, pose: number, s: RiderState): void => {
  let ev = "HorseEnterInstant";
  let ok: boolean | undefined;
  if (pose === 3) {
    const idle = Idle.from(Game.getFormEx(IDLE_ENTER_HORSE_INSTANT));
    ok = idle ? rider.playIdle(idle) : false;
    ev = "playIdle EnterHorseInstant";
  } else if (pose === 5) {
    // The paired mount clip is still playing (MountSynced sets bIsSynced): wait for it.
    if (rider.getAnimationVariableBool("bIsSynced")) return;
    ev = "HorseEnter";
    Debug.sendAnimationEvent(rider, ev);
  } else {
    if (pose === 4 && !s.vehicle) {
      rider.setVehicle(horse);
      s.vehicle = true;
    }
    Debug.sendAnimationEvent(rider, ev);
  }
  s.poseSends++;
  recordAction("anim", rider, { ev, pose });
  gmTrace("mount", "remote rider pose sent", {
    rider: rider.getFormID().toString(16),
    pose,
    ev,
    ok,
    n: s.poseSends,
    iState: rider.getAnimationVariableInt("iState"),
  });
};

/** Pose 2: the rider's locomotion in HorseBehavior.hkx follows the horse (blend on HorseSpeedSampled). */
const driveRiderGait = (rider: Actor, horse: Actor, s: RiderState): void => {
  const speed = horse.getAnimationVariableFloat("Speed");
  const sprint =
    horse.getAnimationVariableBool("IsSprinting") ||
    horse.getAnimationVariableInt("iState") === horse.getAnimationVariableInt("iState_HorseSprint");
  const moving = speed > RIDER_MIN_SPEED;
  rider.setAnimationVariableFloat("HorseSpeedSampled", speed);
  rider.setAnimationVariableFloat("Speed", speed);
  if (moving !== s.gaitMoving) {
    s.gaitMoving = moving;
    Debug.sendAnimationEvent(rider, moving ? "moveStart" : "moveStop");
  }
  if (sprint !== s.gaitSprint) {
    s.gaitSprint = sprint;
    Debug.sendAnimationEvent(rider, sprint ? "SprintStart" : "SprintStop");
  }
};

/** Returns true when the clone's graph is in the riding state. */
const applyPose = (rider: Actor, horse: Actor, s: RiderState, now: number): boolean => {
  const pose = poseTechnique();
  if (pose !== s.pose) {
    if (s.vehicle && pose !== 4) {
      try {
        rider.setVehicle(null);
      } catch (e) {
        gmTrace("mount", `remote rider vehicle off failed: ${e}`);
      }
      s.vehicle = false;
    }
    if (s.pose >= 0) {
      // Switched live: back on foot first, so that the new technique is the one that seats the clone.
      const wasRiding = graphRiding(rider);
      if (wasRiding) {
        Debug.sendAnimationEvent(rider, "JumpLandEnd");
        s.graceUntil = now + POSE_RETRY_MS;
      }
      gmTrace("mount", "remote rider pose switched", { rider: rider.getFormID().toString(16), from: s.pose, to: pose, wasRiding });
    }
    s.pose = pose;
    s.poseAt = 0;
    s.posedAt = 0;
  }
  if (pose === 0 || now < s.graceUntil) return false;
  const riding = graphRiding(rider);
  if (riding) {
    if (!s.posedAt) {
      s.posedAt = now;
      gmTrace("mount", "remote rider pose taken", {
        rider: rider.getFormID().toString(16),
        pose: POSE_NAMES[pose],
        ms: now - s.since,
        sends: s.poseSends,
      });
    }
  } else {
    if (s.posedAt) {
      // Graph rebuilt (3D reset, new clone) or knocked out by an event: the riding state is entered again.
      s.posedAt = 0;
      s.lost++;
      s.gaitMoving = false;
      s.gaitSprint = false;
      gmTrace("mount", "remote rider pose lost", { rider: rider.getFormID().toString(16), lost: s.lost });
    }
    if (now - s.poseAt >= POSE_RETRY_MS) {
      s.poseAt = now;
      sendPose(rider, horse, pose, s);
    }
  }
  if (pose === 2 && riding) driveRiderGait(rider, horse, s);
  return riding;
};

/**
 * Called by FormView for a remote actor at each update. Returns true when the actor is a rider held by the horse:
 * the caller must not translateTo it. viewId identifies the clone's spawn (a FormID can be reused by a new clone).
 */
export const applyMountedRider = (
  rider: Actor,
  riderRemoteId: number | undefined,
  truePos?: NiPoint3,
  viewId = 0,
): boolean => {
  const horseRemote = horseOfRider(riderRemoteId);
  const riderLocal = rider.getFormID();
  let state = riders.get(riderLocal);
  if (state && state.view !== viewId) {
    forgetMountedRider(riderLocal);
    state = undefined;
  }
  const now = Date.now();

  if (!horseRemote) {
    if (state) release(rider, state, truePos);
    reveal(rider, riderLocal, "on foot");
    gaveUp.delete(riderLocal);
    return false;
  }

  // Not glued yet (horse not loaded, clone just born): out of sight rather than standing beside or inside the horse.
  if (!state && method() === 3 && hideOn() && !hidden.has(riderLocal) && !gaveUp.has(riderLocal) && rider.is3DLoaded()) {
    hide(rider, "waiting");
  }

  const horseLocal = remoteIdToLocalId(horseRemote);
  const horse = Actor.from(Game.getFormEx(horseLocal));
  if (!horse || !horse.is3DLoaded() || !rider.is3DLoaded()) {
    keepHiddenOrGiveUp(rider, now);
    return !!state;
  }

  let s = state;
  if (!s || s.horse !== horseLocal || s.method !== method()) {
    if (s) {
      if (s.method === 3 && method() === 3) detach(rider, s, "horse view changed");
      else release(rider, s);
    }
    s = {
      horse: horseLocal, method: method(), since: now, triedAt: 0, serial: 0, traceAt: 0,
      lease: nextLease(), view: viewId, kinOk: true, renewAt: 0, renewals: 0, glued: 0,
      pose: -1, poseAt: 0, poseSends: 0, posedAt: 0, lost: 0, vehicle: false, gaitMoving: false, gaitSprint: false,
      graceUntil: 0,
    };
    riders.set(riderLocal, s);
    gaveUp.delete(riderLocal);
    setProfile(horseLocal, PROFILE_MOUNTED_HORSE, s.lease);
    setProfile(riderLocal, PROFILE_REMOTE_PROXY, s.lease);
    if (s.method === 3) {
      // A keepOffsetFromActor or translateTo given before the pair formed keeps running: walking intent in the
      // saddle and a second mover fighting the kinematic writes.
      rider.clearKeepOffsetFromActor();
      rider.stopTranslation();
    }
    gmTrace("mount", "remote rider", { rider: riderLocal.toString(16), horse: horseLocal.toString(16), method: s.method, lease: s.lease });
  }

  let riding = false;
  if (s.method === 1) {
    if (!rider.isOnMount() && now - s.triedAt > ACTIVATE_RETRY_MS) {
      s.triedAt = now;
      rider.setDontMove(false);
      rider.clearKeepOffsetFromActor();
      // BUG-048 N2 (1er/10): activated from afar, the clone's AI walked to the horse and never caught a horse that
      // had left (0.5 s to 21 s in the saddle, sometimes never). It is put on the horse first.
      let placed = false;
      try {
        TESModPlatform.moveRefrToPosition(
          rider, horse.getParentCell(), horse.getWorldSpace(),
          horse.getPositionX(), horse.getPositionY(), horse.getPositionZ(),
          0, 0, horse.getAngleZ(),
        );
        placed = true;
      } catch (e) {
        gmTrace("mount", `remote rider place failed: ${e}`);
      }
      horse.activate(rider, true);
      gmTrace("mount", "remote rider activate", { rider: riderLocal.toString(16), placed });
    }
  } else {
    const seat = readStorage("gmMountSeat");
    s.serial = (s.serial + 1) >>> 0 || 1;
    const ok = spFn("setMountedPairKinematicTransform")?.(
      horseLocal, riderLocal, s.lease, s.serial,
      horse.getPositionX(), horse.getPositionY(), horse.getPositionZ(),
      horse.getAngleX(), horse.getAngleY(), horse.getAngleZ(),
      typeof seat === "number" ? seat : 90,
    );
    s.kinOk = ok !== false;
    if (ok === false) {
      // The native side revoked this lease (the clone's character controller was rebuilt, or the FormID now belongs
      // to a new clone): every later write with it is refused and the clone would stay where it is, on foot.
      if (now - s.renewAt > KIN_RENEW_MS) {
        s.renewAt = now;
        s.renewals++;
        s.lease = nextLease();
        s.serial = 0;
        setProfile(horseLocal, PROFILE_MOUNTED_HORSE, s.lease);
        setProfile(riderLocal, PROFILE_REMOTE_PROXY, s.lease);
        gmTrace("mount", "remote rider pair renewed", { rider: riderLocal.toString(16), lease: s.lease, n: s.renewals });
      }
    } else {
      s.glued++;
    }
    riding = applyPose(rider, horse, s, now);
    if (hidden.has(riderLocal)) {
      if ((s.pose === 0 || riding) && s.glued >= 2) reveal(rider, riderLocal, "seated");
      else keepHiddenOrGiveUp(rider, now);
    }
  }

  const seated = s.method === 1 && rider.isOnMount();
  if (seated && animStyle() === 5) {
    driveRiddenPair(horse, rider, now);
  } else {
    pairs.delete(horseLocal);
    if (seated) driveHorseGraph(horse, now);
  }

  if (gmDebugOn("mount") && now - s.traceAt > 500) {
    s.traceAt = now;
    const dx = rider.getPositionX() - horse.getPositionX();
    const dy = rider.getPositionY() - horse.getPositionY();
    const dz = rider.getPositionZ() - horse.getPositionZ();
    const data: Record<string, unknown> = {
      rider: riderLocal.toString(16),
      method: s.method,
      onMount: rider.isOnMount(),
      sit: rider.getSitState(),
      gap: Math.round(Math.sqrt(dx * dx + dy * dy)),
      dz: Math.round(dz),
    };
    if (s.method === 3) {
      data.pose = s.pose;
      data.riding = riding;
      data.bIsRiding = rider.getAnimationVariableBool("bIsRiding");
      data.bIsSynced = rider.getAnimationVariableBool("bIsSynced");
      data.IsDismounting = rider.getAnimationVariableBool("IsDismounting");
      data.iState = rider.getAnimationVariableInt("iState");
      data.hSpeed = Math.round(rider.getAnimationVariableFloat("HorseSpeedSampled"));
      data.speed = Math.round(rider.getAnimationVariableFloat("Speed"));
      data.vehicle = s.vehicle;
      data.sends = s.poseSends;
      data.lost = s.lost;
      data.kinOk = s.kinOk;
      data.lease = s.lease;
      data.renewals = s.renewals;
      data.hidden = hidden.has(riderLocal);
      data.seat = readStorage("gmMountSeat");
    }
    gmTrace("mount", "remote rider state", data);
  }
  return true;
};

/**
 * The remote rider sitting on this horse in our game, if any (real saddle). A ridden horse no longer listens to its
 * own AI: the walking intent that animates its legs must be given to its rider, as Skyrim's riding NPCs do.
 */
export const riderOnHorse = (horseLocal: number): Actor | null => {
  let found: Actor | null = null;
  riders.forEach((s, riderLocal) => {
    if (found || s.horse !== horseLocal || s.method !== 1) return;
    const rider = Actor.from(Game.getFormEx(riderLocal));
    if (rider && rider.isOnMount()) found = rider;
  });
  return found;
};

/** Method 3, the horse's view was re-created under the rider: the old pair goes, the pose stays. */
const detach = (rider: Actor, s: RiderState, why: string) => {
  riders.delete(rider.getFormID());
  horseGaits.delete(s.horse);
  spFn("releaseMountedPairKinematicTransform")?.(s.horse, rider.getFormID(), s.lease);
  if (s.vehicle) {
    try {
      rider.setVehicle(null);
    } catch (e) {
      gmTrace("mount", `remote rider vehicle off failed: ${e}`);
    }
  }
  setProfile(s.horse, PROFILE_NONE, s.lease);
  gmTrace("mount", "remote rider pair dropped", { rider: rider.getFormID().toString(16), horse: s.horse.toString(16), why });
};

/**
 * Method 3, after the teleport to the true position. 0 (default): stand up at once. JumpLandEnd is a wildcard of
 * 0_master's root state machine to Default_State (its four variants cover every currentDefaultState/bAttached),
 * so no clip plays. 1: the vanilla dismount (HorseExit -> DismountSynced, the Paired_Dismount clip played without
 * its horse), HorseExitOut sent later in case the rider's own never comes. 2: nothing, the rider's events decide.
 */
const exitPose = (rider: Actor, style: number): void => {
  if (style === 2) return;
  if (style === 1) {
    Debug.sendAnimationEvent(rider, "HorseExit");
    const id = rider.getFormID();
    Utility.wait(2.5).then(() => {
      const a = Actor.from(Game.getFormEx(id));
      if (a && !riders.has(id)) Debug.sendAnimationEvent(a, "HorseExitOut");
    });
    return;
  }
  Debug.sendAnimationEvent(rider, "JumpLandEnd");
};

const release = (rider: Actor, s: RiderState, truePos?: NiPoint3) => {
  riders.delete(rider.getFormID());
  horseGaits.delete(s.horse);
  pairs.delete(s.horse);
  let placed = false;
  let exit = -1;
  if (s.method === 1) {
    if (rider.isOnMount()) rider.dismount();
  } else {
    spFn("releaseMountedPairKinematicTransform")?.(s.horse, rider.getFormID(), s.lease);
    if (s.vehicle) {
      try {
        rider.setVehicle(null);
      } catch (e) {
        gmTrace("mount", `remote rider vehicle off failed: ${e}`);
      }
    }
    // Let go on the saddle, the clone slid down to its real place (Max, 2/10): it is put there at once, where the
    // server says its player stands.
    if (truePos) {
      try {
        TESModPlatform.moveRefrToPosition(
          rider, rider.getParentCell(), rider.getWorldSpace(),
          truePos[0], truePos[1], truePos[2], 0, 0, rider.getAngleZ(),
        );
        placed = true;
      } catch (e) {
        gmTrace("mount", `remote rider place after release failed: ${e}`);
      }
    }
    // Teleport first, then the graph leaves the riding state (the rider's own HorseExit was dropped while held).
    if (s.pose > 0 && graphRiding(rider)) {
      exit = exitStyle();
      exitPose(rider, exit);
    }
  }
  setProfile(s.horse, PROFILE_NONE, s.lease);
  setProfile(rider.getFormID(), PROFILE_NONE, s.lease);
  const id = rider.getFormID();
  const niNode = niNodePending.delete(id);
  if (niNode) {
    // After the stand-up or the dismount clip, unless it got back in the saddle meanwhile.
    Utility.wait(3).then(() => {
      const a = Actor.from(Game.getFormEx(id));
      if (a && !riders.has(id) && !a.isOnMount()) a.queueNiNodeUpdate();
    });
  }
  gmTrace("mount", "remote rider released", { rider: id.toString(16), method: s.method, placed, exit, niNode });
};
