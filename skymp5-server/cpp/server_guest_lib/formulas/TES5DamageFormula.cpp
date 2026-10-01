#include "TES5DamageFormula.h"

#include "HitData.h"
#include "MpActor.h"
#include "SpellCastData.h"
#include "WorldState.h"
#include "libespm/espm.h"
#include <algorithm>
#include <cctype>

namespace internal {

bool IsUnarmedAttack(const uint32_t sourceFormId)
{
  return sourceFormId == 0x1f4;
}

class TES5DamageFormulaImpl
{
  using Effects = std::vector<espm::Effects::Effect>;

public:
  TES5DamageFormulaImpl(const MpActor& aggressor_, const MpActor& target_,
                        const HitData& hitData_);

  [[nodiscard]] float CalculateDamage() const;

private:
  const MpActor& aggressor;
  const MpActor& target;
  const HitData& hitData;
  WorldState* espmProvider;

private:
  [[nodiscard]] float GetBaseWeaponDamage() const;
  [[nodiscard]] float CalcWeaponRating() const;
  [[nodiscard]] float CalcArmorRatingComponent(
    const Inventory::Entry& opponentEquipmentEntry) const;
  [[nodiscard]] float CalcOpponentArmorRating() const;
  [[nodiscard]] float CalcMagicEffects(const Effects& effects) const;
  [[nodiscard]] float DetermineDamageFromSource(uint32_t source) const;
  [[nodiscard]] float CalcUnarmedDamage() const;
  [[nodiscard]] float CalcArmorDamagePenalty() const;
};

TES5DamageFormulaImpl::TES5DamageFormulaImpl(const MpActor& aggressor_,
                                             const MpActor& target_,
                                             const HitData& hitData_)
  : aggressor(aggressor_)
  , target(target_)
  , hitData(hitData_)
  , espmProvider(aggressor.GetParent())
{
}

float TES5DamageFormulaImpl::GetBaseWeaponDamage() const
{
  const auto weapData =
    espm::GetData<espm::WEAP>(hitData.source, espmProvider);
  if (!weapData.weapData) {
    throw std::runtime_error(
      fmt::format("no weapData for {:#x}", hitData.source));
  }
  return weapData.weapData->damage;
}

float TES5DamageFormulaImpl::CalcWeaponRating() const
{
  // TODO(#457): take other components into account
  // ia-forge: plus the tempering of the copy wielded (docs/91).
  return GetBaseWeaponDamage() +
    IaForgeArmament::WeaponTemperBonus(
           IaForgeArmament::FindWieldedCopy(aggressor, hitData.source));
}

float TES5DamageFormulaImpl::CalcMagicEffects(const Effects& effects) const
{
  float armorRating = 0.f;
  for (const auto& effect : effects) {
    const auto actorValueType =
      espm::GetData<espm::MGEF>(effect.effectId, espmProvider).data.primaryAV;
    if (actorValueType == espm::ActorValue::DamageResist) {
      armorRating += effect.magnitude;
    }
  }
  return armorRating;
}

float TES5DamageFormulaImpl::CalcArmorRatingComponent(
  const Inventory::Entry& opponentEquipmentEntry) const
{
  if (opponentEquipmentEntry.GetWorn() != Inventory::Worn::None &&
      espm::GetRecordType(opponentEquipmentEntry.baseId, espmProvider) ==
        espm::ARMO::kType) {
    const auto armorData =
      espm::GetData<espm::ARMO>(opponentEquipmentEntry.baseId, espmProvider);
    // TODO(#458): take other components into account
    auto ac = static_cast<float>(armorData.baseRatingX100) / 100;
    if (armorData.enchantmentFormId) {
      // TODO(#632) refactor this effect with actor effect system
      const auto enchantmentData =
        espm::GetData<espm::ENCH>(armorData.enchantmentFormId, espmProvider);
      ac += CalcMagicEffects(enchantmentData.effects);
    }

    // ia-forge: the worn copy's own tempering and enchantment (docs/91),
    // counted only if the server inventory holds that copy.
    const Inventory::Entry* copy = IaForgeArmament::FindWieldedCopy(
      target, opponentEquipmentEntry.baseId);
    if (copy) {
      uint32_t slots = armorData.bod2.present ? armorData.bod2.bodyPartFlags
                                              : armorData.bodt.bodyPartFlags;
      ac += IaForgeArmament::ArmorTemperBonus(*copy, slots);
      if (copy->enchantmentId && !armorData.enchantmentFormId) {
        auto res =
          espmProvider->GetEspm().GetBrowser().LookupById(*copy->enchantmentId);
        if (res.rec && res.rec->GetType() == espm::ENCH::kType) {
          ac += CalcMagicEffects(
            espm::GetData<espm::ENCH>(*copy->enchantmentId, espmProvider)
              .effects);
        }
      }
    }

    return ac;
  }
  return 0;
}

float TES5DamageFormulaImpl::CalcOpponentArmorRating() const
{
  float combinedArmorRating = 0;
  auto eq = target.GetEquipment();
  for (auto& entry : eq.inv.entries) {
    combinedArmorRating += CalcArmorRatingComponent(entry);
  }
  return combinedArmorRating;
}

float TES5DamageFormulaImpl::CalcUnarmedDamage() const
{
  const uint32_t raceId = aggressor.GetRaceId();
  return espm::GetData<espm::RACE>(raceId, espmProvider).unarmedDamage;
}

float TES5DamageFormulaImpl::DetermineDamageFromSource(uint32_t source) const
{
  return IsUnarmedAttack(source) ? CalcUnarmedDamage() : CalcWeaponRating();
}

float TES5DamageFormulaImpl::CalcArmorDamagePenalty() const
{
  // TODO(#457): weapon rating is probably not only component of incomingDamage
  // Replace this with another issue reference upon investigation
  const float maxArmorRating =
    espm::GetData<espm::GMST>(espm::GMST::kFMaxArmorRating, espmProvider)
      .value;
  const float armorScalingFactor =
    espm::GetData<espm::GMST>(espm::GMST::kFArmorScalingFactor, espmProvider)
      .value;
  return 0.01f *
    (100.f -
     std::min<float>(CalcOpponentArmorRating() * armorScalingFactor,
                     maxArmorRating));
}

float TES5DamageFormulaImpl::CalculateDamage() const
{
  const float incomingDamage = DetermineDamageFromSource(hitData.source);

  // TODO(#461): add difficulty multiplier
  // TODO(#463): add sneak modifier
  float damage = incomingDamage * CalcArmorDamagePenalty();

  if (hitData.isPowerAttack) {
    damage *= 2.f;
  }

  if (hitData.isHitBlocked) {
    // TODO(#460): implement correct block formula
    damage *= 0.1f;
  }

  if (hitData.isSneakAttack) {
    // TODO(GM-613): get from GameSettings
    damage *= 1.3f;
  }

  // ia-forge: enchantment and poison of the wielded copy, magic damage that
  // armour does not reduce (docs/91).
  if (!IsUnarmedAttack(hitData.source) && !hitData.isHitBlocked) {
    damage += IaForgeArmament::OnHitMagicDamage(
      IaForgeArmament::FindWieldedCopy(aggressor, hitData.source),
      espmProvider);
  }

  return damage;
}

class TES5SpellDamageFormulaImpl
{
  using Effects = std::vector<espm::Effects::Effect>;

public:
  TES5SpellDamageFormulaImpl(const MpActor& aggressor_, const MpActor& target_,
                             const SpellCastData& spellCastData_);

