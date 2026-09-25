import { ObjectReference, Game, Actor, MotionType, TESModPlatform, Cell, WorldSpace } from "skyrimPlatform";
import { Appearance, applyTints } from "../sync/appearance";
import { NiPoint3 } from "../sync/movement";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { animTrace } from "../sync/animation";

export class SpawnProcess {
  constructor(
    appearance: Appearance | null,
    pos: NiPoint3,
    refrId: number,
    private callback: () => void,
    worldOrCell = 0,
  ) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) {
      return;
    }

    // ia-forge (2026-09-25) : le PNJ est créé SUR le joueur (placeAtMe) puis déplacé par SetPosition (latent).
    // Quand ce déplacement échoue, le PNJ reste sur le joueur ; s'il est hébergé par ce joueur, sa position
    // (loin de celle du serveur) est ensuite rejetée par le serveur et il reste figé côté serveur. Traces +
    // second déplacement robuste (TESModPlatform.moveRefrToPosition, celui des téléportations de joueurs).
    const before = ObjectReferenceEx.getPos(refr);
    refr.setPosition(...pos).then(() => {
      const r2 = ObjectReference.from(Game.getFormEx(refrId));
      if (r2 && r2.getFormID() === refrId) {
        const after = ObjectReferenceEx.getPos(r2);
        const dist = ObjectReferenceEx.getDistance(after, pos);
        animTrace({ ev: "spawn", refr: refrId.toString(16), base: (r2.getBaseObject()?.getFormID() ?? 0).toString(16), target: pos.map(Math.round), before: before.map(Math.round), after: after.map(Math.round), dist: Math.round(dist), cell: worldOrCell.toString(16) });
        if (dist > 64 && worldOrCell) {
          try {
            TESModPlatform.moveRefrToPosition(r2, Cell.from(Game.getFormEx(worldOrCell)), WorldSpace.from(Game.getFormEx(worldOrCell)), pos[0], pos[1], pos[2], 0, 0, 0);
            const fixed = ObjectReferenceEx.getPos(r2);
            animTrace({ ev: "spawn-fixed", refr: refrId.toString(16), dist: Math.round(ObjectReferenceEx.getDistance(fixed, pos)) });
          } catch (e) {
            animTrace({ ev: "spawn-fix-error", refr: refrId.toString(16), error: String(e) });
          }
        }
      }
      this.enable(appearance, refrId);
    });
  }

  private enable(appearance: Appearance | null, refrId: number) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) {
      return;
    }

    const ac = Actor.from(refr);
    if (ac && appearance) {
      applyTints(ac, appearance);
    }
    refr.enable(false).then(() => this.resurrect(refrId));
  }

  private resurrect(refrId: number) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) {
      return;
    }

    const ac = Actor.from(refr);
    if (ac) {
      return ac.resurrect().then(() => {
        this.callback();
      });
    }

    ObjectReferenceEx.dealWithRef(refr, refr.getBaseObject()!);

    return refr.setMotionType(MotionType.Keyframed, true).then(this.callback);
  }
}
