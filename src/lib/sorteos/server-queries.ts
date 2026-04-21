import type { SorteoCuponOrdenRow, SorteoEntrada } from "@/lib/sorteos/types";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getEmpresaIdForCurrentUserServer } from "@/lib/supabase/empresa-data-server";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";

function resolveSorteosModo(dataSchema: string): "postgres_shim" | "postgrest_schema" {
  const pool = getChatPostgresPool();
  return pool && isLikelyUnexposedTenantChatSchema(dataSchema) ? "postgres_shim" : "postgrest_schema";
}

/** Normaliza fechas que vienen como `Date` desde el pool PG. */
function normalizeRowTimestamps<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const k of ["created_at", "updated_at", "fecha_pago", "validado_at"]) {
    const v = out[k];
    if (v instanceof Date) out[k] = v.toISOString();
  }
  return out as T;
}

export async function fetchSorteoEntradasServer(): Promise<{
  data: SorteoEntrada[];
  error: string | null;
}> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) {
    return { data: [], error: "Sin sesión o empresa." };
  }

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  const modo = resolveSorteosModo(dataSchema);

  console.info("[sorteos][entradas-list]", {
    empresa_id: empresaId,
    schema: dataSchema,
    modo,
  });

  try {
    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data: entradas, error: e1 } = await sb
      .from("sorteo_entradas")
      .select("*")
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: false });

    if (e1) {
      console.error("[sorteos][entradas-list]", "error", {
        empresa_id: empresaId,
        schema: dataSchema,
        modo,
        error: e1.message,
      });
      return { data: [], error: e1.message };
    }

    const rows = (entradas ?? []) as Record<string, unknown>[];
    const sorteoIds = [...new Set(rows.map((r) => r.sorteo_id).filter(Boolean).map(String))];

    let nombreById: Record<string, string> = {};
    if (sorteoIds.length > 0) {
      const { data: sos, error: e2 } = await sb
        .from("sorteos")
        .select("id, nombre")
        .eq("empresa_id", empresaId)
        .in("id", sorteoIds);

      if (e2) {
        console.error("[sorteos][entradas-list]", "sorteos_lookup", {
          empresa_id: empresaId,
          schema: dataSchema,
          modo,
          error: e2.message,
        });
      } else if (sos) {
        for (const s of sos as { id: string; nombre: string }[]) {
          nombreById[s.id] = s.nombre;
        }
      }
    }

    const mapped = rows.map((raw) => {
      const r = normalizeRowTimestamps(raw);
      const sid = r.sorteo_id != null ? String(r.sorteo_id) : "";
      const nm = sid && nombreById[sid] ? { nombre: nombreById[sid] } : null;
      return { ...r, sorteos: nm } as unknown as SorteoEntrada;
    });

    return { data: mapped, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sorteos][entradas-list]", "catch", {
      empresa_id: empresaId,
      schema: dataSchema,
      modo,
      error: msg,
    });
    return { data: [], error: msg };
  }
}

