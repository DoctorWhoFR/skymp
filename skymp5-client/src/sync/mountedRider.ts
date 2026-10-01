import { Actor, Game, storage } from "skyrimPlatform";
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
const ACTIVATE_RETRY_MS = 2000;

interface RiderState {
  horse: number;
  method: number;
  since: number;
  triedAt: number;
  serial: number;
  traceAt: number;
}

const riders = new Map<number, RiderState>();
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
      horse.activate(rider, true);
      gmTrace("mount", "remote rider activate", { rider: riderLocal.toString(16) });
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
  if (s.method === 1) {
    if (rider.isOnMount()) rider.dismount();
  } else {
    spFn("releaseMountedPairKinematicTransform")?.(s.horse, rider.getFormID(), lease);
  }
  setProfile(s.horse, PROFILE_NONE);
  setProfile(rider.getFormID(), PROFILE_NONE);
  gmTrace("mount", "remote rider released", { rider: rider.getFormID().toString(16) });
};
