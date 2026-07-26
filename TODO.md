# TODO

## UI :

+ [x] Construire une app complète pour SunFlower, on arrête l'app electron seule, elle sera seulement un raccourci pour l'app, il faut que l'app soit dans mon finder mais run dans mon terminal, donc si je supprime le terminal elle disparaît 

+ [x] Revoir le design du CLI pour qu'il devienne une partie importante de SunFlower

+ [x] Ajouter un tuto pour avoir un lien "sunflower-code" qui peut être invoquer dans n'importe quel dossier

+ [x] Il faut que le CLI soit exactement comme [Ollama-Code](https://github.com/Tromset/Ollama-Code/) avec un skin de tournesol.

## Backend

+ [x] : Ajouter un lien direct vers Ollama pour browser les modèles et les conneter dinstantanément à l'app

+ [x] Ajouter beaucoup de commande comme /btw ou /model dans le CLI

+ [x] Ajouter /effort pour définir le temps et l'effort que SunFlower va mettre dans une tâche

## Repo :

+ [ ] : Ajouter des images de l'app actuelle, celle actuelle sont obsolètes

+ [x] Un SunFlower.dmg qui installe l'app ET garde son code source ouvert : on
  reprend le code à jour sur GitHub, on le met à la place de celui de l'app, et
  si une update ne plaît pas on ne l'installe pas — ou on la modifie avant.

## Distribution :

+ [ ] Vérifier sur Mac, dans l'ordre du plan : icône dans le Finder, `pnpm dmg`,
  aucun `/Users` dans le lanceur, lancement depuis /Applications, PATH réduit,
  auto-modification, remplacement du source par un clone nu.

+ [ ] Noter ce que les réglages Confidentialité affichent après une
  re-signature (nom listé, re-demande ou non) — c'est la seule inconnue que le
  code ne permet pas de trancher.

+ [ ] Developer ID + notarisation quand le compte Apple sera pris : tout est
  déjà câblé, il n'y a que `SUNFLOWER_SIGN_IDENTITY` et
  `SUNFLOWER_NOTARY_PROFILE` à renseigner.
