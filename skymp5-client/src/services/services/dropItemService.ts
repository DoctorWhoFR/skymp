import { Actor, ContainerChangedEvent, storage } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";

import { MsgType } from "../../messages";
import { SweetTaffySweetCantDropService } from "./sweetTaffySweetCantDropService";
import { WorldCleanerService } from "./worldCleanerService";
import { logTrace } from "../../logging";
import { gmTrace } from "../../debugTrace";

export class DropItemService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
    }

    // ia-forge (2026-09-29): the gamemode's bag is a CEF page, not the InventoryMenu; it stores the time of its
    // dropObject in storage["gmDropAt"] so that the drop is reported to the server as well.
    private droppedFromGamemodeBag(): boolean {
        const at = "gmDropAt" in storage ? Number(storage["gmDropAt"]) : 0;
        return Date.now() - at < 2000;
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        const sweetCantDropService = this.controller.lookupListener(SweetTaffySweetCantDropService);

        const pl = this.sp.Game.getPlayer() as Actor;
        const isPlayer: boolean =
            pl && e.oldContainer && pl.getFormID() === e.oldContainer.getFormID();
        const noContainer: boolean =
            e.newContainer === null || e.newContainer === undefined;
        const isReference: boolean = e.reference !== null;
        if (e.newContainer && e.newContainer.getFormID() === pl.getFormID())
            return;
        const fromBag = this.droppedFromGamemodeBag();
        if (!this.sp.Ui.isMenuOpen("InventoryMenu") && !fromBag)
            return;
        if (fromBag) {
            gmTrace("inventory", "chute vue par SkyMP", {
                base: e.baseObj ? e.baseObj.getFormID().toString(16) : null,
                isPlayer, noContainer, isReference,
                reference: e.reference ? e.reference.getFormID().toString(16) : String(e.reference),
            });
        }
        if (
            isPlayer &&
            isReference &&
            noContainer &&
            sweetCantDropService.canDropOrPutItem(e.baseObj.getFormID())
        ) {
            const radius: number = 2000;
            const baseId = e.baseObj.getFormID();

            const player = this.sp.Game.getPlayer() as Actor;

            let set = new Set<number>();
            for (let i = 0; i < 200; i++) {
                const refrId = this.sp.Game.findRandomReferenceOfType(
                    this.sp.Game.getFormEx(baseId),
                    player.getPositionX(),
                    player.getPositionY(),
                    player.getPositionZ(),
                    radius
                )?.getFormID();
                if (refrId) {
                    set.add(refrId);
                } else {
                    break;
                }
            }

            let numFound = 0;

            const worldCleanerService = this.controller.lookupListener(WorldCleanerService);

            set.forEach((refrId) => {
                const ref = this.sp.ObjectReference.from(this.sp.Game.getFormEx(refrId));
                if (ref !== null && ref.isDeleted() === false) {
                    const refrId = ref.getFormID();

                    if (worldCleanerService.getWcProtection(refrId) === 0) {
                        ref.delete();
                        ++numFound;
                        logTrace(this, "Found and deleted reference " + refrId.toString(16));
                    } else {
                        logTrace(this, "Found reference " + refrId.toString(16) + " but it's protected");
                    }
                }
            });

            if (!numFound) {
                gmTrace("inventory", "chute ignorée : objet posé introuvable autour", { candidates: set.size });
                return logTrace(this, "Ignoring item drop as false positive");
            }
            gmTrace("inventory", "chute envoyée au serveur", { base: baseId.toString(16), count: e.numItems, found: numFound });

            const t = MsgType.DropItem;
            const count = e.numItems;
            // ia-forge: which copy, when the gamemode's bag picked one among several (docs/91).
            const copy = "gmDropCopy" in storage ? storage["gmDropCopy"] as
                { at?: number, baseId?: number, health?: number, ench?: number, poison?: number, name?: string } : null;
            const picked = copy && copy.baseId === baseId && Date.now() - Number(copy.at) < 2000 ? copy : null;
            this.controller.emitter.emit("sendMessage", {
                message: {
                    t, baseId, count,
                    ...(picked?.health ? { health: picked.health } : {}),
                    ...(picked?.ench ? { enchantmentId: picked.ench } : {}),
                    ...(picked?.poison ? { poisonId: picked.poison } : {}),
                    ...(picked?.name ? { name: picked.name } : {}),
                },
                reliability: "reliable"
            });
        }
    }
}
