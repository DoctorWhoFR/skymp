#include "ObjectReferenceApi.h"

#include "CallNativeApi.h"

#include <atomic>
#include <cmath>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <unordered_set>

extern CallNativeApi::NativeCallRequirements g_nativeCallRequirements;

namespace {
enum class CharacterControllerCollisionProfile : std::uint8_t
{
  kNone = 0,
  kMountedHorse = 1,
  kRemoteProxy = 2,
};

struct CharacterControllerCollisionOverride
{
  CharacterControllerCollisionProfile profile =
    CharacterControllerCollisionProfile::kNone;
  std::uint32_t lease = 0;
  RE::ActorHandle actorHandle;
  RE::NiPointer<RE::bhkCharacterController> boundController;
  bool hasControllerSnapshot = false;
  bool ownedNoCharacterCollisions = false;
  bool ownedNotPushable = false;
  bool ownedNotPushablePermanent = false;
  bool ownedPossiblePathObstacleReset = false;
  bool pathObstacleOverrideApplied = false;
  bool missingControllerLogged = false;
  std::uint32_t bindGeneration = 0;
};

struct ObjectReferenceTransform
{
  RE::NiPoint3 position;
  RE::NiPoint3 rotationRadians;
};

struct MountedPairKinematicTransform
{
  RE::FormID horseFormId = 0;
  RE::FormID riderFormId = 0;
  std::uint32_t lease = 0;
  std::uint32_t serial = 0;
  ObjectReferenceTransform horse;
  float riderSeatHeight = 0.f;
  bool writeRider = true;
};

struct MountedPairKinematicState
{
  RE::FormID horseFormId = 0;
  std::uint32_t lease = 0;
  std::uint32_t lastSerial = 0;
  std::uint32_t horseHandle = 0;
  std::uint32_t riderHandle = 0;
  bool scheduled = false;
  bool revoked = false;
  std::optional<MountedPairKinematicTransform> pending;
};

std::mutex g_transformMutex;
std::unordered_map<RE::FormID, ObjectReferenceTransform> g_pendingTransforms;
std::unordered_set<RE::FormID> g_scheduledTransforms;
std::mutex g_mountedPairKinematicMutex;
std::unordered_map<RE::FormID, MountedPairKinematicState>
  g_mountedPairKinematicByRider;
// SKSE load callbacks may run while Skyrim is rebuilding controllers. They
// only publish this fence; the game-thread tick performs the actual cleanup.
std::atomic_bool g_mountStateResetRequested = false;

// Profile mutations and maintenance run exclusively on the game thread. The
// small status cache is the only cross-thread state: JavaScript reads it for
// diagnostics while the game thread publishes controller flags.
std::unordered_map<RE::FormID, CharacterControllerCollisionOverride>
  g_characterControllerCollisionOverrides;
std::mutex g_characterControllerCollisionStateMutex;
std::unordered_map<RE::FormID, std::uint32_t>
  g_characterControllerCollisionState;

constexpr std::uint32_t kProfileStateRegistered = 1u << 0;
constexpr std::uint32_t kProfileStateControllerPresent = 1u << 1;
constexpr std::uint32_t kProfileStateNoCharacterCollisions = 1u << 2;
constexpr std::uint32_t kProfileStateNotPushablePermanent = 1u << 3;
constexpr std::uint32_t kProfileStatePossiblePathObstacle = 1u << 4;
constexpr std::uint32_t kProfileStateNotPushable = 1u << 5;

bool IsNewerUint32(std::uint32_t candidate, std::uint32_t previous)
{
  const auto delta = candidate - previous;
  return delta != 0 && delta < 0x80000000u;
}

void ApplyCharacterControllerCollision(RE::FormID formId, bool enabled)
{
  const auto actor = RE::TESForm::LookupByID<RE::Actor>(formId);
  const auto controller = actor ? actor->GetCharController() : nullptr;
  if (!controller) {
    return;
  }

  if (enabled) {
    controller->flags.reset(RE::CHARACTER_FLAGS::kNoCharacterCollisions);
  } else {
    controller->flags.set(RE::CHARACTER_FLAGS::kNoCharacterCollisions);
  }
}

void QueueCharacterControllerCollision(RE::FormID formId, bool enabled)
{
  g_nativeCallRequirements.gameThrQ->AddTask([formId, enabled](Viet::Void) {
    ApplyCharacterControllerCollision(formId, enabled);
  });
}

void QueueObjectReferenceCollision(RE::FormID formId, bool enabled)
{
  g_nativeCallRequirements.gameThrQ->AddTask([formId, enabled](Viet::Void) {
    const auto refr = RE::TESForm::LookupByID<RE::TESObjectREFR>(formId);
    if (refr) {
      refr->SetCollision(enabled);
    }
    ApplyCharacterControllerCollision(formId, enabled);
  });
}

void PublishCharacterControllerCollisionState(
  RE::FormID formId, const CharacterControllerCollisionOverride& state,
  RE::bhkCharacterController* controller)
{
  auto value = kProfileStateRegistered |
    (static_cast<std::uint32_t>(state.profile) << 8) |
    ((state.bindGeneration & 0xffffu) << 16);
  if (controller) {
    value |= kProfileStateControllerPresent;
    if (controller->flags.any(RE::CHARACTER_FLAGS::kNoCharacterCollisions)) {
      value |= kProfileStateNoCharacterCollisions;
    }
    if (controller->flags.any(RE::CHARACTER_FLAGS::kNotPushablePermanent)) {
      value |= kProfileStateNotPushablePermanent;
    }
    if (controller->flags.any(RE::CHARACTER_FLAGS::kPossiblePathObstacle)) {
      value |= kProfileStatePossiblePathObstacle;
    }
    if (controller->flags.any(RE::CHARACTER_FLAGS::kNotPushable)) {
      value |= kProfileStateNotPushable;
    }
  }

  std::lock_guard lock(g_characterControllerCollisionStateMutex);
  g_characterControllerCollisionState[formId] = value;
}

void EraseCharacterControllerCollisionState(RE::FormID formId)
{
  std::lock_guard lock(g_characterControllerCollisionStateMutex);
  g_characterControllerCollisionState.erase(formId);
}

void RestoreOwnedCharacterControllerFlags(
  CharacterControllerCollisionOverride& state)
{
  const auto controller = state.boundController.get();
  if (controller && state.hasControllerSnapshot) {
    if (state.ownedNoCharacterCollisions) {
      controller->flags.reset(RE::CHARACTER_FLAGS::kNoCharacterCollisions);
    }
    if (state.ownedNotPushable) {
      controller->flags.reset(RE::CHARACTER_FLAGS::kNotPushable);
    }
    if (state.ownedNotPushablePermanent) {
      controller->flags.reset(RE::CHARACTER_FLAGS::kNotPushablePermanent);
    }
    if (state.pathObstacleOverrideApplied &&
        state.ownedPossiblePathObstacleReset) {
      controller->flags.set(RE::CHARACTER_FLAGS::kPossiblePathObstacle);
    }
  }

  state.boundController.reset();
  state.hasControllerSnapshot = false;
  state.ownedNoCharacterCollisions = false;
  state.ownedNotPushable = false;
  state.ownedNotPushablePermanent = false;
  state.ownedPossiblePathObstacleReset = false;
  state.pathObstacleOverrideApplied = false;
}

void BindCharacterController(RE::FormID formId,
                             CharacterControllerCollisionOverride& state,
                             RE::bhkCharacterController* controller)
{
  RestoreOwnedCharacterControllerFlags(state);
  state.boundController.reset(controller);
  state.hasControllerSnapshot = true;
  state.ownedNoCharacterCollisions =
    !controller->flags.any(RE::CHARACTER_FLAGS::kNoCharacterCollisions);
  state.ownedNotPushable =
    !controller->flags.any(RE::CHARACTER_FLAGS::kNotPushable);
  state.ownedNotPushablePermanent =
    !controller->flags.any(RE::CHARACTER_FLAGS::kNotPushablePermanent);
  state.missingControllerLogged = false;
  ++state.bindGeneration;

  logger::info("Character controller collision profile bound: form={:08X}, "
               "profile={}, generation={}, controller={}",
               formId, static_cast<std::uint32_t>(state.profile),
               state.bindGeneration, static_cast<const void*>(controller));
}

bool ApplyCharacterControllerCollisionOverride(
  RE::FormID formId, CharacterControllerCollisionOverride& state)
{
  const auto actor = RE::TESForm::LookupByID<RE::Actor>(formId);
  if (!actor) {
    logger::info(
      "Dropping character controller collision profile with no actor: "
      "form={:08X}, profile={}",
      formId, static_cast<std::uint32_t>(state.profile));
    return false;
  }
  const auto controller = actor ? actor->GetCharController() : nullptr;
  const auto actorHandle = actor->GetHandle();
  if (!actorHandle || !state.actorHandle || state.actorHandle != actorHandle) {
    logger::warn(
      "Dropping stale character controller collision profile after form "
      "reuse: form={:08X}, oldHandle={}, newHandle={}",
      formId, state.actorHandle.native_handle(), actorHandle.native_handle());
    return false;
  }

  if (!controller) {
    // A detached middle-high process can stay unloaded for minutes. Release
    // the old NiPointer after restoring our owned bits; the FormID/profile
    // remains registered and will bind a fresh controller when 3D returns.
    RestoreOwnedCharacterControllerFlags(state);
    if (!state.missingControllerLogged) {
      logger::info(
        "Character controller collision profile waiting for controller: "
        "form={:08X}, profile={}",
        formId, static_cast<std::uint32_t>(state.profile));
      state.missingControllerLogged = true;
    }
    PublishCharacterControllerCollisionState(formId, state, nullptr);
    return true;
  }

  if (!state.hasControllerSnapshot ||
      state.boundController.get() != controller) {
    BindCharacterController(formId, state, controller);
  }

  controller->flags.set(RE::CHARACTER_FLAGS::kNoCharacterCollisions);
  controller->flags.set(RE::CHARACTER_FLAGS::kNotPushable);
  controller->flags.set(RE::CHARACTER_FLAGS::kNotPushablePermanent);

  if (state.profile == CharacterControllerCollisionProfile::kRemoteProxy) {
    if (!state.pathObstacleOverrideApplied) {
      state.ownedPossiblePathObstacleReset =
        controller->flags.any(RE::CHARACTER_FLAGS::kPossiblePathObstacle);
    }
    controller->flags.reset(RE::CHARACTER_FLAGS::kPossiblePathObstacle);
    state.pathObstacleOverrideApplied = true;
  } else if (state.pathObstacleOverrideApplied) {
    if (state.ownedPossiblePathObstacleReset) {
      controller->flags.set(RE::CHARACTER_FLAGS::kPossiblePathObstacle);
    }
    state.ownedPossiblePathObstacleReset = false;
    state.pathObstacleOverrideApplied = false;
  }

  PublishCharacterControllerCollisionState(formId, state, controller);
  return true;
}

void SetCharacterControllerCollisionProfile(
  RE::FormID formId, CharacterControllerCollisionProfile profile,
  std::uint32_t lease)
{
  if (profile == CharacterControllerCollisionProfile::kNone) {
    const auto it = g_characterControllerCollisionOverrides.find(formId);
    if (it != g_characterControllerCollisionOverrides.end()) {
      if (lease != 0 && it->second.lease != 0 && lease != it->second.lease) {
        logger::info(
          "Ignoring stale character controller collision profile clear: "
          "form={:08X}, lease={}, activeLease={}",
          formId, lease, it->second.lease);
        return;
      }
      RestoreOwnedCharacterControllerFlags(it->second);
      g_characterControllerCollisionOverrides.erase(it);
    }
    EraseCharacterControllerCollisionState(formId);
    return;
  }

  const auto actor = RE::TESForm::LookupByID<RE::Actor>(formId);
  const auto actorHandle = actor ? actor->GetHandle() : RE::ActorHandle{};
  if (!actor || !actorHandle) {
    logger::warn(
      "Ignoring character controller collision profile for missing actor: "
      "form={:08X}, profile={}",
      formId, static_cast<std::uint32_t>(profile));
    return;
  }

  auto existing = g_characterControllerCollisionOverrides.find(formId);
  if (existing != g_characterControllerCollisionOverrides.end() && actor &&
      existing->second.actorHandle &&
      actorHandle != existing->second.actorHandle) {
    RestoreOwnedCharacterControllerFlags(existing->second);
    EraseCharacterControllerCollisionState(formId);
    g_characterControllerCollisionOverrides.erase(existing);
  }

  const auto it =
    g_characterControllerCollisionOverrides.try_emplace(formId).first;
  auto& state = it->second;
  state.actorHandle = actorHandle;
  state.profile = profile;
  state.lease = lease;
  if (!ApplyCharacterControllerCollisionOverride(formId, state)) {
    RestoreOwnedCharacterControllerFlags(state);
    EraseCharacterControllerCollisionState(formId);
    g_characterControllerCollisionOverrides.erase(it);
  }
}

void MaintainCharacterControllerCollisionOverride(RE::FormID formId)
{
  const auto it = g_characterControllerCollisionOverrides.find(formId);
  if (it != g_characterControllerCollisionOverrides.end()) {
    if (!ApplyCharacterControllerCollisionOverride(formId, it->second)) {
      RestoreOwnedCharacterControllerFlags(it->second);
      EraseCharacterControllerCollisionState(formId);
      g_characterControllerCollisionOverrides.erase(it);
    }
  }
}

void ClearCharacterControllerCollisionProfiles()
{
  for (auto& entry : g_characterControllerCollisionOverrides) {
    RestoreOwnedCharacterControllerFlags(entry.second);
  }
  g_characterControllerCollisionOverrides.clear();

  std::lock_guard lock(g_characterControllerCollisionStateMutex);
  g_characterControllerCollisionState.clear();
}

void MaintainProfileAfterKinematicWrite(RE::FormID formId,
                                        bool hadNoCharacterCollisions)
{
  if (g_characterControllerCollisionOverrides.contains(formId)) {
    MaintainCharacterControllerCollisionOverride(formId);
    return;
  }

  if (hadNoCharacterCollisions) {
    const auto actor = RE::TESForm::LookupByID<RE::Actor>(formId);
    const auto controller = actor ? actor->GetCharController() : nullptr;
    if (controller) {
      controller->flags.set(RE::CHARACTER_FLAGS::kNoCharacterCollisions);
    }
  }
}

bool ApplyActorKinematicTransform(RE::Actor& actor,
                                  const ObjectReferenceTransform& transform)
{
  const auto controllerBefore = actor.GetCharController();
  if (!controllerBefore) {
    return false;
  }
  const bool hadCollisionProfile =
    g_characterControllerCollisionOverrides.contains(actor.GetFormID());
  const bool hadNoCharacterCollisions = controllerBefore &&
    controllerBefore->flags.any(RE::CHARACTER_FLAGS::kNoCharacterCollisions);

  // This actor-specific virtual deliberately avoids
  // TESObjectREFR::SetPosition, whose implementation is MoveTo_Impl. Updating
  // the existing actor controller keeps Havok and the visual transform on the
  // same pose.
  actor.data.angle = transform.rotationRadians;
  actor.SetPosition(transform.position, true);
  actor.SetRotationX(transform.rotationRadians.x);
  actor.SetRotationZ(transform.rotationRadians.z);
  const auto controllerAfter = actor.GetCharController();
  if (!controllerAfter || controllerAfter != controllerBefore) {
    return false;
  }
  MaintainProfileAfterKinematicWrite(actor.GetFormID(),
                                     hadNoCharacterCollisions);
  const auto controllerFinal = actor.GetCharController();
  if (!controllerFinal || controllerFinal != controllerBefore) {
    return false;
  }
  if (hadCollisionProfile) {
    const auto profile =
      g_characterControllerCollisionOverrides.find(actor.GetFormID());
    if (profile == g_characterControllerCollisionOverrides.end() ||
        !controllerFinal->flags.any(
          RE::CHARACTER_FLAGS::kNoCharacterCollisions) ||
        !controllerFinal->flags.any(RE::CHARACTER_FLAGS::kNotPushable) ||
        !controllerFinal->flags.any(
          RE::CHARACTER_FLAGS::kNotPushablePermanent) ||
        (profile->second.profile ==
           CharacterControllerCollisionProfile::kRemoteProxy &&
         controllerFinal->flags.any(
           RE::CHARACTER_FLAGS::kPossiblePathObstacle))) {
      return false;
    }
  } else if (hadNoCharacterCollisions &&
             !controllerFinal->flags.any(
               RE::CHARACTER_FLAGS::kNoCharacterCollisions)) {
    return false;
  }
  return true;
}

// Caller holds g_mountedPairKinematicMutex through validation and both actor
// writes. Consequently release/new-lease calls cannot return and then be
// followed by a stale transform from this task.
bool BindAndValidateMountedPairHandlesLocked(
  const MountedPairKinematicTransform& transform, RE::Actor& horse,
  RE::Actor& rider)
{
  const auto horseHandle = horse.GetHandle().native_handle();
  const auto riderHandle = rider.GetHandle().native_handle();
  if (!horseHandle || !riderHandle) {
    return false;
  }

  const auto it = g_mountedPairKinematicByRider.find(transform.riderFormId);
  if (it == g_mountedPairKinematicByRider.end() ||
      it->second.horseFormId != transform.horseFormId ||
      it->second.lease != transform.lease ||
      it->second.lastSerial != transform.serial) {
    return false;
  }
  auto& state = it->second;
  if (!state.horseHandle && !state.riderHandle) {
    state.horseHandle = horseHandle;
    state.riderHandle = riderHandle;
    return true;
  }
  if (state.horseHandle == horseHandle && state.riderHandle == riderHandle) {
    return true;
  }

  // A dynamic FormID was reused while an old JS view still had a queued job.
  // Drop the native lease instead of moving the new actors with stale state.
  state.pending.reset();
  state.revoked = true;
  return false;
}

bool QueueMountedPairKinematicTransform(
  const MountedPairKinematicTransform& transform)
{
  bool mustSchedule = false;
  {
    std::lock_guard lock(g_mountedPairKinematicMutex);
    auto& state = g_mountedPairKinematicByRider[transform.riderFormId];
    if (state.lease && state.lease != transform.lease &&
        !IsNewerUint32(transform.lease, state.lease)) {
      return false;
    }
    if (state.lease == transform.lease && state.revoked) {
      return false;
    }
    if (state.lease == transform.lease && state.horseFormId &&
        state.horseFormId != transform.horseFormId) {
      return false;
    }
    if (state.lease == transform.lease &&
        !IsNewerUint32(transform.serial, state.lastSerial)) {
      return false;
    }
    if (state.lease != transform.lease) {
      state = MountedPairKinematicState{};
      state.lease = transform.lease;
    }
    state.horseFormId = transform.horseFormId;
    state.lastSerial = transform.serial;
    state.pending = transform;
    mustSchedule = !state.scheduled;
    state.scheduled = true;
  }
  if (!mustSchedule) {
    return true;
  }

  const auto riderFormId = transform.riderFormId;
  g_nativeCallRequirements.gameThrQ->AddTask([riderFormId](Viet::Void) {
    if (g_mountStateResetRequested.load(std::memory_order_acquire)) {
      return;
    }

    std::optional<MountedPairKinematicTransform> latest;
    {
      std::lock_guard lock(g_mountedPairKinematicMutex);
      const auto it = g_mountedPairKinematicByRider.find(riderFormId);
      if (it == g_mountedPairKinematicByRider.end()) {
        return;
      }
      latest = it->second.pending;
      it->second.pending.reset();
      it->second.scheduled = false;
    }
    if (!latest) {
      return;
    }

    // Resolve all Skyrim objects on the game thread and retain no raw pointer
    // across tasks. Both actors must be ready before either one is moved.
    const auto horse = RE::TESForm::LookupByID<RE::Actor>(latest->horseFormId);
    const auto rider = RE::TESForm::LookupByID<RE::Actor>(latest->riderFormId);
    if (!horse || !rider || !horse->Get3D() || !horse->GetCharController() ||
        (latest->writeRider &&
         (!rider->Get3D() || !rider->GetCharController()))) {
      return;
    }

    std::lock_guard pairLock(g_mountedPairKinematicMutex);
    if (!BindAndValidateMountedPairHandlesLocked(*latest, *horse, *rider)) {
      return;
    }
    const bool horseApplied =
      ApplyActorKinematicTransform(*horse, latest->horse);
    bool riderApplied = true;
    if (latest->writeRider) {
      auto riderTransform = latest->horse;
      riderTransform.position.z += latest->riderSeatHeight;
      riderApplied = ApplyActorKinematicTransform(*rider, riderTransform);
    }
    if (!horseApplied || !riderApplied) {
      // Form IDs may still resolve while Skyrim is rebuilding a character
      // controller. Never let this lease keep writing into that transition.
      const auto state =
        g_mountedPairKinematicByRider.find(latest->riderFormId);
      if (state != g_mountedPairKinematicByRider.end() &&
          state->second.horseFormId == latest->horseFormId &&
          state->second.lease == latest->lease) {
        state->second.pending.reset();
        state->second.revoked = true;
      }
    }
  });
  return true;
}

void ReleaseMountedPairKinematicLease(RE::FormID horseFormId,
                                      RE::FormID riderFormId,
                                      std::uint32_t lease)
{
  std::lock_guard lock(g_mountedPairKinematicMutex);
  const auto it = g_mountedPairKinematicByRider.find(riderFormId);
  if (it != g_mountedPairKinematicByRider.end() &&
      it->second.horseFormId == horseFormId && it->second.lease == lease) {
    // A revoked lease remains as a tombstone so the same JS FormView cannot
    // immediately reacquire it after a controller/identity violation. A newer
    // lease (new view/session) can supersede it through modular ordering.
    if (it->second.revoked) {
      it->second.pending.reset();
      it->second.scheduled = false;
    } else {
      g_mountedPairKinematicByRider.erase(it);
    }
  }
}

void ClearMountedPairKinematicTransforms()
{
  std::lock_guard lock(g_mountedPairKinematicMutex);
  g_mountedPairKinematicByRider.clear();
}

void ClearPendingObjectReferenceTransforms()
{
  std::lock_guard lock(g_transformMutex);
  g_pendingTransforms.clear();
  g_scheduledTransforms.clear();
}

void ClearMountState()
{
  ClearCharacterControllerCollisionProfiles();
  ClearMountedPairKinematicTransforms();
  ClearPendingObjectReferenceTransforms();
}

void QueueObjectReferenceTransform(RE::FormID formId,
                                   const ObjectReferenceTransform& transform)
{
  bool mustSchedule = false;
  {
    std::lock_guard lock(g_transformMutex);
    g_pendingTransforms[formId] = transform;
    mustSchedule = g_scheduledTransforms.insert(formId).second;
  }
  if (!mustSchedule) {
    return;
  }

  g_nativeCallRequirements.gameThrQ->AddTask([formId](Viet::Void) {
    if (g_mountStateResetRequested.load(std::memory_order_acquire)) {
      return;
    }

    ObjectReferenceTransform latest;
    {
      std::lock_guard lock(g_transformMutex);
      const auto it = g_pendingTransforms.find(formId);
      if (it == g_pendingTransforms.end()) {
        g_scheduledTransforms.erase(formId);
        return;
      }
      latest = it->second;
      g_pendingTransforms.erase(it);
      g_scheduledTransforms.erase(formId);
    }

    const auto refr = RE::TESForm::LookupByID<RE::TESObjectREFR>(formId);
    if (!refr) {
      return;
    }

    const auto actor = RE::TESForm::LookupByID<RE::Actor>(formId);
    const auto controllerBefore = actor ? actor->GetCharController() : nullptr;
    const bool hasCollisionProfile =
      g_characterControllerCollisionOverrides.contains(formId);
    const bool hadNoCharacterCollisions = !hasCollisionProfile &&
      controllerBefore &&
      controllerBefore->flags.any(RE::CHARACTER_FLAGS::kNoCharacterCollisions);

    // TESObjectREFR stores radians. Setting the rotation before SetPosition
    // makes CommonLib's MoveTo_Impl apply both parts as one game-thread
    // update.
    refr->data.angle = latest.rotationRadians;
    refr->SetPosition(latest.position);

    // MoveTo_Impl is allowed to rebuild the live character controller.
    // Preserve the bilateral mounted-pair filter across that rebuild in the
    // same task.
    if (hadNoCharacterCollisions && actor) {
      const auto controllerAfter = actor->GetCharController();
      if (controllerAfter) {
        controllerAfter->flags.set(
          RE::CHARACTER_FLAGS::kNoCharacterCollisions);
      }
    }

    // A position write can replace the live controller. Rebind every managed
    // profile before the next physics step, including its no-push/path flags.
    MaintainCharacterControllerCollisionOverride(formId);
  });
}

float ExtractFiniteFloat(const Napi::Value& value, const char* name)
{
  const auto result = NapiHelper::ExtractFloat(value, name);
  if (!std::isfinite(result)) {
    throw std::runtime_error(std::string("Expected '") + name +
                             "' to be finite");
  }
  return result;
}
}

