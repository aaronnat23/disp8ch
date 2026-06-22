import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import { getUserFromSessionId, SESSION_COOKIE_NAME } from "@/lib/security/session";

const SESSION_EXPIRY_DAYS = 7;

export type UserProfile = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

export async function createSession(user: UserProfile) {
  const db = getDb();
  const sessionId = nanoid(32);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_EXPIRY_DAYS * 24 * 60 * 60;

  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  cookies().set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt * 1000),
  });

  return sessionId;
}

export async function getSession(): Promise<UserProfile | null> {
  const sessionId = cookies().get(SESSION_COOKIE_NAME)?.value;
  return getUserFromSessionId(sessionId);
}

export async function deleteSession() {
  const db = getDb();
  const sessionId = cookies().get(SESSION_COOKIE_NAME)?.value;
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  cookies().delete(SESSION_COOKIE_NAME);
}

export async function upsertGoogleUser(googleUser: {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}) {
  const db = getDb();

  const existingByGoogle = await db.select().from(users).where(eq(users.googleId, googleUser.id)).limit(1);
  if (existingByGoogle[0]) {
    const existing = existingByGoogle[0];
    await db
      .update(users)
      .set({
        name: googleUser.name || existing.name,
        image: googleUser.picture || existing.image,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, existing.id));
    return {
      id: existing.id,
      email: existing.email,
      name: googleUser.name || existing.name || null,
      image: googleUser.picture || existing.image || null,
    } satisfies UserProfile;
  }

  const existingByEmail = await db.select().from(users).where(eq(users.email, googleUser.email)).limit(1);
  if (existingByEmail[0]) {
    const existing = existingByEmail[0];
    await db
      .update(users)
      .set({
        googleId: googleUser.id,
        name: googleUser.name || existing.name,
        image: googleUser.picture || existing.image,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, existing.id));
    return {
      id: existing.id,
      email: existing.email,
      name: googleUser.name || existing.name || null,
      image: googleUser.picture || existing.image || null,
    } satisfies UserProfile;
  }

  const createdUser = {
    id: nanoid(),
    email: googleUser.email,
    name: googleUser.name || null,
    image: googleUser.picture || null,
    googleId: googleUser.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.insert(users).values(createdUser);

  return {
    id: createdUser.id,
    email: createdUser.email,
    name: createdUser.name,
    image: createdUser.image,
  } satisfies UserProfile;
}
