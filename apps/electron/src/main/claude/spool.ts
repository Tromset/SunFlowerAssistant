/** La source d'événements : un dossier que Claude remplit, que FSEvents nous
 *  signale, et qu'on vide.
 *
 *  Pas de sondage, pas de minuterie, RIEN. `fs.watch` ne dit rien tant que
 *  personne n'écrit : quand Claude ne tourne pas, ce module ne s'exécute pas
 *  une seule fois. C'est ce que réclame le budget always-on de CLAUDE.md, et
 *  c'est ce qui permet d'ajouter la fonctionnalité sans toucher aux plafonds
 *  de scripts/loop-budget.json.
 *
 *  Deux précautions apprises de FSEvents :
 *
 *  - le `filename` d'un événement n'est pas fiable et plusieurs écritures se
 *    fondent en une seule notification. On relit donc TOUJOURS le dossier,
 *    jamais le nom reçu ;
 *  - un watcher meurt en silence si son dossier disparaît, et ne survit pas
 *    toujours à une mise en veille. On ne le rattrape pas avec un timer : on
 *    le ré-arme depuis des événements déjà gratuits (`wake()`, appelé par
 *    powerMonitor et par l'affichage du compagnon). Au pire une onde arrive
 *    un réveil trop tard ; ça ne vaut pas une charge permanente. */

import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  parseHookPayload,
  type ClaudeHookPayload,
} from "../../shared/claude";

/** Au-delà, l'événement est jeté sans être joué : une onde pour quelque chose
 *  qui s'est terminé pendant que l'app était fermée, c'est du bruit. */
const STALE_AFTER_MS = 120_000;

/** Au-delà, ce n'est plus une charge utile de hook : jeté sans être lu. */
const MAX_PAYLOAD_BYTES = 1_000_000;

export interface ClaudeSpool {
  /** Crée le dossier, arme le watcher, vide ce qui traîne. */
  arm(): void;
  /** Ré-arme si le watcher est mort, puis vide. Gratuit et sans effet sinon. */
  wake(): void;
  disarm(): void;
}

export function createClaudeSpool(deps: {
  dir: string;
  onPayload(payload: ClaudeHookPayload): void;
}): ClaudeSpool {
  let watcher: FSWatcher | null = null;
  let armed = false;
  // Coalescence : une rafale d'événements pendant une lecture ne lance pas
  // dix lectures concurrentes, elle en redemande une à la fin.
  let draining = false;
  let again = false;

  const drain = (): void => {
    if (!armed) return;
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    void (async () => {
      try {
        const names = await readdir(deps.dir);
        // L'ORDRE COMPTE, et readdir ne le donne pas. Un tour rapide dépose
        // UserPromptSubmit puis Stop dans la même salve ; les jouer à
        // l'envers remettrait la tâche à « working » après sa fin, et l'onde
        // serait perdue. On trie donc par date d'écriture, le nom départageant
        // les ex æquo.
        const batch: { file: string; at: number }[] = [];
        for (const name of names) {
          // Le hook publie par rename : un `tmp.*` est un fichier à moitié
          // écrit, il ne nous concerne pas.
          if (!name.endsWith(".json")) continue;
          const file = path.join(deps.dir, name);
          try {
            const info = await stat(file);
            // Une charge utile démesurée n'est pas une charge utile : on la
            // jette sans même la lire.
            if (info.size > MAX_PAYLOAD_BYTES) {
              await unlink(file);
              continue;
            }
            batch.push({ file, at: info.mtimeMs });
          } catch {
            /* déjà pris par un autre passage */
          }
        }
        batch.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));

        for (const { file, at } of batch) {
          try {
            const raw = await readFile(file, "utf8");
            // Supprimé tout de suite : la charge utile contient le dernier
            // message de Claude, elle n'a pas à traîner sur le disque.
            await unlink(file);
            const payload = parseHookPayload(raw, at);
            if (payload && Date.now() - at < STALE_AFTER_MS) {
              deps.onPayload(payload);
            }
          } catch {
            // Illisible : on s'en débarrasse plutôt que de le relire sans fin.
            try {
              await unlink(file);
            } catch {
              /* rien à faire */
            }
          }
        }
      } catch {
        // Dossier disparu : le watcher est probablement mort avec lui. On ne
        // se bat pas ici — le prochain wake() le remettra en place.
        watcher?.close();
        watcher = null;
      } finally {
        draining = false;
        if (again) {
          again = false;
          drain();
        }
      }
    })();
  };

  const startWatch = (): void => {
    if (watcher) return;
    try {
      watcher = watch(deps.dir, () => drain());
      // Un watcher mort ne doit pas rester en place à faire semblant.
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
      // Ne retient pas le process à la sortie.
      watcher.unref?.();
    } catch {
      watcher = null;
    }
  };

  /** Le dossier peut avoir disparu (ménage manuel, autre session) : le
   *  remettre ici rend la reprise déterministe plutôt que de dépendre du
   *  `mkdir -p` du hook. */
  const ensure = (): void => {
    void mkdir(deps.dir, { recursive: true, mode: 0o700 })
      .then(() => {
        if (!armed) return;
        startWatch();
        drain();
      })
      .catch(() => {
        /* décoratif : sans dossier, il n'y a simplement rien à lire */
      });
  };

  return {
    arm(): void {
      armed = true;
      ensure();
    },
    wake(): void {
      if (!armed) return;
      ensure();
    },
    disarm(): void {
      armed = false;
      watcher?.close();
      watcher = null;
    },
  };
}
