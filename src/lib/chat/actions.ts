"use server";

import {
  buildFlowSessionMap,
  isActivelyBotHandledConversation,
  type FlowSessionRowMin,
} from "@/lib/chat/actively-bot-handled";
import {
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
  parseComprobanteValidationConfig,
  type ComprobanteValidacionListRow,
} from "@/lib/chat/comprobante-validation-types";
import { requireEmpresaTenantServiceRole } from "@/lib/chat/empresa-tenant-service-role";
import { isMissingColumnError } from "@/lib/chat/postgres-column-error";
import {
  appendOmnicanalConversationScopeToQuery,
  getOmnicanalScope,
  isOmnicanalAdminScope,
  OMNICANAL_IMPOSSIBLE_CONVERSATION_ID,
  resolveQueueIdsForUsuarios,
  shouldBypassOmnicanalConversationScope,
} from "@/lib/chat/omnicanal-scope";
import {
  deleteOmnichannelRouteByMetaPhone,
  syncOmnichannelRouteForWhatsappChannel,
} from "@/lib/chat/omnichannel-route-sync";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";
import {
  pgDeleteChatChannel,
  pgInsertChatChannelMetaWhatsapp,
  pgInsertGenericOmnichannelChannel,
  pgInsertYCloudWhatsappChannel,
  pgSelectChatChannelConfig,
  pgSelectChatChannelMetaPrev,
  pgUpdateChatChannelConfig,
  pgUpdateChatChannelMetaWhatsapp,
  pgUpdateGenericOmnichannelChannel,
  pgUpdateYCloudWhatsappChannel,
} from "@/lib/chat/chat-channels-mutate-pg";
import { pgMarkConversationUnreadZero, pgReleaseConversationToBot } from "@/lib/chat/chat-send-persist-pg";
import { isInvalidPostgrestSchemaError } from "@/lib/chat/postgrest-schema-error";
import { normalizeChannelType } from "@/lib/chat/channel-type-utils";
import { fetchChatConversationsFromTenantPg } from "@/lib/chat/chat-inbox-fetch-pg";
import {
  pgApproveComprobanteValidacion,
  pgConversationBelongsToEmpresa,
  pgFetchComprobanteValidacionesForConversation,
} from "@/lib/chat/chat-comprobante-validacion-pg";

export type ConversacionesVista = "inbox" | "bot" | "historial";

export type ChatInboxAssignmentFilter = "all" | "mine" | "unassigned";

export type ChatInboxFilters = {
  assignment?: ChatInboxAssignmentFilter;
  queue_id?: string | null;
  status?: string | null;
  priority?: string | null;
  /** Filtro opcional por `chat_conversations.channel_id` (UUID). */
  channel_id?: string | null;
};

export type InboxConversation = {
  id: string;
  status: string;
  priority: string;
  queue_id: string | null;
  queue_name: string | null;
  /** manual_queue | no_eligible_agent cuando queda en cola sin agente; null si hay agente o no aplica. */
  assignment_wait_code: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  flow_status: string;
  human_taken_over: boolean;
  /**
   * Último mensaje del contacto sin respuesta humana posterior (RPC `neura_inbox_awaiting_reply_since_batch`).
   * null si no aplica o si el RPC no está desplegado.
   */
  awaiting_agent_reply_since: string | null;
  /**
   * Último mensaje del hilo es saliente (empresa) y no aplica `awaiting_agent_reply_since` (turno del contacto).
   * Requiere migración con columna `client_turn_since` en el mismo RPC.
   */
  awaiting_client_reply_since: string | null;
  channel: {
    id: string;
    type: string;
    nombre: string | null;
    /** Si el canal tiene activada la validación inteligente de comprobantes (UI inbox). */
    comprobante_validation_enabled: boolean;
    /** Respuestas rápidas en inbox (`config.quick_replies_inbox_enabled`, default true). */
    quick_replies_inbox_enabled: boolean;
  };
  contact: {
    id: string;
    name: string | null;
    phone_number: string;
    cliente_id: string | null;
    crm_prospecto_id: string | null;
  };
};

/**
 * Último mensaje por conversación (respaldo si el RPC de turnos falla o no está desplegado).
 * Una subconsulta por id en paralelo por lotes, para no mezclar límites entre conversaciones.
 */
async function mapLastMessageByConversation(
  supabase: AppSupabaseClient,
  empresaId: string,
  convIds: string[]
): Promise<Record<string, { created_at: string; from_me: boolean }>> {
  if (convIds.length === 0) return {};
  const unique = [...new Set(convIds.map((x) => x.trim()).filter(Boolean))];
  const out: Record<string, { created_at: string; from_me: boolean }> = {};
  const batchSize = 30;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (cid) => {
        const { data, error } = await supabase
          .from("chat_messages")
          .select("conversation_id, created_at, from_me")
          .eq("empresa_id", empresaId)
          .eq("conversation_id", cid)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) {
          console.warn("[fetchChatConversations] último mensaje conv", cid, error.message);
          return;
        }
        if (!data) return;
        const created_at = String((data as { created_at?: string }).created_at ?? "").trim();
        if (!created_at) return;
        out[cid] = {
          created_at,
          from_me: Boolean((data as { from_me?: boolean }).from_me),
        };
      })
    );
  }
  return out;
}

export async function fetchChatConversations(
  vista: ConversacionesVista = "inbox",
  filters?: ChatInboxFilters
): Promise<InboxConversation[]> {
  try {
    return await fetchChatConversationsUnsafe(vista, filters);
  } catch (e) {
    console.error("[fetchChatConversations] fatal (inbox vacío):", e);
    return [];
  }
}

