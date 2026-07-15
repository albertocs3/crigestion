import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const allowedHosts = new Set([
  "sede.agenciatributaria.gob.es",
  "www.agenciatributaria.es",
  "prewww2.aeat.es"
  ,"www.w3.org"
]);

const xsdFileNames = new Map([
  ["supply-xsd", "SuministroLR.xsd"],
  ["supply-response-xsd", "RespuestaSuministro.xsd"],
  ["query-xsd", "ConsultaLR.xsd"],
  ["query-response-xsd", "RespuestaConsultaLR.xsd"],
  ["common-types-xsd", "SuministroInformacion.xsd"],
  ["xmldsig-core-xsd", "xmldsig-core-schema.xsd"]
]);

const artifactSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && allowedHosts.has(url.hostname);
  }, "La URL debe usar HTTPS y pertenecer a un host oficial AEAT permitido."),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  lastModified: z.string().min(1)
});

const manifestSchema = z.object({
  manifestVersion: z.literal("AEAT_VERIFACTU_ARTIFACTS_V1"),
  retrievedAt: z.string().datetime({ offset: true }),
  sourceIndex: z.string().url(),
  sourceIndexUpdatedAt: z.string().date(),
  artifacts: z.array(artifactSchema).min(1)
}).superRefine((manifest, context) => {
  const ids = manifest.artifacts.map((artifact) => artifact.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: "Los IDs deben ser unicos." });
  }
});

async function main(): Promise<void> {
  const manifestPath = resolve("docs/facturacion/verifactu/aeat-artifacts.v1.json");
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = manifestSchema.parse(parsed);
  const materializeArgument = process.argv.find((argument) => argument.startsWith("--materialize-xsd="));
  const materializeDirectory = materializeArgument
    ? resolve(materializeArgument.slice("--materialize-xsd=".length))
    : null;
  if (materializeDirectory) await mkdir(materializeDirectory, { recursive: true });

  const artifactsToVerify = materializeDirectory
    ? manifest.artifacts.filter((artifact) => xsdFileNames.has(artifact.id))
    : manifest.artifacts;
  for (const artifact of artifactsToVerify) {
    const bytes = await downloadWithSystemTrust(artifact.url);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.bytes) {
      throw new Error(`${artifact.id}: tamano esperado ${artifact.bytes}, recibido ${bytes.byteLength}`);
    }
    if (sha256 !== artifact.sha256) {
      throw new Error(`${artifact.id}: SHA-256 esperado ${artifact.sha256}, recibido ${sha256}`);
    }
    const xsdFileName = xsdFileNames.get(artifact.id);
    if (materializeDirectory && xsdFileName) {
      await writeFile(resolve(materializeDirectory, xsdFileName), bytes, { flag: "w" });
    }
    process.stdout.write(`OK ${artifact.id} ${artifact.version} ${sha256}\n`);
  }
  if (materializeDirectory) {
    const missing = [...xsdFileNames.values()].filter((fileName) =>
      !manifest.artifacts.some((artifact) => xsdFileNames.get(artifact.id) === fileName)
    );
    if (missing.length > 0) throw new Error(`Faltan XSD requeridos: ${missing.join(", ")}`);
    process.stdout.write(`XSD materializados en ${materializeDirectory}\n`);
  }
}

async function downloadWithSystemTrust(url: string): Promise<Uint8Array> {
  return new Promise((resolveDownload, rejectDownload) => {
    const process = spawn("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--proto", "=https",
      "--max-redirs", "0",
      "--connect-timeout", "10",
      "--max-time", "60",
      url
    ], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    process.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        process.kill();
        rejectDownload(new Error("El artefacto supera el limite de 10 MiB."));
        return;
      }
      chunks.push(chunk);
    });
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", rejectDownload);
    process.on("close", (code) => {
      if (code !== 0) {
        rejectDownload(new Error(`curl finalizo con codigo ${code}: ${Buffer.concat(errors).toString("utf8").trim()}`));
        return;
      }
      resolveDownload(Buffer.concat(chunks));
    });
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Error desconocido";
  process.stderr.write(`Verificacion VeriFactu fallida: ${message}\n`);
  process.exitCode = 1;
});
