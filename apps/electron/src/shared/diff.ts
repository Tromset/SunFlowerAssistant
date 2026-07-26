/** Diff avant/après, ligne à ligne, bornée — le rendu « ce qui a changé »
 *  partagé par Sunflower-Code (revue des changements et compte des lignes)
 *  (l'app, qui montre ce que le modèle vient d'écrire).
 *
 *  Vivait dans renderer/panel/panel.ts : le harnais calcule maintenant ses
 *  diffs côté main, donc le module descend en partagé. Aucun changement de
 *  comportement — c'est le même LCS, les mêmes bornes.
 *
 *  Module partagé main ↔ renderer : ni electron, ni node. */

export interface DiffLine {
  type: "same" | "add" | "del" | "skip";
  text: string;
}

export function splitLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Au-delà, le LCS coûterait plus que ce qu'il apporte : on montre les deux
 *  bouts et on le dit. */
export const DIFF_MAX_LINES = 300;

export function diffLines(before: string | null, after: string): DiffLine[] {
  const a = before === null ? [] : splitLines(before);
  const b = splitLines(after);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    // Trop gros pour un LCS confortable : avant tronqué puis après tronqué.
    return [
      ...a.slice(0, 60).map((text) => ({ type: "del" as const, text: `- ${text}` })),
      { type: "skip", text: "··· file too large for a full diff ···" },
      ...b.slice(0, 60).map((text) => ({ type: "add" as const, text: `+ ${text}` })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ type: "same", text: `  ${a[i]}` });
      i++;
      j++;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      raw.push({ type: "del", text: `- ${a[i]}` });
      i++;
    } else {
      raw.push({ type: "add", text: `+ ${b[j]}` });
      j++;
    }
  }
  for (; i < n; i++) raw.push({ type: "del", text: `- ${a[i]}` });
  for (; j < m; j++) raw.push({ type: "add", text: `+ ${b[j]}` });
  // Ne garder que 2 lignes de contexte autour des changements.
  const keep = new Array<boolean>(raw.length).fill(false);
  raw.forEach((line, idx) => {
    if (line.type === "same") return;
    for (
      let k = Math.max(0, idx - 2);
      k <= Math.min(raw.length - 1, idx + 2);
      k++
    ) {
      keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipping = false;
  raw.forEach((line, idx) => {
    if (keep[idx]) {
      out.push(line);
      skipping = false;
    } else if (!skipping) {
      out.push({ type: "skip", text: "···" });
      skipping = true;
    }
  });
  return out;
}

/** Compte des lignes ajoutées / retirées, pour la pastille « +12 −3 ». */
export function diffTally(diff: readonly DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}
