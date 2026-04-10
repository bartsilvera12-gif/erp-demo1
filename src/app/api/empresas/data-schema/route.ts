import { NextResponse } from "next/server";
import { resolveApiAuthContext } from "@/lib/middleware/api-auth-context";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";

export const dynamic = "force-dynamic";

const DIAG = process.env.NEURA_DIAG_AUTH === "1";

/**
 * GET /api/empresas/data-schema
 * Devuelve el schema PostgREST donde viven las tablas de negocio de la empresa autenticada.
 * Auth: anon + JWT (cookies o Authorization Bearer). Lectura empresas.data_schema vía RLS (sin service role).
 */
export async function GET(request: Request) {
  if (DIAG) {
    const hasAuth = !!request.headers.get("authorization")?.toLowerCase().startsWith("bearer ");
    console.warn(
      "[neura:diag:data-schema]",
      JSON.stringify({ hasAuthorizationBearer: hasAuth, path: "/api/empresas/data-schema" })
    );
  }

  const r = await resolveApiAuthContext(request, { forDataSchemaEndpoint: true });
  if (!r.ok) {
    const body: Record<string, unknown> = { error: "No autorizado", code: r.code };
    if (DIAG && r.detail) body.detail = r.detail;
    const headers = DIAG ? { "x-neura-auth-fail": r.code } : undefined;
    return NextResponse.json(body, { status: 401, headers });
  }

  if (r.ctx.empresa_id === null) {
    if (DIAG) console.warn("[neura:diag:data-schema]", JSON.stringify({ branch: "super_admin_sin_empresa" }));
    return NextResponse.json({ schema: SUPABASE_APP_SCHEMA });
  }

  const { data: erows, error: eErr } = await r.ctx.userScopedSupabase
    .from("empresas")
    .select("data_schema")
    .eq("id", r.ctx.empresa_id)
    .limit(1);

  if (eErr) {
    if (DIAG) console.warn("[neura:diag:data-schema]", JSON.stringify({ empresasErr: eErr.message }));
    return NextResponse.json(
      { error: "No se pudo leer configuración de empresa", code: "empresas_fetch_error" },
      { status: 502 }
    );
  }

  const raw = (erows?.[0] as { data_schema?: string | null } | undefined)?.data_schema;
  const schema =
    typeof raw === "string" && raw.trim() ? raw.trim() : SUPABASE_APP_SCHEMA;

  if (DIAG) {
    console.warn("[neura:diag:data-schema]", JSON.stringify({ schema, empresaHint: r.ctx.empresa_id.slice(0, 8) + "…" }));
  }

  return NextResponse.json({ schema });
}
