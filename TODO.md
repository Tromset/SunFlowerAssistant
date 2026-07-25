# A faire

## UI :

### Dans l'onglet de l'app éléctron :

+ [ ] L'onglet de l'app éléctron ne se termine pas bien, il manque les coins arrondies
+ [ ] Rajouter un bouton "quit" qui termine tout activité de SunFlower
+ [ ] Rajouter plein de petite animations mignonnes :
    + quand on lance [Deezer](1) ou [Spotify](2), le tournesol a un petit casque pour écouter la musique,
    + quand on lance [Cursor](3) ou [VS Code](4), il a un petit ordi pour coder
    + Quand on lance [Claude](5), [ChatGPT](6), [Gemini](7), etc, le tournesol a une pencarte qui dit "AI on top"
    + Quand on est sur un site ou appli de diverstissement/streaming comme [Youtube](8) ou [Netflix](9), le tournesol a du popcorn
    + Quand on est sur une appli créative comme [Figma](10) ou [Premiere Pro](11), le tournesol et courbé et a un plaid et regarde son PC
    + Quand on est sur une app de messagerie genre [SnapChat](12) ou [Discord](13), le tournesol a un téléphone et envoie des messages 
    + Quand on est sur une appli de doomscrolling genre [Tiktok](14) ou [Instagram](15) le tournesol a un téléphone et est tout fatigué et courbé
    + Etc,

### Dans le CLI: 
    
+ [ ] Créer une UI complète pour le CLI de Sunflower
+ [ ] La UI doit ressembler à celle de [Ollama Code](16) (pixelisée avec des petits détails mignons)

## Backend :

> Les agents ne fonctionnent pas réellement et on a aucun moyen de les traquer.

+ [ ] Ajouter une copie de Ollama Code dans Sunflower, "Sunflower-Code" pour coder avec Sunflower :
    + [ ] Ajouter une fonction qui envoie tout les messages à Sunflower-Code dans le CLI,
    + [ ] Copier toute l'infrastructure de [Ollama Code](16)
+ [ ] Ajouter "Sunflower Work" définitivement :
    * Lancer une tâche avec l'onglet Work, 
    * Sunflower lance un nouveau terminal pour l'app,
    * Effectue la tâche en renouvelant le terminal à chque fois que SunFlower atteint la limite de contexte,
    * Il effectue la tâche en observant l'écran puis clique ou écris,
    * Il est fait pour tourner pendant très longtemps dû au fait qu'il utilise des modèles locaux normalement,
    * [ ] Il faut créer une UI complète pour Work :
        * Quand le user clique sur work dans l'app éléctron, une app dediée se lance :
            + Avec du suivi d'agent etc
            +  De la création d'agents
            + Chatbox
            + Suivi des activités terminales,
            + Appels d'outils 
            + Etc,
    + Work sert quand on veut réaliser une tâche sans toucher à son PC et qu'on a pas besoin de résultats immédiats comme avec [Claude Cowork](5) ou [ChatGPT Work](6)



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