Napi::Value ObjectReferenceApi::SetCollision(const Napi::CallbackInfo& info)
{
  const auto formId = NapiHelper::ExtractUInt32(info[0], "refrFormId");
  const auto enabled = NapiHelper::ExtractBoolean(info[1], "collision");

  // Keep the persistent reference flag used when a 3D is created. Actors
  // already loaded also have a live bhkCharacterController, whose collision
  // state is independent from that flag. Both writes must run on the game
  // thread; JavaScript executes on SkyrimPlatform's worker.
  QueueObjectReferenceCollision(formId, enabled);
  return info.Env().Undefined();
}

Napi::Value ObjectReferenceApi::SetCharacterControllerCollision(
  const Napi::CallbackInfo& info)
{
  const auto formId = NapiHelper::ExtractUInt32(info[0], "actorFormId");
  const auto enabled = NapiHelper::ExtractBoolean(info[1], "collision");
  QueueCharacterControllerCollision(formId, enabled);
  return info.Env().Undefined();
}

Napi::Value ObjectReferenceApi::SetCharacterControllerCollisionProfile(
  const Napi::CallbackInfo& info)
{
  const auto formId = NapiHelper::ExtractUInt32(info[0], "actorFormId");
  const auto rawProfile = NapiHelper::ExtractUInt32(info[1], "profile");
  if (rawProfile > static_cast<std::uint32_t>(
                     CharacterControllerCollisionProfile::kRemoteProxy)) {
    throw std::runtime_error("Expected 'profile' to be 0, 1, or 2");
  }

  const auto profile =
    static_cast<CharacterControllerCollisionProfile>(rawProfile);
  const auto lease =
    info.Length() >= 3 && !info[2].IsUndefined() && !info[2].IsNull()
    ? NapiHelper::ExtractUInt32(info[2], "lease")
    : 0;
  g_nativeCallRequirements.gameThrQ->AddTask(
    [formId, profile, lease](Viet::Void) {
      if (g_mountStateResetRequested.load(std::memory_order_acquire)) {
        return;
      }
      SetCharacterControllerCollisionProfile(formId, profile, lease);
    });
  return info.Env().Undefined();
}

