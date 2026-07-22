import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const apiDirectory = join(process.cwd(), "app", "api");
const publicMutationRoutes = new Set([
  normalizePath(join("app", "api", "auth", "login", "route.ts")),
  normalizePath(join("app", "api", "platform", "installation", "initialize", "route.ts"))
]);
const mutationHandlerPattern = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/;
const sharedCustomerCreditGuard = "authorizeCustomerCreditMutation(request";
const sharedCustomerCreditRefundAction = "runCustomerCreditRefundAction(request";
const sharedPurchaseGuard = "authorizePurchaseMutation(request";

describe("API security route contracts", () => {
  it("requires origin and CSRF validation for mutating route handlers", () => {
    const mutatingRoutes = routeFiles(apiDirectory).filter((filePath) =>
      mutationHandlerPattern.test(readFileSync(filePath, "utf8"))
    );

    expect(mutatingRoutes.length).toBeGreaterThan(0);

    const routesMissingOriginValidation = mutatingRoutes.filter((filePath) => {
      const source = readFileSync(filePath, "utf8");

      return !source.includes("isAllowedOrigin(request)")
        && !source.includes(sharedCustomerCreditGuard)
        && !source.includes(sharedCustomerCreditRefundAction)
        && !source.includes(sharedPurchaseGuard);
    });
    const authenticatedRoutesMissingCsrfValidation = mutatingRoutes.filter((filePath) => {
      const routePath = normalizePath(relative(process.cwd(), filePath));
      const source = readFileSync(filePath, "utf8");

      return !publicMutationRoutes.has(routePath)
        && !source.includes("validateCsrfToken(")
        && !source.includes(sharedCustomerCreditGuard)
        && !source.includes(sharedCustomerCreditRefundAction)
        && !source.includes(sharedPurchaseGuard);
    });

    expect(routesMissingOriginValidation.map(toProjectPath)).toEqual([]);
    expect(authenticatedRoutesMissingCsrfValidation.map(toProjectPath)).toEqual([]);

    const customerCreditGuardSource = readFileSync(
      join(process.cwd(), "app", "api", "treasury", "_customer-credit-http.ts"),
      "utf8"
    );
    expect(customerCreditGuardSource).toContain("isAllowedOrigin(request)");
    expect(customerCreditGuardSource).toContain("validateCsrfToken(");
    const refundActionSource = readFileSync(
      join(process.cwd(), "app", "api", "treasury", "_customer-credit-refund-action.ts"),
      "utf8"
    );
    expect(refundActionSource).toContain(sharedCustomerCreditGuard);
    const purchaseGuardSource = readFileSync(
      join(process.cwd(), "app", "api", "purchases", "_http.ts"),
      "utf8"
    );
    expect(purchaseGuardSource).toContain("isAllowedOrigin(request)");
    expect(purchaseGuardSource).toContain("validateCsrfToken(");
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
