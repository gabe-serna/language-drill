import { spawn } from "node:child_process";

export type Settings = { enabled: boolean; apiAddress: string; speakerId: number | null; speed: number; autoPlay: boolean };

export function voicevox(settings: Settings, request = fetch) {
  if (!settings || typeof settings.enabled !== "boolean" || typeof settings.autoPlay !== "boolean"
    || !Number.isFinite(settings.speed) || settings.speed <= 0
    || !(settings.speakerId === null || Number.isSafeInteger(settings.speakerId) && settings.speakerId >= 0)
    || !/^https?:$/.test(new URL(settings.apiAddress).protocol)) throw new Error("Invalid VOICEVOX settings.");
  let speaker = settings.speakerId;
  return async (sentence: string, cancel: AbortSignal) => {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(30000)]);
    async function call(path: string, params: Record<string, string>, init?: RequestInit) {
      const url = new URL(path, settings.apiAddress);
      url.search = new URLSearchParams(params).toString();
      const response = await request(url, { ...init, signal });
      if (!response.ok) throw new Error("VOICEVOX " + path + " returned HTTP " + response.status);
      return response;
    }
    if (speaker === null) {
      const voices = await (await call("/speakers", {})).json() as { name: string; styles: {name: string; id: number}[] }[];
      const id = voices.find(v => v.name === "玄野武宏")?.styles.find(s => s.name === "ノーマル")?.id;
      if (id === undefined || !Number.isSafeInteger(id)) throw new Error("VOICEVOX default voice unavailable.");
      speaker = id;
    }
    const params = { speaker: String(speaker) };
    const query = await (await call("/audio_query", { ...params, text: sentence }, { method: "POST" })).json();
    query.speedScale = settings.speed;
    const response = await call("/synthesis", params, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) });
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid VOICEVOX audio.");
    return wav;
  };
}

// Pipe WAV bytes directly into the built-in Windows .NET player.
export function playWave(audio: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const script = "$ErrorActionPreference='Stop'; $stream=New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($stream); $stream.Position=0; $player=New-Object System.Media.SoundPlayer; $player.Stream=$stream; $player.PlaySync()";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["pipe", "ignore", "ignore"],
    });
    const stop = () => { child.kill(); };
    signal.addEventListener("abort", stop, { once: true });
    let failure: Error | undefined;
    child.on("error", error => { failure = error; });
    child.stdin.on("error", error => { failure = error; stop(); });
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted || (!failure && code === 0)) resolve();
      else reject(failure ?? new Error("Windows audio playback failed."));
    });
    child.stdin.end(audio);
  });
}

export function sessionAudio(synthesize: ReturnType<typeof voicevox>, play = playWave) {
  const lifetime = new AbortController();
  const cache = new Map<string, Promise<Buffer | undefined>>();
  let playback: AbortController | undefined;
  let stopped = Promise.resolve();
  function preload(text: string) {
    if (!cache.has(text) && !lifetime.signal.aborted) {
      cache.set(text, synthesize(text, lifetime.signal).catch(() => undefined));
    }
  }
  function stop() { playback?.abort(); }
  return {
    preload, stop,
    replay(text: string, unavailable: () => void) {
      stop();
      const current = new AbortController();
      playback = current;
      stopped = stopped.then(async () => {
        const audio = await cache.get(text);
        if (current.signal.aborted || lifetime.signal.aborted) return;
        if (!audio) { unavailable(); return; }
        try { await play(audio, current.signal); }
        catch { if (!current.signal.aborted) unavailable(); }
      });
    },
    async close() { lifetime.abort(); stop(); cache.clear(); await stopped; },
  };
}
