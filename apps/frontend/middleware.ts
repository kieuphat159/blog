import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/sessionToken";

export async function middleware(request: NextRequest) {
    const token = request.cookies.get("session")?.value;
    const session = await verifySessionToken(token);

    if (!session || !session.user) {
        const response = NextResponse.redirect(new URL('/auth/signin', request.url));
        // Drop the stale/invalid cookie so the next request doesn't fail verification again.
        if (token) response.cookies.delete("session");
        return response;
    }
}

export const config = {
    matcher: "/user/:path*"
}
