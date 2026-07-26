// Island: state rendering + mic capture (16 kHz mono AudioWorklet).
import { ensureBridge } from "../shared/dev-stub";
import {
  ISLAND_LISTENING,
  POSES,
  pixelArtSvg,
  type PixelArt,
} from "../../shared/sunflower-pixels";
import type { IslandState, StatePayload } from "../../shared/state";

ensureBridge();

const island = document.getElementById("island")!;
const iconEl = document.getElementById("icon")!;
const labelEl = document.getElementById("label")!;
const waveEl = document.getElementById("wave")!;
const waveBars = Array.from(waveEl.querySelectorAll("span"));

const LABELS: Partial<Record<IslandState, string>> = {
  listening: "listening…",
  reading: "looking at your screen…",
  thinking: "thinking…",
  answering: "answering…",
};

const ICONS: Record<IslandState, PixelArt> = {
  idle: POSES.idle,
  listening: ISLAND_LISTENING,
  reading: POSES.reading,
  thinking: POSES.idle,
  acting: POSES.idle,
  answering: POSES.answering,
  guiding: POSES.pointing,
  error: POSES.idle,
};

function iconSize(art: PixelArt): [number, number] {
  const [vw, vh] = art.vb;
  const scale = 18 / 9; // 18px tall, as in prototype 1a
  return [Math.round(vw * scale), Math.round(vh * scale)];
}

function render(payload: StatePayload): void {
  const state = payload.island;
  island.className = `state-${state}`;
  const art = ICONS[state];
  const [w, h] = iconSize(art);
  iconEl.innerHTML = pixelArtSvg(art, w, h);
  if (state === "error") {
    labelEl.innerHTML = `<span class="warn">[!!]</span> ${escapeHtml(
      payload.message ?? "something went wrong.",
    )}`;
  } else if (state === "acting") {
    labelEl.textContent = `[->] ${payload.message ?? "something is running…"}`;
  } else if (state === "guiding") {
    labelEl.textContent = payload.message ?? "guiding…";
  } else {
    labelEl.textContent = LABELS[state] ?? "";
  }
  // Wave: CSS animation while answering and at the start of listening; as
  // soon as the mic reports a real level, it takes over (.anim removed).
  waveEl.classList.toggle("anim", state === "answering" || state === "listening");
  if (state !== "listening") {
    for (const bar of waveBars) bar.style.transform = "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- Mic capture --------------------------------------------------------
const MAX_SECONDS = 60;

interface Capture {
  id: number;
  ctx: AudioContext;
  stream: MediaStream;
  chunks: Float32Array[];
  samples: number;
}

/** Session identity: a quick mic-start/mic-stop must neither leak a mic
    stream nor send audio from a cancelled session. */
let session = 0;
let capture: Capture | null = null;
let starting: Promise<void> | null = null;
const rmsHistory: number[] = [0, 0, 0, 0, 0];

function discard(stream: MediaStream, ctx: AudioContext | null): void {
  stream.getTracks().forEach((t) => t.stop());
  if (ctx) void ctx.close();
}

async function startCapture(id: number): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err) {
    console.error("getUserMedia:", err);
    if (id === session) {
      window.sunflower.sendMicError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "denied"
          : "failed",
      );
    }
    return;
  }
  if (id !== session) {
    discard(stream, null);
    return;
  }
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  try {
    try {
      await ctx.audioWorklet.addModule("./capture-worklet.js");
    } catch {
      // Fallback: inject the worklet through a Blob URL.
      const source = await fetch("./capture-worklet.js").then((r) => r.text());
      const url = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    console.error("audioWorklet:", err);
    discard(stream, ctx);
    if (id === session) window.sunflower.sendMicError("failed");
    return;
  }
  if (id !== session) {
    discard(stream, ctx);
    return;
  }
  const sourceNode = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, "sf-capture");
  const state: Capture = { id, ctx, stream, chunks: [], samples: 0 };
  worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (capture !== state) return;
    const block = e.data;
    if (state.samples < MAX_SECONDS * ctx.sampleRate) {
      state.chunks.push(block);
      state.samples += block.length;
    }
    let sum = 0;
    for (const v of block) sum += v * v;
    pushRms(Math.sqrt(sum / block.length));
  };
  sourceNode.connect(worklet);
  capture = state;
}

function pushRms(rms: number): void {
  rmsHistory.pop();
  rmsHistory.unshift(rms);
  if (!island.className.includes("listening")) return;
  waveEl.classList.remove("anim");
  waveBars.forEach((bar, i) => {
    const level = Math.min(1, (rmsHistory[i] ?? 0) * 9 + 0.25);
    bar.style.transform = `scaleY(${level.toFixed(3)})`;
  });
}

async function stopCapture(): Promise<void> {
  const id = session;
  if (starting) await starting;
  const state = capture;
  if (!state || state.id !== id) return;
  capture = null;
  const sampleRate = state.ctx.sampleRate;
  discard(state.stream, state.ctx);
  const pcm = new Float32Array(state.samples);
  let offset = 0;
  for (const chunk of state.chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  window.sunflower.sendMicData(pcm, sampleRate);
}

window.sunflower.onState(render);
window.sunflower.onMicStart(() => {
  const previous = capture;
  capture = null;
  if (previous) discard(previous.stream, previous.ctx);
  const id = ++session;
  starting = startCapture(id).finally(() => {
    if (id === session) starting = null;
  });
});
window.sunflower.onMicStop(() => {
  void stopCapture();
});

render({ island: "idle", pose: "idle" });
