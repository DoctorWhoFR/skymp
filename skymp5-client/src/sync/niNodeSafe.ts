import { Actor, Game } from "skyrimPlatform";
import { gmTrace } from "../debugTrace";

// ia-forge (BUG-048, 1er/10): QueueNiNodeUpdate (DoReset3D) on a mounted actor breaks its physics: horse and rider
// thrown about violently until they dismount (Papyrus documentation; BStarRP's "flying horses" fix does the same).
// SkyMP rebuilds the player's 3D whenever another player's head enters the screen (formView), and any actor's 3D
// when its worn items change (inventory): never while in the saddle.

const PLAYER_FLUSH_AFTER_MS = 1500;

let playerPending = false;
let playerOffSince = 0;

/** queueNiNodeUpdate, unless the actor is riding. For the player the update waits for the dismount. */
export const queueNiNodeUpdateSafe = (ac: Actor, why: string): boolean => {
  const id = ac.getFormID();
  if (id === 0x14) {
    if (ac.isOnMount()) {
      if (!playerPending) gmTrace("mount", "queueNiNodeUpdate deferred (player mounted)", { why });
      playerPending = true;
      return false;
    }
    ac.queueNiNodeUpdate();
    return true;
  }
  if (ac.isOnMount()) {
    gmTrace("mount", "queueNiNodeUpdate skipped (rider seated)", { refr: id.toString(16), why });
    return false;
  }
  ac.queueNiNodeUpdate();
  return true;
};

/** Once per frame: a deferred update runs once the player has been on foot for a moment. */
export const flushPlayerNiNodeUpdate = (): void => {
  if (!playerPending) return;
  const player = Game.getPlayer();
  if (!player) return;
  const now = Date.now();
  if (player.isOnMount()) {
    playerOffSince = 0;
    return;
  }
  if (!playerOffSince) {
    playerOffSince = now;
    return;
  }
  if (now - playerOffSince < PLAYER_FLUSH_AFTER_MS) return;
  playerPending = false;
  playerOffSince = 0;
  player.queueNiNodeUpdate();
  gmTrace("mount", "queueNiNodeUpdate (deferred, player on foot)");
};
