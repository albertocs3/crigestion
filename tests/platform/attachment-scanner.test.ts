import { describe, expect, it } from "vitest";
import { clamdScanArguments } from "@/modules/platform/infrastructure/attachmentScanner";

describe("ClamAV attachment scanner", () => {
  it("streams files so scanning works inside the systemd mount namespace", () => {
    const argumentsList = clamdScanArguments("/private/.quarantine/logo.png");

    expect(argumentsList).toEqual([
      "--stream",
      "--no-summary",
      "--infected",
      "--",
      "/private/.quarantine/logo.png"
    ]);
    expect(argumentsList).not.toContain("--fdpass");
  });
});