Napi::Value ObjectReferenceApi::GetCharacterControllerCollisionProfileState(
  const Napi::CallbackInfo& info)
{
  const auto formId = NapiHelper::ExtractUInt32(info[0], "actorFormId");
  std::lock_guard lock(g_characterControllerCollisionStateMutex);
  const auto it = g_characterControllerCollisionState.find(formId);
  return Napi::Number::New(
    info.Env(),
    it == g_characterControllerCollisionState.end() ? 0 : it->second);
}

Napi::Value ObjectReferenceApi::SetObjectReferenceTransform(
  const Napi::CallbackInfo& info)
{
  const auto formId = NapiHelper::ExtractUInt32(info[0], "refrFormId");
  constexpr float kDegreesToRadians = 3.14159265358979323846f / 180.0f;
  const ObjectReferenceTransform transform{
    .position = {
      ExtractFiniteFloat(info[1], "positionX"),
      ExtractFiniteFloat(info[2], "positionY"),
      ExtractFiniteFloat(info[3], "positionZ"),
    },
    .rotationRadians = {
      ExtractFiniteFloat(info[4], "angleX") * kDegreesToRadians,
      ExtractFiniteFloat(info[5], "angleY") * kDegreesToRadians,
      ExtractFiniteFloat(info[6], "angleZ") * kDegreesToRadians,
    },
  };
  QueueObjectReferenceTransform(formId, transform);
  return info.Env().Undefined();
}

