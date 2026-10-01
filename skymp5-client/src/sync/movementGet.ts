import { gmDebugOn, gmTrace } from "../debugTrace";
import { FormModel } from '../view/model';
import { ObjectReference, Actor, TESModPlatform } from "skyrimPlatform";
import { NiPoint3, Movement, RunMode } from "./movement";
import { ObjectReferenceEx } from '../extensions/objectReferenceEx';

class PlayerCharacterSpeedCalculator {
  static savePosition(pos: NiPoint3, worldOrCell: number) {
    this.lastPcPos = pos;
    this.lastPcPosCheck = Date.now();
    this.lastPcWorldOrCell = worldOrCell;
  }

  static getSpeed(currentPos: NiPoint3, worldOrCell: number) {
    if (this.lastPcPosCheck === -1) {
      return 0;
    }

    const timeDeltaSec = (Date.now() - this.lastPcPosCheck) / 1000;
    if (timeDeltaSec > 5) return 0; // Too inaccurate
    if (timeDeltaSec === 0) return 0; // Division by zero
    if (worldOrCell !== this.lastPcWorldOrCell) {
      return 0;
    }

    const distance = ObjectReferenceEx.getDistance(currentPos, this.lastPcPos);
    return distance / timeDeltaSec;
  }

  private static lastPcPos: NiPoint3 = [0, 0, 0];
  private static lastPcPosCheck = -1;
  private static lastPcWorldOrCell = 0;
}

// ia-forge (mounts, 1er/10): Skyrim leaves SpeedSampled at 0 on a horse ridden by the player, so the horse we host
// was sent as "Standing" while galloping and slid without moving its legs in every other game. Its gait comes from
// how far it really went since the last send.
let lastGaitTrace = 0;
const riddenLast = new Map<number, { x: number; y: number; at: number }>();
const riddenGait = (refr: ObjectReference, pos: NiPoint3): { runMode: RunMode; speed: number } => {
  const id = refr.getFormID();
  const now = Date.now();
  const prev = riddenLast.get(id);
  riddenLast.set(id, { x: pos[0], y: pos[1], at: now });
  if (!prev || now - prev.at <= 0 || now - prev.at > 2000) return { runMode: "Standing", speed: 0 };
  const speed = Math.sqrt((pos[0] - prev.x) ** 2 + (pos[1] - prev.y) ** 2) / ((now - prev.at) / 1000);
  const runMode: RunMode = speed < 40 ? "Standing" : speed < 250 ? "Walking" : speed < 650 ? "Running" : "Sprinting";
  if (gmDebugOn("mount") && now - lastGaitTrace > 1000) {
    lastGaitTrace = now;
    gmTrace("mount", "ridden horse gait", { horse: id.toString(16), runMode, speed: Math.round(speed) });
  }
  return { runMode, speed };
};

export const getMovement = (refr: ObjectReference, form?: FormModel): Movement => {
  const ac = Actor.from(refr);
  const ridden = !!ac && refr.getFormID() !== 0x14 && ac.isBeingRidden();
  const gait = ridden ? riddenGait(refr, ObjectReferenceEx.getPos(refr)) : null;

  // It is running for ObjectReferences because Standing
  // Doesn't lead to translateTo call
  const runMode = gait ? gait.runMode : ac ? getRunMode(ac) : "Running";

  let healthPercentage = ac && ac.getActorValuePercentage("health");
  if (ac && ac.isDead()) {
    healthPercentage = 0;
  }

  let lookAt: undefined | NiPoint3 = undefined;
  if (refr.getFormID() !== 0x14) {
    const combatTarget = ac?.getCombatTarget();
    if (combatTarget) {
      lookAt = [
        combatTarget.getPositionX(),
        combatTarget.getPositionY(),
        combatTarget.getPositionZ(),
      ];
    }
  }

  const pos = ObjectReferenceEx.getPos(refr);

  let speed;
  if (gait) {
    speed = gait.speed;
  } else if (refr.getFormID() !== 0x14) {
    speed = refr.getAnimationVariableFloat("SpeedSampled");
  } else {
    // Real players often run into the wall.
    // We need to have zero speed in this case. SpeedSampled doesn't help
    const w = ObjectReferenceEx.getWorldOrCell(refr);
    speed = PlayerCharacterSpeedCalculator.getSpeed(pos, w);
    PlayerCharacterSpeedCalculator.savePosition(pos, w);

    // It's unrealistic speed. It still may happen due to teleports
    if (speed > 2000) {
      speed = 0;
    }
  }

  const worldOrCell = refr.getWorldSpace() || refr.getParentCell();

  return {
    worldOrCell: worldOrCell?.getFormID() || 0,
    pos,
    rot: [refr.getAngleX(), refr.getAngleY(), refr.getAngleZ()],
    runMode: runMode,
    // A ridden horse goes where it faces.
    direction: runMode !== "Standing" && !gait
      ? 360 * refr.getAnimationVariableFloat("Direction")
      : 0,
    isInJumpState: !!(ac && ac.getAnimationVariableBool("bInJumpState")),
    isSneaking: !!(ac && isSneaking(ac)),
    isBlocking: !!(ac && ac.getAnimationVariableBool("IsBlocking")),
    isWeapDrawn: !!(ac && ac.isWeaponDrawn()),
    isDead: (form?.isDead ?? false) || !!(ac && ac.isDead()),
    healthPercentage: healthPercentage || 0,
    lookAt,
    speed
  };
}

const isSneaking = (ac: Actor) =>
  ac.isSneaking() || ac.getAnimationVariableBool("IsSneaking");

const getRunMode = (ac: Actor): RunMode => {
  if (ac.isSprinting()) {
    return "Sprinting";
  }

  const speed = ac.getAnimationVariableFloat("SpeedSampled");
  if (!speed) {
    return "Standing";
  }

  const furniture = ac.getFurnitureReference();
  if (furniture !== null) return "Standing"; // TODO: Sitting?

  let isRunning = true;
  if (ac.getFormID() == 0x14) {
    if (!TESModPlatform.isPlayerRunningEnabled() || speed < 150)
      isRunning = false;
  } else {
    if (!ac.isRunning() || speed < 150) {
      isRunning = false;
    }
  }

  if (ac.getAnimationVariableFloat("IsBlocking")) {
    isRunning = isSneaking(ac);
  }

  const carryWeight = ac.getActorValue("CarryWeight");
  const totalItemWeight = ac.getTotalItemWeight();
  if (carryWeight < totalItemWeight) {
    isRunning = false;
  }

  return isRunning ? "Running" : "Walking";
};
