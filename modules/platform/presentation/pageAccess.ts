import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getSessionState,
  requirePermission,
  sessionCookieName,
  type SessionState,
  type SessionUser
} from "@/modules/platform/application/auth";
import { getInstallationState } from "@/modules/platform/application/installation";

export async function requireInitializedPlatform(): Promise<void> {
  const installation = await getInstallationState();

  if (!installation.initialized) {
    redirect("/platform/installation");
  }
}

export async function requireAnonymousInitializedPage(): Promise<void> {
  const installation = await getInstallationState();

  if (!installation.initialized) {
    redirect("/platform/installation");
  }

  const session = await getCurrentSessionState();

  if (session.authenticated) {
    redirect("/app");
  }
}

export async function requireInstallationPageAccess(): Promise<void> {
  const installation = await getInstallationState();

  if (!installation.initialized) {
    return;
  }

  const session = await getCurrentSessionState();

  redirect(session.authenticated ? "/app" : "/login");
}

export async function requireAuthenticatedPage(): Promise<
  Extract<SessionState, { authenticated: true }>
> {
  await requireInitializedPlatform();

  const session = await getCurrentSessionState();

  if (!session.authenticated) {
    redirect("/login");
  }

  return session;
}

export async function authorizePagePermission(permission: string): Promise<
  | {
      ok: true;
      user: SessionUser;
      sessionId: string;
    }
  | {
      ok: false;
      message: string;
    }
> {
  await requireInitializedPlatform();

  const token = await getSessionToken();
  const authorization = await requirePermission(token, permission);

  if (!authorization.ok) {
    if (authorization.status === 401) {
      redirect("/login");
    }

    return {
      ok: false,
      message: authorization.error.message
    };
  }

  return authorization;
}

async function getCurrentSessionState(): Promise<SessionState> {
  return getSessionState(await getSessionToken());
}

async function getSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();

  return cookieStore.get(sessionCookieName)?.value;
}
