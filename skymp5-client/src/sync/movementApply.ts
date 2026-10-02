import {
  ObjectReference,
  Actor,
  Game,
  TESModPlatform,
  Debug
} from "skyrimPlatform";
import { RespawnNeededError } from "../lib/errors";
import { Movement, RunMode, AnimationVariables, Transform, NiPoint3 } from "./movement";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { SpApiInteractor } from "../services/spApiInteractor";
import { animStyle, isGraphDrivenRider, isKinematicRider, riderOnHorse, setRiddenHorseGait } from "./mountedRider";
import { gmDebugOn, gmTrace } from "../debugTrace";
import { recordAction } from "./rideWatch";

const sqr = (x: number) => x * x;
let lastDriverTrace = 0;

// ia-forge (mounts): a remote rider held by its horse is not moved here (sync/mountedRider.ts).
export const applyMovement = (refr: ObjectReference, m: Movement, isMyClone?: boolean, mounted?: boolean): void => {
  if (teleportIfNeed(refr, m)) {
    return;
  }

  // Z axis isn't useful here
  const acX = refr.getPositionX();
  const acY = refr.getPositionY();
  const lagUnitsNoZ = Math.round(Math.sqrt(sqr(m.pos[0] - acX) + sqr(m.pos[1] - acY)));

  if (isMyClone === true) {
    SpApiInteractor.getControllerInstance().emitter.emit("newLocalLagValueCalculated", { lagUnitsNoZ });
  }

  if (!mounted) translateTo(refr, m);

  const ac = Actor.from(refr);
  if (!ac) {
    return;
  }

  let lookAt = null;
  if (m.lookAt) {
    try {
      lookAt = Game.findClosestActor(
        m.lookAt[0],
        m.lookAt[1],
        m.lookAt[2],
        128
      );
    } catch (e) {
      lookAt = null;
    }
  }

  if (lookAt) {
    ac.setHeadTracking(true);
    ac.setLookAt(lookAt, false);
  } else {
    ac.setHeadTracking(false);
  }

  // ac.stopCombat();
  ac.blockActivation(true);

  // ia-forge (mounts, 1er/10): a horse ridden by a remote rider in our game slid without moving its legs: its
  // walking intent goes to the rider, who drives it.
  const driver = mounted ? null : riderOnHorse(ac.getFormID());
  const style = driver || mounted ? animStyle() : 0;
  if (driver) {
    // The horse's graph is driven from the received gait (mountedRider.ts); the seated rider keeps its walking
    // intent too (local-44 removed it and the remote horse stopped animating; local-43 validated by Max, 1er/10).
    setRiddenHorseGait(ac.getFormID(), m.speed || 0, m.runMode, m.rot[2], m.pos);
    if (style === 1 || style === 3) keepOffsetFromActor(driver, m);
    if (gmDebugOn("mount") && Date.now() - lastDriverTrace > 1000) {
      lastDriverTrace = Date.now();
      gmTrace("mount", "horse driven by its rider", {
        horse: ac.getFormID().toString(16),
        rider: driver.getFormID().toString(16),
        runMode: m.runMode,
        style,
      });
    }
  } else if (!mounted) keepOffsetFromActor(ac, m);

  // ia-forge (mounts): a rider glued to its horse (method 3) gets its gait from the pose technique only; sprint,
  // block and sneak events from its on-foot movement would fight the riding state (BStarRP skips them too).
  // Style 5 (method 1): the gallop of a ridden pair comes from the horse's gait, for both graphs (mountedRider.ts).
  const glued = !!mounted && isKinematicRider(ac.getFormID());
  const sprintByPair = style === 5 && (!!driver || (!!mounted && isGraphDrivenRider(ac)));
  if (!glued && !sprintByPair) applySprinting(ac, m.runMode === "Sprinting");
  if (!glued) {
    applyBlocking(ac, m);
    applySneaking(ac, m.isSneaking);
  }
  applyWeapDrawn(ac, m.isWeapDrawn);
  applyHealthPercentage(ac, m.healthPercentage);

  SpApiInteractor.getControllerInstance().emitter.emit("applyDeathStateEvent", { actor: ac, isDead: m.isDead });
};

const keepOffsetFromActor = (ac: Actor, m: Movement) => {
  recordAction("keepOffset", ac, { run: m.runMode });
  let offsetAngle = m.rot[2] - ac.getAngleZ();
  if (Math.abs(offsetAngle) < 5) {
    offsetAngle = 0;
  }

  if (m.runMode === "Standing") {
    return ac.keepOffsetFromActor(ac, 0, 0, 0, 0, 0, offsetAngle, 1, 1);
  }
  const offset = [
    3 * Math.sin((m.direction / 180) * Math.PI),
    3 * Math.cos((m.direction / 180) * Math.PI),
    getOffsetZ(m.runMode),
  ];

  ac.keepOffsetFromActor(
    ac,
    offset[0],
    offset[1],
    offset[2],
    0,
    0,
    offsetAngle,
    m.runMode === "Walking" ? 2048 : 1,
    1,
  );
};

const getOffsetZ = (runMode: RunMode) => {
  switch (runMode) {
    case "Walking":
      return -512;
    case "Running":
      return -1024;
  }
  return 0;
};

