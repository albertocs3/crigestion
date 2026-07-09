import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const apiDirectory = join(process.cwd(), "app", "api");
const publicMutationRoutes = new Set([
  normalizePath(join("app", "api", "auth", "login", "route.ts")),
  normalizePath(join("app", "api", "platform", "installation", "initialize", "route.ts"))
]);
const mutationHandlerPattern = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/;

describe("API security route contracts", () => {
  it("requires origin and CSRF validation for mutating route handlers", () => {
    const mutatingRoutes = routeFiles(apiDirectory).filter((filePath) =>
      mutationHandlerPattern.test(readFileSync(filePath, "utf8"))
    );

    expect(mutatingRoutes.length).toBeGreaterThan(0);

    const routesMissingOriginValidation = mutatingRoutes.filter((filePath) => {
      const source = readFileSync(filePath, "utf8");

      return !source.includes("isAllowedOrigin(request)");
    });
    const authenticatedRoutesMissingCsrfValidation = mutatingRoutes.filter((filePath) => {
      const routePath = normalizePath(relative(process.cwd(), filePath));
      const source = readFileSync(filePath, "utf8");

      return !publicMutationRoutes.has(routePath) && !source.includes("validateCsrfToken(");
    });

    expect(routesMissingOriginValidation.map(toProjectPath)).toEqual([]);
    expect(authenticatedRoutesMissingCsrfValidation.map(toProjectPath)).toEqual([]);
  });
});

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = join(directory, entry);
    const stats = statSync(filePath);

    if (stats.isDirectory()) {
      return routeFiles(filePath);
    }

    return entry === "route.ts" ? [filePath] : [];
  });
}

function toProjectPath(filePath: string): string {
  return normalizePath(relative(process.cwd(), filePath));
}

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}
