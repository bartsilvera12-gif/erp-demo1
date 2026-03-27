import type { SupabaseAdmin } from "@/lib/chat/types";

const LOG = "[webhook/whatsapp][flow-resolve]" as const;

export type ActiveFlowsCatalogResult =
  | { kind: "single"; flowCode: string }
  | { kind: "none" }
  | { kind: "multiple"; flowCodes: string[] };

/**
 * Flujos marcados activos en catálogo para canal WhatsApp de la empresa.
 */
export async function listActiveWhatsappFlowsForEmpresa(
  supabase: SupabaseAdmin,
  empresaId: string
): Promise<ActiveFlowsCatalogResult> {
  const { data, error } = await supabase
    .from("chat_flows")
    .select("flow_code")
    .eq("empresa_id", empresaId)
    .eq("channel", "whatsapp")
    .eq("activo", true)
    .order("flow_code", { ascending: true });

  if (error) {
    console.error(LOG, "catalog_query_failed", { empresaId, message: error.message });
    throw new Error(error.message);
  }

  const codes = [...new Set((data ?? []).map((r) => String((r as { flow_code?: string }).flow_code ?? "").trim()).filter(Boolean))];
  if (codes.length === 0) return { kind: "none" };
  if (codes.length === 1) return { kind: "single", flowCode: codes[0] };
  return { kind: "multiple", flowCodes: codes };
}

/**
 * Primer nodo activo del flujo (sort_order, luego created_at). Sin filas → null.
 */
export async function getFirstActiveNodeCodeForFlow(
  supabase: SupabaseAdmin,
  empresaId: string,
  flowCode: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("chat_flow_nodes")
    .select("node_code, sort_order, created_at")
    .eq("empresa_id", empresaId)
    .eq("flow_code", flowCode)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    console.error(LOG, "first_node_query_failed", { empresaId, flowCode, message: error.message });
    return null;
  }
  const row = data?.[0] as { node_code?: string } | undefined;
  return row?.node_code?.trim() || null;
}

export type SyncConversationFlowResult = {
  flow_code: string | null;
  flow_current_node: string | null;
  changed: boolean;
};

/**
 * Asigna o corrige flow_code / nodo inicial según catálogo activo.
 * - Un solo flujo activo: usa ese (nueva conv o conv con flujo inexistente/inactivo en catálogo).
 * - Varios activos: solo mantiene la conv si su flow_code ya está entre los activos; si no, no elige al azar.
 * - Ninguno activo: no rompe; deja la conv tal cual y loguea no_active_flow_found.
 */
export async function syncWhatsappConversationFlowFromCatalog(
  supabase: SupabaseAdmin,
  empresaId: string,
  conversationId: string,
  conv: { flow_code: string | null; flow_current_node: string | null }
): Promise<SyncConversationFlowResult> {
  const currentFlow = conv.flow_code?.trim() || null;
  const currentNode = conv.flow_current_node?.trim() || null;

  const catalog = await listActiveWhatsappFlowsForEmpresa(supabase, empresaId);

  if (catalog.kind === "none") {
    console.warn(LOG, "no_active_flow_found", { empresaId, conversationId, currentFlow });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  if (catalog.kind === "multiple") {
    if (currentFlow && catalog.flowCodes.includes(currentFlow)) {
      console.info(LOG, "resolved_active_flow", {
        empresaId,
        conversationId,
        flowCode: currentFlow,
        reason: "conversation_flow_already_among_multiple_active",
      });
      return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
    }
    console.error(LOG, "multiple_active_flows", {
      empresaId,
      conversationId,
      activeFlowCodes: catalog.flowCodes,
      conversationFlow: currentFlow,
    });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  const targetFlow = catalog.flowCode;

  if (currentFlow === targetFlow) {
    console.info(LOG, "resolved_active_flow", {
      empresaId,
      conversationId,
      flowCode: targetFlow,
      flow_current_node: currentNode,
      action: "unchanged_single_active_match",
    });
    return { flow_code: targetFlow, flow_current_node: currentNode, changed: false };
  }

  const firstNode = (await getFirstActiveNodeCodeForFlow(supabase, empresaId, targetFlow)) ?? "inicio";

  if (currentFlow) {
    console.warn(LOG, "previous_flow_inactive", {
      conversationId,
      previousFlow: currentFlow,
      previousNode: currentNode,
      targetFlow,
      targetInitialNode: firstNode,
    });
  }

  console.info(LOG, "resolved_active_flow", {
    empresaId,
    conversationId,
    flowCode: targetFlow,
    flow_current_node: firstNode,
    action: "assign_single_active_flow",
  });

  const { error: updErr } = await supabase
    .from("chat_conversations")
    .update({
      flow_code: targetFlow,
      flow_current_node: firstNode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);

  if (updErr) {
    console.error(LOG, "conversation_flow_update_failed", { conversationId, message: updErr.message });
    return { flow_code: currentFlow, flow_current_node: currentNode, changed: false };
  }

  console.info(LOG, "conversation_flow_updated", {
    conversationId,
    flow_code: targetFlow,
    flow_current_node: firstNode,
  });

  return { flow_code: targetFlow, flow_current_node: firstNode, changed: true };
}
