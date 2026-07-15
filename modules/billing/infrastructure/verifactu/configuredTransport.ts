import "server-only";

import { createAeatVerifactuTransport } from "./aeatTransport";
import { createPrismaVerifactuCredentialSource } from "./credentialStore";
import { createVerifactuCredentialProvider } from "./credentialProvider";
import { readSecureEnvelopeKeyring } from "./secureEnvelope";

export function readConfiguredAeatVerifactuTransport(env: NodeJS.ProcessEnv = process.env) {
  const credentialCipher = readSecureEnvelopeKeyring(
    env.VERIFACTU_CREDENTIAL_ACTIVE_KEY_ID,
    env.VERIFACTU_CREDENTIAL_KEYS
  );
  const responseCipher = readSecureEnvelopeKeyring(
    env.VERIFACTU_RESPONSE_ACTIVE_KEY_ID,
    env.VERIFACTU_RESPONSE_KEYS
  );
  const credentialProvider = createVerifactuCredentialProvider({
    source: createPrismaVerifactuCredentialSource(credentialCipher)
  });
  return createAeatVerifactuTransport({ credentialProvider, responseCipher });
}
