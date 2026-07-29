/* Le petit son qui accompagne l'onde quand Claude a terminé.
 *
 *  L'app n'a aucun son et aucun fichier audio : plutôt que d'en embarquer un,
 *  on synthétise deux sinus. Même esprit que pixel-png.ts (encodeur PNG écrit
 *  à la main) ou tui-ansi.ts — zéro dépendance, zéro octet livré.
 *
 *  Le coût caché qu'il faut connaître : un AudioContext vivant tient le
 *  périphérique de sortie CoreAudio OUVERT. C'est exactement la classe de
 *  charge permanente que le budget de CLAUDE.md interdit, et que
 *  check-loops.mjs ne peut pas voir. D'où la discipline ici :
 *
 *    - le contexte est créé à la PREMIÈRE onde, pas au chargement ;
 *    - il est suspendu une seconde et demie après chaque son, ce qui rend le
 *      périphérique ;
 *    - il est repris juste avant de jouer (moins d'une milliseconde à chaud).
 *
 *  Code décoratif : ne lève jamais, n'écrit jamais dans la console. Si l'audio
 *  n'est pas disponible, l'onde passe toute seule et personne n'est prévenu. */

/** Les deux notes : la5 puis do♯6 — un intervalle qui monte, court, sans
 *  harmoniques (sinus pur), donc audible sans être perçant. */
const NOTES: readonly { hz: number; at: number; len: number }[] = [
  { hz: 880, at: 0, len: 0.18 },
  { hz: 1108.73, at: 0.14, len: 0.18 },
];

/** Volume de crête. Discret veut dire discret. */
const PEAK = 0.055;

/** Délai avant de rendre le périphérique audio. */
const IDLE_BEFORE_SUSPEND_MS = 1500;

type Ctx = AudioContext & { __sfSuspend?: number };

let ctx: Ctx | null = null;

function ensureContext(): Ctx | null {
  if (ctx) return ctx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor() as Ctx;
    return ctx;
  } catch {
    return null;
  }
}

/** Joue le carillon. Silencieux et sans effet si l'audio n'est pas là. */
export function chime(): void {
  const audio = ensureContext();
  if (!audio) return;
  try {
    // Electron met autoplayPolicy à « no-user-gesture-required » par défaut et
    // le Web Audio n'a jamais eu besoin du focus : ce resume est une ceinture,
    // et il sert surtout à sortir de la suspension armée ci-dessous.
    if (audio.state !== "running") void audio.resume().catch(() => {});

    const start = audio.currentTime + 0.01;
    for (const note of NOTES) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = note.hz;
      const t0 = start + note.at;
      // Une attaque instantanée claque ; 15 ms suffisent à l'arrondir.
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(PEAK, t0 + 0.015);
      // JAMAIS zéro : exponentialRampToValueAtTime lève sur une cible nulle.
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.len);
      osc.connect(gain).connect(audio.destination);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(t0);
      osc.stop(t0 + note.len + 0.02);
    }

    // Rendre le périphérique après coup. Le corps du callback ne fait que des
    // accès de propriété : aucun appel d'identifiant, donc rien que
    // check-loops.mjs puisse prendre pour une replanification.
    if (audio.__sfSuspend !== undefined) {
      window.clearTimeout(audio.__sfSuspend);
    }
    audio.__sfSuspend = window.setTimeout(() => {
      void audio.suspend().catch(() => {});
    }, IDLE_BEFORE_SUSPEND_MS);
  } catch {
    /* décoratif : pas de son, pas de drame */
  }
}

/** Ferme le contexte — appelé quand la page s'en va. */
export function stopChime(): void {
  if (!ctx) return;
  try {
    if (ctx.__sfSuspend !== undefined) window.clearTimeout(ctx.__sfSuspend);
    void ctx.close().catch(() => {});
  } catch {
    /* rien à faire */
  }
  ctx = null;
}
