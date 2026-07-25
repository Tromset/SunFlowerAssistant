// Liste noire de commandes shell, partagée par les deux endroits où sunflower
// peut en exécuter une : les agents d'arrière-plan du panneau (agents/runner)
// et l'outil `bash` de Sunflower-Code (code/tools).
//
// Best effort assumé (un shell reste un shell) : le vrai garde-fou reste
// l'accord humain explicite, commande par commande. Cette liste refuse
// d'office, SANS même proposer l'accord, les motifs destructeurs évidents —
// et le refus est toujours visible, jamais silencieux.

/** Au-delà, la commande n'est même pas lue : le modèle divague. */
export const MAX_COMMAND_LENGTH = 400;

const BLOCKED_COMMANDS: { re: RegExp; why: string }[] = [
  { re: /\b(sudo|doas)\b/i, why: "privilege escalation" },
  {
    // rm avec un drapeau récursif ET un drapeau force dans le même segment,
    // quel que soit l'ordre ou la forme (-rf, -fr, -r -f, --recursive --force).
    re: /\brm\b(?=[^|;&]*\s(-[a-zA-Z]*[rR]|--recursive\b))(?=[^|;&]*\s(-[a-zA-Z]*f|--force\b))/,
    why: "recursive force delete",
  },
  { re: /\brm\b[^|;&]*\s(\/|~\/?)([ \t]|$)/, why: "delete at / or ~" },
  { re: /\bgit\s+push\b[^|;&]*\s(-f|--force(-with-lease)?)\b/i, why: "force push" },
  { re: /\bgit\s+reset\b[^|;&]*\s--hard\b/i, why: "git reset --hard" },
  { re: /\bgit\s+clean\b[^|;&]*\s-[a-zA-Z]*[fx]/i, why: "git clean -f/-x" },
  {
    re: /\bgit\s+checkout\b[^|;&]*\s(--\s*\.|\.)([ \t]|$)/,
    why: "checkout over local changes",
  },
  {
    re: /\b(curl|wget)\b[^|;&]*\|[^|;&]*\b(ba|z|da|fi|c|k)?sh\b/i,
    why: "piping a download into a shell",
  },
  {
    re: /(>|>>)[ \t]*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b)/,
    why: "writing to a device",
  },
  { re: /\bdd\b[^|;&]*\bof=/i, why: "raw disk write (dd)" },
  { re: /\b(mkfs|fdisk|parted|diskutil|newfs)\b/i, why: "disk formatting/partitioning" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "system power control" },
  { re: /\bkill(all)?\b[^|;&]*\s-9\s+-?1\b/, why: "killing all processes" },
  { re: /:\s*\(\s*\)\s*\{/, why: "fork bomb" },
  {
    re: /\bchmod\b[^|;&]*\s(-[a-zA-Z]*R[a-zA-Z]*\s[^|;&]*)?\/([ \t]|$)/,
    why: "chmod on /",
  },
  { re: /\blaunchctl\b|\bsystemctl\b/i, why: "system service control" },
];

/** Motif destructeur détecté (ou commande hors gabarit) ; null si acceptable. */
export function blockedReason(command: string): string | null {
  if (command.length > MAX_COMMAND_LENGTH) return "command too long";
  for (const { re, why } of BLOCKED_COMMANDS) {
    if (re.test(command)) return why;
  }
  return null;
}
