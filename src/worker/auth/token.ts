// Token extraction: the Cf-Access-Jwt-Assertion header always; the CF_Authorization cookie only in local mode
// (set by /dev/login to emulate the browser cookie Access sets). Production ignores cookies, as the Access docs
// recommend validating the header.
import { getCookie } from "hono/cookie";
import type { Context } from "hono";

export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
export const ACCESS_COOKIE = "CF_Authorization";

export function extractToken(c: Context, authMode: "access" | "local-jwks"): string | null {
  const header = c.req.header(ACCESS_HEADER);
  if (header) return header.trim();
  if (authMode === "local-jwks") {
    const cookie = getCookie(c, ACCESS_COOKIE);
    if (cookie) return cookie;
  }
  return null;
}
