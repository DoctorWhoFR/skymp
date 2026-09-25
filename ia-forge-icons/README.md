# ia-forge-icons

Plugin SKSE (Skyrim SE/AE 1.5.97 – 1.6.1170) qui **photographie les objets du jeu** pour le sac de l'interface
ia-forge : `Data/SKSE/Plugins/IaForgeIcons/<FORMID>.png`, 256 × 256, fond transparent.

- **Méthode** : scène 3D d'inventaire du jeu (`Inventory3DManager`), rendu de l'objet sur fond noir puis sur fond
  blanc dans un rectangle de l'image, copie, remise de l'image d'origine. Reprise de **Modex**
  (patchulidev/ModExplorerMenu, `Item3DPreview`) et de **Grid Inventory** (skypia0147-dev/grid-inventory,
  `ItemPreview`/`IconCache`), tous deux sous **GPL-3.0 avec exception de modding** ; ce plugin l'est aussi.
- **Pilotage** : événement de mod `IaForgeIcons_Capture` (ids hexadécimaux séparés par des virgules) ; réponse
  `IaForgeIcons_Done` (ids prêts). Depuis Skyrim Platform : `Game.getPlayer().sendModEvent(...)` et `on("modEvent")`.
- Le jeu est mis en **pause** le temps d'une série de captures (le moteur ne dessine la scène d'inventaire qu'en
  pause) ; une fois capturée, une icône reste sur le disque.
- Journal : `Documents/My Games/Skyrim Special Edition/SKSE/IaForgeIcons.log`.
- Compilation : GitHub Actions (`.github/workflows/ia-forge-icons.yml`), Windows, CMake + vcpkg + CommonLibSSE-NG.
