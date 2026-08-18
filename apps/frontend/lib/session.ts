import { SignJWT } from "jose";
import { cookies } from "next/headers";
import { encodeKey, verifySessionToken, type Session } from "./sessionToken";

export type { Session, SessionUser } from "./sessionToken";
export { verifySessionToken } from "./sessionToken";

const isProduction = process.env.NODE_ENV === "production";

export async function createSession(payload: Session) {
    const session = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime("7d").sign(encodeKey);

    const expiredAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    (await cookies()).set("session", session, {
        httpOnly: true,
        secure: isProduction,
        expires: expiredAt,
        sameSite: "lax",
        path: "/",
    });
}

export async function getSession(): Promise<Session | null> {
    const cookie = (await cookies()).get("session")?.value;
    return verifySessionToken(cookie);
}

export async function deleteSession() {
    await (await cookies()).delete("session");
}
