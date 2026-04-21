/**
 * Regla única de negocio: pestaña **Bot** = conversación operada **ahora** por automatización,
 * no por flags históricos ni punteros a sesiones ya cerradas.
 */

export type FlowSessionRowMin = {
  id: string;
  status: string;
  flow_code: string;
  conversation_id: string;
};

export function buildFlowSessionMap(rows: FlowSessionRowMin[] | null | undefined): Map<string, FlowSessionRowMin> {
  const m = new Map<string, FlowSessionRowMin>();
  for (const r of rows ?? []) {
    const id = String(r.id ?? "").trim();
    if (!id) continue;
    m.set(id, {
      id,
      status: String(r.status ?? "").trim(),
      flow_code: String(r.flow_code ?? "").trim(),
      conversation_id: String(r.conversation_id ?? "").trim(),
    });
  }
  return m;
}

/**
 * Prueba nuclear (equivalente a `if (true) return false` en código):
 * en Vercel / .env local setear `CHAT_BOT_IF_TRUE_RETURN_FALSE=true` → Bot queda vacío si esta función alimenta el listado.
 */
function debugForceInboxLikeTrue(): boolean {
  return String(process.env.CHAT_BOT_IF_TRUE_RETURN_FALSE ?? "")
    .trim()
    .toLowerCase() === "true";
}

/**
 * `true` solo si en este momento hay automatización de flujo **vigente** (sesión `active` en BD),
 * flujo publicado como activo en `chat_flows`, sin toma humana, y datos coherentes (sin legado incoherente).
 */
export function isActivelyBotHandledConversation(
  conv: Record<string, unknown>,
  activeFlowCodeSet: Set<string>,
  sessionById: Map<string, FlowSessionRowMin>
): boolean {
  if (debugForceInboxLikeTrue()) {
    const conversationId = String((conv as { id?: string }).id ?? "").trim();
    console.info("[bot-routing]", "conversation_not_bot_tab", {
      conversation_id: conversationId,
      flow_status: String((conv as { flow_status?: string | null }).flow_status ?? "").trim(),
      flow_code: String((conv as { flow_code?: string | null }).flow_code ?? "").trim(),
      active_flow_session_id: String(
        (conv as { active_flow_session_id?: string | null }).active_flow_session_id ?? ""
      ).trim(),
      hasActiveSession: false,
      reason: "env_CHAT_BOT_IF_TRUE_RETURN_FALSE",
      forced: true,
    });
    return false;
  }

  const humanTaken = Boolean((conv as { human_taken_over?: boolean }).human_taken_over);
  const flowStatus = String((conv as { flow_status?: string | null }).flow_status ?? "").trim();
  const conversationId = String((conv as { id?: string }).id ?? "").trim();
  const flowCode = String((conv as { flow_code?: string | null }).flow_code ?? "").trim();
  const sessionId = String((conv as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim();

  const sess = sessionId ? sessionById.get(sessionId) : undefined;
  const hasActiveSession = Boolean(
    sess &&
      sess.status === "active" &&
      sess.conversation_id === conversationId &&
      sess.flow_code === flowCode
  );

  let result = false;
  if (!humanTaken && flowStatus !== "human" && conversationId && flowCode && activeFlowCodeSet.has(flowCode) && sessionId) {
    if (sess && sess.status === "active" && sess.conversation_id === conversationId && sess.flow_code === flowCode) {
      result = true;
    }
  }

  if (!result) {
    const reason =
      humanTaken || flowStatus === "human"
        ? "human_mode"
        : !flowCode
          ? "missing_flow_code"
          : !activeFlowCodeSet.has(flowCode)
            ? "flow_not_in_active_whatsapp_catalog"
            : !sessionId
              ? "missing_active_flow_session_id"
              : !sess
                ? "session_row_not_loaded"
                : sess.status !== "active"
                  ? "session_not_active"
                  : sess.conversation_id !== conversationId || sess.flow_code !== flowCode
                    ? "session_mismatch"
                    : "unknown";
    console.info("[bot-routing]", "conversation_not_bot_tab", {
      conversation_id: conversationId,
      flow_status: flowStatus,
      flow_code: flowCode,
      active_flow_session_id: sessionId || null,
      hasActiveSession,
      reason,
    });
  }

  return result;
}