Napi::Value ObjectReferenceApi::SetMountedPairKinematicTransform(
  const Napi::CallbackInfo& info)
{
  const auto horseFormId = NapiHelper::ExtractUInt32(info[0], "horseFormId");
  const auto riderFormId = NapiHelper::ExtractUInt32(info[1], "riderFormId");
  const auto lease = NapiHelper::ExtractUInt32(info[2], "lease");
  const auto serial = NapiHelper::ExtractUInt32(info[3], "serial");
  if (!horseFormId || !riderFormId || horseFormId == riderFormId ||
      riderFormId == 0x14 || !lease || !serial) {
    return Napi::Boolean::New(info.Env(), false);
  }

  constexpr float kDegreesToRadians = 3.14159265358979323846f / 180.0f;
  const MountedPairKinematicTransform transform{
    .horseFormId = horseFormId,
    .riderFormId = riderFormId,
    .lease = lease,
    .serial = serial,
    .horse = {
      .position = {
        ExtractFiniteFloat(info[4], "positionX"),
        ExtractFiniteFloat(info[5], "positionY"),
        ExtractFiniteFloat(info[6], "positionZ"),
      },
      .rotationRadians = {
        ExtractFiniteFloat(info[7], "angleX") * kDegreesToRadians,
        ExtractFiniteFloat(info[8], "angleY") * kDegreesToRadians,
        ExtractFiniteFloat(info[9], "angleZ") * kDegreesToRadians,
      },
    },
    .riderSeatHeight = ExtractFiniteFloat(info[10], "riderSeatHeight"),
    .writeRider = true,
  };
  return Napi::Boolean::New(info.Env(),
                            QueueMountedPairKinematicTransform(transform));
}