  [[nodiscard]] float CalculateDamage() const;

private:
  const MpActor& aggressor;
  const MpActor& target;
  const SpellCastData& spellCastData;
  WorldState* espmProvider;

private:
  [[nodiscard]] float GetBaseSpellDamage() const;
};

TES5SpellDamageFormulaImpl::TES5SpellDamageFormulaImpl(
  const MpActor& aggressor_, const MpActor& target_,
  const SpellCastData& spellCastData_)
  : aggressor(aggressor_)
  , target(target_)
  , spellCastData(spellCastData_)
  , espmProvider(aggressor.GetParent())
{
}

float TES5SpellDamageFormulaImpl::GetBaseSpellDamage() const
{
  const auto spellData =
    espm::GetData<espm::SPEL>(spellCastData.spell, espmProvider);

  float damage = 0.f;

  for (const auto& effect : spellData.effects) {

    if (!effect.effectItem || effect.effectFormId == 0) {
      continue;
    }

    auto magicEffect =
      espm::GetData<espm::MGEF>(effect.effectFormId, espmProvider);

    const bool needAddDamage =
      magicEffect.data.IsFlagSet(espm::MGEF::Flags::Hostile) ||
      magicEffect.data.IsFlagSet(espm::MGEF::Flags::Detrimental);

    if (needAddDamage &&
        magicEffect.data.primaryAV == espm::ActorValue::Health) {

      damage += effect.effectItem->magnitude;
    }
  }
  return damage;
}

float TES5SpellDamageFormulaImpl::CalculateDamage() const
{
  return GetBaseSpellDamage();
}

}

