#include "MovementValidation.h"
#include <cmath>
#include <spdlog/spdlog.h>
#include "FormDesc.h"
#include "NiPoint3.h"
#include "PartOne.h"
#include "TeleportMessage2.h"
#include <nlohmann/json.hpp>
#include <string>

namespace MovementValidation {

bool Validate(PartOne& partOne, const NiPoint3& currentPos,
              const NiPoint3& currentRot, const FormDesc& currentCellOrWorld,
              const NiPoint3& newPos, const FormDesc& newCellOrWorld,
              Networking::UserId userId, MpActor* actor,
              const std::vector<std::string>& espmFiles)
{
  constexpr float kSqrMaxDistance = 4096.f * 4096.f;

  PartOneSendTargetWrapper& sendTarget = partOne.GetSendTarget();

  if (currentCellOrWorld != newCellOrWorld ||
      (currentPos - newPos).SqrLength() >= kSqrMaxDistance) {

    // Not doing this to any NPCs at this moment, yet we might consider to
    bool isMe = actor && partOne.serverState.ActorByUser(userId) == actor;
    if (isMe) {
      TeleportMessage2 msg;
      msg.pos = { currentPos[0], currentPos[1], currentPos[2] };
      msg.rot = { currentRot[0], currentRot[1], currentRot[2] };
      msg.worldOrCell = currentCellOrWorld.ToFormId(espmFiles);
      sendTarget.Send(userId, msg, true);
      return false;
    }

    // ia-forge (2026-09-25) : pour un PNJ, l'expéditeur est son hôte (vérifié par SendToNeighbours) et le
    // serveur ne simule rien lui-même : rejeter en silence figeait le PNJ côté serveur pour toujours (position
    // obsolète → PNJ diffusé/retiré au centimètre près, « il se téléporte sur moi », OnHit « too distant »).
    // On fait confiance à l'hôte et on journalise le saut pour comprendre d'où il vient.
    const float dist = std::sqrt((currentPos - newPos).SqrLength());
    spdlog::warn("MovementValidation - NPC {:x} hosted by user {}: jump of {:.0f} units ({:.0f} m), cell change {} ({} -> {}), accepted (ia-forge: trust hoster)",
                 actor ? actor->GetFormId() : 0, userId, dist, dist / 70.f,
                 currentCellOrWorld != newCellOrWorld ? "yes" : "no",
                 currentCellOrWorld.ToString(), newCellOrWorld.ToString());
    return true;
  }
  return true;
}

} // namespace MovementValidation