Napi::Value ObjectReferenceApi::SetMountedHorseKinematicTransform(
  const Napi::CallbackInfo& info)
{
  const auto horseFormId = NapiHelper::ExtractUInt32(info[0], "horseFormId");
  const auto riderFormId = NapiHelper::ExtractUInt32(info[1], "riderFormId");
  const auto lease = NapiHelper::ExtractUInt32(info[2], "lease");
  const auto serial = NapiHelper::ExtractUInt32(info[3], "serial");
  if (!horseFormId || !riderFormId || horseFormId == riderFormId ||
      riderFormId == 0x14 || !lease || !serial) {
    return Napi::Boolean::New(info.Env(), false);
  }

  constexpr float kDegreesToRadians = 3.14159265358979323846f / 180.0f;
  const MountedPairKinematicTransform transform{
    .horseFormId = horseFormId,
    .riderFormId = riderFormId,
    .lease = lease,
    .serial = serial,
    .horse = {
      .position = {
        ExtractFiniteFloat(info[4], "positionX"),
        ExtractFiniteFloat(info[5], "positionY"),
        ExtractFiniteFloat(info[6], "positionZ"),
      },
      .rotationRadians = {
        ExtractFiniteFloat(info[7], "angleX") * kDegreesToRadians,
        ExtractFiniteFloat(info[8], "angleY") * kDegreesToRadians,
        ExtractFiniteFloat(info[9], "angleZ") * kDegreesToRadians,
      },
    },
    .riderSeatHeight = 0.f,
    .writeRider = false,
  };
  return Napi::Boolean::New(info.Env(),
                            QueueMountedPairKinematicTransform(transform));
}

