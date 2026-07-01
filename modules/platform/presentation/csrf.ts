export async function fetchCsrfToken(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error("CSRF_TOKEN_UNAVAILABLE");
  }

  const body = (await response.json()) as { csrfToken: string };
  return body.csrfToken;
}
