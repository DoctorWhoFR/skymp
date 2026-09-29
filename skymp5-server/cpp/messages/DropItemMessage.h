#pragma once
#include "MessageBase.h"
#include "MsgType.h"
#include <optional>
#include <string>
#include <type_traits>

struct DropItemMessage : public MessageBase<DropItemMessage>
{
  static constexpr auto kMsgType =
    std::integral_constant<char, static_cast<char>(MsgType::DropItem)>{};

  template <class Archive>
  void Serialize(Archive& archive)
  {
    archive.Serialize("t", kMsgType)
      .Serialize("baseId", baseId)
      .Serialize("count", count)
      .Serialize("health", health)
      .Serialize("enchantmentId", enchantmentId)
      .Serialize("poisonId", poisonId)
      .Serialize("name", name);
  }

  uint64_t baseId = 0;
  uint32_t count = 0;
  // ia-forge: the copy the player chose in the gamemode's bag (docs/91)
  std::optional<float> health;
  std::optional<uint32_t> enchantmentId;
  std::optional<uint32_t> poisonId;
  std::optional<std::string> name;
};