Napi::Value ObjectReferenceApi::ReleaseMountedPairKinematicTransform(
  const Napi::CallbackInfo& info)
{
  const auto horseFormId = NapiHelper::ExtractUInt32(info[0], "horseFormId");
  const auto riderFormId = NapiHelper::ExtractUInt32(info[1], "riderFormId");
  const auto lease = NapiHelper::ExtractUInt32(info[2], "lease");
  if (horseFormId && riderFormId && lease) {
    ReleaseMountedPairKinematicLease(horseFormId, riderFormId, lease);
  }
  return info.Env().Undefined();
}

void ObjectReferenceApi::MaintainCharacterControllerCollisionProfiles()
{
  if (g_mountStateResetRequested.exchange(false, std::memory_order_acq_rel)) {
    ClearMountState();
    return;
  }

  auto it = g_characterControllerCollisionOverrides.begin();
  while (it != g_characterControllerCollisionOverrides.end()) {
    if (ApplyCharacterControllerCollisionOverride(it->first, it->second)) {
      ++it;
      continue;
    }
    RestoreOwnedCharacterControllerFlags(it->second);
    EraseCharacterControllerCollisionState(it->first);
    it = g_characterControllerCollisionOverrides.erase(it);
  }
}

void ObjectReferenceApi::RequestMountStateReset()
{
  g_mountStateResetRequested.store(true, std::memory_order_release);
}
