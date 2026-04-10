import { NextResponse } from "next/server";

/**
 * GET /api/deploy-info
 * Identificador del build desplegado (Vercel inyecta VERCEL_GIT_COMMIT_SHA).
 * Sirve para comprobar que producción/preview tiene el mismo código que GitHub.
 */
export async function GET() {
  const sha =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_REF?.trim() ||
    null;
  return NextResponse.json({
    git_commit_sha: sha,
    vercel_env: process.env.VERCEL_ENV ?? null,
    /** Presencia en JSON confirma deploy con auth/data-schema vía RLS (sin service key obligatoria en ese flujo). */
    neura_auth_bundle: "api-auth-context-v2-rls",
  });
}
