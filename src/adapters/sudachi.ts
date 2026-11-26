import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Token } from "../core/generation.ts";

const python = fileURLToPath(new URL("../../.venv/Scripts/python.exe", import.meta.url));
const analyzer = fileURLToPath(new URL("./analyze.py", import.meta.url));

function isToken(value: unknown): value is Token {
  return Array.isArray(value) && (value.length === 6 || value.length === 7) &&
    value.slice(0, 3).every(field => typeof field === "string") && typeof value[3] === "boolean" &&
    Number.isSafeInteger(value[4]) && Number.isSafeInteger(value[5]) && value[4] >= 0 &&
    value[5] > value[4] && (value.length === 6 || typeof value[6] === "string");
}

export function analyze(lines: string[], signal?: AbortSignal): Promise<Token[][]> {
  const timeout = AbortSignal.timeout(10_000);
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [analyzer], {
      windowsHide: true, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
    proc.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
    proc.on("error", reject);
    proc.stdin.on("error", reject);
    proc.on("close", code => {
      try {
        if (code !== 0) throw new Error("Sudachi failed: " + stderr.trim().slice(0, 250));
        const result: unknown = JSON.parse(stdout);
        if (!Array.isArray(result) || result.length !== lines.length ||
            !result.every(row => Array.isArray(row) && row.every(isToken))) throw new Error("Invalid Sudachi result");
        resolve(result);
      } catch (error) { reject(error); }
    });
    proc.stdin.end(JSON.stringify(lines), "utf8");
  });
}
