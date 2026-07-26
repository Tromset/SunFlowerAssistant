// Types du client Ollama partagé (lib/ollama-api.cjs). Écrits à la main :
// l'implémentation est du CommonJS sans build, parce que les bins doivent
// tourner depuis un clone frais.

export declare const DEFAULT_HOST: string;

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  /** « 8.2B » quand Ollama le donne, chaîne vide sinon. */
  parameterSize: string;
  /** « Q4_K_M » quand Ollama le donne, chaîne vide sinon. */
  quantization: string;
  capabilities: string[];
  modifiedAt: string;
}

export interface OllamaPullProgress {
  status: string;
  completed: number;
  total: number;
}

export declare function normalizeHost(raw: string): string;
export declare function sameModel(a: string, b: string): boolean;
export declare function listModels(
  host: string,
  timeoutMs?: number,
): Promise<OllamaModelInfo[]>;
export declare function loadedModels(
  host: string,
  timeoutMs?: number,
): Promise<string[]>;
export declare function showModel(
  host: string,
  model: string,
  timeoutMs?: number,
): Promise<{ capabilities: string[] }>;
export declare function reachable(host: string, timeoutMs?: number): Promise<boolean>;
export declare function pullModel(
  host: string,
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal,
): Promise<void>;
export declare function formatBytes(bytes: number): string;
