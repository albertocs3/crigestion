import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { createSecureContext } from "node:tls";

export type VerifactuEnvironment = "TEST" | "PRODUCTION";

export type StoredVerifactuCredential = {
  credentialRef: string;
  versionId: string;
  version: string;
  status: "ACTIVE" | "DISABLED" | "REVOKED";
  testedAt: Date | null;
  validFrom: Date;
  validUntil: Date;
  allowedEnvironments: readonly VerifactuEnvironment[];
  endpointKind: "STANDARD" | "SEAL";
  pfx: Uint8Array;
  passphrase: string;
  testedPfxSha256: string;
  release(): void;
};

export type VerifactuCredentialSource = {
  load(credentialRef: string, companyId: string): Promise<StoredVerifactuCredential | null>;
};

export type VerifactuCredentialLease = {
  readonly credentialRef: string;
  readonly versionId: string;
  readonly version: string;
  readonly endpointKind: "STANDARD" | "SEAL";
  readonly pfx: Buffer;
  readonly passphrase: string;
  release(): void;
};

export type VerifactuCredentialProvider = {
  acquire(input: {
    credentialRef: string;
    companyId: string;
    environment: VerifactuEnvironment;
  }): Promise<VerifactuCredentialLease>;
};

export class VerifactuCredentialError extends Error {
  readonly code:
    | "VERIFACTU_CREDENTIAL_REF_INVALID"
    | "VERIFACTU_CREDENTIAL_UNAVAILABLE"
    | "VERIFACTU_CREDENTIAL_NOT_ACTIVE"
    | "VERIFACTU_CREDENTIAL_NOT_TESTED"
    | "VERIFACTU_CREDENTIAL_NOT_YET_VALID"
    | "VERIFACTU_CREDENTIAL_EXPIRED"
    | "VERIFACTU_CREDENTIAL_ENVIRONMENT_DENIED"
    | "VERIFACTU_CREDENTIAL_MATERIAL_INVALID";

  constructor(code: VerifactuCredentialError["code"]) {
    super(code);
    this.name = "VerifactuCredentialError";
    this.code = code;
  }
}

const credentialRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const maxPfxBytes = 512 * 1024;

export function createVerifactuCredentialProvider(options: {
  source: VerifactuCredentialSource;
  now?: () => Date;
}): VerifactuCredentialProvider {
  const now = options.now ?? (() => new Date());

  return {
    async acquire(input): Promise<VerifactuCredentialLease> {
      if (!credentialRefPattern.test(input.credentialRef)) {
        throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_REF_INVALID");
      }

      const stored = await options.source.load(input.credentialRef, input.companyId);
      if (!stored || stored.credentialRef !== input.credentialRef) {
        stored?.release();
        throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_UNAVAILABLE");
      }
      try {
        if (stored.status !== "ACTIVE") {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_NOT_ACTIVE");
        }
        const currentTime = now().getTime();
        const testedAt = stored.testedAt?.getTime() ?? Number.NaN;
        const validFrom = stored.validFrom.getTime();
        const validUntil = stored.validUntil.getTime();
        if (!Number.isFinite(currentTime) || !Number.isFinite(testedAt) || testedAt > currentTime) {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_NOT_TESTED");
        }
        if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validFrom >= validUntil) {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
        }
        if (validFrom > currentTime) {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_NOT_YET_VALID");
        }
        if (validUntil <= currentTime) {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_EXPIRED");
        }
        if (!stored.allowedEnvironments.includes(input.environment)) {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_ENVIRONMENT_DENIED");
        }
        if (stored.pfx.byteLength === 0 || stored.pfx.byteLength > maxPfxBytes) {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
        }
        const actualHash = createHash("sha256").update(stored.pfx).digest();
        const testedHash = Buffer.from(stored.testedPfxSha256, "hex");
        if (testedHash.byteLength !== actualHash.byteLength || !timingSafeEqual(actualHash, testedHash)) {
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_NOT_TESTED");
        }

        const pfx = Buffer.from(stored.pfx);
        try {
          createSecureContext({ pfx, passphrase: stored.passphrase, minVersion: "TLSv1.2" });
        } catch {
          pfx.fill(0);
          throw new VerifactuCredentialError("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
        }

        let released = false;
        return {
          credentialRef: stored.credentialRef,
          versionId: stored.versionId,
          version: stored.version,
          endpointKind: stored.endpointKind,
          pfx,
          passphrase: stored.passphrase,
          release(): void {
            if (released) return;
            released = true;
            pfx.fill(0);
          }
        };
      } finally {
        stored.release();
      }
    }
  };
}
