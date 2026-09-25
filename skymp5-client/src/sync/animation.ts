/* eslint-disable @typescript-eslint/no-empty-function */
import {
  ObjectReference,
  Debug,
  hooks,
  Actor,
  printConsole,
  Utility,
  Game,
  storage,
  // @ts-expect-error (TODO: Remove in 2.10.0)
  setCollision
} from "skyrimPlatform";
import { Movement } from "./movement";
import { applyWeapDrawn } from "./movementApply";

export enum AnimationEventName {
  Ragdoll = "Ragdoll",
  GetUpBegin = "GetUpBegin",
};

export interface Animation {
  animEventName: string;
  numChanges: number;
}

export interface AnimationApplyState {
  lastNumChanges: number;
  useAnimOverrides: boolean;
}

// ia-forge : trace des animations « d'assise » des persos distants (lue par le script _gmAnimDiag du
// gamemode via storage["gmAnimTrace"]) pour comprendre pourquoi s'asseoir n'était pas vu (2026-09-25).
const SIT_TRACE = /chair|stool|bench|sit|throne/i;
// Signature de version du client maison (lue par le gamemode : quel client tourne chez chaque joueur).
try {
  storage["gmClientBuild"] = "ia-forge-local-3";
} catch (e) {
  // storage indisponible
}
export const animTrace = (ev: Record<string, unknown>): void => {
  try {
    const t = (storage["gmAnimTrace"] as Array<unknown> | undefined) ?? [];
    t.push({ at: Date.now(), ...ev });
    if (t.length > 50) t.splice(0, t.length - 50);
    storage["gmAnimTrace"] = t;
  } catch (e) {
    // trace indisponible
  }
};
const sitRetries = new Set<string>();

const allowedIdles = new Array<[number, string]>();
const refsWithDefaultAnimsDisabled = new Set<number>();
const allowedAnims = new Set<string>();

const actorSitAnimsLowerCase = [
  'idlestoolenterplayer',
  'idlestoolenter',
  'idlestoolenterinstant',
  'idlechairrightenter',
  'idlechairleftenter',
  'idlechairfrontenter',
  'idlechairenterinstant',
  'idlejarlchairenter',
  'idlejarlchairenterinstant',
  'idlesnowelfprincechairdialogue',
  'idlesnowelfprincechairenter',
  'idlesnowelfprincechairenterinstant',
  'idlechairchildenterinstant',
  'idlechairchildfrontenter',
  'idlechairchildleftenter',
  'idlechairchildrightenter',
];

const actorGetUpAnimsLowerCase = [
  'idlestoolbackexit',
  'idlechairrightexit',
  'idlechairrightquickexit',
  'idlechairleftexit',
  'idlechairleftquickexit',
  'idlechairfrontexit',
  'idlechairfrontquickexit',
  'idlechairchildfrontexit',
  'idlechairchildleftexit',
  'idlechairchildrightexit'
];

// It's critical for values to be the correct case, not just lowercase, otherwise 'allowedIdles' check will break
// We don't want to modify the check itself, because it'll be slower
const animOverridesLowerCase: Record<string, string | undefined> = {
  'idlechairbook_onepage': 'IdleChairEnterInstant',
  'idlechairshoulderflex': 'IdleChairEnterInstant',
  'idlechairwrite': 'IdleChairEnterInstant',
  'idlechairarmscrossedvar1': 'IdleChairEnterInstant',
  'chaireatingstart_vampiremeat': 'IdleChairEnterInstant',
  'chairreadingstart': 'IdleChairEnterInstant',
  'chairvampireeatingstart': 'IdleChairEnterInstant',
  'chairdrinkingstart': 'IdleChairEnterInstant',
  'chaireatingstart': 'IdleChairEnterInstant',

  // The only triple animation we know for now. One base anim to sit, then two to eat
  'chaireatingsoupstart': 'IdleChairEnterInstant',
  'idleeatsoup': 'IdleChairEnterInstant',

  // No need to re-play the animation, use instant variant for spawning actors
  // This is not essential, but makes the sync feel more smooth. The list is not complete.
  'idlechairrightenter': 'IdleChairEnterInstant',
  'idlechairleftenter': 'IdleChairEnterInstant',
  'idlechairfrontenter': 'IdleChairEnterInstant',

  // Untested yet looks correct
  'idlesnowelfprincefireandforget': 'IdleSnowElfPrinceChairEnterInstant',
  'idletablemugenter': 'IdleTableEnterInstant',
  'idletabledrinkenter': 'IdleTableEnterInstant',
  'idletabledrinkandmugenter': 'IdleTableEnterInstant'
};

