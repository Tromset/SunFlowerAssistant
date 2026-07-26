// Le catalogue des gestes de Sunflower Work.
//
// Il existe parce que le répertoire a grossi. Tant qu'il y avait quatre
// gestes, la liste des noms vivait en double (shared/work.ts et une constante
// du runner), la grammaire était de la prose dans le prompt, la validation une
// suite de `if`, et l'aiguillage un `else` fourre-tout qui transformait
// SILENCIEUSEMENT toute action inconnue en appui de touche. À douze gestes,
// c'est intenable.
//
// Ici, une seule source. Le registre est indexé par WorkActionName : ajouter
// un nom à l'union sans le décrire ne compile pas, et l'aiguillage du runner
// est un `switch` exhaustif que tsc refuse de laisser incomplet. En dérivent
// la liste acceptée par le parseur, les champs exigés de chaque action, les
// lignes de grammaire du prompt, le schéma JSON qui contraint le décodage, et
// la trace resservie au modèle au tour suivant.
//
// Modelé sur le registre d'outils de Sunflower-Code (code/tools.ts).
import type { WorkActionName } from "../../shared/work";
import { KEY_NAMES } from "./clicker";

/** L'étape rendue par le modèle, une fois validée. Un geste, jamais deux. */
export interface WorkStep {
  action: WorkActionName;
  /** Fractions d'écran 0..1 : cible du geste. */
  x?: number;
  y?: number;
  /** Fractions d'écran 0..1 : arrivée d'un glisser. */
  x2?: number;
  y2?: number;
  /** Texte tapé, nom de touche, combinaison, sens, cible, libellé. */
  text?: string;
  /** Crans de molette. */
  amount?: number;
  why: string;
}

/** Ce qu'une action exige pour être exécutable ; sinon la réponse est rejetée
 *  et le modèle rejoue son tour. */
export type WorkActionNeed = "xy" | "xy2" | "text";

export interface WorkActionDef {
  needs: readonly WorkActionNeed[];
  /** Une ligne de grammaire, servie telle quelle au modèle. */
  help: string;
}

/** Le répertoire complet. L'ordre est celui du prompt : les gestes les plus
 *  courants d'abord, la sortie en dernier. */
export const WORK_ACTIONS: Record<WorkActionName, WorkActionDef> = {
  click: {
    needs: ["xy"],
    help: "click — one left click at x,y.",
  },
  "double-click": {
    needs: ["xy"],
    help: "double-click — two left clicks at x,y (open a file, select a word).",
  },
  "right-click": {
    needs: ["xy"],
    help: "right-click — open the context menu at x,y.",
  },
  type: {
    needs: ["xy", "text"],
    help: "type — click x,y to focus the field, then type text.",
  },
  key: {
    needs: ["text"],
    help: `key — press one bare key, name it in text: ${KEY_NAMES.join(", ")}.`,
  },
  hotkey: {
    needs: ["text"],
    help: "hotkey — a combination in text, like cmd+c, cmd+v, cmd+a, cmd+f, cmd+l, cmd+t, cmd+w, cmd+shift+t. Modifiers: cmd, ctrl, opt, shift.",
  },
  scroll: {
    needs: ["xy", "text"],
    help: "scroll — scroll the thing under x,y; text is up, down, left or right, and amount is how many wheel clicks (default 5).",
  },
  drag: {
    needs: ["xy", "xy2"],
    help: "drag — press at x,y, move, release at x2,y2 (move a file, select a range).",
  },
  open: {
    needs: ["text"],
    help: 'open — bring up an app or a page; text is an app name ("Safari", "Mail") or an http(s) URL.',
  },
  "click-label": {
    needs: ["text"],
    help: "click-label — click the on-screen element whose label matches text. Whenever a list of on-screen elements is given and one of them is what you want, prefer this over click: it lands exactly, where guessed coordinates often miss.",
  },
  wait: {
    needs: [],
    help: "wait — do nothing for a moment, when the screen is still loading.",
  },
  done: {
    needs: [],
    help: "done — end the run; say in why whether the task is finished or impossible.",
  },
};

/** Les noms acceptés, dans l'ordre du registre. */
export const WORK_ACTION_NAMES = Object.keys(WORK_ACTIONS) as WorkActionName[];

export function isWorkActionName(value: string): value is WorkActionName {
  return Object.prototype.hasOwnProperty.call(WORK_ACTIONS, value);
}

/** Les lignes de grammaire, une par geste, pour le prompt système. */
export function actionHelpLines(): string {
  return WORK_ACTION_NAMES.map((name) => `- ${WORK_ACTIONS[name].help}`).join(
    "\n",
  );
}

/**
 * Le schéma de la réponse, passé à Ollama en `format` pour CONTRAINDRE le
 * décodage plutôt que d'espérer que la prose suffise. À douze gestes, un
 * `format: "json"` nu ne tient plus : le modèle invente des noms d'action.
 *
 * Volontairement plat : les champs requis dépendent de l'action, et exprimer
 * ça en oneOf donnerait une grammaire que tous les moteurs ne savent pas
 * compiler. C'est `parseStep` qui exige les bons champs, action par action.
 */
export function workStepSchema(): Record<string, unknown> {
  const fraction = { type: "number", minimum: 0, maximum: 1 };
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: WORK_ACTION_NAMES },
      x: fraction,
      y: fraction,
      x2: fraction,
      y2: fraction,
      text: { type: "string" },
      amount: { type: "number" },
      why: { type: "string" },
    },
    required: ["action", "why"],
  };
}

/** Trace courte d'une étape, resservie au modèle au tour suivant — c'est toute
 *  sa mémoire des gestes déjà faits. */
export function describeStep(step: WorkStep): string {
  const pt = (x?: number, y?: number) =>
    x !== undefined && y !== undefined
      ? `(${x.toFixed(2)}, ${y.toFixed(2)})`
      : "";
  const from = pt(step.x, step.y);
  const to = pt(step.x2, step.y2);
  const where = from ? (to ? ` ${from} → ${to}` : ` at ${from}`) : "";
  const text = step.text ? ` "${step.text.slice(0, 40)}"` : "";
  const amount =
    step.action === "scroll" && step.amount !== undefined
      ? ` ×${step.amount}`
      : "";
  return `${step.action}${where}${text}${amount} — ${step.why || "no reason given"}`;
}
