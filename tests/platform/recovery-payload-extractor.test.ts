import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const python = resolvePython();
const extractor = path.resolve("scripts/extract-recovery-bundle.py");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("recovery payload safe extractor", () => {
  it("extracts a valid payload and its allowlisted attachment archive", async () => {
    const root = await temporaryDirectory();
    const { archive, storageKey, attachmentBytes } = await createValidArchive(root);

    const result = runExtractor(root, archive);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RECOVERY_PAYLOAD_OK uploads=1 referenced=1");
    await expect(readFile(path.join(root, "attachments", ...storageKey.split("/"))))
      .resolves.toEqual(attachmentBytes);
  });

  it("rejects path traversal before writing outside the destination", async () => {
    const root = await temporaryDirectory();
    const archive = path.join(root, "traversal.tar.gz");
    createArchive(archive, "../escaped.txt", "file");

    const result = runExtractor(root, archive);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RECOVERY_ARCHIVE_PATH_INVALID");
    await expect(readFile(path.join(root, "escaped.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["symlink", "hardlink"] as const)("rejects a %s archive member", async (kind) => {
    const root = await temporaryDirectory();
    const archive = path.join(root, `${kind}.tar.gz`);
    createArchive(archive, "unsafe-link", kind);

    const result = runExtractor(root, archive);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RECOVERY_ARCHIVE_SPECIAL_ENTRY_REJECTED");
  });

  it("rejects duplicate normalized archive names", async () => {
    const root = await temporaryDirectory();
    const archive = path.join(root, "duplicate.tar.gz");
    const program = [
      "import io,sys,tarfile",
      "with tarfile.open(sys.argv[1], 'w:gz') as archive:",
      "  for name in ('file.txt', './file.txt'):",
      "    data=b'x'",
      "    info=tarfile.TarInfo(name)",
      "    info.size=len(data)",
      "    archive.addfile(info, io.BytesIO(data))"
    ].join("\n");
    const created = spawnSync(python, ["-c", program, archive], { encoding: "utf8" });
    expect(created.status).toBe(0);

    const result = runExtractor(root, archive);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RECOVERY_ARCHIVE_DUPLICATE_ENTRY");
  });

  it("rejects a manifest that does not match the authenticated header", async () => {
    const root = await temporaryDirectory();
    const { archive } = await createValidArchive(root);
    const header = path.join(root, "header.json");
    await writeFile(header, JSON.stringify({
      bundleId: "staging-20260721T170001Z",
      environment: "staging",
      productVersion: "0.1.0"
    }));

    const result = runExtractor(root, archive, header);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RECOVERY_HEADER_MANIFEST_MISMATCH");
  });
});

function createArchive(
  archive: string,
  name: string,
  kind: "file" | "symlink" | "hardlink"
): void {
  const program = [
    "import io,sys,tarfile",
    "archive_path,name,kind=sys.argv[1:]",
    "with tarfile.open(archive_path, 'w:gz') as archive:",
    "  info=tarfile.TarInfo(name)",
    "  if kind == 'file':",
    "    data=b'unsafe'",
    "    info.size=len(data)",
    "    archive.addfile(info, io.BytesIO(data))",
    "  else:",
    "    info.type=tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE",
    "    info.linkname='target'",
    "    archive.addfile(info)"
  ].join("\n");
  const result = spawnSync(python, ["-c", program, archive, name, kind], {
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr || "PYTHON_TAR_CREATION_FAILED");
}

function runExtractor(root: string, archive: string, header?: string) {
  const arguments_ = [
    extractor,
    archive,
    path.join(root, "payload"),
    path.join(root, "attachments")
  ];
  if (header) arguments_.push("--authenticated-header", header);
  return spawnSync(
    python,
    arguments_,
    { encoding: "utf8" }
  );
}

async function createValidArchive(root: string): Promise<{
  archive: string;
  storageKey: string;
  attachmentBytes: Buffer;
}> {
  const source = path.join(root, "source");
  const databaseDirectory = path.join(source, "database");
  const uploadsDirectory = path.join(source, "uploads");
  const releaseDirectory = path.join(source, "release");
  const attachmentSource = path.join(root, "logo.png");
  await mkdir(databaseDirectory, { recursive: true });
  await mkdir(uploadsDirectory, { recursive: true });
  await mkdir(releaseDirectory, { recursive: true });
  const databaseBytes = Buffer.from("test-database-dump");
  const attachmentBytes = Buffer.from("canonical-logo");
  const releaseBytes = Buffer.from("release-archive");
  const lockBytes = Buffer.from('{"lockfileVersion":3}');
  const storageKey = `company-logo/${randomUUID()}/${randomUUID()}.png`;
  await writeFile(path.join(databaseDirectory, "crigestion_staging.dump"), databaseBytes);
  await writeFile(attachmentSource, attachmentBytes);
  await writeFile(path.join(releaseDirectory, "application-release.tar"), releaseBytes);
  await writeFile(path.join(releaseDirectory, "package-lock.json"), lockBytes);

  const attachmentArchive = path.join(uploadsDirectory, "attachments.tar");
  const createAttachmentTar = [
    "import sys,tarfile",
    "archive_path,source_path,storage_key=sys.argv[1:]",
    "with tarfile.open(archive_path, 'w:') as archive:",
    "  archive.add(source_path, arcname=storage_key, recursive=False)"
  ].join("\n");
  const attachmentTarResult = spawnSync(
    python,
    ["-c", createAttachmentTar, attachmentArchive, attachmentSource, storageKey],
    { encoding: "utf8" }
  );
  expect(attachmentTarResult.status).toBe(0);

  const manifest = {
    format: "CRIGESTION-RECOVERY-BUNDLE-v1",
    bundleId: "staging-20260721T170000Z",
    createdAt: "2026-07-21T17:00:00Z",
    environment: "staging",
    database: "crigestion_staging",
    sourceDump: "crigestion_staging-auto-20260721T160000Z.dump",
    sourceDumpSha256: sha256(databaseBytes),
    releaseId: "staging-test",
    commitSha: "a".repeat(40),
    buildId: "test-build-id",
    productVersion: "0.1.0",
    releaseArchiveSha256: sha256(releaseBytes),
    packageLockSha256: sha256(lockBytes),
    migrationsSha256: "d".repeat(64),
    uploads: {
      status: "included",
      entries: 1,
      referencedEntries: 1,
      unreferencedEntries: 0,
      archive: "uploads/attachments.tar",
      archiveSha256: sha256(await readFile(attachmentArchive)),
      quarantineIncluded: false
    },
    keyCustody: "external_systemd_credential",
    verifactuEnvironment: "TEST"
  };
  await writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(source, "inventory.tsv"), "fixture\n");

  const inventoryFiles = [
    "database/crigestion_staging.dump",
    "inventory.tsv",
    "manifest.json",
    "release/application-release.tar",
    "release/package-lock.json",
    "uploads/attachments.tar"
  ];
  const inventoryLines = await Promise.all(inventoryFiles.map(async (name) =>
    `${sha256(await readFile(path.join(source, ...name.split("/"))))}  ./${name}`
  ));
  await writeFile(path.join(source, "inventory.sha256"), `${inventoryLines.join("\n")}\n`);

  const archive = path.join(root, "valid.tar.gz");
  const createOuterTar = [
    "import sys,tarfile",
    "archive_path,source_path=sys.argv[1:]",
    "with tarfile.open(archive_path, 'w:gz') as archive:",
    "  archive.add(source_path, arcname='.')"
  ].join("\n");
  const outerTarResult = spawnSync(python, ["-c", createOuterTar, archive, source], {
    encoding: "utf8"
  });
  expect(outerTarResult.status).toBe(0);
  return { archive, storageKey, attachmentBytes };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crigestion-recovery-payload-"));
  temporaryDirectories.push(directory);
  return directory;
}

function resolvePython(): string {
  for (const candidate of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  throw new Error("PYTHON_REQUIRED_FOR_RECOVERY_PAYLOAD_TESTS");
}
