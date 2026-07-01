import "server-only";

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const iterations = 210_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");

  return `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  const [algorithm, iterationsText, saltText, hashText] = passwordHash.split("$");

  if (algorithm !== "pbkdf2_sha256") {
    return false;
  }

  const iterations = Number(iterationsText);

  if (!Number.isInteger(iterations) || iterations < 1) {
    return false;
  }

  const salt = Buffer.from(saltText, "base64");
  const storedHash = Buffer.from(hashText, "base64");
  const computedHash = pbkdf2Sync(password, salt, iterations, storedHash.length, "sha256");

  return (
    computedHash.length === storedHash.length &&
    timingSafeEqual(computedHash, storedHash)
  );
}

export function dummyPasswordHash(): string {
  return "pbkdf2_sha256$210000$MDAwMDAwMDAwMDAwMDAwMA==$rN4hzJfORrS8kQ9GcoyLFNrqbbJaes5nzZQuQoFt/RU=";
}
