#pragma once

#include "RE/Skyrim.h"
#include "SKSE/SKSE.h"

// Windows.h APRÈS CommonLibSSE-NG (conflits de macros REX), comme Grid Inventory.
#include <Windows.h>
#ifdef GetObject
#    undef GetObject
#endif

#include <spdlog/sinks/basic_file_sink.h>

#include <chrono>
#include <deque>
#include <thread>
#include <filesystem>
#include <string>
#include <unordered_set>
#include <vector>

using namespace std::literals;

namespace logger = SKSE::log;