float TES5DamageFormula::CalculateDamage(const MpActor& aggressor,
                                         const MpActor& target,
                                         const HitData& hitData) const
{
  return internal::TES5DamageFormulaImpl(aggressor, target, hitData)
    .CalculateDamage();
}

float TES5DamageFormula::CalculateDamage(
  const MpActor& aggressor, const MpActor& target,
  const SpellCastData& spellCastData) const
{
  return internal::TES5SpellDamageFormulaImpl(aggressor, target, spellCastData)
    .CalculateDamage();
}

// ---- ia-forge armament (docs/91) ----

#include "MpActor.h"
#include "WorldState.h"
#include "libespm/espm.h"
#include <cmath>
#include <spdlog/spdlog.h>

IaForgeArmamentSettings& IaForgeArmamentSettings::Get()
{
  static IaForgeArmamentSettings g_settings;
  return g_settings;
}

void IaForgeArmamentSettings::Load(const nlohmann::json& j)
{
  auto& s = Get();
  if (!j.is_object()) {
    return;
  }
  auto read = [&](const char* key, float& out) {
    if (j.contains(key) && j[key].is_number()) {
      out = j[key].get<float>();
    }
  };
  read("weaponPerTenth", s.weaponPerTenth);
  read("armorPerTenth", s.armorPerTenth);
  read("bodyArmorMult", s.bodyArmorMult);
  read("enchantChargePerHit", s.enchantChargePerHit);
}