// unclassified:

// IdleChairEnterInstant
// IdleChairEnterStart
// IdleChairEnterStop
// IdleChairEnterToSit
// IdleChairExitStart
// IdleChairExitToStand
// IdleChairSitting
// IdleLeftChairEnterStart
// ChairIdle
// IdleRightChairEnterStart
// IdleLeftChairEnterStart

const isIdle = (animEventName: string) => {
  const animEventNameLowerCase = animEventName.toLowerCase();
  return (
    animEventNameLowerCase === "motiondrivenidle" ||
    (animEventNameLowerCase.startsWith("idle") &&
      animEventNameLowerCase !== "idlestop" &&
      animEventNameLowerCase !== "idleforcedefaultstate")
  );
};

export const applyAnimation = (
  refr: ObjectReference,
  anim: Animation,
  state: AnimationApplyState
): void => {
  if (SIT_TRACE.test(anim.animEventName)) {
    animTrace({ ev: "apply", refr: refr.getFormID().toString(16), anim: anim.animEventName, n: anim.numChanges, last: state.lastNumChanges, overrides: state.useAnimOverrides });
  }
  if (state.lastNumChanges === anim.numChanges) {
    return;
  }
  state.lastNumChanges = anim.numChanges;

  if (state.useAnimOverrides) {
    const animOverride = animOverridesLowerCase[anim.animEventName.toLowerCase()];
    if (animOverride !== undefined) {
      anim.animEventName = animOverride;
    }
  }

  const animEventNameLowerCase = anim.animEventName.toLowerCase();

  if (isIdle(anim.animEventName)) {
    allowedIdles.push([refr.getFormID(), anim.animEventName]);
  }

  const ac = Actor.from(refr);

  if (anim.animEventName === "SkympFakeEquip") {
    if (ac) {
      applyWeapDrawn(ac, true);
    }
    return;
  }

  if (anim.animEventName === "SkympFakeUnequip") {
    if (ac) {
      applyWeapDrawn(ac, false);
    }
    return;
  }

  if (anim.animEventName === "Ragdoll") {
    if (ac) {
      if (storage["animationFunc1Set"] === true) {
        // @ts-ignore
        storage["animationFunc1"](ac);
      } else {
        ac.pushActorAway(ac, 0);
        ac.setActorValue("Variable10", -1000);
      }
    }
    return;
  }

  if (refsWithDefaultAnimsDisabled.has(refr.getFormID())) {
    if (animEventNameLowerCase.includes("attack")) {
      allowedAnims.add(refr.getFormID() + ":" + anim.animEventName);
    }
  }

  Debug.sendAnimationEvent(refr, anim.animEventName);

  if (anim.animEventName === "GetUpBegin") {
    const refrId = refr.getFormID();
    Utility.wait(1).then(() => {
      const ac = Actor.from(Game.getFormEx(refrId));
      if (ac) {
        ac.setActorValue("Variable10", 1000);
      }
    });
  }

  if (actorSitAnimsLowerCase.find((x) => x === animEventNameLowerCase) !== undefined) {
    setCollision(refr.getFormID(), false);
  }

  if (actorGetUpAnimsLowerCase.find((x) => x === animEventNameLowerCase) !== undefined) {
    setCollision(refr.getFormID(), true);
  }
};

export const setDefaultAnimsDisabled = (
  refrId: number,
  disabled: boolean
): void => {
  if (disabled) {
    refsWithDefaultAnimsDisabled.add(refrId);
  } else {
    refsWithDefaultAnimsDisabled.delete(refrId);
  }
};

