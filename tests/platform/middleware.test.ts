import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

describe("request correlation middleware", () => {
  it("preserves an incoming correlation id", () => {
    const request = new NextRequest("http://localhost/app", {
      headers: {
        "X-Correlation-ID": "test-correlation-001"
      }
    });

    const response = middleware(request);

    expect(response.headers.get("X-Correlation-ID")).toBe("test-correlation-001");
  });

  it("creates a correlation id when the request does not provide one", () => {
    const request = new NextRequest("http://localhost/app");
    const response = middleware(request);

    expect(response.headers.get("X-Correlation-ID")).toEqual(expect.any(String));
  });
});
