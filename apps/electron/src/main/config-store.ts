import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  type SunflowerConfig,
} from "../shared/config-schema";

let cached: SunflowerConfig | null = null;

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

export function getConfig(): SunflowerConfig {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<
      SunflowerConfig
    > & { agentOrbY?: number };
    // `agentOrbY` s'appelait ainsi du temps où le rond était celui des agents :
    // reprendre la position plutôt que de la remettre au milieu de l'écran.
    const { agentOrbY, ...rest } = raw;
    cached = {
      ...DEFAULT_CONFIG,
      ...(typeof agentOrbY === "number" ? { orbY: agentOrbY } : {}),
      ...rest,
    };
  } catch {
    cached = { ...DEFAULT_CONFIG };
  }
  return cached;
}

export function setConfig(patch: Partial<SunflowerConfig>): SunflowerConfig {
  const next = { ...getConfig(), ...patch };
  cached = next;
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file);
  return next;
}
