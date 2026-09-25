import { ObjectReference, Game, Actor, MotionType, TESModPlatform, Cell, WorldSpace, storage } from "skyrimPlatform";
import { Appearance, applyTints } from "../sync/appearance";
import { NiPoint3 } from "../sync/movement";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";
import { animTrace } from "../sync/animation";

export class SpawnProcess {
  private pos: NiPoint3;
  private worldOrCell: number;

  constructor(
    appearance: Appearance | null,
    pos: NiPoint3,
    refrId: number,
    private callback: () => void,
    worldOrCell = 0,
  ) {
    this.pos = [pos[0], pos[1], pos[2]];
    this.worldOrCell = worldOrCell;
    // ia-forge : tant que la naissance n'est pas finie, sendInputsService ne doit rien envoyer pour ce PNJ (sinon
    // sa position « sur le joueur » part au serveur et devient la vraie). Liste des naissances en cours.
    SpawnProcess.setSpawning(refrId, true);
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
        animTrace({ ev: "spawn", refr: refrId.toString(16), base: (r2.getBaseObject()?.getFormID() ?? 0).toString(16), target: pos.map(Math.round), before: before.map(Math.round), after: after.map(Math.round), dist: Math.round(dist), cell: worldOrCell.toString(16) }, "naissance");
        if (dist > 64 && worldOrCell) {
          try {
            TESModPlatform.moveRefrToPosition(r2, Cell.from(Game.getFormEx(worldOrCell)), WorldSpace.from(Game.getFormEx(worldOrCell)), pos[0], pos[1], pos[2], 0, 0, 0);
            const fixed = ObjectReferenceEx.getPos(r2);
            animTrace({ ev: "spawn-fixed", refr: refrId.toString(16), dist: Math.round(ObjectReferenceEx.getDistance(fixed, pos)) }, "naissance");
          } catch (e) {
            animTrace({ ev: "spawn-fix-error", refr: refrId.toString(16), error: String(e) }, "naissance");
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
    refr.enable(false).then(() => {
      this.fixPosition(refrId, "spawn-enabled");
      this.resurrect(refrId);
    });
  }

  private fixPosition(refrId: number, ev: string) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) return;
    const before = ObjectReferenceEx.getPos(refr);
    const dist = ObjectReferenceEx.getDistance(before, this.pos);
    let after = before;
    if (dist > 64 && this.worldOrCell) {
      try {
        TESModPlatform.moveRefrToPosition(refr, Cell.from(Game.getFormEx(this.worldOrCell)), WorldSpace.from(Game.getFormEx(this.worldOrCell)), this.pos[0], this.pos[1], this.pos[2], 0, 0, 0);
        after = ObjectReferenceEx.getPos(refr);
      } catch (e) {
        animTrace({ ev: ev + "-error", refr: refrId.toString(16), error: String(e) }, "naissance");
      }
    }
    animTrace({ ev, refr: refrId.toString(16), dist: Math.round(dist), fixed: dist > 64, after: after.map(Math.round), target: this.pos.map(Math.round) }, "naissance");
  }

  private resurrect(refrId: number) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) {
      return;
    }

    const ac = Actor.from(refr);
    if (ac) {
      return ac.resurrect().then(() => {
        // ia-forge (2026-09-25) : après enable + resurrect, l'acteur est revenu SUR le joueur (là où placeAtMe
        // l'a créé) : traces « spawn » (dist 0 après SetPosition) puis saut serveur de 92 m = distance joueur→cible.
        // On le replace ici, une fois activé, par la fonction robuste des téléportations.
        this.fixPosition(refrId, "spawn-final");
        SpawnProcess.setSpawning(refrId, false);
        this.callback();
      });
    }

    ObjectReferenceEx.dealWithRef(refr, refr.getBaseObject()!);

    SpawnProcess.setSpawning(refrId, false);
    return refr.setMotionType(MotionType.Keyframed, true).then(this.callback);
  }

  static setSpawning(refrId: number, on: boolean) {
    try {
      const cur = storage["gmSpawning"];
      const list = (Array.isArray(cur) ? cur : []) as number[];
      const next = on ? (list.includes(refrId) ? list : list.concat([refrId])) : list.filter((x) => x !== refrId);
      storage["gmSpawning"] = next;
    } catch (e) {
      // storage indisponible
    }
  }

  /** Vrai si la naissance de ce PNJ (id local) est encore en cours. */
  static isSpawning(refrId: number): boolean {
    try {
      const cur = storage["gmSpawning"];
      return Array.isArray(cur) && (cur as number[]).includes(refrId);
    } catch (e) {
      return false;
    }
  }
}
