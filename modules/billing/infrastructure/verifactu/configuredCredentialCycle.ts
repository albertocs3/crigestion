import "server-only";

import type { VerifactuCredentialCycleDependencies } from "../../application/verifactuCredentials";
import { createAeatVerifactuCredentialProbe } from "./credentialProbe";
import { readSecureEnvelopeKeyring } from "./secureEnvelope";

export function readConfiguredVerifactuCredentialCycle(
  env: NodeJS.ProcessEnv = process.env
): VerifactuCredentialCycleDependencies {
  return {
    credentialCipher: readSecureEnvelopeKeyring(
      env.VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID,
      env.VERIFACTU_CREDENTIAL_KEYS
    ),
    probe: createAeatVerifactuCredentialProbe()
  };
}
