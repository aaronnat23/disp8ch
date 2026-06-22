import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";

export const SESSION_COOKIE_NAME = "disp8ch_session";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

export function extractSessionIdFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const chunk of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = chunk.trim().split("=");
    if (rawName !== SESSION_COOKIE_NAME) continue;
    const value = rawValue.join("=").trim();
    return value || null;
  }
  return null;
}

export async function getUserFromSessionId(sessionId: string | null | undefined): Promise<SessionUser | null> {
  if (!sessionId) return null;
  const db = getDb();
  const activeSession = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        gt(sessions.expiresAt, Math.floor(Date.now() / 1000)),
      ),
    )
    .limit(1);

  if (!activeSession[0]) {
    return null;
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, activeSession[0].userId))
    .limit(1);
  const user = userRows[0];
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    image: user.image ?? null,
  };
}

export async function getUserFromCookieHeader(cookieHeader: string | null | undefined): Promise<SessionUser | null> {
  return getUserFromSessionId(extractSessionIdFromCookieHeader(cookieHeader));
}

export async function getUserFromRequest(request: Request): Promise<SessionUser | null> {
  return getUserFromCookieHeader(request.headers.get("cookie"));
}
