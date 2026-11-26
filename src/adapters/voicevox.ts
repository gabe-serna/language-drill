import { isWave, type AudioProvider } from "../core/audio.ts";

export type Settings = { enabled: boolean; apiAddress: string; speakerId: number | null; speed: number; autoPlay: boolean };

export function voicevox(settings: Settings, request = fetch): AudioProvider {
  if (!settings || typeof settings.enabled !== "boolean" || typeof settings.autoPlay !== "boolean"
    || !Number.isFinite(settings.speed) || settings.speed <= 0
    || !(settings.speakerId === null || Number.isSafeInteger(settings.speakerId) && settings.speakerId >= 0)
    || !/^https?:$/.test(new URL(settings.apiAddress).protocol)) throw new Error("Invalid VOICEVOX settings.");
  let speaker = settings.speakerId;
  return async (sentence: string, cancel: AbortSignal) => {
    if (typeof sentence !== "string" || !sentence.trim()) throw new Error("Expected reference text.");
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
    if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("Invalid VOICEVOX audio query.");
    query.speedScale = settings.speed;
    const response = await call("/synthesis", params, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) });
    const wav = new Uint8Array(await response.arrayBuffer());
    if (!isWave(wav)) throw new Error("Invalid VOICEVOX audio.");
    return wav;
  };
}