export class AnimationSource {
  constructor(refr: ObjectReference) {
    this.refrId = refr.getFormID();
    hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => {
        if (ctx.selfId !== this.refrId) {
          return;
        }

        if (!ctx.animationSucceeded) {
          // Workaround, see carryAnimSystem.ts in gamemode
          // Case-sensetive check here for better performance
          if (ctx.animEventName !== "OffsetCarryBasketStart") {
            return;
          }
        }
        this.onSendAnimationEvent(ctx.animEventName);
      },
    });
  }

  filterMovement(mov: Movement): Movement {
    if (this.weapDrawnBlocker >= Date.now()) {
      mov.isWeapDrawn = true;
    }
    if (this.weapNonDrawnBlocker >= Date.now()) {
      mov.isWeapDrawn = false;
    }

    if (this.sneakBlocker === mov.isSneaking) {
      this.sneakBlocker = null;
    } else if (this.sneakBlocker === true) {
      mov.isSneaking = true;
    } else if (this.sneakBlocker === false) {
      mov.isSneaking = false;
    }

    return mov;
  }

  getAnimation(): Animation {
    const { numChanges, animEventName } = this;
    return { numChanges, animEventName };
  }

  private onSendAnimationEvent(animEventName: string) {
    if (ignoredAnims.has(animEventName)) {
      return;
    }

    const lower = animEventName.toLowerCase();

    const isTorchEvent = lower.includes("torch");
    if (animEventName.toLowerCase().includes("unequip") && !isTorchEvent) {
      this.weapNonDrawnBlocker = Date.now() + 300;
      animEventName = "SkympFakeUnequip";
    } else if (animEventName.toLowerCase().includes("equip") && !isTorchEvent) {
      this.weapDrawnBlocker = Date.now() + 300;
      animEventName = "SkympFakeEquip";
    }

    if (animEventName === "SneakStart") {
      this.sneakBlocker = true;
      return;
    }
    if (animEventName === "SneakStop") {
      this.sneakBlocker = false;
      return;
    }

    this.numChanges++;
    this.animEventName = animEventName;
  }

  private refrId = 0;
  private numChanges = 0;
  private animEventName = "";

  private weapNonDrawnBlocker = 0;
  private weapDrawnBlocker = 0;
  private sneakBlocker: boolean | null = null;
}

const ignoredAnims = new Set<string>([
  "moveStart",
  "moveStop",
  "turnStop",
  "CyclicCrossBlend",
  "CyclicFreeze",
  "TurnLeft",
  "TurnRight",
]);

export const setupHooks = (): void => {
  hooks.sendAnimationEvent.add({
    enter: (ctx) => {
      if (refsWithDefaultAnimsDisabled.has(ctx.selfId)) {
        if (ctx.animEventName.toLowerCase().includes("attack")) {
          const animKey = ctx.selfId + ":" + ctx.animEventName;
          if (allowedAnims.has(animKey)) {
            allowedAnims.delete(animKey);
          } else {
            printConsole("block anim " + ctx.animEventName);
            return (ctx.animEventName = "");
          }
        }
      }

      // ShowRaceMenu forces this anim
      if (ctx.animEventName === "OffsetBoundStandingPlayerInstant") {
        return (ctx.animEventName = "");
      }

      // Disable idle animations for 0xff actors
      if (ctx.selfId < 0xff000000) {
        return;
      }
      if (isIdle(ctx.animEventName)) {
        const i = allowedIdles.findIndex((pair) => {
          return pair[0] === ctx.selfId && pair[1] === ctx.animEventName;
        });
        if (i === -1) {
          if (SIT_TRACE.test(ctx.animEventName)) animTrace({ ev: "blocked", refr: ctx.selfId.toString(16), anim: ctx.animEventName });
          ctx.animEventName = "";
        } else {
          allowedIdles.splice(i, 1);
        }
      }
    },
    leave: (ctx) => {
      // ia-forge : un perso distant qui n'est pas « installé » sur le meuble refuse l'animation d'entrée
      // (IdleChairLeftEnter…) ; l'animation « instantanée » passe (vue à l'apparition) → repli.
      if (ctx.selfId < 0xff000000 || !ctx.animEventName) return;
      const lower = ctx.animEventName.toLowerCase();
      if (!actorSitAnimsLowerCase.includes(lower) || lower.endsWith("instant")) return;
      animTrace({ ev: "result", refr: ctx.selfId.toString(16), anim: ctx.animEventName, ok: ctx.animationSucceeded });
      const key = ctx.selfId + ":" + ctx.animEventName;
      if (!ctx.animationSucceeded && !sitRetries.has(key)) {
        sitRetries.add(key);
        const fallback = lower.includes("stool") ? "IdleStoolEnterInstant" : lower.includes("jarl") ? "IdleJarlChairEnterInstant" : "IdleChairEnterInstant";
        const refr = ObjectReference.from(Game.getFormEx(ctx.selfId));
        if (refr) {
          allowedIdles.push([ctx.selfId, fallback]);
          Debug.sendAnimationEvent(refr, fallback);
          setCollision(ctx.selfId, false);
          animTrace({ ev: "fallback", refr: ctx.selfId.toString(16), anim: fallback });
        }
        Utility.wait(2).then(() => sitRetries.delete(key));
      }
    },
  });
};
