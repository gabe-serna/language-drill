export type AudioProvider = (sentence: string, signal: AbortSignal, slow?: boolean) => Promise<Uint8Array>;
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
  function preload(text: string, slow = false) {
    const key = JSON.stringify([text, slow]);
    if (!cache.has(key) && !lifetime.signal.aborted) {
      cache.set(key, synthesize(text, lifetime.signal, slow).then(bytes => isWave(bytes) ? bytes : undefined).catch(() => undefined));
    }
  }
  function stop() { playback?.abort(); }
  return {
    preload, stop,
    replay(text: string, unavailable: () => void, slow = false) {
      preload(text, slow);
      stop();
      const current = new AbortController();
      playback = current;
      void cache.get(JSON.stringify([text, slow]))?.then(audio => {
        if (current.signal.aborted || lifetime.signal.aborted) return;
        if (!audio) { unavailable(); return; }
        stopped = stopped.then(async () => {
          if (current.signal.aborted || lifetime.signal.aborted) return;
          try { await play(audio, current.signal); }
          catch { if (!current.signal.aborted) unavailable(); }
        });
      });
    },
    async close() { lifetime.abort(); stop(); cache.clear(); await stopped; },
  };
}
