cmake_minimum_required(VERSION 3.21)

# ia-forge : icônes des objets capturées en jeu (docs/79 et docs/81 du projet ia-forge).
# Compilation reprise de Grid Inventory (skypia0147-dev/grid-inventory, GPL-3.0) : CommonLibSSE-NG d'alandtse,
# figé sur un commit, et dépendances vcpkg.
option(CommonLibSSE_POSH_GENERATION "Generate .posh.d.ts type definition file" OFF)
option(CommonLibSSE_TESTING "Build tests" OFF)
set(CommonLibSSE_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

project(IaForgeIcons VERSION 0.3.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(fmt CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)
find_path(RAPIDCSV_INCLUDE_DIRS "rapidcsv.h")
find_path(STB_INCLUDE_DIRS "stb_image_write.h")

include(FetchContent)
FetchContent_Declare(
    CommonLibSSE
    GIT_REPOSITORY https://github.com/alandtse/CommonLibVR.git
    GIT_TAG 0e167dd4c3981d586a53953e2c1a608e2c4ccedf   # ng @ 2026-08-21 (même commit que Grid Inventory)
)
FetchContent_MakeAvailable(CommonLibSSE)

add_library(${PROJECT_NAME} SHARED
    src/PCH.h
    src/main.cpp
    src/Capture.h
    src/Capture.cpp
)

target_compile_features(${PROJECT_NAME} PRIVATE cxx_std_23)
target_compile_options(${PROJECT_NAME} PRIVATE /utf-8 /Zi)
target_link_options(${PROJECT_NAME} PRIVATE /DEBUG:FULL /OPT:REF /OPT:ICF)
target_precompile_headers(${PROJECT_NAME} PRIVATE src/PCH.h)
target_include_directories(${PROJECT_NAME} PRIVATE src ${STB_INCLUDE_DIRS})
target_link_libraries(${PROJECT_NAME} PRIVATE CommonLibSSE::CommonLibSSE fmt::fmt spdlog::spdlog d3d11)
