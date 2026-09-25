#include "Capture.h"

#include <d3d11_1.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <stb_image_write.h>

#include <algorithm>
#include <cmath>

namespace IaForge
{
    namespace
    {
        // Côté maximal du rectangle capturé (pixels d'écran) : taille des textures de travail.
        constexpr UINT kTex = 1024;
        // Images d'attente avant d'abandonner un objet dont le modèle ne se charge pas (~3 s à 60 i/s).
        constexpr int kTimeoutFrames = 180;
        // Images où le modèle doit être prêt avant la capture (le moteur repose la rotation à l'arrivée).
        constexpr int kSettleFrames = 3;

        template <class T>
        void Release(void*& a_p)
        {
            if (a_p) {
                static_cast<T*>(a_p)->Release();
                a_p = nullptr;
            }
        }

        float Half(std::uint16_t h)
        {
            const std::uint32_t s = (h >> 15) & 1, e = (h >> 10) & 0x1F, m = h & 0x3FF;
            if (e == 0) return (s ? -1.f : 1.f) * std::ldexp(static_cast<float>(m), -24);
            if (e == 31) return m ? 0.f : (s ? -1.f : 1.f) * 65504.f;
            return (s ? -1.f : 1.f) * std::ldexp(static_cast<float>(m | 0x400), static_cast<int>(e) - 25);
        }

        // Lit un pixel (r, g, b dans 0..1) selon le format de l'image du jeu. false = format inconnu.
        bool ReadRGB(std::uint32_t a_fmt, const std::uint8_t* a_px, float* a_out)
        {
            switch (a_fmt) {
            case DXGI_FORMAT_R8G8B8A8_UNORM:
            case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
                a_out[0] = a_px[0] / 255.f; a_out[1] = a_px[1] / 255.f; a_out[2] = a_px[2] / 255.f;
                return true;
            case DXGI_FORMAT_B8G8R8A8_UNORM:
            case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
                a_out[0] = a_px[2] / 255.f; a_out[1] = a_px[1] / 255.f; a_out[2] = a_px[0] / 255.f;
                return true;
            case DXGI_FORMAT_R10G10B10A2_UNORM: {
                std::uint32_t v;
                std::memcpy(&v, a_px, 4);
                a_out[0] = (v & 0x3FF) / 1023.f; a_out[1] = ((v >> 10) & 0x3FF) / 1023.f; a_out[2] = ((v >> 20) & 0x3FF) / 1023.f;
                return true;
            }
            case DXGI_FORMAT_R16G16B16A16_FLOAT: {
                std::uint16_t h[3];
                std::memcpy(h, a_px, 6);
                for (int i = 0; i < 3; ++i) a_out[i] = std::clamp(Half(h[i]), 0.f, 1.f);
                return true;
            }
            default:
                return false;
            }
        }

        int BytesPerPixel(std::uint32_t a_fmt)
        {
            return a_fmt == DXGI_FORMAT_R16G16B16A16_FLOAT ? 8 : 4;
        }
    }

    std::filesystem::path IconPath(RE::FormID a_id)
    {
        return std::filesystem::path("Data/SKSE/Plugins/IaForgeIcons") / fmt::format("{:08X}.png", a_id);
    }

    Capturer* Capturer::GetSingleton()
    {
        static Capturer singleton;
        return std::addressof(singleton);
    }

    void Capturer::Enqueue(const std::vector<RE::FormID>& a_ids)
    {
        for (auto id : a_ids) {
            if (!id) continue;
            std::error_code ec;
            if (std::filesystem::exists(IconPath(id), ec)) {
                m_done.push_back(id);
                continue;
            }
            if (m_queued.insert(id).second) m_queue.push_back(id);
        }
        logger::info("demande de {} icône(s) : {} en file, {} déjà prête(s)", a_ids.size(), m_queue.size(), m_done.size());
        if (m_queue.empty() && !m_current) {
            Notify();
            return;
        }
        if (!m_menuWanted) {
            m_menuWanted = true;
            RequestMenu(true);
        }
    }