namespace IaForgeArmament {

namespace {
constexpr uint32_t kBodySlot = 1u << 2; // biped slot 32

// One rule for "the same copy" (docs/91): base, tempering, enchantment and
// soul. Charge, poison and its doses are the copy's state, worn is where it
// is. The name only ranks candidates: the game names every copy with extra
// data after its base, and drops a custom name when it splits a stack.
std::string Lower(std::string s)
{
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return s;
}

// -1 if `inv` cannot be the copy the game reports as `worn`, else how well
// it fits.
int CopyScore(const Inventory::Entry& inv, const Inventory::Entry& worn)
{
  if (inv.baseId != worn.baseId || TemperTenths(inv) != TemperTenths(worn) ||
      inv.enchantmentId.value_or(0) != worn.enchantmentId.value_or(0) ||
      inv.soul.value_or(0) != worn.soul.value_or(0)) {
    return -1;
  }
  int score = 0;
  std::string invName = Lower(inv.name.value_or(""));
  std::string wornName = Lower(worn.name.value_or(""));
  if (invName == wornName) {
    score += 4;
  } else if (invName.empty()) {
    score += 2;
  }
  // The worn copy's poison as the game reports it, none included: a plain
  // sword in hand is not the poisoned one.
  if (inv.poisonId.value_or(0) == worn.poisonId.value_or(0)) {
    score += 2;
  }
  return score;
}

bool IsHealthDamage(uint32_t mgefId, WorldState* espmProvider)
{
  auto res = espmProvider->GetEspm().GetBrowser().LookupById(mgefId);
  if (!res.rec || res.rec->GetType() != espm::MGEF::kType) {
    return false;
  }
  auto data = espm::GetData<espm::MGEF>(mgefId, espmProvider).data;
  // Frost, fire and shock damage are Dual (health + stamina or magicka).
  bool valueMod = data.effectType == espm::MGEF::EffectType::ValueMod ||
    data.effectType == espm::MGEF::EffectType::Dual ||
    data.effectType == espm::MGEF::EffectType::ValueAndParts ||
    data.effectType == espm::MGEF::EffectType::PeakValueMod;
  return valueMod && data.primaryAV == espm::ActorValue::Health &&
    data.IsFlagSet(espm::MGEF::Flags::Detrimental);
}
}

int TemperTenths(const Inventory::ExtraData& e)
{
  float h = e.health.value_or(1.f);
  return std::max(0, static_cast<int>(std::lround((h - 1.f) * 10.f)));
}

const Inventory::Entry* FindWieldedCopy(const MpActor& actor, uint32_t baseId)
{
  // The client reports its whole inventory with worn flags: only what is
  // worn counts, right hand first.
  const auto& inv = actor.GetInventory().entries;
  for (auto hand : { Inventory::Worn::Right, Inventory::Worn::Left }) {
    for (auto& worn : actor.GetEquipment().inv.entries) {
      if (worn.baseId != baseId || worn.GetWorn() != hand) {
        continue;
      }
      const Inventory::Entry* best = nullptr;
      int bestScore = -1;
      for (auto& e : inv) {
        int score = e.count > 0 ? CopyScore(e, worn) : -1;
        if (score > bestScore) {
          best = &e;
          bestScore = score;
        }
      }
      if (best) {
        return best;
      }
    }
  }
  // Nothing matching: the plain copy, as SkyMP always assumed.
  return nullptr;
}

float WeaponTemperBonus(const Inventory::Entry* copy)
{
  if (!copy) {
    return 0.f;
  }
  return TemperTenths(*copy) * IaForgeArmamentSettings::Get().weaponPerTenth;
}

float ArmorTemperBonus(const Inventory::Entry& worn, uint32_t bodyPartFlags)
{
  const auto& s = IaForgeArmamentSettings::Get();
  float mult = (bodyPartFlags & kBodySlot) ? s.bodyArmorMult : 1.f;
  return TemperTenths(worn) * s.armorPerTenth * mult;
}

float HealthDamageOf(uint32_t enchOrAlchId, WorldState* espmProvider)
{
  if (!enchOrAlchId || !espmProvider) {
    return 0.f;
  }
  try {
    auto res = espmProvider->GetEspm().GetBrowser().LookupById(enchOrAlchId);
    if (!res.rec) {
      return 0.f;
    }
    std::vector<espm::Effects::Effect> effects;
    if (res.rec->GetType() == espm::ENCH::kType) {
      effects = espm::GetData<espm::ENCH>(enchOrAlchId, espmProvider).effects;
    } else if (res.rec->GetType() == espm::ALCH::kType) {
      effects = espm::GetData<espm::ALCH>(enchOrAlchId, espmProvider).effects;
    } else {
      return 0.f;
    }
    float total = 0.f;
    for (auto& e : effects) {
      uint32_t mgef = res.ToGlobalId(e.effectId);
      if (IsHealthDamage(mgef, espmProvider)) {
        total += e.magnitude * std::max<uint32_t>(1, e.duration);
      }
    }
    return total;
  } catch (std::exception& e) {
    spdlog::warn("IaForgeArmament::HealthDamageOf {:x}: {}", enchOrAlchId,
                 e.what());
    return 0.f;
  }
}

float OnHitMagicDamage(const Inventory::Entry* copy, WorldState* espmProvider)
{
  if (!copy) {
    return 0.f;
  }
  float damage = 0.f;
  if (copy->enchantmentId) {
    bool charged = !copy->maxCharge || copy->chargePercent.value_or(0) > 0;
    if (charged) {
      damage += HealthDamageOf(*copy->enchantmentId, espmProvider);
    }
  }
  if (copy->poisonId && copy->poisonCount.value_or(1) > 0) {
    damage += HealthDamageOf(*copy->poisonId, espmProvider);
  }
  return damage;
}

void ConsumeOnHit(MpActor& aggressor, uint32_t baseId, bool blocked)
{
  if (blocked) {
    return;
  }
  const Inventory::Entry* copy = FindWieldedCopy(aggressor, baseId);
  if (!copy || (!copy->maxCharge && !copy->poisonId)) {
    return;
  }
  Inventory inv = aggressor.GetInventory();
  for (auto& e : inv.entries) {
    if (&e - inv.entries.data() !=
        copy - aggressor.GetInventory().entries.data()) {
      continue;
    }
    if (e.count != 1) {
      // A stack of identical enchanted copies: leave it, the charge is shared.
      return;
    }
    if (e.maxCharge && e.chargePercent.value_or(0) > 0) {
      e.chargePercent = std::max(
        0.f,
        e.chargePercent.value_or(0) -
          IaForgeArmamentSettings::Get().enchantChargePerHit);
    }
    // The spent poison stays on the copy at 0 doses (no more damage): the
    // game still reports it in hand, and taking it off would make another
    // copy with that poison the best fit, which would then lose its doses.
    if (e.poisonId && e.poisonCount.value_or(1) > 0) {
      e.poisonCount = e.poisonCount.value_or(1) - 1;
    }
    aggressor.SetInventoryQuiet(inv);
    return;
  }
}

}
