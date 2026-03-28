import type { SupabaseClient } from "@supabase/supabase-js";
import { empresaTieneModuloSorteos } from "@/lib/sorteos/raffles-service";

/** Clave estable: mismo comprobante (media) en misma conversación y flujo → una sola orden. */
export function buildSorteoIdempotencyKey(
  conversationId: string,
  flowCode: string,
  mediaId: string
): string {
  return `${conversationId}:${flowCode}:${mediaId}`;
}

function norm(s: string | undefined): string {
  return (s ?? "").trim();
}

/**
 * Lee campos típicos guardados vía save_as_field en el flujo (nombres flexibles).
 */
export function parseSorteoParticipantFromFlowData(data: Record<string, string>): {
  nombre_completo: string;
  cedula: string;
  ciudad: string;
  cantidad_boletos: number;
} | null {
  const qtyKeys = ["cantidad_boletos", "cantidad", "boletos", "qty"];
  let qty = NaN;
  for (const k of qtyKeys) {
    const v = norm(data[k]);
    if (!v) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) {
      qty = Math.trunc(n);
      break;
    }
  }
  if (!Number.isFinite(qty) || qty < 1) return null;

  const nombreCompleto =
    norm(data["nombre_completo"]) ||
    norm(data["nombre_y_apellido"]) ||
    [norm(data["nombre"]), norm(data["apellido"])].filter(Boolean).join(" ").trim();

  if (!nombreCompleto) return null;

  return {
    nombre_completo: nombreCompleto,
    cedula: norm(data["cedula"]) || norm(data["documento"]) || norm(data["ci"]),
    ciudad: norm(data["ciudad"]),
    cantidad_boletos: qty,
  };
}

export async function getSorteoIdForChatFlow(
  supabase: SupabaseClient,
  empresaId: string,
  flowCode: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("chat_flows")
    .select("sorteo_id")
    .eq("empresa_id", empresaId)
    .eq("flow_code", flowCode)
    .maybeSingle();
  if (error || !data) return null;
  const sid = data.sorteo_id as string | null | undefined;
  return sid && typeof sid === "string" ? sid : null;
}

export type EnsureSorteoOrderFromChatInput = {
  empresaId: string;
  conversationId: string;
  flowCode: string;
  mediaId: string;
  whatsappNumero: string;
  comprobanteUrl: string;
  /** Mapa field_name → field_value desde chat_flow_data */
  flowData: Record<string, string>;
};

export type EnsureSorteoOrderFromChatResult =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      skipped: false;
      idempotent: boolean;
      entradaId: string;
      numeroOrden: number;
      cupones: { id: string; numero_cupon: string }[];
    }
  | { ok: false; message: string };

/**
 * Crea orden (sorteo_entradas) + cupones vía RPC atómica e idempotente.
 * Si el flow no tiene sorteo_id o faltan datos, hace skip sin error.
 */
export async function ensureSorteoOrderFromChat(
  supabase: SupabaseClient,
  input: EnsureSorteoOrderFromChatInput
): Promise<EnsureSorteoOrderFromChatResult> {
  const tiene = await empresaTieneModuloSorteos(supabase, input.empresaId);
  if (!tiene) {
    return { ok: true, skipped: true, reason: "modulo_sorteos_inactivo" };
  }

  const sorteoId = await getSorteoIdForChatFlow(supabase, input.empresaId, input.flowCode);
  if (!sorteoId) {
    return { ok: true, skipped: true, reason: "flow_sin_sorteo_id" };
  }

  const participant = parseSorteoParticipantFromFlowData(input.flowData);
  if (!participant) {
    console.warn("[sorteo-order-from-chat] Datos de flujo incompletos para orden", {
      conversationId: input.conversationId,
      flowCode: input.flowCode,
      keys: Object.keys(input.flowData),
    });
    return { ok: true, skipped: true, reason: "datos_flujo_incompletos" };
  }

  const idempotencyKey = buildSorteoIdempotencyKey(
    input.conversationId,
    input.flowCode,
    input.mediaId
  );

  const { data, error } = await supabase.rpc("sorteos_ensure_order_from_chat", {
    p: {
      empresa_id: input.empresaId,
      sorteo_id: sorteoId,
      chat_conversation_id: input.conversationId,
      flow_code: input.flowCode,
      idempotency_key: idempotencyKey,
      whatsapp_numero: input.whatsappNumero,
      nombre_completo: participant.nombre_completo,
      cedula: participant.cedula || "",
      ciudad: participant.ciudad || "",
      cantidad_boletos: participant.cantidad_boletos,
      comprobante_url: input.comprobanteUrl,
      validado_por: "chat_flow",
    },
  });

  if (error) {
    return { ok: false, message: error.message || "RPC sorteos_ensure_order_from_chat falló" };
  }

  const row = data as Record<string, unknown> | null;
  if (!row || typeof row.ok !== "boolean") {
    return { ok: false, message: "Respuesta inválida del servidor (sorteo)" };
  }
  if (!row.ok) {
    return {
      ok: false,
      message: typeof row.message === "string" ? row.message : "Error al crear orden de sorteo",
    };
  }

  const entrada = row.entrada as Record<string, unknown> | undefined;
  const entradaId = typeof entrada?.id === "string" ? entrada.id : "";
  const numeroOrden =
    typeof entrada?.numero_orden === "number"
      ? entrada.numero_orden
      : Number(entrada?.numero_orden);
  const cuponesRaw = row.cupones as unknown;
  const cupones: { id: string; numero_cupon: string }[] = Array.isArray(cuponesRaw)
    ? cuponesRaw.map((c) => {
        const o = c as Record<string, unknown>;
        return {
          id: String(o.id ?? ""),
          numero_cupon: String(o.numero_cupon ?? ""),
        };
      })
    : [];

  if (!entradaId || !Number.isFinite(numeroOrden)) {
    return { ok: false, message: "Respuesta de orden incompleta" };
  }

  return {
    ok: true,
    skipped: false,
    idempotent: row.idempotent === true,
    entradaId,
    numeroOrden,
    cupones,
  };
}
