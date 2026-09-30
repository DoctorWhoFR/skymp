#pragma once
#include "PropertyBinding.h"

// ia-forge (mounts): the only actor allowed to host a reference, e.g. the
// rider of a horse. 0 hands it back to SkyMP's usual host rule.
class HosterBinding : public PropertyBinding
{
public:
  std::string GetPropertyName() const override { return "hoster"; }
  Napi::Value Get(Napi::Env env, ScampServer& scampServer,
                  uint32_t formId) override;
  void Set(Napi::Env env, ScampServer& scampServer, uint32_t formId,
           Napi::Value newValue) override;
};
