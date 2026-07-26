/** Le petit rond ancré au bord droit : ce qu'il affiche, et rien de plus.
 *
 *  Deux surfaces peuvent travailler en tâche de fond — Sunflower-Code et
 *  Sunflower Work — et le rond est leur seul témoin visuel quand leur fenêtre
 *  est fermée. Plutôt que de lui faire connaître les deux modèles d'état, le
 *  main les traduit en une liste de `OrbRun` déjà lisible : le renderer choisit
 *  laquelle montrer, pas ce qu'elle raconte. */

export type OrbSource = "code" | "work";

export interface OrbRun {
  id: string;
  source: OrbSource;
  /** Ligne du haut de la pastille : la tâche, ou le dossier pour Code. */
  title: string;
  /** Mot d'état déjà rédigé (« turn 3/8 · thinking… », « paused »…). */
  state: string;
  /** Compte comme activité en cours : le rond est visible, disque allumé. */
  active: boolean;
  /** Modèle ou outil réellement en vol. L'animation ne tourne QUE là : une
   *  attente d'accord humain n'est pas du travail, elle ne pulse pas. */
  working: boolean;
}