    void Capturer::RequestMenu(bool a_show)
    {
        SKSE::GetTaskInterface()->AddUITask([a_show]() {
            if (auto* q = RE::UIMessageQueue::GetSingleton()) {
                q->AddMessage(RE::BSFixedString(kMenuName.data()), a_show ? RE::UI_MESSAGE_TYPE::kShow : RE::UI_MESSAGE_TYPE::kHide, nullptr);
            }
        });
    }

    void Capturer::Begin()
    {
        if (m_running) return;
        auto* mgr = RE::Inventory3DManager::GetSingleton();
        if (!mgr) {
            logger::error("Inventory3DManager absent");
            return;
        }
        mgr->Begin3D(RE::INTERFACE_LIGHT_SCHEME::kInventory);
        m_running = true;
        m_hideRequested = false;
        logger::info("scène 3D ouverte, {} objet(s) à capturer", m_queue.size());
    }

    void Capturer::End()
    {
        if (m_running) {
            if (auto* mgr = RE::Inventory3DManager::GetSingleton()) {
                mgr->UnloadInventoryItem();
                mgr->End3D();
            }
        }
        if (m_current) {
            // Menu fermé en pleine capture : l'objet reste en file pour la prochaine fois.
            m_queued.erase(m_currentId);
            m_current = nullptr;
        }
        m_running = false;
        m_menuWanted = false;
        ReleaseTextures();
        Notify();
        logger::info("scène 3D fermée ({} objet(s) encore en file)", m_queue.size());
        // Des demandes sont arrivées pendant la fermeture : on rouvre.
        if (!m_queue.empty()) {
            m_menuWanted = true;
            RequestMenu(true);
        }
    }

    RE::NiAVObject* Capturer::FindModel() const
    {
        auto* mgr = RE::Inventory3DManager::GetSingleton();
        if (!mgr || !m_current) return nullptr;
        for (auto& lm : mgr->GetRuntimeData().loadedModels) {
            if (lm.itemBase != static_cast<RE::TESForm*>(m_current) && lm.modelObj != m_current) continue;
            if (lm.spModel && lm.spModel->worldBound.radius > 0.0f) return lm.spModel.get();
        }
        return nullptr;
    }

    void Capturer::Advance()
    {
        if (!m_running) return;
        auto* mgr = RE::Inventory3DManager::GetSingleton();
        if (!mgr) return;
        if (m_current) {
            if (++m_frames > kTimeoutFrames) {
                logger::warn("{:08X} : modèle jamais chargé, abandon", m_currentId);
                Finish(false);
            }
            return;
        }
        while (!m_queue.empty()) {
            const auto id = m_queue.front();
            m_queue.pop_front();
            auto* form = RE::TESForm::LookupByID(id);
            auto* obj = form ? form->As<RE::TESBoundObject>() : nullptr;
            if (!obj) {
                logger::warn("{:08X} : pas un objet", id);
                m_queued.erase(id);
                continue;
            }
            mgr->UnloadInventoryItem();
            mgr->LoadInventoryItem(obj, nullptr);
            m_current = obj;
            m_currentId = id;
            m_frames = 0;
            m_readyFrames = 0;
            return;
        }
        // File vide : on referme le menu, mais jamais pendant un chargement (End3D ferait planter le jeu).
        if (!m_hideRequested && !mgr->GetRuntimeData().loadTask.get()) {
            m_hideRequested = true;
            Notify();
            RequestMenu(false);
        }
    }

    void Capturer::Render()
    {
        if (!m_running || !m_current) return;
        auto* model = FindModel();
        if (!model) {
            m_readyFrames = 0;
            return;
        }
        if (++m_readyFrames < kSettleFrames) return;
        Finish(CaptureModel(model));
    }