async function fetchChatConversationsUnsafe(
  vista: ConversacionesVista = "inbox",
  filters?: ChatInboxFilters
): Promise<InboxConversation[]> {
  const { supabase, catalogSr, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();

  const poolInbox = getChatPostgresPool();
  if (poolInbox && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    return fetchChatConversationsFromTenantPg(poolInbox, dataSchema, vista, filters, {
      supabase,
      catalogSr,
      empresa_id,
      usuario_id,
    });
  }

  const { data: activeFlowRows, error: activeFlowsErr } = await supabase
    .from("chat_flows")
    .select("flow_code")
    .eq("empresa_id", empresa_id)
    .eq("activo", true);
  if (activeFlowsErr) {
    console.warn("[fetchChatConversations] chat_flows activos:", activeFlowsErr.message);
  }
  const activeFlowCodeSet = new Set(
    (activeFlowRows ?? [])
      .map((r) => String((r as { flow_code?: string | null }).flow_code ?? "").trim())
      .filter((c) => c.length > 0)
  );

  if (vista === "bot" && activeFlowCodeSet.size === 0) {
    return [];
  }

  /**
   * Sin embeds desde `chat_conversations`: en esquemas tenant PostgREST suele no tener en caché
   * las FKs hacia `chat_channels` / `chat_queues` / `chat_agents` y falla el select anidado.
   */
  const convSelectWithWait = `
      id,
      status,
      priority,
      queue_id,
      assignment_wait_code,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;
  const convSelectLegacy = `
      id,
      status,
      priority,
      queue_id,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;
  /** Sin `priority` ni `assignment_wait_code` (tenants desalineados). */
  const convSelectLegacyNoPriority = `
      id,
      status,
      queue_id,
      assigned_agent_id,
      last_message_at,
      last_message_preview,
      unread_count,
      contact_id,
      channel_id,
      flow_code,
      flow_status,
      human_taken_over,
      active_flow_session_id
    `;

  /** Ver `appendOmnicanalConversationScopeToQuery`: el builder PostgREST no debe devolverse “crudo” desde async. */
  const buildFilteredConversationQuery = async (selectStr: string) => {
    let qb = supabase.from("chat_conversations").select(selectStr).eq("empresa_id", empresa_id);

    if (vista === "inbox") {
      qb = qb.in("status", ["open", "pending"]);
    } else if (vista === "bot") {
      qb = qb
        .eq("human_taken_over", false)
        .in("status", ["open", "pending"])
        .not("active_flow_session_id", "is", null);
    } else if (vista === "historial") {
      qb = qb.eq("status", "closed");
    }

    const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
      tenantDataSchema: dataSchema,
    });
    const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);
    try {
      if (!bypass) {
        const { builder } = await appendOmnicanalConversationScopeToQuery(
          supabase,
          empresa_id,
          scope,
          qb,
          undefined,
          dataSchema
        );
        qb = builder;
      }
    } catch (e) {
      console.error("[fetchChatConversations] alcance omnicanal omitido:", e);
    }

    const assignment = filters?.assignment ?? "all";
    if (assignment === "mine") {
      let myAgents: { id: string }[] | null = null;
      let maErr = null as { message: string } | null;
      let r = await supabase
        .from("chat_agents")
        .select("id")
        .eq("empresa_id", empresa_id)
        .eq("usuario_id", usuario_id)
        .eq("is_active", true);
      if (r.error && isMissingColumnError(r.error.message, "is_active")) {
        r = await supabase
          .from("chat_agents")
          .select("id")
          .eq("empresa_id", empresa_id)
          .eq("usuario_id", usuario_id);
      }
      myAgents = r.data as { id: string }[] | null;
      maErr = r.error;
      if (maErr) {
        console.warn(
          "[fetchChatConversations] no se pudo cargar chat_agents para filtro «mios»; se listan todas:",
          maErr.message
        );
      } else {
        const ids = (myAgents ?? []).map((row) => row.id as string);
        if (ids.length > 0) {
          qb = qb.in("assigned_agent_id", ids);
        } else {
          console.warn(
            "[fetchChatConversations] filtro «mios» sin filas en chat_agents para el usuario; se listan todas las conversaciones"
          );
        }
      }
    } else if (assignment === "unassigned") {
      qb = qb.is("assigned_agent_id", null);
    }

    const fq = filters?.queue_id?.trim();
    if (fq) {
      let queueOk = true;
      if (!bypass && !isOmnicanalAdminScope(scope)) {
        const allowedQueues = await resolveQueueIdsForUsuarios(
          supabase,
          empresa_id,
          scope.agentUsuarioIds,
          dataSchema
        );
        queueOk = allowedQueues.includes(fq);
      }
      qb = queueOk ? qb.eq("queue_id", fq) : qb.eq("id", OMNICANAL_IMPOSSIBLE_CONVERSATION_ID);
    }

    const fs = filters?.status?.trim().toLowerCase();
    if (fs && ["open", "pending", "closed"].includes(fs)) {
      qb = qb.eq("status", fs);
    }

    const fp = filters?.priority?.trim().toLowerCase();
    if (fp && ["low", "medium", "high"].includes(fp)) {
      qb = qb.eq("priority", fp);
    }

    const fch = filters?.channel_id?.trim();
    if (fch) {
      qb = qb.eq("channel_id", fch);
    }

    return { builder: qb };
  };

  /* PostgREST: desempaquetar `.builder` — el builder es thenable y no puede devolverse solo desde async. */
  let q: any = (await buildFilteredConversationQuery(convSelectWithWait)).builder;
  let { data: convs, error } = await q.order("last_message_at", {
    ascending: false,
    nullsFirst: false,
  });

  if (error && isMissingColumnError(error.message, "assignment_wait_code")) {
    console.warn("[fetchChatConversations] assignment_wait_code ausente; reintento sin columna");
    q = (await buildFilteredConversationQuery(convSelectLegacy)).builder;
    ({ data: convs, error } = await q.order("last_message_at", {
      ascending: false,
      nullsFirst: false,
    }));
  }

  if (error) {
    console.warn("[fetchChatConversations] reintento select mínimo sin priority ni assignment_wait_code");
    q = (await buildFilteredConversationQuery(convSelectLegacyNoPriority)).builder;
    ({ data: convs, error } = await q.order("last_message_at", {
      ascending: false,
      nullsFirst: false,
    }));
  }

  if (error) {
    console.warn("[fetchChatConversations] listado conversaciones no disponible:", error.message);
    return [];
  }
  let list = (convs ?? []) as Record<string, unknown>[];
  const totalAfterQuery = list.length;

  const sessionIds = [
    ...new Set(
      list
        .map((row: Record<string, unknown>) =>
          String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim()
        )
        .filter((id: string) => id.length > 0)
    ),
  ];
  const flowSessionById = new Map<string, FlowSessionRowMin>();
  const sessionChunk = 100;
  for (let i = 0; i < sessionIds.length; i += sessionChunk) {
    const chunk = sessionIds.slice(i, i + sessionChunk);
    const { data: sessRows, error: sessErr } = await supabase
      .from("chat_flow_sessions")
      .select("id, status, flow_code, conversation_id")
      .eq("empresa_id", empresa_id)
      .in("id", chunk);
    if (sessErr) {
      console.warn("[fetchChatConversations] chat_flow_sessions:", sessErr.message);
      continue;
    }
    for (const [k, v] of buildFlowSessionMap(sessRows as FlowSessionRowMin[]).entries()) {
      flowSessionById.set(k, v);
    }
  }

  const isActivelyBot = (row: Record<string, unknown>) =>
    isActivelyBotHandledConversation(row, activeFlowCodeSet, flowSessionById);

  let classifiedAsActivelyBot = 0;
  if (vista === "inbox") {
    /** Inbox lista todo lo abierto/pendiente; si ocultáramos «solo bot» los operadores no ven WhatsApp en flujo (inbox vacío). La pestaña Bot sigue filtrando solo automatización. */
    for (const row of list) {
      if (isActivelyBot(row as Record<string, unknown>)) classifiedAsActivelyBot += 1;
    }
  } else if (vista === "bot") {
    list = list.filter((row) => {
      const b = isActivelyBot(row as Record<string, unknown>);
      if (b) classifiedAsActivelyBot += 1;
      return b;
    });
  }

  const botCount = vista === "bot" ? list.length : classifiedAsActivelyBot;
  const inboxCount = vista === "inbox" ? list.length : totalAfterQuery - list.length;
  console.log("[BOT-LIST]", {
    vista,
    empresa_id,
    total: totalAfterQuery,
    botCount,
    inboxCount,
    sessionMapSize: flowSessionById.size,
    activeFlowCodes: activeFlowCodeSet.size,
  });

  if (list.length === 0) return [];

  const convIdList = list.map((row) => String((row as { id?: unknown }).id ?? "").trim()).filter(Boolean);
  const awaitingById: Record<string, string | null> = {};
  const clientTurnById: Record<string, string | null> = {};
  if (convIdList.length > 0) {
    try {
      const { data: rpcRows, error: rpcErr } = await catalogSr.rpc("neura_inbox_awaiting_reply_since_batch", {
        p_schema: dataSchema,
        p_empresa_id: empresa_id,
        p_conversation_ids: convIdList,
      });
      if (rpcErr) {
        console.warn("[fetchChatConversations] awaiting_reply RPC:", rpcErr.message);
      } else if (Array.isArray(rpcRows)) {
        for (const r of rpcRows as {
          conversation_id?: string;
          awaiting_since?: string | null;
          client_turn_since?: string | null;
        }[]) {
          const id = String(r.conversation_id ?? "").trim();
          if (!id) continue;
          awaitingById[id] = r.awaiting_since ?? null;
          clientTurnById[id] = (r as { client_turn_since?: string | null }).client_turn_since ?? null;
        }
      }
    } catch (e) {
      console.warn("[fetchChatConversations] awaiting_reply RPC:", e instanceof Error ? e.message : e);
    }
    const lastByConv = await mapLastMessageByConversation(supabase, empresa_id, convIdList);
    for (const id of convIdList) {
      if (awaitingById[id] != null || clientTurnById[id] != null) continue;
      const last = lastByConv[id];
      if (!last?.created_at) continue;
      if (!last.from_me) awaitingById[id] = last.created_at;
      else clientTurnById[id] = last.created_at;
    }
  }

  const channelIds = [
    ...new Set(
      list
        .map((c) => (c.channel_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];

  let channelById: Record<
    string,
    {
      type: string;
      nombre: string | null;
      comprobante_validation_enabled: boolean;
      quick_replies_inbox_enabled: boolean;
    }
  > = {};
  if (channelIds.length > 0) {
    const { data: chrows, error: chErr } = await supabase
      .from("chat_channels")
      .select("id, type, nombre, config")
      .eq("empresa_id", empresa_id)
      .in("id", channelIds);
    if (chErr) {
      console.warn("[fetchChatConversations] chat_channels:", chErr.message);
    } else {
      channelById = Object.fromEntries(
        (chrows ?? []).map((r) => {
          const rec = r as {
            id: string;
            type?: string | null;
            nombre?: string | null;
            config?: unknown;
          };
          const cfg = rec.config;
          const compOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? parseComprobanteValidationConfig(cfg as Record<string, unknown>).enabled
              : false;
          const qrOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? (cfg as Record<string, unknown>).quick_replies_inbox_enabled !== false
              : true;
          return [
            rec.id,
            {
              type: (rec.type as string) ?? "whatsapp",
              nombre: rec.nombre ?? null,
              comprobante_validation_enabled: compOn,
              quick_replies_inbox_enabled: qrOn,
            },
          ];
        })
      );
    }
  }

  const queueIds = [
    ...new Set(
      list
        .map((c) => (c.queue_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  const assignedAgentIds = [
    ...new Set(
      list
        .map((c) => (c.assigned_agent_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];

  let queueNombreById: Record<string, string | null> = {};
  if (queueIds.length > 0) {
    const { data: qrows, error: qErr } = await supabase
      .from("chat_queues")
      .select("id, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", queueIds);
    if (qErr) {
      console.warn("[fetchChatConversations] chat_queues:", qErr.message);
    } else {
      queueNombreById = Object.fromEntries(
        (qrows ?? []).map((r) => [r.id as string, (r as { nombre?: string | null }).nombre ?? null])
      );
    }
  }

  let agentUsuarioById: Record<string, string> = {};
  if (assignedAgentIds.length > 0) {
    const { data: arows, error: aErr } = await supabase
      .from("chat_agents")
      .select("id, usuario_id")
      .eq("empresa_id", empresa_id)
      .in("id", assignedAgentIds);
    if (aErr) {
      console.warn("[fetchChatConversations] chat_agents (enriquecido):", aErr.message);
    } else {
      agentUsuarioById = Object.fromEntries(
        (arows ?? []).map((r) => [r.id as string, (r as { usuario_id: string }).usuario_id])
      );
    }
  }

  const contactIds = [
    ...new Set(
      list
        .map((c) => (c.contact_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  let byId: Record<string, Record<string, unknown>> = {};
  if (contactIds.length > 0) {
    const { data: contacts, error: e2 } = await supabase
      .from("chat_contacts")
      .select("id, name, phone_number, cliente_id, crm_prospecto_id")
      .eq("empresa_id", empresa_id)
      .in("id", contactIds);

    if (e2) {
      console.warn("[fetchChatConversations] chat_contacts:", e2.message);
    } else {
      byId = Object.fromEntries((contacts ?? []).map((c) => [c.id, c as Record<string, unknown>]));
    }
  }

  const agentUserIds = [
    ...new Set(
      list
        .map((row) => {
          const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
          const uid = aid ? agentUsuarioById[aid] : undefined;
          return uid;
        })
        .filter(Boolean) as string[]
    ),
  ];

  let usuarioNombreById: Record<string, { nombre: string | null; email: string | null }> = {};
  if (agentUserIds.length > 0) {
    const { data: urows, error: uErr } = await catalogSr
      .from("usuarios")
      .select("id, nombre, email")
      .in("id", agentUserIds);
    if (uErr) {
      console.warn("[fetchChatConversations] usuarios (catálogo):", uErr.message);
    } else {
      usuarioNombreById = Object.fromEntries(
        (urows ?? []).map((u) => [
          u.id as string,
          {
            nombre: (u as { nombre?: string | null }).nombre ?? null,
            email: (u as { email?: string | null }).email ?? null,
          },
        ])
      );
    }
  }

  return list.map((row) => {
    const c = byId[row.contact_id as string] as
      | { id?: string; name?: string | null; phone_number?: string; cliente_id?: string | null; crm_prospecto_id?: string | null }
      | undefined;
    const cid = (row.channel_id as string | null | undefined)?.trim() ?? "";
    const chMeta = cid ? channelById[cid] : undefined;
    const channelId = cid;
    const channelType = chMeta?.type ?? "whatsapp";
    const channelNombre = chMeta?.nombre ?? null;
    const compValEnabled = chMeta?.comprobante_validation_enabled ?? false;
    const qrInboxEnabled = chMeta?.quick_replies_inbox_enabled !== false;
    const qid = (row.queue_id as string | null | undefined)?.trim() || null;
    const qRowNombre = qid ? queueNombreById[qid] : null;
    const waitCode = ((row as { assignment_wait_code?: string | null }).assignment_wait_code ?? null) as
      | string
      | null;
    const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
    const uid = aid ? agentUsuarioById[aid] : undefined;
    const uMeta = uid ? usuarioNombreById[uid] : undefined;
    const assignedName =
      (uMeta?.nombre?.trim() || uMeta?.email?.trim() || null) as string | null;
    return {
      id: row.id as string,
      status: row.status as string,
      priority: (row.priority as string) ?? "medium",
      queue_id: (row.queue_id as string | null) ?? null,
      queue_name: qRowNombre ?? null,
      assignment_wait_code: typeof waitCode === "string" && waitCode.trim() ? waitCode.trim() : null,
      assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
      assigned_agent_name: assignedName,
      last_message_at: row.last_message_at as string | null,
      last_message_preview: row.last_message_preview as string | null,
      unread_count: (row.unread_count as number) ?? 0,
      flow_status: String((row as { flow_status?: string | null }).flow_status ?? ""),
      human_taken_over: Boolean(row.human_taken_over),
      channel: {
        id: channelId,
        type: channelType,
        nombre: channelNombre,
        comprobante_validation_enabled: compValEnabled,
        quick_replies_inbox_enabled: qrInboxEnabled,
      },
      contact: {
        id: c?.id ?? (row.contact_id as string),
        name: c?.name ?? null,
        phone_number: c?.phone_number ?? "",
        cliente_id: c?.cliente_id ?? null,
        crm_prospecto_id: c?.crm_prospecto_id ?? null,
      },
      awaiting_agent_reply_since: awaitingById[row.id as string] ?? null,
      awaiting_client_reply_since: clientTurnById[row.id as string] ?? null,
    };
  });
}

/** True si la empresa tiene al menos un flujo de chat activo (tab Bot en inbox). */
export async function hasEmpresaActiveChatFlows(): Promise<boolean> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    try {
      const r = await pool.query(
        `SELECT 1 AS one
         FROM ${quoteSchemaTable(dataSchema, "chat_flows")}
         WHERE empresa_id = $1::uuid AND COALESCE(activo, false) = true
         LIMIT 1`,
        [empresa_id]
      );
      return (r.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }
  const { count, error } = await supabase
    .from("chat_flows")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .eq("activo", true);
  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Vuelve a modo bot (solo operador). No reinicia el flujo ni la sesión.
 */
export async function releaseConversationToBot(conversationId: string): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const id = conversationId.trim();
  if (!id) throw new Error("ID inválido");

  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    await pgReleaseConversationToBot(pool, dataSchema, empresa_id, id);
    return;
  }

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      human_taken_over: false,
      flow_status: "bot",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    await pgMarkConversationUnreadZero(pool, dataSchema, empresa_id, conversationId.trim());
    return;
  }

  const { error } = await supabase
    .from("chat_conversations")
    .update({ unread_count: 0, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export type ChatChannelRow = {
  id: string;
  empresa_id: string;
  type: string;
  meta_phone_number_id: string | null;
  nombre: string | null;
  provider: string;
  provider_channel_id: string | null;
  activo: boolean;
  connection_mode: string | null;
  config_status: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  /** Sin exponer secretos; solo presente cuando el servidor puede calcularlo (p. ej. Postgres). */
  meta_access_token_present?: boolean | null;
  /** Presencia de API key YCloud en `config` sin exponer el valor. */
  ycloud_api_key_present?: boolean | null;
};

function isoFromPgOrJson(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v ?? "");
}

function mapChatChannelRow(r: Record<string, unknown>): ChatChannelRow {
  const mp = r.meta_phone_number_id;
  const upd = r.updated_at;
  const metaTok = r.meta_access_token_present;
  const ycKey = r.ycloud_api_key_present;
  const rawId = r.id;
  const idStr = typeof rawId === "string" ? rawId.trim() : rawId != null ? String(rawId).trim() : "";
  return {
    id: idStr,
    empresa_id: r.empresa_id as string,
    type: normalizeChannelType(r.type),
    meta_phone_number_id: typeof mp === "string" ? mp : mp != null ? String(mp) : null,
    nombre: (r.nombre as string) ?? null,
    provider: (r.provider as string) ?? "meta",
    provider_channel_id: (r.provider_channel_id as string) ?? null,
    activo: r.activo !== false,
    connection_mode: (r.connection_mode as string | null) ?? null,
    config_status: (r.config_status as string) ?? "incomplete",
    config: (typeof r.config === "object" && r.config !== null ? r.config : {}) as Record<string, unknown>,
    created_at: isoFromPgOrJson(r.created_at),
    meta_access_token_present:
      typeof metaTok === "boolean" ? metaTok : metaTok === null ? null : undefined,
    ycloud_api_key_present: typeof ycKey === "boolean" ? ycKey : ycKey === null ? null : undefined,
    updated_at:
      upd === null || upd === undefined
        ? undefined
        : typeof upd === "string"
          ? upd
          : upd instanceof Date
            ? upd.toISOString()
            : String(upd),
  };
}

const POSTGREST_TENANT_SCHEMA_HINT =
  "PostgREST no puede usar el schema de datos de esta empresa. Configurá SUPABASE_DB_URL o DIRECT_URL (pooler Postgres) en el entorno del servidor, o agregá el schema en Supabase → Settings → API → Exposed schemas.";

function postgrestMutationError(dataSchema: string, message: string): Error {
  if (isLikelyUnexposedTenantChatSchema(dataSchema) && isInvalidPostgrestSchemaError(message)) {
    return new Error(POSTGREST_TENANT_SCHEMA_HINT);
  }
  return new Error(message);
}

async function enrichChatChannelsSecretFlagsFromPg(
  dataSchema: string,
  empresaId: string,
  rows: ChatChannelRow[]
): Promise<void> {
  const pool = getChatPostgresPool();
  if (!pool || rows.length === 0) return;
  const qt = quoteSchemaTable(dataSchema, "chat_channels");
  try {
    const r = await pool.query(
      `
      SELECT id::text AS id,
        (LOWER(TRIM(COALESCE(provider::text, ''))) = 'meta'
          AND whatsapp_access_token IS NOT NULL
          AND LENGTH(TRIM(COALESCE(whatsapp_access_token, ''))) > 0) AS meta_access_token_present,
        (LOWER(TRIM(COALESCE(provider::text, ''))) = 'ycloud'
          AND COALESCE(TRIM(config->>'ycloud_api_key'), '') <> '') AS ycloud_api_key_present
      FROM ${qt}
      WHERE empresa_id = $1::uuid
    `,
      [empresaId]
    );
    const byId = new Map<string, { m: boolean; y: boolean }>();
    for (const row of r.rows ?? []) {
      const rec = row as Record<string, unknown>;
      byId.set(String(rec.id), {
        m: Boolean(rec.meta_access_token_present),
        y: Boolean(rec.ycloud_api_key_present),
      });
    }
    for (const row of rows) {
      const f = byId.get(row.id);
      if (f) {
        row.meta_access_token_present = f.m;
        row.ycloud_api_key_present = f.y;
      }
    }
  } catch {
    /* flags opcionales */
  }
}

async function tryFetchChatChannelsFromPg(
  dataSchema: string,
  empresaId: string
): Promise<ChatChannelRow[] | undefined> {
  const pool = getChatPostgresPool();
  if (!pool) return undefined;
  const qt = quoteSchemaTable(dataSchema, "chat_channels");
  const qFull = `
    SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, connection_mode, config_status, config, created_at, updated_at,
           (LOWER(TRIM(COALESCE(provider::text, ''))) = 'meta'
             AND whatsapp_access_token IS NOT NULL
             AND LENGTH(TRIM(COALESCE(whatsapp_access_token, ''))) > 0) AS meta_access_token_present,
           (LOWER(TRIM(COALESCE(provider::text, ''))) = 'ycloud'
             AND COALESCE(TRIM(config->>'ycloud_api_key'), '') <> '') AS ycloud_api_key_present
    FROM ${qt}
    WHERE empresa_id = $1::uuid
    ORDER BY created_at ASC
  `;
  const qMinimal = `
    SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, connection_mode, config_status, config, created_at, updated_at
    FROM ${qt}
    WHERE empresa_id = $1::uuid
    ORDER BY created_at ASC
  `;
  try {
    const r = await pool.query(qFull, [empresaId]);
    return (r.rows ?? []).map((row) => mapChatChannelRow(row as Record<string, unknown>));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[fetchChatChannels] pg_full_failed", {
      schema: dataSchema,
      empresa_id: empresaId,
      message: msg.slice(0, 300),
    });
    try {
      const r = await pool.query(qMinimal, [empresaId]);
      return (r.rows ?? []).map((row) => mapChatChannelRow(row as Record<string, unknown>));
    } catch (e2) {
      console.error("[fetchChatChannels] pg_minimal_failed", {
        schema: dataSchema,
        empresa_id: empresaId,
        message: e2 instanceof Error ? e2.message.slice(0, 300) : String(e2),
      });
      return undefined;
    }
  }
}

async function tryFetchChatChannelByIdFromPg(
  dataSchema: string,
  empresaId: string,
  channelId: string
): Promise<ChatChannelRow | null | undefined> {
  const pool = getChatPostgresPool();
  if (!pool) return undefined;
  const qt = quoteSchemaTable(dataSchema, "chat_channels");
  const attempts = [
    `SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, connection_mode, config_status, config, created_at, updated_at FROM ${qt}
     WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
    `SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, config_status, config, created_at, updated_at FROM ${qt}
     WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
    `SELECT id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id,
           activo, config, created_at, updated_at FROM ${qt}
     WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`,
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = await pool.query(attempts[i]!, [channelId, empresaId]);
      const row = r.rows?.[0];
      if (!row) return null;
      return mapChatChannelRow(row as Record<string, unknown>);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i === attempts.length - 1) {
        console.error("[fetchChatChannelById] pg_failed", {
          schema: dataSchema,
          empresa_id: empresaId,
          message: msg.slice(0, 300),
        });
        return undefined;
      }
    }
  }
  return undefined;
}

export async function fetchChatChannels(): Promise<ChatChannelRow[]> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const rows = await tryFetchChatChannelsFromPg(dataSchema, empresa_id);
    if (rows !== undefined) return rows;
  }

  const selectAttempts = [
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, connection_mode, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config, created_at, updated_at",
  ];

  let data: Record<string, unknown>[] | null = null;
  let lastError: { message: string } | null = null;

  for (let i = 0; i < selectAttempts.length; i++) {
    const sel = selectAttempts[i]!;
    const res = await supabase
      .from("chat_channels")
      .select(sel)
      .eq("empresa_id", empresa_id)
      .order("created_at", { ascending: true });

    if (!res.error) {
      data = ((res.data ?? []) as unknown) as Record<string, unknown>[];
      lastError = null;
      break;
    }
    lastError = res.error;
    const msg = res.error.message ?? "";
    const retryable =
      i < selectAttempts.length - 1 &&
      (isMissingColumnError(msg, "connection_mode") ||
        isMissingColumnError(msg, "config_status") ||
        isMissingColumnError(msg, "provider_channel_id"));
    if (!retryable) break;
    console.warn("[fetchChatChannels] postgrest_retry_narrow_select", {
      schema: dataSchema,
      attempt: i + 1,
      message: msg.slice(0, 200),
    });
  }

  if (lastError) {
    const msg = lastError.message ?? "";
    if (isLikelyUnexposedTenantChatSchema(dataSchema) && isInvalidPostgrestSchemaError(msg)) {
      throw new Error(POSTGREST_TENANT_SCHEMA_HINT);
    }
    throw new Error(msg);
  }

  const mapped = (data ?? [])
    .map((r) => mapChatChannelRow(r))
    .filter((r) => typeof r.id === "string" && r.id.trim().length > 0);
  await enrichChatChannelsSecretFlagsFromPg(dataSchema, empresa_id, mapped);
  return mapped;
}

export async function fetchChatChannelById(channelId: string): Promise<ChatChannelRow | null> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const id = channelId.trim();
  if (!id) return null;

  if (isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const row = await tryFetchChatChannelByIdFromPg(dataSchema, empresa_id, id);
    if (row !== undefined) return row;
  }

  const selectAttempts = [
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, connection_mode, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config_status, config, created_at, updated_at",
    "id, empresa_id, type, meta_phone_number_id, nombre, provider, provider_channel_id, activo, config, created_at, updated_at",
  ];

  let data: Record<string, unknown> | null = null;
  let lastError: { message: string } | null = null;

  for (let i = 0; i < selectAttempts.length; i++) {
    const sel = selectAttempts[i]!;
    const res = await supabase
      .from("chat_channels")
      .select(sel)
      .eq("id", id)
      .eq("empresa_id", empresa_id)
      .maybeSingle();

    if (!res.error) {
      data = (res.data ?? null) as Record<string, unknown> | null;
      lastError = null;
      break;
    }
    lastError = res.error;
    const msg = res.error.message ?? "";
    const retryable =
      i < selectAttempts.length - 1 &&
      (isMissingColumnError(msg, "connection_mode") ||
        isMissingColumnError(msg, "config_status") ||
        isMissingColumnError(msg, "provider_channel_id"));
    if (!retryable) break;
    console.warn("[fetchChatChannelById] postgrest_retry_narrow_select", {
      schema: dataSchema,
      attempt: i + 1,
      message: msg.slice(0, 200),
    });
  }

  if (lastError) {
    const msg = lastError.message ?? "";
    if (isLikelyUnexposedTenantChatSchema(dataSchema) && isInvalidPostgrestSchemaError(msg)) {
      throw new Error(POSTGREST_TENANT_SCHEMA_HINT);
    }
    throw new Error(msg);
  }
  if (!data) return null;
  const row = mapChatChannelRow(data);
  return row.id.trim().length > 0 ? row : null;
}

export type ChatChannelFormInput = {
  id?: string;
  nombre: string;
  meta_phone_number_id: string;
  provider_channel_id: string;
  activo: boolean;
  display_phone_number?: string;
  /** Token Meta para enviar desde el ERP; en edición, vacío = no cambiar el guardado */
  whatsapp_access_token?: string;
  /** Opcionales Cloud API (se persisten en `config`). */
  meta_waba_id?: string;
  meta_app_id?: string;
  meta_verify_token?: string;
  /** Se guarda en `config.comprobante_validation` (validación de comprobantes WhatsApp). */
  comprobante_validation?: Record<string, unknown>;
  /** Mensajes automáticos livianos en `config.business_automation` (no es chat_flows). */
  business_automation?: Record<string, unknown>;
  /** Estado UI de secciones del formulario en `config.form_section_state`. */
  form_section_state?: Record<string, { active: boolean; expanded: boolean }>;
  /** Persistido en `config.quick_replies_inbox_enabled` (icono rayo en inbox). */
  quick_replies_inbox_enabled?: boolean;
};

function metaChannelConfigStatus(params: {
  activo: boolean;
  phoneId: string;
  hasAccessToken: boolean;
}): "inactive" | "incomplete" | "active" {
  if (!params.activo) return "inactive";
  if (!params.phoneId) return "incomplete";
  if (!params.hasAccessToken) return "incomplete";
  return "active";
}

export type YCloudWhatsappChannelInput = {
  id?: string;
  nombre: string;
  activo: boolean;
  ycloud_api_key?: string;
  ycloud_webhook_secret?: string;
  ycloud_sender_id?: string;
  ycloud_channel_id?: string;
  /** Misma persistencia que Meta: validación de comprobantes, automatización, estado UI de secciones. */
  comprobante_validation?: Record<string, unknown>;
  business_automation?: Record<string, unknown>;
  form_section_state?: Record<string, { active: boolean; expanded: boolean }>;
  quick_replies_inbox_enabled?: boolean;
};

/** WhatsApp vía YCloud (coexistencia). Sin ruta omnicanal Meta. */
export async function saveYCloudWhatsappChannel(input: YCloudWhatsappChannelInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;
  const existingId = typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;
  let config: Record<string, unknown> = {};
  if (existingId) {
    let prevRaw: unknown = null;
    if (tenantPg) {
      prevRaw = await pgSelectChatChannelConfig(pool!, dataSchema, empresa_id, existingId);
    } else {
      const { data: prevRow, error: prevErr } = await supabase
        .from("chat_channels")
        .select("config")
        .eq("id", existingId)
        .eq("empresa_id", empresa_id)
        .maybeSingle();
      if (prevErr) throw postgrestMutationError(dataSchema, prevErr.message);
      prevRaw = prevRow?.config;
    }
    const prev =
      prevRaw && typeof prevRaw === "object" && prevRaw !== null && !Array.isArray(prevRaw)
        ? ({ ...(prevRaw as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    config = { ...prev };
  }
  const keyPatch = input.ycloud_api_key?.trim();
  if (keyPatch) config.ycloud_api_key = keyPatch;
  if (input.ycloud_webhook_secret !== undefined) {
    const s = input.ycloud_webhook_secret.trim();
    if (s) config.ycloud_webhook_secret = s;
  }
  if (input.ycloud_sender_id !== undefined) {
    const s = input.ycloud_sender_id.trim();
    if (s) config.ycloud_sender_id = s;
  }
  if (input.ycloud_channel_id !== undefined) {
    const s = input.ycloud_channel_id.trim();
    if (s) config.ycloud_channel_id = s;
  }

  if (input.comprobante_validation !== undefined) {
    config.comprobante_validation = input.comprobante_validation;
  }
  if (input.business_automation !== undefined) {
    config.business_automation = input.business_automation;
  }
  if (input.form_section_state !== undefined) {
    config.form_section_state = input.form_section_state;
  }
  if (input.quick_replies_inbox_enabled !== undefined) {
    config.quick_replies_inbox_enabled = input.quick_replies_inbox_enabled;
  }

  const hasKey =
    Boolean(keyPatch) ||
    Boolean(
      typeof config.ycloud_api_key === "string" && (config.ycloud_api_key as string).trim().length > 0
    );
  const config_status: "inactive" | "incomplete" | "active" = !input.activo
    ? "inactive"
    : hasKey
      ? "active"
      : "incomplete";

  const base = {
    nombre: input.nombre.trim() || "WhatsApp (YCloud)",
    type: "whatsapp" as const,
    meta_phone_number_id: null as string | null,
    provider: "ycloud",
    provider_channel_id: (input.ycloud_channel_id?.trim() || input.ycloud_sender_id?.trim() || null) as
      | string
      | null,
    activo: input.activo,
    connection_mode: "coexistence",
    config_status,
    config,
  };

  const updatedAt = new Date().toISOString();

  if (existingId) {
    if (tenantPg) {
      const updated = await pgUpdateYCloudWhatsappChannel(pool!, dataSchema, empresa_id, existingId, {
        nombre: base.nombre,
        type: base.type,
        provider: base.provider,
        provider_channel_id: base.provider_channel_id,
        activo: base.activo,
        connection_mode: base.connection_mode,
        config_status: base.config_status,
        config: base.config,
        updated_at: updatedAt,
      });
      if (!updated) throw new Error("No se pudo actualizar el canal.");
      return existingId;
    }
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update({ ...base, updated_at: updatedAt })
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();
    if (error) throw postgrestMutationError(dataSchema, error.message);
    if (!updated) throw new Error("No se pudo actualizar el canal.");
    return existingId;
  }

  if (tenantPg) {
    return pgInsertYCloudWhatsappChannel(pool!, dataSchema, {
      empresa_id,
      nombre: base.nombre,
      type: base.type,
      provider: base.provider,
      provider_channel_id: base.provider_channel_id,
      activo: base.activo,
      connection_mode: base.connection_mode,
      config_status: base.config_status,
      config: base.config,
    });
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
    })
    .select("id")
    .single();
  if (error) throw postgrestMutationError(dataSchema, error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo crear el canal.");
  return newId;
}

export type GenericOmnichannelChannelInput = {
  id?: string;
  type: "instagram" | "facebook" | "linkedin" | "email";
  nombre: string;
  provider: string;
  activo: boolean;
  config?: Record<string, unknown>;
};

/** Canal no WhatsApp: registro base para Etapa 2 (sin phone Meta). */
/**
 * Persiste estado UI de “Respuestas rápidas” sin guardar todo el formulario del canal (p. ej. omnicanal no WhatsApp).
 */
export async function patchChatChannelQuickRepliesSectionState(
  channelId: string,
  slice: { active: boolean; expanded: boolean }
): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;
  const id = channelId.trim();
  if (!id) throw new Error("Canal inválido.");

  let rawCfg: unknown = null;
  if (tenantPg) {
    rawCfg = await pgSelectChatChannelConfig(pool!, dataSchema, empresa_id, id);
    if (rawCfg === null) throw new Error("Canal no encontrado.");
  } else {
    const { data: prevRow, error: fetchErr } = await supabase
      .from("chat_channels")
      .select("config")
      .eq("id", id)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    if (fetchErr) throw postgrestMutationError(dataSchema, fetchErr.message);
    rawCfg = prevRow?.config;
    if (!prevRow) throw new Error("Canal no encontrado.");
  }

  const prevCfg =
    rawCfg && typeof rawCfg === "object" && rawCfg !== null && !Array.isArray(rawCfg)
      ? ({ ...(rawCfg as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const prevFsRaw = prevCfg.form_section_state;
  const prevFs =
    prevFsRaw && typeof prevFsRaw === "object" && !Array.isArray(prevFsRaw)
      ? ({ ...(prevFsRaw as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  prevFs.quick_replies = { active: slice.active, expanded: slice.expanded };
  prevCfg.form_section_state = prevFs;
  prevCfg.quick_replies_inbox_enabled = slice.active;

  const updatedAt = new Date().toISOString();

  if (tenantPg) {
    await pgUpdateChatChannelConfig(pool!, dataSchema, empresa_id, id, prevCfg, updatedAt);
    return;
  }

  const { error } = await supabase
    .from("chat_channels")
    .update({ config: prevCfg, updated_at: updatedAt })
    .eq("id", id)
    .eq("empresa_id", empresa_id);

  if (error) throw postgrestMutationError(dataSchema, error.message);
}

export async function saveGenericOmnichannelChannel(input: GenericOmnichannelChannelInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;
  const existingId = typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;
  let config: Record<string, unknown> = input.config ? { ...input.config } : {};
  if (existingId) {
    let prevRaw: unknown = null;
    if (tenantPg) {
      prevRaw = await pgSelectChatChannelConfig(pool!, dataSchema, empresa_id, existingId);
    } else {
      const { data: prevRow, error: prevErr } = await supabase
        .from("chat_channels")
        .select("config")
        .eq("id", existingId)
        .eq("empresa_id", empresa_id)
        .maybeSingle();
      if (prevErr) throw postgrestMutationError(dataSchema, prevErr.message);
      prevRaw = prevRow?.config;
    }
    const prev =
      prevRaw && typeof prevRaw === "object" && prevRaw !== null && !Array.isArray(prevRaw)
        ? ({ ...(prevRaw as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    config = { ...prev, ...config };
  }

  const config_status: "inactive" | "incomplete" | "active" = !input.activo
    ? "inactive"
    : "incomplete";

  const base = {
    nombre: input.nombre.trim() || input.type,
    type: input.type,
    meta_phone_number_id: null as string | null,
    provider: (input.provider || "meta").trim() || "meta",
    provider_channel_id: null as string | null,
    activo: input.activo,
    connection_mode: "standard" as const,
    config_status,
    config,
  };

  const updatedAt = new Date().toISOString();

  if (existingId) {
    if (tenantPg) {
      const updated = await pgUpdateGenericOmnichannelChannel(pool!, dataSchema, empresa_id, existingId, {
        nombre: base.nombre,
        type: base.type,
        meta_phone_number_id: null,
        provider: base.provider,
        provider_channel_id: null,
        activo: base.activo,
        connection_mode: "standard",
        config_status: base.config_status,
        config: base.config,
        updated_at: updatedAt,
      });
      if (!updated) throw new Error("No se pudo actualizar el canal.");
      return existingId;
    }
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update({ ...base, updated_at: updatedAt })
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();
    if (error) throw postgrestMutationError(dataSchema, error.message);
    if (!updated) throw new Error("No se pudo actualizar el canal.");
    return existingId;
  }

  if (tenantPg) {
    return pgInsertGenericOmnichannelChannel(pool!, dataSchema, {
      empresa_id,
      nombre: base.nombre,
      type: base.type,
      meta_phone_number_id: null,
      provider: base.provider,
      provider_channel_id: null,
      activo: base.activo,
      connection_mode: "standard",
      config_status: base.config_status,
      config: base.config,
    });
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
    })
    .select("id")
    .single();
  if (error) throw postgrestMutationError(dataSchema, error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo crear el canal.");
  return newId;
}

/** Crea o actualiza canal WhatsApp Cloud API (Meta). Devuelve el id del canal. */
export async function saveChatChannel(input: ChatChannelFormInput): Promise<string> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;

  const pid = input.meta_phone_number_id.trim();
  if (!pid) throw new Error("Phone Number ID es obligatorio");

  const existingId =
    typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;

  const disp = input.display_phone_number?.trim();

  let config: Record<string, unknown> = { phone_number_id: pid };
  let previousMetaPhone: string | null = null;
  let existingToken: string | null = null;
  if (existingId) {
    if (tenantPg) {
      const pr = await pgSelectChatChannelMetaPrev(pool!, dataSchema, empresa_id, existingId);
      previousMetaPhone = pr?.meta_phone_number_id?.trim() || null;
      existingToken = pr?.whatsapp_access_token?.trim() || null;
      const prev =
        pr?.config && typeof pr.config === "object" && pr.config !== null && !Array.isArray(pr.config)
          ? ({ ...(pr.config as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      config = { ...prev, phone_number_id: pid };
      if (disp) config.display_phone_number = disp;
    } else {
      const { data: prevRow, error: prevErr } = await supabase
        .from("chat_channels")
        .select("config, meta_phone_number_id, whatsapp_access_token")
        .eq("id", existingId)
        .eq("empresa_id", empresa_id)
        .maybeSingle();
      if (prevErr) throw postgrestMutationError(dataSchema, prevErr.message);
      previousMetaPhone =
        (prevRow as { meta_phone_number_id?: string | null } | null)?.meta_phone_number_id?.trim() || null;
      existingToken =
        (prevRow as { whatsapp_access_token?: string | null } | null)?.whatsapp_access_token?.trim() || null;
      const prev =
        prevRow?.config &&
        typeof prevRow.config === "object" &&
        prevRow.config !== null &&
        !Array.isArray(prevRow.config)
          ? ({ ...(prevRow.config as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      config = { ...prev, phone_number_id: pid };
      if (disp) config.display_phone_number = disp;
    }
  } else if (disp) {
    config.display_phone_number = disp;
  }

  const waba = input.meta_waba_id?.trim();
  if (waba) config.meta_waba_id = waba;
  const appId = input.meta_app_id?.trim();
  if (appId) config.meta_app_id = appId;
  const verify = input.meta_verify_token?.trim();
  if (verify) config.meta_verify_token = verify;

  if (input.comprobante_validation !== undefined) {
    config.comprobante_validation = input.comprobante_validation;
  }
  if (input.business_automation !== undefined) {
    config.business_automation = input.business_automation;
  }
  if (input.form_section_state !== undefined) {
    config.form_section_state = input.form_section_state;
  }
  if (input.quick_replies_inbox_enabled !== undefined) {
    config.quick_replies_inbox_enabled = input.quick_replies_inbox_enabled;
  }

  const tokenPatch = input.whatsapp_access_token?.trim();
  const hasAccessToken = Boolean(tokenPatch) || Boolean(existingToken);

  const config_status = metaChannelConfigStatus({
    activo: input.activo,
    phoneId: pid,
    hasAccessToken,
  });

  const base = {
    nombre: input.nombre.trim() || "WhatsApp",
    type: "whatsapp" as const,
    meta_phone_number_id: pid,
    provider: "meta",
    provider_channel_id: input.provider_channel_id.trim() || pid,
    activo: input.activo,
    connection_mode: "official",
    config_status,
    config,
  };

  if (existingId) {
    const updatedAt = new Date().toISOString();
    if (tenantPg) {
      const updated = await pgUpdateChatChannelMetaWhatsapp(pool!, dataSchema, empresa_id, existingId, {
        nombre: base.nombre,
        type: base.type,
        meta_phone_number_id: base.meta_phone_number_id,
        provider: base.provider,
        provider_channel_id: base.provider_channel_id,
        activo: base.activo,
        connection_mode: base.connection_mode,
        config_status: base.config_status,
        config: base.config,
        updated_at: updatedAt,
        whatsapp_access_token_patch: tokenPatch ? tokenPatch : undefined,
      });
      if (!updated) {
        throw new Error("No se pudo actualizar el canal (¿pertenece a tu empresa?).");
      }
      if (previousMetaPhone && previousMetaPhone !== pid) {
        await deleteOmnichannelRouteByMetaPhone(previousMetaPhone);
      }
      await syncOmnichannelRouteForWhatsappChannel({
        metaPhoneNumberId: pid,
        empresaId: empresa_id,
        channelId: existingId,
        activo: input.activo,
        dataSchema,
      });
      return existingId;
    }

    const updatePayload: Record<string, unknown> = {
      ...base,
      updated_at: updatedAt,
    };
    if (tokenPatch) {
      updatePayload.whatsapp_access_token = tokenPatch;
    }
    const { data: updated, error } = await supabase
      .from("chat_channels")
      .update(updatePayload)
      .eq("id", existingId)
      .eq("empresa_id", empresa_id)
      .select("id")
      .maybeSingle();

    if (error) throw postgrestMutationError(dataSchema, error.message);
    if (!updated) {
      throw new Error("No se pudo actualizar el canal (¿pertenece a tu empresa?).");
    }
    if (previousMetaPhone && previousMetaPhone !== pid) {
      await deleteOmnichannelRouteByMetaPhone(previousMetaPhone);
    }
    await syncOmnichannelRouteForWhatsappChannel({
      metaPhoneNumberId: pid,
      empresaId: empresa_id,
      channelId: existingId,
      activo: input.activo,
      dataSchema,
    });
    return existingId;
  }

  if (tenantPg) {
    const newId = await pgInsertChatChannelMetaWhatsapp(pool!, dataSchema, {
      empresa_id,
      nombre: base.nombre,
      type: base.type,
      meta_phone_number_id: base.meta_phone_number_id,
      provider: base.provider,
      provider_channel_id: base.provider_channel_id,
      activo: base.activo,
      connection_mode: base.connection_mode,
      config_status: base.config_status,
      config: base.config,
      whatsapp_access_token: tokenPatch || null,
    });
    await syncOmnichannelRouteForWhatsappChannel({
      metaPhoneNumberId: pid,
      empresaId: empresa_id,
      channelId: newId,
      activo: input.activo,
      dataSchema,
    });
    return newId;
  }

  const { data: inserted, error } = await supabase
    .from("chat_channels")
    .insert({
      empresa_id,
      ...base,
      whatsapp_access_token: tokenPatch || null,
    })
    .select("id")
    .single();

  if (error) throw postgrestMutationError(dataSchema, error.message);
  const newId = inserted?.id as string | undefined;
  if (!newId) throw new Error("No se pudo obtener el id del canal creado.");
  await syncOmnichannelRouteForWhatsappChannel({
    metaPhoneNumberId: pid,
    empresaId: empresa_id,
    channelId: newId,
    activo: input.activo,
    dataSchema,
  });
  return newId;
}

/**
 * Activa o desactiva un canal WhatsApp sin borrar la fila ni credenciales guardadas.
 * Meta: sincroniza `omnichannel_routes` igual que al guardar desde el formulario.
 */
export async function patchChatChannelActivo(channelId: string, activo: boolean): Promise<void> {
  const id = channelId.trim();
  if (!id) throw new Error("Canal inválido.");

  const row = await fetchChatChannelById(id);
  if (!row) throw new Error("Canal no encontrado.");
  if (normalizeChannelType(row.type) !== "whatsapp") {
    throw new Error("Solo se puede activar o desactivar canales WhatsApp desde este acceso.");
  }

  const prov = String(row.provider ?? "meta").trim().toLowerCase();
  if (prov === "ycloud") {
    await saveYCloudWhatsappChannel({
      id: row.id,
      nombre: row.nombre?.trim() || "WhatsApp (YCloud)",
      activo,
    });
    return;
  }

  await saveChatChannel({
    id: row.id,
    nombre: row.nombre?.trim() || "WhatsApp",
    meta_phone_number_id: row.meta_phone_number_id?.trim() || "",
    provider_channel_id: row.provider_channel_id?.trim() || row.meta_phone_number_id?.trim() || "",
    activo,
    display_phone_number:
      typeof row.config?.display_phone_number === "string" ? row.config.display_phone_number : "",
    whatsapp_access_token: "",
    meta_waba_id: typeof row.config?.meta_waba_id === "string" ? row.config.meta_waba_id : "",
    meta_app_id: typeof row.config?.meta_app_id === "string" ? row.config.meta_app_id : "",
    meta_verify_token: typeof row.config?.meta_verify_token === "string" ? row.config.meta_verify_token : "",
  });
}

export type { ComprobanteValidacionListRow } from "@/lib/chat/comprobante-validation-types";

export async function fetchComprobanteValidacionesForConversation(
  conversationId: string
): Promise<ComprobanteValidacionListRow[]> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const cid = conversationId.trim();
  if (!cid) return [];

  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const ok = await pgConversationBelongsToEmpresa(pool, dataSchema, empresa_id, cid);
    if (!ok) return [];
    return pgFetchComprobanteValidacionesForConversation(pool, dataSchema, empresa_id, cid);
  }

  const { data: conv, error: cErr } = await supabase
    .from("chat_conversations")
    .select("id")
    .eq("id", cid)
    .eq("empresa_id", empresa_id)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!conv) return [];

  const { data, error } = await supabase
    .from("chat_comprobante_validaciones")
    .select(
      "id, estado_validacion, motivo_validacion, comprobante_url, flow_code, created_at, ocr_referencia, ocr_monto, monto_validacion_esperado_gs, monto_validacion_ocr_gs, monto_validacion_diferencia_gs, monto_validacion_status, bank_val_titular_esperado, bank_val_cuenta_esperada, bank_val_alias_esperado, bank_val_titular_ocr, bank_val_cuenta_ocr, bank_val_alias_ocr, bank_val_coincidencias, bank_val_min_requeridas, bank_val_status"
    )
    .eq("conversation_id", cid)
    .eq("empresa_id", empresa_id)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ComprobanteValidacionListRow[];
}

export async function approveComprobanteValidacion(validacionId: string): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const id = validacionId.trim();
  if (!id) throw new Error("ID de validación inválido");

  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    await pgApproveComprobanteValidacion(pool, dataSchema, empresa_id, id);
    return;
  }

  const { data: row, error: qErr } = await supabase
    .from("chat_comprobante_validaciones")
    .select("id, conversation_id, flow_code, flow_session_id")
    .eq("id", id)
    .eq("empresa_id", empresa_id)
    .maybeSingle();

  if (qErr) throw new Error(qErr.message);
  if (!row) throw new Error("Validación no encontrada");

  const r = row as {
    id: string;
    conversation_id: string;
    flow_code: string;
    flow_session_id: string;
  };

  const now = new Date().toISOString();
  const { error: uErr } = await supabase
    .from("chat_comprobante_validaciones")
    .update({
      estado_validacion: "valido",
      motivo_validacion: "aprobado_manual_erp",
      updated_at: now,
    })
    .eq("id", id)
    .eq("empresa_id", empresa_id);

  if (uErr) throw new Error(uErr.message);

  const upserts = [
    {
      empresa_id,
      conversation_id: r.conversation_id,
      flow_code: r.flow_code.trim(),
      flow_session_id: r.flow_session_id,
      field_name: SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
      field_value: "valido",
    },
    {
      empresa_id,
      conversation_id: r.conversation_id,
      flow_code: r.flow_code.trim(),
      flow_session_id: r.flow_session_id,
      field_name: SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
      field_value: "aprobado_manual_erp",
    },
  ];

  const { error: dErr } = await supabase.from("chat_flow_data").upsert(upserts, {
    onConflict: "flow_session_id,field_name",
  });
  if (dErr) throw new Error(dErr.message);
}

export async function deleteChatChannel(id: string): Promise<void> {
  const { supabase, empresa_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  const tenantPg = isLikelyUnexposedTenantChatSchema(dataSchema) && pool != null;

  let prev: { meta_phone_number_id: string | null; provider: string | null } | null = null;

  if (tenantPg) {
    const del = await pgDeleteChatChannel(pool!, dataSchema, empresa_id, id);
    prev = del ? { meta_phone_number_id: del.meta_phone_number_id, provider: del.provider } : null;
  } else {
    const { data: prevRow, error: selErr } = await supabase
      .from("chat_channels")
      .select("meta_phone_number_id, provider")
      .eq("id", id)
      .eq("empresa_id", empresa_id)
      .maybeSingle();
    if (selErr) throw postgrestMutationError(dataSchema, selErr.message);
    const { error } = await supabase.from("chat_channels").delete().eq("id", id).eq("empresa_id", empresa_id);
    if (error) throw postgrestMutationError(dataSchema, error.message);
    prev = prevRow as typeof prev;
  }

  const prov = String(prev?.provider ?? "meta").toLowerCase();
  const mp = prev?.meta_phone_number_id?.trim();
  if (mp && prov === "meta") await deleteOmnichannelRouteByMetaPhone(mp);
}
