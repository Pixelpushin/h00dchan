import { NextRequest, NextResponse } from "next/server";

// QA-only gate - this file only exists on the `qa` branch (never merged to
// main), so production is never affected. Requires QA_BASIC_AUTH_USER/
// QA_BASIC_AUTH_PASSWORD to be set; if either is missing, the site is left
// open rather than locking everyone out on a misconfigured deploy.
export function middleware(req: NextRequest) {
  const user = process.env.QA_BASIC_AUTH_USER;
  const password = process.env.QA_BASIC_AUTH_PASSWORD;
  if (!user || !password) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const [reqUser, reqPassword] = atob(encoded).split(":");
      if (reqUser === user && reqPassword === password) {
        return NextResponse.next();
      }
    }
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="h00dchan QA"' },
  });
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
