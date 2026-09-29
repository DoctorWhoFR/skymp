import { MsgType } from "../../messages";

export interface DropItemMessage {
    t: MsgType.DropItem,
    baseId: number,
    count: number,
    // ia-forge: the copy dropped from the gamemode's bag (docs/91)
    health?: number,
    enchantmentId?: number,
    poisonId?: number,
    name?: string
}