    void Capturer::Finish(bool a_ok)
    {
        if (auto* mgr = RE::Inventory3DManager::GetSingleton()) mgr->UnloadInventoryItem();
        if (a_ok) m_done.push_back(m_currentId);
        m_queued.erase(m_currentId);
        m_current = nullptr;
        m_currentId = 0;
        // Annonce au fil de l'eau : le sac affiche les images dès qu'elles existent.
        if (m_done.size() >= 8) Notify();
    }

    void Capturer::Notify()
    {
        if (m_done.empty()) return;
        std::string list;
        for (auto id : m_done) {
            if (!list.empty()) list += ',';
            list += fmt::format("{:X}", id);
        }
        const auto n = static_cast<float>(m_done.size());
        m_done.clear();
        SKSE::ModCallbackEvent ev{ RE::BSFixedString(kEventDone.data()), RE::BSFixedString(list.c_str()), n, nullptr };
        if (auto* src = SKSE::GetModCallbackEventSource()) src->SendEvent(&ev);
        logger::info("annoncé : {} icône(s)", static_cast<int>(n));
    }

    bool Capturer::InitTextures(std::uint32_t a_format)
    {
        if (m_scratch && m_format == a_format) return true;
        ReleaseTextures();
        auto* renderer = RE::BSGraphics::Renderer::GetSingleton();
        if (!renderer) return false;
        auto* device = reinterpret_cast<ID3D11Device*>(renderer->GetRuntimeData().forwarder);
        if (!device) return false;

        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = kTex;
        desc.Height = kTex;
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = static_cast<DXGI_FORMAT>(a_format);
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        ID3D11Texture2D* t = nullptr;
        for (void** slot : { &m_scratch, &m_black, &m_white }) {
            if (FAILED(device->CreateTexture2D(&desc, nullptr, &t))) {
                ReleaseTextures();
                return false;
            }
            *slot = t;
        }
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        for (void** slot : { &m_stageBlack, &m_stageWhite }) {
            if (FAILED(device->CreateTexture2D(&desc, nullptr, &t))) {
                ReleaseTextures();
                return false;
            }
            *slot = t;
        }
        m_format = a_format;
        logger::info("textures de capture prêtes (format {})", a_format);
        return true;
    }

    void Capturer::ReleaseTextures()
    {
        Release<ID3D11Texture2D>(m_scratch);
        Release<ID3D11Texture2D>(m_black);
        Release<ID3D11Texture2D>(m_white);
        Release<ID3D11Texture2D>(m_stageBlack);
        Release<ID3D11Texture2D>(m_stageWhite);
        m_format = 0;
    }

