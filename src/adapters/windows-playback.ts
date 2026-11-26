import { spawn } from "node:child_process";

// Pipe WAV bytes directly into the built-in Windows .NET player.
export function playWave(audio: Uint8Array, signal: AbortSignal): Promise<void> {
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
