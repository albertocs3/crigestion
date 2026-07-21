import "server-only";

import { spawn } from "node:child_process";

export type AttachmentScanResult =
  | { outcome: "clean"; engine: string; version: string | null }
  | { outcome: "infected"; engine: string; version: string | null }
  | { outcome: "inconclusive"; engine: string; version: string | null };

export interface AttachmentScanner {
  scan(filePath: string): Promise<AttachmentScanResult>;
}

export class ClamdAttachmentScanner implements AttachmentScanner {
  constructor(
    private readonly executablePath: string,
    private readonly timeoutMilliseconds = 30_000
  ) {}

  async scan(filePath: string): Promise<AttachmentScanResult> {
    return new Promise((resolve) => {
      const child = spawn(
        this.executablePath,
        ["--fdpass", "--no-summary", "--infected", "--", filePath],
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let settled = false;
      let outputBytes = 0;

      const finish = (result: AttachmentScanResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const accountOutput = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 4096) {
          child.kill("SIGKILL");
          finish(inconclusive());
        }
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(inconclusive());
      }, this.timeoutMilliseconds);

      child.stdout.on("data", accountOutput);
      child.stderr.on("data", accountOutput);
      child.once("error", () => finish(inconclusive()));
      child.once("exit", (code, signal) => {
        if (signal || code === null) return finish(inconclusive());
        if (code === 0) return finish({ outcome: "clean", engine: "clamdscan", version: null });
        if (code === 1) return finish({ outcome: "infected", engine: "clamdscan", version: null });
        return finish(inconclusive());
      });
    });
  }
}

function inconclusive(): AttachmentScanResult {
  return { outcome: "inconclusive", engine: "clamdscan", version: null };
}