    bool Capturer::CaptureModel(RE::NiAVObject* a_model)
    {
        auto* inv = RE::Inventory3DManager::GetSingleton();
        auto* scn = RE::UI3DSceneManager::GetSingleton();
        auto* renderer = RE::BSGraphics::Renderer::GetSingleton();
        if (!inv || !scn || !renderer) return false;
        const auto& data = renderer->GetRuntimeData();
        auto* context = reinterpret_cast<ID3D11DeviceContext*>(data.context);
        auto* rtv = reinterpret_cast<ID3D11RenderTargetView*>(data.renderWindows[0].renderView);
        if (!context || !rtv) return false;

        // --- Où le modèle tombe à l'écran (calcul de Modex, Item3DPreview::Render) ---
        const auto screen = RE::BSGraphics::Renderer::GetScreenSize();
        if (screen.width == 0 || screen.height == 0) return false;
        const auto& vf = scn->viewFrustum;
        const auto& t = a_model->local.translate;
        const float wminx = -vf.fLeft * t.y;
        const float wminz = -vf.fBottom * t.y;
        const float ww = -vf.fRight * t.y - wminx;
        const float wh = -vf.fTop * t.y - wminz;
        const float rx = ww / static_cast<float>(screen.width);
        const float ry = wh / static_cast<float>(screen.height);
        if (rx == 0.0f || ry == 0.0f) return false;
        const auto& c = a_model->worldBound.center;
        const float sx = -(c.x + wminx) / rx;
        const float sy = -(c.z + wminz) / ry;
        const float radiusPx = a_model->worldBound.radius / std::fabs(rx);
        const float side = std::clamp(radiusPx * 2.4f, 64.0f, static_cast<float>((std::min)(kTex, screen.height)));
        int left = static_cast<int>(sx - side * 0.5f);
        int top = static_cast<int>(sy - side * 0.5f);
        int width = static_cast<int>(side);
        int height = static_cast<int>(side);
        if (left < 0) { width += left; left = 0; }
        if (top < 0) { height += top; top = 0; }
        width = (std::min)(width, static_cast<int>(screen.width) - left);
        height = (std::min)(height, static_cast<int>(screen.height) - top);
        width = (std::min)(width, static_cast<int>(kTex));
        height = (std::min)(height, static_cast<int>(kTex));
        if (width < 8 || height < 8) {
            logger::warn("{:08X} : rectangle hors écran", m_currentId);
            return false;
        }

        ID3D11Resource* srcRes = nullptr;
        rtv->GetResource(&srcRes);
        if (!srcRes) return false;
        ID3D11Texture2D* src = nullptr;
        srcRes->QueryInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&src));
        srcRes->Release();
        if (!src) return false;
        D3D11_TEXTURE2D_DESC sd{};
        src->GetDesc(&sd);
        if (!InitTextures(sd.Format)) {
            src->Release();
            logger::error("textures de capture impossibles (format {})", static_cast<int>(sd.Format));
            return false;
        }
        ID3D11DeviceContext1* ctx1 = nullptr;
        if (FAILED(context->QueryInterface(__uuidof(ID3D11DeviceContext1), reinterpret_cast<void**>(&ctx1))) || !ctx1) {
            src->Release();
            return false;
        }

        D3D11_BOX box{ static_cast<UINT>(left), static_cast<UINT>(top), 0, static_cast<UINT>(left + width), static_cast<UINT>(top + height), 1 };
        const D3D11_RECT rect{ left, top, left + width, top + height };
        auto* scratch = static_cast<ID3D11Texture2D*>(m_scratch);
        auto* black = static_cast<ID3D11Texture2D*>(m_black);
        auto* white = static_cast<ID3D11Texture2D*>(m_white);

        // Sauvegarde, rendu sur noir, rendu sur blanc, remise de l'image d'origine.
        context->CopySubresourceRegion(scratch, 0, 0, 0, 0, src, 0, &box);
        const FLOAT kBlack[4] = { 0, 0, 0, 0 };
        const FLOAT kWhite[4] = { 1, 1, 1, 0 };
        ctx1->ClearView(rtv, kBlack, &rect, 1);
        inv->Render();
        context->CopySubresourceRegion(black, 0, 0, 0, 0, src, 0, &box);
        ctx1->ClearView(rtv, kWhite, &rect, 1);
        inv->Render();
        context->CopySubresourceRegion(white, 0, 0, 0, 0, src, 0, &box);
        const D3D11_BOX back{ 0, 0, 0, static_cast<UINT>(width), static_cast<UINT>(height), 1 };
        context->CopySubresourceRegion(src, 0, static_cast<UINT>(left), static_cast<UINT>(top), 0, scratch, 0, &back);
        ctx1->Release();
        src->Release();

        // Lecture côté processeur (le jeu est en pause : l'attente du GPU ne se voit pas).
        auto* sb = static_cast<ID3D11Texture2D*>(m_stageBlack);
        auto* sw = static_cast<ID3D11Texture2D*>(m_stageWhite);
        context->CopyResource(sb, black);
        context->CopyResource(sw, white);
        D3D11_MAPPED_SUBRESOURCE mb{}, mw{};
        if (FAILED(context->Map(sb, 0, D3D11_MAP_READ, 0, &mb))) return false;
        if (FAILED(context->Map(sw, 0, D3D11_MAP_READ, 0, &mw))) {
            context->Unmap(sb, 0);
            return false;
        }

        // Transparence exacte par les deux fonds (Grid Inventory, GI77) : sur noir, pixel = a·couleur ; sur blanc,
        // pixel = a·couleur + (1 − a). On garde la couleur prémultipliée (le rendu sur noir) et a.
        const int bpp = BytesPerPixel(m_format);
        std::vector<float> pm(static_cast<size_t>(width) * height * 4, 0.0f);
        int minX = width, minY = height, maxX = -1, maxY = -1;
        bool okFmt = true;
        for (int y = 0; y < height && okFmt; ++y) {
            const auto* rb = static_cast<const std::uint8_t*>(mb.pData) + static_cast<size_t>(y) * mb.RowPitch;
            const auto* rw = static_cast<const std::uint8_t*>(mw.pData) + static_cast<size_t>(y) * mw.RowPitch;
            for (int x = 0; x < width; ++x) {
                float cb[3], cw[3];
                if (!ReadRGB(m_format, rb + x * bpp, cb) || !ReadRGB(m_format, rw + x * bpp, cw)) {
                    okFmt = false;
                    break;
                }
                float a = 1.0f - ((cw[0] - cb[0]) + (cw[1] - cb[1]) + (cw[2] - cb[2])) / 3.0f;
                a = std::clamp(a, 0.0f, 1.0f);
                auto* p = &pm[(static_cast<size_t>(y) * width + x) * 4];
                if (a < 0.004f) continue;
                p[0] = (std::min)(cb[0], a);
                p[1] = (std::min)(cb[1], a);
                p[2] = (std::min)(cb[2], a);
                p[3] = a;
                if (a > 0.03f) {
                    minX = (std::min)(minX, x); maxX = (std::max)(maxX, x);
                    minY = (std::min)(minY, y); maxY = (std::max)(maxY, y);
                }
            }
        }
        context->Unmap(sb, 0);
        context->Unmap(sw, 0);
        if (!okFmt) {
            logger::error("format d'image non géré : {}", m_format);
            return false;
        }
        if (maxX < minX || maxY < minY) {
            logger::warn("{:08X} : rien de dessiné", m_currentId);
            return false;
        }

        // Carré centré sur l'objet, 6 % de marge, réduit en kIconSize × kIconSize par moyenne de zone.
        const float cx = (minX + maxX + 1) * 0.5f;
        const float cy = (minY + maxY + 1) * 0.5f;
        const float sq = (std::max)(maxX - minX + 1, maxY - minY + 1) * 1.12f;
        const float x0 = cx - sq * 0.5f;
        const float y0 = cy - sq * 0.5f;
        const float step = sq / kIconSize;
        std::vector<std::uint8_t> out(static_cast<size_t>(kIconSize) * kIconSize * 4, 0);
        for (int oy = 0; oy < kIconSize; ++oy) {
            for (int ox = 0; ox < kIconSize; ++ox) {
                const float fx0 = x0 + ox * step, fy0 = y0 + oy * step;
                const int ix0 = static_cast<int>(std::floor(fx0)), iy0 = static_cast<int>(std::floor(fy0));
                const int ix1 = static_cast<int>(std::ceil(fx0 + step)), iy1 = static_cast<int>(std::ceil(fy0 + step));
                float acc[4] = { 0, 0, 0, 0 };
                int n = 0;
                for (int y = iy0; y < iy1; ++y) {
                    for (int x = ix0; x < ix1; ++x) {
                        ++n;
                        if (x < 0 || y < 0 || x >= width || y >= height) continue;
                        const auto* p = &pm[(static_cast<size_t>(y) * width + x) * 4];
                        for (int k = 0; k < 4; ++k) acc[k] += p[k];
                    }
                }
                if (!n) continue;
                const float a = acc[3] / n;
                auto* o = &out[(static_cast<size_t>(oy) * kIconSize + ox) * 4];
                if (a <= 0.0f) continue;
                for (int k = 0; k < 3; ++k) o[k] = static_cast<std::uint8_t>(std::clamp(acc[k] / n / a, 0.0f, 1.0f) * 255.0f + 0.5f);
                o[3] = static_cast<std::uint8_t>(std::clamp(a, 0.0f, 1.0f) * 255.0f + 0.5f);
            }
        }

        const auto path = IconPath(m_currentId);
        std::error_code ec;
        std::filesystem::create_directories(path.parent_path(), ec);
        if (!stbi_write_png(path.string().c_str(), kIconSize, kIconSize, 4, out.data(), kIconSize * 4)) {
            logger::error("{:08X} : écriture impossible ({})", m_currentId, path.string());
            return false;
        }
        logger::info("{:08X} : icône écrite ({}×{} px capturés)", m_currentId, width, height);
        return true;
    }

    // --- Menu ------------------------------------------------------------------------------------------

    RE::IMenu* IconMenu::Creator()
    {
        using Flags = RE::UI_MENU_FLAGS;
        auto* menu = new IconMenu();
        // La scène 3D d'inventaire ne se dessine que jeu en pause (Grid Inventory, GridMenu.cpp) ; pas d'interface.
        menu->menuFlags.set(Flags::kPausesGame, Flags::kCustomRendering, Flags::kDisablePauseMenu);
        menu->depthPriority = 0;
        return menu;
    }

    void IconMenu::Register()
    {
        if (auto* ui = RE::UI::GetSingleton()) {
            ui->Register(kMenuName, Creator);
            logger::info("menu {} enregistré", kMenuName);
        }
    }

    RE::UI_MESSAGE_RESULTS IconMenu::ProcessMessage(RE::UIMessage& a_message)
    {
        switch (a_message.type.get()) {
        case RE::UI_MESSAGE_TYPE::kShow:
            Capturer::GetSingleton()->Begin();
            break;
        case RE::UI_MESSAGE_TYPE::kHide:
            Capturer::GetSingleton()->End();
            break;
        default:
            break;
        }
        return RE::IMenu::ProcessMessage(a_message);
    }

    void IconMenu::AdvanceMovie(float a_interval, std::uint32_t a_currentTime)
    {
        Capturer::GetSingleton()->Advance();
        RE::IMenu::AdvanceMovie(a_interval, a_currentTime);
    }

    void IconMenu::PostDisplay()
    {
        Capturer::GetSingleton()->Render();
    }

    // --- Événements de mod ---------------------------------------------------------------------------

    ModEventSink* ModEventSink::GetSingleton()
    {
        static ModEventSink singleton;
        return std::addressof(singleton);
    }

    RE::BSEventNotifyControl ModEventSink::ProcessEvent(const SKSE::ModCallbackEvent* a_event, RE::BSTEventSource<SKSE::ModCallbackEvent>*)
    {
        if (!a_event || std::string_view(a_event->eventName.c_str()) != kEventCapture) return RE::BSEventNotifyControl::kContinue;
        std::vector<RE::FormID> ids;
        std::string_view s = a_event->strArg.c_str();
        while (!s.empty()) {
            const auto comma = s.find(',');
            const auto part = s.substr(0, comma);
            if (!part.empty()) {
                try {
                    ids.push_back(static_cast<RE::FormID>(std::stoul(std::string(part), nullptr, 16)));
                } catch (...) {
                    logger::warn("id illisible : {}", part);
                }
            }
            if (comma == std::string_view::npos) break;
            s.remove_prefix(comma + 1);
        }
        if (!ids.empty()) {
            SKSE::GetTaskInterface()->AddTask([ids = std::move(ids)]() { Capturer::GetSingleton()->Enqueue(ids); });
        }
        return RE::BSEventNotifyControl::kContinue;
    }
}
