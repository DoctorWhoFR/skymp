// ia-forge-icons : plugin SKSE qui photographie les objets du jeu pour le sac de l'interface ia-forge.
// Voir Capture.h (méthode, pilotage par événements de mod) et README.md.
#include "Capture.h"

namespace
{
    void InitializeLog()
    {
        auto path = SKSE::log::log_directory();
        if (!path) return;
        *path /= "IaForgeIcons.log";
        auto sink = std::make_shared<spdlog::sinks::basic_file_sink_mt>(path->string(), true);
        auto log = std::make_shared<spdlog::logger>("global log", std::move(sink));
        log->set_level(spdlog::level::info);
        log->flush_on(spdlog::level::info);
        spdlog::set_default_logger(std::move(log));
        spdlog::set_pattern("[%H:%M:%S.%e] %v");
    }

    void MessageHandler(SKSE::MessagingInterface::Message* a_msg)
    {
        if (a_msg->type != SKSE::MessagingInterface::kDataLoaded) return;
        IaForge::IconMenu::Register();
        if (auto* src = SKSE::GetModCallbackEventSource()) {
            src->AddEventSink(IaForge::ModEventSink::GetSingleton());
            logger::info("écoute de l'événement {}", IaForge::kEventCapture);
        }
    }
}

SKSEPluginInfo(
    .Version = { 0, 5, 0, 0 },
    .Name = "IaForgeIcons",
    .Author = "ia-forge",
    .RuntimeCompatibility = SKSE::VersionIndependence::AddressLibrary)

SKSEPluginLoad(const SKSE::LoadInterface* a_skse)
{
    InitializeLog();
    logger::info("IaForgeIcons 0.5.0, compilé le " __DATE__ " " __TIME__);
    SKSE::Init(a_skse);
    SKSE::GetMessagingInterface()->RegisterListener(MessageHandler);
    return true;
}
