#pragma once

#include "IDamageFormula.h"

// Implements vanilla Skyrim damage formula.
// Some parts may be missing. If they are, there should be a TODO regarding it.
// If there's no corresponding TODO, consider adding it and/or filing an issue.

class TES5DamageFormula : public IDamageFormula
{
public:
  [[nodiscard]] float CalculateDamage(const MpActor& aggressor,
                                      const MpActor& target,
                                      const HitData& hitData) const override;

  [[nodiscard]] float CalculateDamage(
    const MpActor& aggressor, const MpActor& target,
    const SpellCastData& spellCastData) const override;
};

#include "Inventory.h"
#include <cstdint>
#include <nlohmann/json.hpp>

class MpActor;
class WorldState;

// ia-forge: weapons and armour count what each copy carries (tempering,
// enchantment, poison), with our own numbers. The gamemode shows the same
// numbers in the bag: gamemode/src/shared/data/armament.ts, keep both in step.
// Settings: server-settings.json "iaForgeArmament" (all optional).
struct IaForgeArmamentSettings
{
  float weaponPerTenth = 1.f;
  float armorPerTenth = 1.f;
  float bodyArmorMult = 2.f;
  float enchantChargePerHit = 30.f;

  static IaForgeArmamentSettings& Get();
  static void Load(const nlohmann::json& j);
};

namespace IaForgeArmament {

// Tenths of health above 1 (the server keeps health as a float: 1.6f is
// 1.600000023841858).
int TemperTenths(const Inventory::ExtraData& e);

// The copy of `baseId` the actor wields: the equipment the client reports,
// trusted only if the server inventory holds such a copy.
const Inventory::Entry* FindWieldedCopy(const MpActor& actor,
                                        uint32_t baseId);

float WeaponTemperBonus(const Inventory::Entry* copy);
float ArmorTemperBonus(const Inventory::Entry& worn, uint32_t bodyPartFlags);

// Health damage of the detrimental value-modifier effects of an ENCH or ALCH
// (magnitude, times the duration for lingering ones).
float HealthDamageOf(uint32_t enchOrAlchId, WorldState* espmProvider);

// Extra damage the copy's enchantment (if charged) and poison deal on hit.
float OnHitMagicDamage(const Inventory::Entry* copy,
                       WorldState* espmProvider);

// After a hit landed: the enchantment loses charge, the poison a dose.
void ConsumeOnHit(MpActor& aggressor, uint32_t baseId);

}
