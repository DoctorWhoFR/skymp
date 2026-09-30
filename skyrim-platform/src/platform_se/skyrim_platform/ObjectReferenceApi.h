#pragma once

#include "NapiHelper.h"

namespace ObjectReferenceApi {

Napi::Value SetCollision(const Napi::CallbackInfo& info);
Napi::Value SetCharacterControllerCollision(const Napi::CallbackInfo& info);
Napi::Value SetCharacterControllerCollisionProfile(
  const Napi::CallbackInfo& info);
Napi::Value GetCharacterControllerCollisionProfileState(
  const Napi::CallbackInfo& info);
Napi::Value SetObjectReferenceTransform(const Napi::CallbackInfo& info);
Napi::Value SetMountedPairKinematicTransform(const Napi::CallbackInfo& info);
Napi::Value SetMountedHorseKinematicTransform(const Napi::CallbackInfo& info);
Napi::Value ReleaseMountedPairKinematicTransform(
  const Napi::CallbackInfo& info);
void MaintainCharacterControllerCollisionProfiles();
void RequestMountStateReset();

inline void Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set(
    "setCollision",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetCollision)));
  exports.Set(
    "setCharacterControllerCollision",
    Napi::Function::New(
      env, NapiHelper::WrapCppExceptions(SetCharacterControllerCollision)));
  exports.Set("setCharacterControllerCollisionProfile",
              Napi::Function::New(env,
                                  NapiHelper::WrapCppExceptions(
                                    SetCharacterControllerCollisionProfile)));
  exports.Set(
    "getCharacterControllerCollisionProfileState",
    Napi::Function::New(env,
                        NapiHelper::WrapCppExceptions(
                          GetCharacterControllerCollisionProfileState)));
  exports.Set(
    "setObjectReferenceTransform",
    Napi::Function::New(
      env, NapiHelper::WrapCppExceptions(SetObjectReferenceTransform)));
  exports.Set(
    "setMountedPairKinematicTransform",
    Napi::Function::New(
      env, NapiHelper::WrapCppExceptions(SetMountedPairKinematicTransform)));
  exports.Set(
    "setMountedHorseKinematicTransform",
    Napi::Function::New(
      env, NapiHelper::WrapCppExceptions(SetMountedHorseKinematicTransform)));
  exports.Set("releaseMountedPairKinematicTransform",
              Napi::Function::New(env,
                                  NapiHelper::WrapCppExceptions(
                                    ReleaseMountedPairKinematicTransform)));
}
}
