#!/usr/bin/env python3
"""Safely extract and validate an authenticated CriGestion recovery payload."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
from datetime import datetime

MAX_OUTER_ENTRIES = 200_000
MAX_OUTER_BYTES = 8 * 1024 * 1024 * 1024
MAX_INNER_ENTRIES = 50_000
MAX_INNER_BYTES = 2 * 1024 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_INVENTORY_BYTES = 64 * 1024 * 1024
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
ATTACHMENT_PATTERN = re.compile(
    rf"^company-logo/{UUID_PATTERN}/{UUID_PATTERN}\.(?:png|jpg)$"
)


class RecoveryPayloadError(Exception):
    pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("payload_directory")
    parser.add_argument("attachment_directory")
    parser.add_argument("--authenticated-header")
    arguments = parser.parse_args()

    archive = Path(arguments.archive).resolve(strict=True)
    payload_directory = Path(arguments.payload_directory).resolve()
    attachment_directory = Path(arguments.attachment_directory).resolve()
    ensure_empty_destination(payload_directory)
    ensure_empty_destination(attachment_directory)

    extract_safe_archive(
        archive, payload_directory, "r:gz", MAX_OUTER_ENTRIES, MAX_OUTER_BYTES,
        MAX_OUTER_BYTES
    )
    manifest = validate_payload(payload_directory, arguments.authenticated_header)
    attachment_archive = payload_directory / "uploads" / "attachments.tar"
    attachment_entries = extract_safe_archive(
        attachment_archive, attachment_directory, "r:", MAX_INNER_ENTRIES,
        MAX_INNER_BYTES, MAX_ATTACHMENT_BYTES
    )
    regular_attachments = [name for name, kind in attachment_entries if kind == "file"]
    expected_entries = manifest["uploads"]["entries"]
    if len(regular_attachments) != expected_entries:
        raise RecoveryPayloadError("RECOVERY_UPLOAD_ENTRY_COUNT_MISMATCH")
    for name in regular_attachments:
        if not ATTACHMENT_PATTERN.fullmatch(name):
            raise RecoveryPayloadError("RECOVERY_UPLOAD_PATH_INVALID")

    print(
        "RECOVERY_PAYLOAD_OK "
        f"uploads={len(regular_attachments)} "
        f"referenced={manifest['uploads']['referencedEntries']}"
    )


def ensure_empty_destination(destination: Path) -> None:
    if destination.exists():
        raise RecoveryPayloadError("RECOVERY_EXTRACTION_DESTINATION_EXISTS")
    destination.mkdir(mode=0o700, parents=False)


def extract_safe_archive(
    archive: Path, destination: Path, mode: str, max_entries: int,
    max_total_bytes: int, max_file_bytes: int
) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()
    members_by_name: dict[str, tarfile.TarInfo] = {}
    total_bytes = 0

    try:
        with tarfile.open(archive, mode) as source:
            members = source.getmembers()
            if len(members) > max_entries:
                raise RecoveryPayloadError("RECOVERY_ARCHIVE_ENTRY_LIMIT_EXCEEDED")

            for member in members:
                name = normalize_member_name(member.name)
                if not name:
                    if not member.isdir():
                        raise RecoveryPayloadError("RECOVERY_ARCHIVE_ROOT_ENTRY_INVALID")
                    continue
                if name in seen:
                    raise RecoveryPayloadError("RECOVERY_ARCHIVE_DUPLICATE_ENTRY")
                seen.add(name)

                if member.isdir():
                    entries.append((name, "directory"))
                    members_by_name[name] = member
                    continue
                if not member.isreg():
                    raise RecoveryPayloadError("RECOVERY_ARCHIVE_SPECIAL_ENTRY_REJECTED")
                if member.size < 0:
                    raise RecoveryPayloadError("RECOVERY_ARCHIVE_SIZE_INVALID")
                if member.size > max_file_bytes:
                    raise RecoveryPayloadError("RECOVERY_ARCHIVE_FILE_SIZE_LIMIT_EXCEEDED")
                total_bytes += member.size
                if total_bytes > max_total_bytes:
                    raise RecoveryPayloadError("RECOVERY_ARCHIVE_SIZE_LIMIT_EXCEEDED")
                entries.append((name, "file"))
                members_by_name[name] = member

            for name, kind in sorted(entries, key=lambda item: (item[0].count("/"), item[0])):
                target = safe_target(destination, name)
                if kind == "directory":
                    target.mkdir(mode=0o700, parents=False, exist_ok=False)
                    continue

                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                member = members_by_name[name]
                stream = source.extractfile(member)
                if stream is None:
                    raise RecoveryPayloadError("RECOVERY_ARCHIVE_FILE_UNREADABLE")
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(target, flags, 0o600)
                try:
                    with os.fdopen(descriptor, "wb", closefd=False) as output:
                        shutil.copyfileobj(stream, output, length=1024 * 1024)
                        output.flush()
                        os.fsync(output.fileno())
                    if target.stat().st_size != member.size:
                        raise RecoveryPayloadError("RECOVERY_ARCHIVE_FILE_SIZE_MISMATCH")
                finally:
                    os.close(descriptor)
                    stream.close()
    except (tarfile.TarError, OSError, KeyError) as error:
        if isinstance(error, RecoveryPayloadError):
            raise
        raise RecoveryPayloadError("RECOVERY_ARCHIVE_INVALID") from error

    return entries


def normalize_member_name(value: str) -> str:
    if not value or "\\" in value or any(ord(character) < 32 for character in value):
        raise RecoveryPayloadError("RECOVERY_ARCHIVE_PATH_INVALID")
    while value.startswith("./"):
        value = value[2:]
    if value in ("", "."):
        return ""
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise RecoveryPayloadError("RECOVERY_ARCHIVE_PATH_INVALID")
    return path.as_posix()


def safe_target(destination: Path, name: str) -> Path:
    target = (destination / Path(*PurePosixPath(name).parts)).resolve()
    if destination not in target.parents:
        raise RecoveryPayloadError("RECOVERY_ARCHIVE_PATH_INVALID")
    return target


def validate_payload(payload: Path, authenticated_header_path: str | None) -> dict:
    inventory_path = payload / "inventory.sha256"
    manifest_path = payload / "manifest.json"
    if not inventory_path.is_file() or not manifest_path.is_file():
        raise RecoveryPayloadError("RECOVERY_PAYLOAD_REQUIRED_FILE_MISSING")

    if inventory_path.stat().st_size > MAX_INVENTORY_BYTES:
        raise RecoveryPayloadError("RECOVERY_INVENTORY_TOO_LARGE")
    if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
        raise RecoveryPayloadError("RECOVERY_MANIFEST_TOO_LARGE")

    expected_files: dict[str, str] = {}
    for line in inventory_path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match:
            raise RecoveryPayloadError("RECOVERY_INVENTORY_INVALID")
        name = normalize_member_name(match.group(2))
        if not name or name in expected_files or name == "inventory.sha256":
            raise RecoveryPayloadError("RECOVERY_INVENTORY_INVALID")
        expected_files[name] = match.group(1)

    actual_files = {
        path.relative_to(payload).as_posix()
        for path in payload.rglob("*")
        if path.is_file() and path.name != "inventory.sha256"
    }
    if actual_files != set(expected_files):
        raise RecoveryPayloadError("RECOVERY_INVENTORY_FILE_SET_MISMATCH")
    for name, expected_hash in expected_files.items():
        if sha256_file(payload / name) != expected_hash:
            raise RecoveryPayloadError("RECOVERY_INVENTORY_HASH_MISMATCH")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_manifest(manifest)
    if authenticated_header_path is not None:
        header_path = Path(authenticated_header_path).resolve(strict=True)
        if header_path.stat().st_size > MAX_MANIFEST_BYTES:
            raise RecoveryPayloadError("RECOVERY_HEADER_TOO_LARGE")
        header = json.loads(header_path.read_text(encoding="utf-8"))
        if (
            not isinstance(header, dict)
            or header.get("bundleId") != manifest["bundleId"]
            or header.get("environment") != manifest["environment"]
            or header.get("productVersion") != manifest["productVersion"]
        ):
            raise RecoveryPayloadError("RECOVERY_HEADER_MANIFEST_MISMATCH")
    database_dump = payload / "database" / "crigestion_staging.dump"
    if sha256_file(database_dump) != manifest["sourceDumpSha256"]:
        raise RecoveryPayloadError("RECOVERY_DATABASE_HASH_MISMATCH")
    attachment_archive = payload / "uploads" / "attachments.tar"
    if sha256_file(attachment_archive) != manifest["uploads"]["archiveSha256"]:
        raise RecoveryPayloadError("RECOVERY_UPLOAD_ARCHIVE_HASH_MISMATCH")
    if sha256_file(payload / "release" / "application-release.tar") != manifest["releaseArchiveSha256"]:
        raise RecoveryPayloadError("RECOVERY_RELEASE_ARCHIVE_HASH_MISMATCH")
    if sha256_file(payload / "release" / "package-lock.json") != manifest["packageLockSha256"]:
        raise RecoveryPayloadError("RECOVERY_PACKAGE_LOCK_HASH_MISMATCH")
    return manifest


def validate_manifest(manifest: object) -> None:
    if not isinstance(manifest, dict):
        raise RecoveryPayloadError("RECOVERY_MANIFEST_INVALID")
    required = {
        "format", "bundleId", "createdAt", "environment", "database",
        "sourceDump", "sourceDumpSha256", "releaseId", "commitSha", "buildId",
        "productVersion",
        "releaseArchiveSha256", "packageLockSha256", "migrationsSha256", "uploads",
        "keyCustody", "verifactuEnvironment"
    }
    if set(manifest) != required:
        raise RecoveryPayloadError("RECOVERY_MANIFEST_INVALID")
    if (
        manifest["format"] != "CRIGESTION-RECOVERY-BUNDLE-v1"
        or manifest["environment"] != "staging"
        or manifest["database"] != "crigestion_staging"
        or not SHA256_PATTERN.fullmatch(str(manifest["sourceDumpSha256"]))
        or not re.fullmatch(r"staging-[0-9]{8}T[0-9]{6}Z", str(manifest["bundleId"]))
        or not re.fullmatch(r"crigestion_staging-auto-[0-9]{8}T[0-9]{6}Z\.dump", str(manifest["sourceDump"]))
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,79}", str(manifest["releaseId"]))
        or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", str(manifest["commitSha"]))
        or not re.fullmatch(r"[A-Za-z0-9_-]{10,80}", str(manifest["buildId"]))
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,119}", str(manifest["productVersion"]))
        or not all(SHA256_PATTERN.fullmatch(str(manifest[key])) for key in (
            "releaseArchiveSha256", "packageLockSha256", "migrationsSha256"
        ))
        or manifest["keyCustody"] != "external_systemd_credential"
        or manifest["verifactuEnvironment"] != "TEST"
    ):
        raise RecoveryPayloadError("RECOVERY_MANIFEST_INVALID")
    try:
        created_at = datetime.fromisoformat(str(manifest["createdAt"]).replace("Z", "+00:00"))
    except ValueError as error:
        raise RecoveryPayloadError("RECOVERY_MANIFEST_INVALID") from error
    if created_at.tzinfo is None:
        raise RecoveryPayloadError("RECOVERY_MANIFEST_INVALID")
    uploads = manifest.get("uploads")
    upload_keys = {
        "status", "entries", "referencedEntries", "unreferencedEntries",
        "archive", "archiveSha256", "quarantineIncluded"
    }
    if (
        not isinstance(uploads, dict)
        or set(uploads) != upload_keys
        or uploads["status"] != "included"
        or uploads["archive"] != "uploads/attachments.tar"
        or uploads["quarantineIncluded"] is not False
        or not all(type(uploads[key]) is int and uploads[key] >= 0 for key in (
            "entries", "referencedEntries", "unreferencedEntries"
        ))
        or uploads["entries"] != uploads["referencedEntries"] + uploads["unreferencedEntries"]
        or not SHA256_PATTERN.fullmatch(str(uploads["archiveSha256"]))
    ):
        raise RecoveryPayloadError("RECOVERY_MANIFEST_UPLOADS_INVALID")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    try:
        main()
    except (RecoveryPayloadError, json.JSONDecodeError, UnicodeError, OSError) as error:
        code = str(error) if isinstance(error, RecoveryPayloadError) else "RECOVERY_PAYLOAD_INVALID"
        print(code, file=__import__("sys").stderr)
        raise SystemExit(1)
