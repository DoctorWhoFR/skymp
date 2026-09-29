// TODO: refactor this out
import { localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";

// @ts-expect-error (TODO: Remove in 2.10.0)
import { SpellCastEvent, Actor, printConsole, Game, getAnimationVariablesFromActor, ActorAnimationVariables, SpellType, SlotType, EquippedItemType } from 'skyrimPlatform'
import { ClientListener, CombinedController, Sp } from './clientListener';
import { logTrace } from '../../logging';
import { gmTrace } from '../../debugTrace';
import { RemoteServer } from "./remoteServer";

import { MsgType } from "../../messages";
import { SpellCastMsgData, SpellCastMessage } from "../messages/spellCastMessage";
import { UpdateAnimVariablesMessageMsgData } from "../messages/updateAnimVariablesMessage";

export class MagicSyncService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
        this.controller.on("spellCast", (e) => this.onSpellCast(e));

        const self = this;


        this.sp.hooks.sendAnimationEvent.add({
            enter: (ctx) => { },
            leave: (ctx) => {
                self.onSendAnimationEventLeave(ctx);
            }
        }, this.playerId, this.playerId);
    }

    private onUpdate() {
        this.sendInterruptWhenCastEnds();

        if (this.isAnyMagicStuffEquiped() === false) {
            return;
        }

        if (Date.now() - this.lastSendUpdateAnimationVariables <= this.sendUpdateAnimationVariablesRateMs) {
            return;
        }

        this.lastSendUpdateAnimationVariables = Date.now();

        this.controller.once('update', () => {
            const ac = Game.getPlayer();

            if (!ac) {
                return;
            }

            const animVariables = this.getAnimationVariablesFromActorConverted(ac.getFormID());

            this.controller.emitter.emit("sendMessage", {
                message: { t: MsgType.UpdateAnimVariables, data: this.getUpdateAnimVariablesEventData(ac, animVariables) },
                reliability: "reliable"
            });
        });

    }

    private onSpellCast(event: SpellCastEvent) {
        const isInterruptCast = false;

        const msg: SpellCastMsgData = this.getSpellCastEventData(event, isInterruptCast);

        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.SpellCast, data: msg },
            reliability: "reliable"
        });

        this.lastSpellCastEventMsg = msg;
        this.castSeen = false;
        this.notCastingSince = 0;
    }

    // ia-forge (2026-09-29) : l'arrêt d'un sort n'était envoyé que sur l'événement d'animation « arme de nouveau en main »
    // (onSendAnimationEventLeave), qui ne passe pas toujours : un sort à maintenir (Flammes, Guérison) relâché restait
    // actif chez les autres joueurs. On envoie aussi l'arrêt dès que le lanceur a été vu en train de lancer puis ne
    // lance plus depuis 150 ms ; si l'arrêt est déjà parti par l'autre chemin, rien de plus.
    private sendInterruptWhenCastEnds() {
        const msg = this.lastSpellCastEventMsg;
        if (!msg || msg.interruptCast) {
            return;
        }
        const ac = Actor.from(Game.getFormEx(this.casterLocalId(msg)));
        if (!ac) {
            return;
        }
        const casting = ac.getAnimationVariableBool("IsCastingRight")
            || ac.getAnimationVariableBool("IsCastingLeft")
            || ac.getAnimationVariableBool("IsCastingDual");
        if (casting) {
            this.castSeen = true;
            this.notCastingSince = 0;
            return;
        }
        if (!this.castSeen) {
            return;
        }
        if (!this.notCastingSince) {
            this.notCastingSince = Date.now();
            return;
        }
        if (Date.now() - this.notCastingSince < 150) {
            return;
        }
        msg.interruptCast = true;
        msg.actorAnimationVariables = this.getAnimationVariablesFromActorConverted(ac.getFormID());
        gmTrace("combat", `arrêt de sort envoyé (plus en train de lancer)`, { caster: msg.caster.toString(16) });
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.SpellCast, data: msg },
            reliability: "reliable"
        });
    }

    private onSendAnimationEventLeave(ctx: { animEventName: string, animationSucceeded: boolean }) {

        if (!this.lastSpellCastEventMsg || !this.isInteraptSpellCastAnim(ctx.animEventName)) {
            return;
        }

        this.controller.once('update', () => {
            if (!this.lastSpellCastEventMsg || this.lastSpellCastEventMsg.interruptCast) {
                return;
            }

            let msg: SpellCastMsgData = this.lastSpellCastEventMsg;
            msg.interruptCast = true;
            gmTrace("combat", "arrêt de sort envoyé (animation)", { caster: msg.caster.toString(16) });
            msg.actorAnimationVariables = this.getAnimationVariablesFromActorConverted(this.casterLocalId(msg));

            this.controller.emitter.emit("sendMessage", {
                message: { t: MsgType.SpellCast, data: msg },
                reliability: "reliable"
            });
        });

    }

    // ia-forge (2026-09-29) : notre propre personnage n'a pas de vue (formViews) : remoteIdToLocalId de notre id serveur
    // rend 0, getAnimationVariablesFromActor(0) rend undefined et l'arrêt plantait avant d'être envoyé.
    private casterLocalId(msg: SpellCastMsgData): number {
        const remote = this.controller.lookupListener(RemoteServer).getMyRemoteRefrId();
        return msg.caster === remote ? this.playerId : remoteIdToLocalId(msg.caster);
    }

    private getSpellCastEventData(e: SpellCastEvent, isInterruptCast: boolean): SpellCastMsgData {
        const spellCastData: SpellCastMsgData = {
            caster: localIdToRemoteId(e.caster.getFormID(), true),
            // @ts-expect-error (TODO: Remove in 2.10.0)
            target: e.target ? localIdToRemoteId(e.target.getFormID(), true) : 0,
            spell: e.spell ? e.spell.getFormID() : 0,
            interruptCast: isInterruptCast,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            isDualCasting: e.isDualCasting,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            castingSource: e.castingSource,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimAngle: e.aimAngle,
            // @ts-expect-error (TODO: Remove in 2.10.0)
            aimHeading: e.aimHeading,
            actorAnimationVariables: this.getAnimationVariablesFromActorConverted(e.caster.getFormID()),
        }
        return spellCastData;
    }

    private getAnimationVariablesFromActorConverted(actorId: number) {
        const animVars = getAnimationVariablesFromActor(actorId);
        const booleans: ArrayBuffer = animVars.booleans;
        const floats: ArrayBuffer = animVars.floats;
        const integers: ArrayBuffer = animVars.integers;
        return {
            booleans: Array.from(new Uint8Array(booleans)),
            floats: Array.from(new Uint8Array(floats)),
            integers: Array.from(new Uint8Array(integers)),
        }
    }

    private getUpdateAnimVariablesEventData(ac: Actor, animVariables: ActorAnimationVariables): UpdateAnimVariablesMessageMsgData {
        const animVarsData: UpdateAnimVariablesMessageMsgData = {
            actorRemoteId: localIdToRemoteId(ac.getFormID(), true),
            actorAnimationVariables: animVariables,
        }
        return animVarsData;
    }

    private isInteraptSpellCastAnim(animEventName: string): boolean {
        const eventName = animEventName.toLowerCase();
        return eventName === "mlh_equipped_event" || eventName === "mrh_equipped_event";
    };

    private isSpellCastAnim(animEventName: string): boolean {
        const eventName = animEventName.toLowerCase();

        const isSpellCastAnimForLeftHand = eventName === "mlh_spellaimedconcentrationstart" || eventName === "mlh_spellaimedstart" || eventName === "mlh_spellready_event" ||
            eventName === "mlh_spellrelease_event" || eventName === "mlh_equipped_event";

        const isSpellCastAnimForRightHand = eventName === "mrh_spellaimedconcentrationstart" || eventName === "mrh_spellaimedstart" || eventName === "mrh_spellready_event" ||
            eventName === "mrh_spellrelease_event" || eventName === "mrh_equipped_event";

        return isSpellCastAnimForLeftHand || isSpellCastAnimForRightHand;
    };

    private isAnyMagicStuffEquiped(): boolean {
        const ac = Game.getPlayer();

        if (!ac) {
            return false;
        }

        if (ac.getEquippedSpell(SpellType.Left) || ac.getEquippedSpell(SpellType.Right)) {
            return true;
        }

        if (ac.getEquippedSpell(SpellType.Voise) || ac.getEquippedSpell(SpellType.Instant)) {
            return true;
        }

        const leftHandEquipmentType = ac.getEquippedItemType(SlotType.Left);
        const rightHandEquipmentType = ac.getEquippedItemType(SlotType.Right);

        if (leftHandEquipmentType === 9 || leftHandEquipmentType === EquippedItemType.Staff ||
            rightHandEquipmentType === 9 || rightHandEquipmentType === EquippedItemType.Staff) {
            return true;
        }

        return false;
    }

    private playerId = 0x14;
    private sendUpdateAnimationVariablesRateMs = 500;
    private lastSpellCastEventMsg: SpellCastMsgData | null = null;
    private castSeen = false;
    private notCastingSince = 0;
    private lastSendUpdateAnimationVariables: number = 0;
}
