#include "HosterBinding.h"
#include "HostStartMessage.h"
#include "HostStopMessage.h"
#include "NapiHelper.h"

Napi::Value HosterBinding::Get(Napi::Env env, ScampServer& scampServer,
                               uint32_t formId)
{
  auto& forced = scampServer.GetPartOne()->worldState.forcedHosters;
  auto it = forced.find(formId);
  return Napi::Number::New(env, it == forced.end() ? 0 : it->second);
}

// Same steps as ActionListener::OnHostAttempt when it grants a host: the new
// hoster starts, the previous one stops, neighbours learn who hosts it.
void HosterBinding::Set(Napi::Env env, ScampServer& scampServer,
                        uint32_t formId, Napi::Value newValue)
{
  auto& partOne = scampServer.GetPartOne();
  auto& worldState = partOne->worldState;
  const uint32_t newHoster = NapiHelper::ExtractUInt32(newValue, "hoster");

  if (newHoster == 0) {
    worldState.forcedHosters.erase(formId);
    return;
  }

  auto& remote = worldState.GetFormAt<MpObjectReference>(formId);
  auto& hosterActor = worldState.GetFormAt<MpActor>(newHoster);

  worldState.forcedHosters[formId] = newHoster;
  const uint32_t prevHoster = worldState.hosters[formId];
  worldState.hosters[formId] = newHoster;
  remote.UpdateHoster(newHoster);

  const auto idx = remote.GetIdx();
  if (worldState.lastMovUpdateByIdx.size() <= idx) {
    worldState.lastMovUpdateByIdx.resize(idx + 1);
  }
  worldState.lastMovUpdateByIdx[idx] = std::chrono::system_clock::now();

  uint64_t longFormId = remote.GetFormId();
  if (remote.AsActor() && longFormId < 0xff000000) {
    longFormId += 0x100000000;
  }

  if (prevHoster == newHoster) {
    return;
  }

  auto user = partOne->serverState.UserByActor(&hosterActor);
  if (user != Networking::InvalidUserId) {
    HostStartMessage message;
    message.target = longFormId;
    partOne->GetSendTarget().Send(user, message, true);
  }

  if (prevHoster == 0) {
    return;
  }
  auto& prevForm = worldState.LookupFormById(prevHoster);
  if (MpActor* prevActor = prevForm ? prevForm->AsActor() : nullptr) {
    auto prevUser = partOne->serverState.UserByActor(prevActor);
    if (prevUser != Networking::InvalidUserId && prevUser != user) {
      HostStopMessage message;
      message.target = longFormId;
      partOne->GetSendTarget().Send(prevUser, message, true);
    }
  }
}
