# A faire

> Tout ce qui suit est fait. Chaque ligne pointe vers l'endroit où ça vit,
> et le README détaille le comportement.

## UI :

### Dans l'onglet de l'app éléctron :

+ [x] L'onglet de l'app éléctron ne se termine pas bien, il manque les coins arrondies
    → la fenêtre du panneau avait une hauteur FIXE (620 px) : dès que la carte
      dépassait, le bas était coupé net et les deux coins arrondis avec. Le
      renderer mesure maintenant la hauteur naturelle de la carte et la fenêtre
      s'y ajuste, bornée à l'écran avec de l'air en dessous pour l'ombre ;
      au-delà, c'est la vue qui défile À L'INTÉRIEUR de la carte.
      `renderer/panel/panel.ts` (reportHeight) + `main/windows/panel.ts` (resizePanel).
+ [x] Rajouter un bouton "quit" qui termine tout activité de SunFlower
    → vrai bouton dans le pied du panneau, et un arrêt qui coupe VRAIMENT tout :
      agents en file, run de travail en cours, session Sunflower-Code, voix,
      guetteur d'humeur, fenêtre Work. `shutdownEverything()` dans `main/index.ts`.
+ [x] Rajouter plein de petite animations mignonnes :
    + [x] quand on lance [Deezer](1) ou [Spotify](2), le tournesol a un petit casque pour écouter la musique,
    + [x] quand on lance [Cursor](3) ou [VS Code](4), il a un petit ordi pour coder
    + [x] Quand on lance [Claude](5), [ChatGPT](6), [Gemini](7), etc, le tournesol a une pencarte qui dit "AI on top"
    + [x] Quand on est sur un site ou appli de diverstissement/streaming comme [Youtube](8) ou [Netflix](9), le tournesol a du popcorn
    + [x] Quand on est sur une appli créative comme [Figma](10) ou [Premiere Pro](11), le tournesol et courbé et a un plaid et regarde son PC
    + [x] Quand on est sur une app de messagerie genre [SnapChat](12) ou [Discord](13), le tournesol a un téléphone et envoie des messages
    + [x] Quand on est sur une appli de doomscrolling genre [Tiktok](14) ou [Instagram](15) le tournesol a un téléphone et est tout fatigué et courbé
    + [x] Etc, → sept familles, une centaine d'apps et de domaines rangés dedans.
    → dessins dans `shared/sunflower-pixels.ts` (MOOD_*), animations CSS dans
      `renderer/companion/companion.css`, classement dans `shared/activity.ts`,
      détection (app au premier plan + onglet du navigateur) dans `main/activity.ts`.
      100 % local, rien n'est écrit ni envoyé, l'humeur ne s'affiche qu'au repos,
      et l'interrupteur est dans le panneau.

### Dans le CLI:

+ [x] Créer une UI complète pour le CLI de Sunflower
+ [x] La UI doit ressembler à celle de [Ollama Code](16) (pixelisée avec des petits détails mignons)
    → le VRAI tournesol pixel de l'app rendu en demi-blocs 24 bits, cartes à
      coins arrondis, badge de mode dans le prompt, commandes slash, rendu des
      appels d'outils. `main/tui.ts`, `main/tui-pixel.ts`, `main/tui-ansi.ts`.

## Backend :

> Les agents ne fonctionnent pas réellement et on a aucun moyen de les traquer.

+ [x] Ajouter une copie de Ollama Code dans Sunflower, "Sunflower-Code" pour coder avec Sunflower :
    + [x] Ajouter une fonction qui envoie tout les messages à Sunflower-Code dans le CLI,
        → `routeToCode()` dans `main/index.ts` : un seul point de passage pour
          tout ce qui est tapé hors du mode `ask`.
    + [x] Copier toute l'infrastructure de [Ollama Code](16)
        → 4 modes (code/chat/vision/plan), 7 outils (read_file, write_file,
          edit_file, move_file, list_files, search, bash) confinés à un dossier,
          3 niveaux de permission (plan/normal/yolo), appels d'outils natifs
          Ollama AVEC repli en protocole texte pour les modèles qui ne savent
          pas, contexte qui se compacte tout seul.
          `main/code/{session,tools,permissions}.ts` + `shared/code.ts`.
+ [x] Ajouter "Sunflower Work" définitivement :
    * [x] Lancer une tâche avec l'onglet Work,
    * [x] Sunflower lance un nouveau terminal pour l'app,
    * [x] Effectue la tâche en renouvelant le terminal à chque fois que SunFlower atteint la limite de contexte,
        → chaque fenêtre de contexte est bornée ; pleine, elle est fermée avec
          un résumé de passation, le runner Ollama est DÉCHARGÉ (son état part
          avec) et une fenêtre neuve reprend. L'app Work montre les coutures
          (« terminal 2 · 4 800 tokens ») au lieu de les cacher.
    * [x] Il effectue la tâche en observant l'écran puis clique ou écris,
    * [x] Il est fait pour tourner pendant très longtemps dû au fait qu'il utilise des modèles locaux normalement,
        → budget par défaut 2 h (réglable, 0 = illimité) et 300 étapes, contre
          8 min / 25 étapes avant.
    * [x] Il faut créer une UI complète pour Work :
        * [x] Quand le user clique sur work dans l'app éléctron, une app dediée se lance :
            + [x] Avec du suivi d'agent etc
            + [x] De la création d'agents
            + [x] Chatbox → ce qu'on écrit pendant un run est servi au modèle au tour suivant
            + [x] Suivi des activités terminales,
            + [x] Appels d'outils
            + [x] Etc, → réglages des limites, interrupteur, purge de l'historique
        → `main/windows/work.ts` + `renderer/work/*`, registre dans
          `main/work/store.ts`, boucle dans `main/work/runner.ts`.
    + Work sert quand on veut réaliser une tâche sans toucher à son PC et qu'on a pas besoin de résultats immédiats comme avec [Claude Cowork](5) ou [ChatGPT Work](6)
        → et il n'attend plus qu'on parte pour s'y mettre : un run démarre
          sur-le-champ, puis rend le curseur dès qu'on se sert de la machine et
          reprend après deux secondes de calme (`onUserInput`, défaut « pause »).
          L'ancien « attends que je sois parti » reste réglable dans l'app Work.



## Références :

Deezer : [1](https://deezer.com/fr/)

Spotify : [2](https://open.spotify.com/intl-fr/)

Cursor : [3](https://cursor.com/)

VS Code : [4](https://code.visualstudio.com/)

Claude : [5](https://claude.ai/)

ChatGPT : [6](https://chatgpt.ai/fr/)

Gemini : [7](https://gemini.google.com/)

Youtube : [8](https://youtube.com/)

Netflix : [9](https://netflix.com/)

Figma : [10](https://figma.com/)

Premiere Pro : [11](https://www.adobe.com/fr/)

Snapchat : [12](https://snapchat.com/)

Discord : [13](https://discord.com/)

Tiktok : [14](https://tiktok.com/)

Instagram : [15](https://instagram.com)

Ollama Code : [16](https://github.com/Tromset/Ollama-Code)