export async function fetchSorteoCuponesOrdenesServer(): Promise<{
  data: SorteoCuponOrdenRow[];
  error: string | null;
}> {
  const empresaId = await getEmpresaIdForCurrentUserServer();
  if (!empresaId) {
    return { data: [], error: "Sin sesión o empresa." };
  }

  const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
  const modo = resolveSorteosModo(dataSchema);

  console.info("[sorteos][cupones-list]", {
    empresa_id: empresaId,
    schema: dataSchema,
    modo,
  });

  try {
    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data: entradasRaw, error: e1 } = await sb
      .from("sorteo_entradas")
      .select("*")
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: false });

    if (e1) {
      console.error("[sorteos][cupones-list]", "error", {
        empresa_id: empresaId,
        schema: dataSchema,
        modo,
        error: e1.message,
      });
      return { data: [], error: e1.message };
    }

    const entradas = (entradasRaw ?? []) as Record<string, unknown>[];
    const entradaIds = entradas.map((r) => String(r.id)).filter(Boolean);

    let cuponesRows: { entrada_id: string; numero_cupon: string }[] = [];
    if (entradaIds.length > 0) {
      const { data: cupones, error: e2 } = await sb
        .from("sorteo_cupones")
        .select("entrada_id, numero_cupon")
        .eq("empresa_id", empresaId)
        .in("entrada_id", entradaIds);

      if (e2) {
        console.error("[sorteos][cupones-list]", "cupones_lookup", {
          empresa_id: empresaId,
          schema: dataSchema,
          modo,
          error: e2.message,
        });
        return { data: [], error: e2.message };
      }
      cuponesRows = (cupones ?? []) as { entrada_id: string; numero_cupon: string }[];
    }

    const cuponesByEntrada: Record<string, string[]> = {};
    for (const c of cuponesRows) {
      const id = String(c.entrada_id);
      if (!cuponesByEntrada[id]) cuponesByEntrada[id] = [];
      cuponesByEntrada[id].push(c.numero_cupon);
    }

    const sorteoIds = [...new Set(entradas.map((r) => r.sorteo_id).filter(Boolean).map(String))];
    let nombreById: Record<string, string> = {};
    if (sorteoIds.length > 0) {
      const { data: sos, error: e3 } = await sb
        .from("sorteos")
        .select("id, nombre")
        .eq("empresa_id", empresaId)
        .in("id", sorteoIds);
      if (e3) {
        console.error("[sorteos][cupones-list]", "sorteos_lookup", {
          empresa_id: empresaId,
          schema: dataSchema,
          modo,
          error: e3.message,
        });
      } else if (sos) {
        for (const s of sos as { id: string; nombre: string }[]) {
          nombreById[s.id] = s.nombre;
        }
      }
    }

    const mapped = entradas
      .map((raw) => {
        const r = normalizeRowTimestamps(raw);
        const id = String(r.id);
        const numeros = (cuponesByEntrada[id] ?? []).filter(Boolean).sort();
        if (numeros.length === 0) return null;

        const sid = r.sorteo_id != null ? String(r.sorteo_id) : "";
        const sorteoNombre = sid && nombreById[sid] ? nombreById[sid] : "—";

        const mt =
          typeof r.monto_total === "number" && Number.isFinite(r.monto_total)
            ? r.monto_total
            : Number(r.monto_total);
        const montoTotal = Number.isFinite(mt) ? mt : 0;
        const pfRaw = r.precio_fuente;
        const pf = pfRaw === "promo" || pfRaw === "lista" ? pfRaw : null;
        const promoNom = r.promo_nombre;

        return {
          entrada_id: id,
          numero_orden: typeof r.numero_orden === "number" ? r.numero_orden : 0,
          nombre_participante: String(r.nombre_participante ?? ""),
          documento:
            typeof r.documento === "string" && r.documento.trim() ? r.documento.trim() : null,
          whatsapp_numero: String(r.whatsapp_numero ?? ""),
          cantidad_boletos: Number(r.cantidad_boletos ?? 0),
          monto_total: montoTotal,
          promo_nombre:
            typeof promoNom === "string" && promoNom.trim() ? promoNom.trim() : null,
          precio_fuente: pf,
          estado_pago: r.estado_pago as SorteoCuponOrdenRow["estado_pago"],
          created_at: String(r.created_at ?? ""),
          chat_conversation_id:
            r.chat_conversation_id == null ? null : String(r.chat_conversation_id),
          sorteo_nombre: sorteoNombre ?? "—",
          numeros_cupon: numeros,
        };
      })
      .filter((x): x is SorteoCuponOrdenRow => x !== null);

    return { data: mapped, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sorteos][cupones-list]", "catch", {
      empresa_id: empresaId,
      schema: dataSchema,
      modo,
      error: msg,
    });
    return { data: [], error: msg };
  }
}
