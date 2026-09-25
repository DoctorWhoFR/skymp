#pragma once

// ia-forge : capture des icônes d'objets par le moteur du jeu.
//
// Méthode reprise de Modex (patchulidev/ModExplorerMenu, Item3DPreview, GPL-3.0 avec exception de modding) et de
// Grid Inventory (skypia0147-dev/grid-inventory, ItemPreview / IconCache, GPL-3.0) : l'objet est chargé dans la scène
// 3D d'inventaire du jeu (Inventory3DManager), rendu deux fois dans un rectangle de l'image (fond noir puis fond
// blanc, ce qui donne la transparence exacte), copié, puis l'image d'origine est remise. Le moteur ne dessine cette
// scène que pendant un menu qui met le jeu en pause : un petit menu à nous, sans interface, s'ouvre le temps d'une
// série de captures puis se referme.
//
// Pilotage (depuis Skyrim Platform, sans script Papyrus) :
//   entrée : événement de mod « IaForgeIcons_Capture », strArg = ids hexadécimaux séparés par des virgules ;
//   sortie : événement de mod « IaForgeIcons_Done », strArg = ids capturés (ou déjà présents), numArg = leur nombre.
// Fichiers : Data/SKSE/Plugins/IaForgeIcons/<FORMID sur 8 chiffres>.png, 256 × 256, fond transparent.

namespace IaForge
{
    inline constexpr auto kMenuName = "IaForgeIconMenu"sv;
    inline constexpr auto kEventCapture = "IaForgeIcons_Capture"sv;
    inline constexpr auto kEventDone = "IaForgeIcons_Done"sv;
    inline constexpr int kIconSize = 256;

    std::filesystem::path IconPath(RE::FormID a_id);

    class Capturer
    {
    public:
        static Capturer* GetSingleton();

        // Fil principal seulement.
        void Enqueue(const std::vector<RE::FormID>& a_ids);

        // Appelés par le menu (fil principal, pendant le menu).
        void Begin();
        void Advance();
        void Render();
        void End();

    private:
        Capturer() = default;

        RE::NiAVObject* FindModel() const;
        bool LoadInFlight() const;
        bool SceneHalfBuilt() const;
        bool ResetScene();
        void TeardownWhenIdle(std::uint32_t a_session, int a_tries);
        void Close(const char* a_why);
        void LogScene(const char* a_why) const;
        void GiveUp(const char* a_why);
        bool CaptureModel(RE::NiAVObject* a_model);
        void Finish(bool a_ok);
        void Notify();
        void RequestMenu(bool a_show);
        bool InitTextures(std::uint32_t a_format);
        void ReleaseTextures();

        std::deque<RE::FormID> m_queue;
        std::unordered_set<RE::FormID> m_queued;
        std::vector<RE::FormID> m_done;  // à annoncer
        RE::TESBoundObject* m_current = nullptr;
        RE::FormID m_currentId = 0;
        int m_frames = 0;
        int m_readyFrames = 0;
        int m_sessionCount = 0;    // objets pris depuis l'ouverture du menu (plafond : kPerSession)
        bool m_needReset = false;  // un chargement a été abandonné : vider la scène dès qu'aucun n'est en cours
        std::string m_currentModel;  // chemin du .nif de l'objet en cours (modèles partagés)
        std::uint32_t m_captured = 0, m_failed = 0;
        bool m_running = false;
        bool m_menuWanted = false;
        bool m_hideRequested = false;
        // Scène 3D ouverte (Begin3D sans End3D) : la fermeture est différée tant qu'un chargement est en cours (Grid
        // Inventory, GI73 / TeardownWhenIdle) ; une réouverture reprend la scène encore debout.
        bool m_scene3D = false;
        std::uint32_t m_session = 0;
        int m_stalls = 0;  // passages de suite sans aucun objet pris
        std::chrono::steady_clock::time_point m_openedAt{};
        std::unordered_set<RE::FormID> m_retried;  // objets déjà remis une fois en file après un abandon

        // Textures de travail (même format que l'image du jeu).
        std::uint32_t m_format = 0;
        void* m_scratch = nullptr;  // ID3D11Texture2D* : l'image d'origine, remise après capture
        void* m_black = nullptr;    // rendu sur fond noir
        void* m_white = nullptr;    // rendu sur fond blanc
        void* m_stageBlack = nullptr;
        void* m_stageWhite = nullptr;
    };

    // Menu sans interface qui met le jeu en pause le temps des captures.
    class IconMenu : public RE::IMenu
    {
    public:
        static RE::IMenu* Creator();
        static void Register();

        RE::UI_MESSAGE_RESULTS ProcessMessage(RE::UIMessage& a_message) override;
        void AdvanceMovie(float a_interval, std::uint32_t a_currentTime) override;
        void PostDisplay() override;
    };

    class ModEventSink : public RE::BSTEventSink<SKSE::ModCallbackEvent>
    {
    public:
        static ModEventSink* GetSingleton();
        RE::BSEventNotifyControl ProcessEvent(const SKSE::ModCallbackEvent* a_event, RE::BSTEventSource<SKSE::ModCallbackEvent>* a_source) override;
    };
}
