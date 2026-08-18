import { jwtVerify } from "jose";

export type SessionUser = {
    id?: string;
    name?: string;
    avatar?: string;
    bio?: string;
};

export type Session = {
    user: SessionUser;
    accessToken: string;
};

const secretKey = process.env.SESSION_SECRET_KEY!;
export const encodeKey = new TextEncoder().encode(secretKey);

/**
 * Verify a raw session JWT. Returns null when the token is missing, malformed or expired.
 *
 * Lives in its own module (no `next/headers` import) so middleware can use it on the Edge
 * runtime, and takes the token as an argument instead of reading the cookie store itself.
 * It must never call `redirect()` from `next/navigation` — that only works in Server
 * Components/Actions, while this also runs in middleware.
 */
export async function verifySessionToken(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, encodeKey, {
            algorithms: ['HS256']
        });
        return payload as unknown as Session;
    } catch (error) {
        console.error("Failed to verify session token:", error);
        return null;
    }
}
