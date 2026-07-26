// Client Ollama partagé — la SEULE implémentation du dialogue avec l'hôte
// local. Avant ce fichier, la résolution d'hôte, `/api/tags` et le pull
// vivaient en trois exemplaires : `src/main/ollama.ts`, `bin/sunflower-models.js`
// et `bin/sunflower-requirements.js`. Trois copies veut dire trois
// comportements le jour où l'une corrige un cas limite.
//
// Écrit en CommonJS sans dépendance, et PAS dans `src/`, parce que les deux
// bins doivent tourner depuis un clone frais, sans build et sans Electron.
// Le main l'importe tel quel (esbuild le rassemble), avec les types de
// `ollama-api.d.cts` en face.
"use strict";

const DEFAULT_HOST = "http://localhost:11434";

/** Normalise une adresse d'hôte : schéma implicite, pas de slash final. */
function normalizeHost(raw) {
  let host = String(raw || DEFAULT_HOST).trim() || DEFAULT_HOST;
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  return host.replace(/\/+$/, "");
}

/** `qwen3-vl` et `qwen3-vl:latest` désignent le même modèle. */
function sameModel(a, b) {
  const norm = (s) => (String(s).includes(":") ? String(s) : `${s}:latest`);
  return norm(a) === norm(b);
}

async function getJson(host, path, timeoutMs) {
  const res = await fetch(`${normalizeHost(host)}${path}`, {
    signal: AbortSignal.timeout(timeoutMs ?? 1500),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * `GET /api/tags` — les modèles présents sur le disque, du plus récemment
 * modifié au plus ancien (comme `ollama list`), avec ce qu'il faut pour
 * dessiner une ligne de picker : taille de paramètres, quantization, octets.
 */
async function listModels(host, timeoutMs) {
  const data = await getJson(host, "/api/tags", timeoutMs ?? 4000);
  const models = Array.isArray(data && data.models) ? data.models : [];
  return models
    .map((m) => {
      const details = m.details || {};
      return {
        name: String(m.name || m.model || ""),
        sizeBytes: Number(m.size) || 0,
        parameterSize: details.parameter_size ? String(details.parameter_size) : "",
        quantization: details.quantization_level
          ? String(details.quantization_level)
          : "",
        capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
        modifiedAt: m.modified_at ? String(m.modified_at) : "",
      };
    })
    .filter((m) => m.name !== "")
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** `GET /api/ps` — modèles actuellement chargés en mémoire. */
async function loadedModels(host, timeoutMs) {
  const data = await getJson(host, "/api/ps", timeoutMs ?? 1500);
  const models = Array.isArray(data && data.models) ? data.models : [];
  return models.map((m) => String(m.name || m.model || "")).filter(Boolean);
}

/** `POST /api/show` — capacités annoncées par un modèle (tools, vision…). */
async function showModel(host, model, timeoutMs) {
  const res = await fetch(`${normalizeHost(host)}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(timeoutMs ?? 5000),
  });
  if (!res.ok) throw new Error(`/api/show → HTTP ${res.status}`);
  const data = await res.json();
  return {
    capabilities: Array.isArray(data && data.capabilities)
      ? data.capabilities.map(String)
      : [],
  };
}

/** L'hôte répond-il ? Vrai / faux, jamais une exception. */
async function reachable(host, timeoutMs) {
  try {
    await getJson(host, "/api/tags", timeoutMs ?? 1500);
    return true;
  } catch {
    return false;
  }
}

/**
 * `POST /api/pull` en NDJSON. `onProgress` reçoit `{status, completed, total}`
 * au fil du téléchargement ; l'appelant en fait une barre ou rien du tout.
 * Résout quand le flux se termine, rejette sur erreur signalée par Ollama.
 */
async function pullModel(host, model, onProgress, signal) {
  const res = await fetch(`${normalizeHost(host)}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    throw new Error(`pull ${model} → HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.error) throw new Error(String(event.error));
      if (typeof onProgress === "function") {
        onProgress({
          status: String(event.status || ""),
          completed: Number(event.completed) || 0,
          total: Number(event.total) || 0,
        });
      }
    }
  }
}

/** Octets → « 4.7 GB », pour les lignes de picker et les tables du CLI. */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

module.exports = {
  DEFAULT_HOST,
  formatBytes,
  listModels,
  loadedModels,
  normalizeHost,
  pullModel,
  reachable,
  sameModel,
  showModel,
};
