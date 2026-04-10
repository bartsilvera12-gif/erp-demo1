import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { supabaseDbSchemaOption, type AppSupabaseClient } from "@/lib/supabase/schema";

const DIAG = process.env.NEURA_DIAG_AUTH === "1";

function logDiag(payload: Record<string, unknown>) {
  if (DIAG) {
    console.warn("[neura:diag:auth]", JSON.stringify(payload));
  }
}

export type ApiAuthFailureCode =
  | "missing_public_env"
  | "no_session"
  | "usuario_query_error"
  | "usuario_zero_rows"
  | "empresa_id_null";

export type ApiAuthContext = {
  user: User;
  /** null solo cuando forDataSchemaEndpoint y super_admin sin empresa. */
  empresa_id: string | null;
  /** Cliente anon + JWT del usuario (cookies o Bearer). PostgREST respeta RLS en zentra_erp. */
  userScopedSupabase: AppSupabaseClient;
};

export type ApiAuthResult =
  | { ok: true; ctx: ApiAuthContext }
  | { ok: false; code: ApiAuthFailureCode; detail?: string };

function extractBearer(request?: Request | null): string | null {
  const h = request?.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  const t = h.slice(7).trim();
  return t || null;
}

/**
 * Resuelve usuario Supabase + empresa_id + cliente PostgREST con el mismo JWT que verá RLS.
 * No requiere SUPABASE_SERVICE_ROLE_KEY (evita 401 en Vercel si falta la service key).
 */
export type ResolveApiAuthOptions = {
  /** Si true: super_admin sin empresa_id puede resolver (data_schema → plantilla zentra_erp). */
  forDataSchemaEndpoint?: boolean;
};

export async function resolveApiAuthContext(
  request?: Request | null,
  opts?: ResolveApiAuthOptions
): Promise<ApiAuthResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    logDiag({ step: "env", hasUrl: !!url, hasAnon: !!anonKey });
    return { ok: false, code: "missing_public_env" };
  }

  const bearer = extractBearer(request);
  if (DIAG) {
    const cs = await cookies();
    logDiag({
      step: "request",
      hasBearer: !!bearer,
      cookieCount: cs.getAll().length,
      cookieNames: cs.getAll().map((c) => c.name),
    });
  }

  let user: User | null = null;
  let userScopedSupabase: AppSupabaseClient;

  if (bearer) {
    userScopedSupabase = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      ...supabaseDbSchemaOption,
    }) as AppSupabaseClient;
    const { data, error } = await userScopedSupabase.auth.getUser(bearer);
    if (error || !data.user?.email) {
      logDiag({ step: "get_user_bearer", err: error?.message });
      return { ok: false, code: "no_session", detail: error?.message };
    }
    user = data.user;
  } else {
    const cookieStore = await cookies();
    userScopedSupabase = createServerClient(url, anonKey, {
      ...supabaseDbSchemaOption,
      cookies: {
        getAll() {
          return cookieStore.getAll().map((c) => ({ name: c.name, value: c.value }));
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }) as AppSupabaseClient;
    const { data, error } = await userScopedSupabase.auth.getUser();
    if (error || !data.user?.email) {
      logDiag({ step: "get_user_cookie", err: error?.message });
      return { ok: false, code: "no_session", detail: error?.message };
    }
    user = data.user;
  }

  const { data: rows, error: uErr } = await userScopedSupabase
    .from("usuarios")
    .select("empresa_id, rol")
    .eq("email", user.email)
    .limit(1);

  if (uErr) {
    logDiag({ step: "usuario", err: uErr.message });
    return { ok: false, code: "usuario_query_error", detail: uErr.message };
  }

  const row = rows?.[0] as { empresa_id?: string | null; rol?: string | null } | undefined;
  if (!row) {
    logDiag({ step: "usuario_rows", count: 0 });
    return { ok: false, code: "usuario_zero_rows" };
  }

  const empresa_id = row.empresa_id ?? null;
  if (empresa_id) {
    if (DIAG) {
      logDiag({
        step: "ok",
        emailHint: user.email?.replace(/^(.{2}).+(@.+)$/, "$1…$2"),
        empresaHint: `${empresa_id.slice(0, 8)}…`,
      });
    }
    return {
      ok: true,
      ctx: { user, empresa_id, userScopedSupabase },
    };
  }

  if (opts?.forDataSchemaEndpoint && row.rol === "super_admin") {
    if (DIAG) logDiag({ step: "ok_super_admin_sin_empresa" });
    return {
      ok: true,
      ctx: { user, empresa_id: null, userScopedSupabase },
    };
  }

  logDiag({ step: "empresa_id_null" });
  return { ok: false, code: "empresa_id_null" };
}
