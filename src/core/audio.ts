export type AudioProvider = (sentence: string, signal: AbortSignal) => Promise<Uint8Array>;
export type PlayWave = (audio: Uint8Array, signal: AbortSignal) => Promise<void>;

export function isWave(bytes: Uint8Array) {
  return bytes instanceof Uint8Array && bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
}

export function sessionAudio(synthesize: AudioProvider, play: PlayWave) {
  const lifetime = new AbortController();
  const cache = new Map<string, Promise<Uint8Array | undefined>>();
  let playback: AbortController | undefined;
  let stopped = Promise.resolve();
  function preload(text: string) {
    if (!cache.has(text) && !lifetime.signal.aborted) {
      cache.set(text, synthesize(text, lifetime.signal).then(bytes => isWave(bytes) ? bytes : undefined).catch(() => undefined));
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
