import { Actor, Game, storage, TESModPlatform } from "skyrimPlatform";
import * as skyrimPlatform from "skyrimPlatform";
import { remoteIdToLocalId } from "../view/worldViewMisc";
import { gmDebugOn, gmTrace } from "../debugTrace";

// ia-forge (mounts, docs/92 § 5): another player riding a horse. The gamemode keeps storage.gmMounts
// = { horse server id: rider server id } in every game that sees the horse. Here, in an observer's game, the remote
// rider is kept on the remote horse instead of being moved by translateTo next to it.
// storage.gmMountMethod picks how (prototype, set by the staff command /mountmethod):
//   1 = real saddle: the horse is activated by the rider actor (default);
//   3 = no saddle: HDN's kinematic pair puts the rider on the horse's back at every frame.

const PROFILE_NONE = 0;
const PROFILE_MOUNTED_HORSE = 1;
const PROFILE_REMOTE_PROXY = 2;
const ACTIVATE_RETRY_MS = 800;

interface RiderState {
  horse: number;
  method: number;
  since: number;
  triedAt: number;
  serial: number;
  traceAt: number;
}

const riders = new Map<number, RiderState>();

// ia-forge (BUG-048, 1er/10): the walking intent given to the seated rider did not move the horse's legs. The
// horse's animation graph is driven directly, every frame, from the gait its rider sends (as Skyrim Together syncs
// Speed / HorseSpeedSampled / IsSprinting / iSyncSprintState of HorseRootBehavior).
interface HorseGait {
  speed: number;
  sprint: boolean;
  moving: boolean;
  at: number;
}
const horseGaits = new Map<number, HorseGait>();
let gaitTraceAt = 0;

/** From applyMovement: the gait received for a remote horse that a remote rider drives in our game. */
export const setRiddenHorseGait = (horseLocal: number, speed: number, runMode: string): void => {
  horseGaits.set(horseLocal, { speed, sprint: runMode === "Sprinting", moving: runMode !== "Standing", at: Date.now() });
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

/**
 * How the observer animates a remote ridden horse (staff command /mountmethod n seat anim, live, no relaunch):
 * 1 = rider keeps a walking intent + iSyncForwardState follows (local-43); 2 = neither (local-44);
 * 3 = walking intent, forward 0; 4 = no walking intent, forward follows.
 */
export const animStyle = (): number => {
  const a = readStorage("gmMountAnim");
  // Default 2 = local-44: the version Max saw as "tout est parfait" (1er/10, 02:19 UTC).
  return typeof a === "number" && a >= 1 && a <= 4 ? a : 2;
};

const spFn = (name: string): ((...args: number[]) => unknown) | undefined => {
  const f = (skyrimPlatform as unknown as Record<string, unknown>)[name];
  return typeof f === "function" ? (f as (...args: number[]) => unknown) : undefined;
};

const setProfile = (formId: number, profile: number) => {
  try {
    spFn("setCharacterControllerCollisionProfile")?.(formId, profile, lease);
  } catch (e) {
    gmTrace("mount", `collision profile failed: ${e}`);
  }
};

/**
 * Called by FormView for a remote actor at each update. Returns true when the actor is a rider held by the horse:
 * the caller must not translateTo it.
 */
export const applyMountedRider = (rider: Actor, riderRemoteId: number | undefined): boolean => {
  const horseRemote = horseOfRider(riderRemoteId);
  const riderLocal = rider.getFormID();
  const state = riders.get(riderLocal);

  if (!horseRemote) {
    if (state) release(rider, state);
    return false;
  }

  const horseLocal = remoteIdToLocalId(horseRemote);
  const horse = Actor.from(Game.getFormEx(horseLocal));
  if (!horse || !horse.is3DLoaded() || !rider.is3DLoaded()) {
    return !!state;
  }

  const now = Date.now();
  let s = state;
  if (!s || s.horse !== horseLocal || s.method !== method()) {
    if (s) release(rider, s);
    s = { horse: horseLocal, method: method(), since: now, triedAt: 0, serial: 0, traceAt: 0 };
    riders.set(riderLocal, s);
    lease = (lease + 1) >>> 0 || 1;
    setProfile(horseLocal, PROFILE_MOUNTED_HORSE);
    setProfile(riderLocal, PROFILE_REMOTE_PROXY);
    gmTrace("mount", "remote rider", { rider: riderLocal.toString(16), horse: horseLocal.toString(16), method: s.method });
  }

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
    spFn("setMountedPairKinematicTransform")?.(
      horseLocal, riderLocal, lease, s.serial,
      horse.getPositionX(), horse.getPositionY(), horse.getPositionZ(),
      horse.getAngleX(), horse.getAngleY(), horse.getAngleZ(),
      typeof seat === "number" ? seat : 90,
    );
  }

  if (s.method === 1 && rider.isOnMount()) driveHorseGraph(horse, now);

  if (gmDebugOn("mount") && now - s.traceAt > 500) {
    s.traceAt = now;
    const dx = rider.getPositionX() - horse.getPositionX();
    const dy = rider.getPositionY() - horse.getPositionY();
    const dz = rider.getPositionZ() - horse.getPositionZ();
    gmTrace("mount", "remote rider state", {
      rider: riderLocal.toString(16),
      method: s.method,
      onMount: rider.isOnMount(),
      sit: rider.getSitState(),
      gap: Math.round(Math.sqrt(dx * dx + dy * dy)),
      dz: Math.round(dz),
    });
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

const release = (rider: Actor, s: RiderState) => {
  riders.delete(rider.getFormID());
  horseGaits.delete(s.horse);
  if (s.method === 1) {
    if (rider.isOnMount()) rider.dismount();
  } else {
    spFn("releaseMountedPairKinematicTransform")?.(s.horse, rider.getFormID(), lease);
  }
  setProfile(s.horse, PROFILE_NONE);
  setProfile(rider.getFormID(), PROFILE_NONE);
  gmTrace("mount", "remote rider released", { rider: rider.getFormID().toString(16) });
};