const applySprinting = (ac: Actor, isSprinting: boolean) => {
  if (ac.isSprinting() != isSprinting) {
    Debug.sendAnimationEvent(ac, isSprinting ? "SprintStart" : "SprintStop");
  }
};

const applyBlocking = (ac: Actor, m: AnimationVariables) => {
  if (ac.getAnimationVariableBool("IsBlocking") != m.isBlocking) {
    Debug.sendAnimationEvent(ac, m.isBlocking ? "BlockStart" : "BlockStop");
    Debug.sendAnimationEvent(ac, m.isSneaking ? "SneakStart" : "SneakStop");
  }
};

const applySneaking = (ac: Actor, isSneaking: boolean) => {
  const currentIsSneaking =
    ac.isSneaking() || ac.getAnimationVariableBool("IsSneaking");
  if (currentIsSneaking != isSneaking) {
    Debug.sendAnimationEvent(ac, isSneaking ? "SneakStart" : "SneakStop");
  }
};

export const applyWeapDrawn = (ac: Actor, isWeapDrawn: boolean): void => {
  if (ac.isWeaponDrawn() !== isWeapDrawn) {
    TESModPlatform.setWeaponDrawnMode(ac, isWeapDrawn ? 1 : 0);
  }
};

const applyHealthPercentage = (ac: Actor, healthPercentage: number) => {
  const currentPercentage = ac.getActorValuePercentage('health');
  if (currentPercentage === healthPercentage) {
    return;
  }

  const currentMax = ac.getBaseActorValue('health');
  const deltaPercentage = healthPercentage - currentPercentage;
  const k = 0.25;
  if (deltaPercentage > 0) {
    ac.restoreActorValue('health', deltaPercentage * currentMax * k);
  } else if (deltaPercentage < 0) {
    ac.damageActorValue('health', deltaPercentage * currentMax * k);
  }
};

// Use global temp var to avoid allocation of an array on each translateTo
const gTempTargetPos: NiPoint3 = [0, 0, 0];

const translateTo = (refr: ObjectReference, m: Movement) => {
  let time = 0.2;
  if (m.isInJumpState || m.runMode !== "Standing") {
    time = 0.2;
  }

  // Local lag compensation
  // TODO: Remove "|| 0" hack (added to support old MpClientPlugin)
  const distanceAdd = (m.speed || 0) * time;
  const direction = m.rot[2] + m.direction;
  gTempTargetPos[0] = m.pos[0];
  gTempTargetPos[1] = m.pos[1];
  gTempTargetPos[2] = m.pos[2];

  // We do not want to add pos in case of standing-jumping
  if (m.runMode !== "Standing") {
    gTempTargetPos[0] += Math.sin(direction / 180 * Math.PI) * distanceAdd;
    gTempTargetPos[1] += Math.cos(direction / 180 * Math.PI) * distanceAdd;
  }

  const refrRealPos = ObjectReferenceEx.getPos(refr);
  const distance = ObjectReferenceEx.getDistance(refrRealPos, gTempTargetPos);

  const speed = distance / time;

  const angleDiff = Math.abs(m.rot[2] - refr.getAngleZ());
  if (
    m.runMode !== "Standing" ||
    m.isInJumpState ||
    ObjectReferenceEx.getDistanceNoZ(refrRealPos, gTempTargetPos) > 8 ||
    angleDiff > 80 ||
    Actor.from(refr)?.getSitState() === 3
  ) {
    const actor = Actor.from(refr);
    if (actor && actor.getActorValue("Variable10") < -999) {
      return;
    }

    if (!actor || !actor.isDead()) {
      recordAction("translateTo", refr, { to: [Math.round(gTempTargetPos[0]), Math.round(gTempTargetPos[1]), Math.round(gTempTargetPos[2])], speed: Math.round(speed), run: m.runMode });
      refr.translateTo(
        gTempTargetPos[0],
        gTempTargetPos[1],
        gTempTargetPos[2],
        m.rot[0],
        m.rot[1],
        m.rot[2],
        speed,
        0
      );
    }
  }
};

const teleportIfNeed = (refr: ObjectReference, m: Transform) => {
  if (
    isInDifferentWorldOrCell(refr, m.worldOrCell) ||
    (!refr.is3DLoaded() && isInDifferentExteriorCell(refr, m.pos))
  ) {
    throw new RespawnNeededError("needs to be respawned");
  }
  return false;
};

const cellWidth = 4096;

const isInDifferentExteriorCell = (refr: ObjectReference, pos: NiPoint3) => {
  const currentPos = ObjectReferenceEx.getPos(refr);
  const playerPos = ObjectReferenceEx.getPos(Game.getPlayer() as Actor);
  const targetDistanceToPlayer = ObjectReferenceEx.getDistance(playerPos, pos);
  const currentDistanceToPlayer = ObjectReferenceEx.getDistance(playerPos, currentPos);
  return currentDistanceToPlayer > cellWidth && targetDistanceToPlayer <= cellWidth;
};

const isInDifferentWorldOrCell = (
  refr: ObjectReference,
  worldOrCell: number
) => {
  return worldOrCell !== ObjectReferenceEx.getWorldOrCell(refr);
};
