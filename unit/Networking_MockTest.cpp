#include "NetworkingMock.h"
#include <catch2/catch_all.hpp>
#include <cstring>
#include <string>
#include <vector>

using namespace Networking;

TEST_CASE("MockServer - IsConnected is always true for clients",
          "[Networking]")
{
  REQUIRE(MockServer().CreateClient().first->IsConnected());
}

TEST_CASE("MockServer - send message to server", "[Networking]")
{
  MockServer mockServer;
  auto cl = mockServer.CreateClient().first;
  cl->Send((uint8_t*)"abcd", 4, true);

  static bool received = false;

  mockServer.Tick(
    [](void* state, UserId userId, PacketType packetType, PacketData data,
       size_t length) {
      if (length == 4 && !memcmp(data, "abcd", 4)) {
        received = true;
      }
    },
    nullptr);
  REQUIRE(received);
}

TEST_CASE("MockServer - send message to client", "[Networking]")
{
  MockServer mockServer;
  auto cl0 = mockServer.CreateClient().first;
  auto cl1 = mockServer.CreateClient().first;
  auto cl2 = mockServer.CreateClient().first;
  cl1.reset();

  auto cl = mockServer.CreateClient().first;

  mockServer.Send(1, (uint8_t*)"abcd", 4, true);

  static bool received = false;

  cl->Tick(
    [](void* state, PacketType packetType, PacketData data, size_t length,
       const char* error) {
      if (length == 4 && !memcmp(data, "abcd", 4)) {
        received = true;
      }
    },
    nullptr);
  REQUIRE(received);
}

TEST_CASE("MockServer - send message to unexisting client", "[Networking]")
{
  REQUIRE_THROWS_WITH(MockServer().Send(0, nullptr, 9000, true),
                      Catch::Matchers::ContainsSubstring(
                        "No client with id 0 found on MockServer"));
}

TEST_CASE("MockServer - connect/disconnect", "[Networking]")
{
  MockServer mockServer;

  auto cl = mockServer.CreateClient().first;

  {
    static bool serverTicked = false;
    mockServer.Tick(
      [](void* state, UserId userId, PacketType packetType, PacketData data,
         size_t length) {
        serverTicked = true;
        REQUIRE(packetType == PacketType::ServerSideUserConnect);
        REQUIRE(userId == 0);
      },
      nullptr);
    REQUIRE(serverTicked);
  }

  static bool clientTicked = false;

  cl->Tick(
    [](void* state, PacketType packetType, PacketData data, size_t length,
       const char* error) {
      clientTicked = true;
      REQUIRE(packetType == PacketType::ClientSideConnectionAccepted);
    },
    nullptr);

  REQUIRE(clientTicked);

  cl.reset();
  {
    static bool serverTicked = false;
    mockServer.Tick(
      [](void* state, UserId userId, PacketType packetType, PacketData data,
         size_t length) {
        serverTicked = true;
        REQUIRE(packetType == PacketType::ServerSideUserDisconnect);
        REQUIRE(userId == 0);
      },
      nullptr);
    REQUIRE(serverTicked);
  }
}

TEST_CASE("MockServer - a packet whose handling throws is not handled again",
          "[Networking]")
{
  MockServer mockServer;
  auto cl = mockServer.CreateClient().first;
  cl->Send((uint8_t*)"bad!", 4, true);
  cl->Send((uint8_t*)"good", 4, true);

  REQUIRE_THROWS(mockServer.Tick(
    [](void*, UserId, PacketType packetType, PacketData data, size_t length) {
      if (packetType == PacketType::Message) {
        throw std::runtime_error("bad packet");
      }
    },
    nullptr));

  static std::vector<std::string> handled;
  mockServer.Tick(
    [](void*, UserId, PacketType packetType, PacketData data, size_t length) {
      handled.push_back(packetType == PacketType::Message
                          ? std::string((const char*)data, length)
                          : "other");
    },
    nullptr);
  REQUIRE(handled == std::vector<std::string>({ "good" }));
}
