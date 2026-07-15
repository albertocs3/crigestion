import "server-only";

import { createHash } from "node:crypto";
import forge from "node-forge";

export type VerifactuCertificateMetadata = {
  validFrom: Date;
  validUntil: Date;
  certificateSha256: string;
};

export function readVerifactuCertificateMetadata(
  pfx: Uint8Array,
  passphrase: string
): VerifactuCertificateMetadata {
  if (pfx.byteLength < 1 || pfx.byteLength > 512 * 1024 || passphrase.length > 4096) {
    throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
  }
  try {
    const der = forge.util.createBuffer(Buffer.from(pfx).toString("binary"), "raw");
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, passphrase);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
    const keyBags = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])
    ];
    const keyIds = new Set(keyBags.flatMap((bag) => bag.attributes.localKeyId ?? []).map((value) => Buffer.from(value, "binary").toString("hex")));
    const leafBags = certBags.filter((bag) => {
      const constraints = bag.cert?.getExtension("basicConstraints") as { cA?: boolean } | null | undefined;
      return constraints?.cA !== true;
    });
    const matched = leafBags.find((bag) => (bag.attributes.localKeyId ?? []).some((value: string) => keyIds.has(Buffer.from(value, "binary").toString("hex"))));
    const leaf = matched?.cert ?? (leafBags.length === 1 && keyBags.length === 1 ? leafBags[0]?.cert : undefined);
    if (!leaf || !(leaf.validity.notBefore instanceof Date) || !(leaf.validity.notAfter instanceof Date) || leaf.validity.notBefore >= leaf.validity.notAfter) {
      throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
    }
    const certificateDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(leaf)).getBytes(), "binary");
    try {
      return {
        validFrom: new Date(leaf.validity.notBefore.getTime()),
        validUntil: new Date(leaf.validity.notAfter.getTime()),
        certificateSha256: createHash("sha256").update(certificateDer).digest("hex")
      };
    } finally {
      certificateDer.fill(0);
    }
  } catch {
    throw new Error("VERIFACTU_CREDENTIAL_MATERIAL_INVALID");
  }
}
