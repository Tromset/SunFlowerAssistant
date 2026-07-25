// Sunflower-Code — les trois niveaux de permission d'Ollama-Code, portés tels
// quels. Le niveau décide de ce qui part tout seul, de ce qui demande un
// accord, et de ce qui est refusé sans appel.
//
//   plan    lecture seule       write/execute refusés d'office
//   normal  lecture libre       write/execute demandent un accord (défaut)
//   yolo    tout part           rien ne demande rien
//
// Le MODE peut restreindre davantage mais jamais élargir : `plan` et `chat`
// n'exposent au modèle que les outils qui n'écrivent rien, quel que soit le
// niveau — un `yolo` en mode plan reste en lecture seule.
import {
  CODE_TOOLS,
  CODE_TOOL_EFFECT,
  type CodeGate,
  type CodeMode,
  type CodePermission,
  type CodeToolName,
} from "../../shared/code";

/** Sort d'un outil sous un niveau donné. */
export function gateFor(
  permission: CodePermission,
  tool: CodeToolName,
): CodeGate {
  const effect = CODE_TOOL_EFFECT[tool];
  if (effect === "read") return "allow";
  switch (permission) {
    case "plan":
      return "deny";
    case "yolo":
      return "allow";
    case "normal":
      return "ask";
  }
}

/** Phrase montrée à l'utilisateur quand un outil est refusé d'office. */
export function denyReason(
  permission: CodePermission,
  tool: CodeToolName,
): string {
  return `${tool} is a ${CODE_TOOL_EFFECT[tool]} tool and the permission level is "${permission}" — switch with /permission normal.`;
}

/** Outils réellement exposés au modèle pour un mode + un niveau donnés. */
export function toolsFor(
  mode: CodeMode,
  permission: CodePermission,
): CodeToolName[] {
  if (mode === "chat") return [];
  const readOnly = mode === "plan" || permission === "plan";
  return CODE_TOOLS.filter(
    (t) => !readOnly || CODE_TOOL_EFFECT[t] === "read",
  );
}
