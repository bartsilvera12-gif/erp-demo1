import type { Pool } from "pg";
import {
  buildFlowSessionMap,
  isActivelyBotHandledConversation,
  type FlowSessionRowMin,
} from "@/lib/chat/actively-bot-handled";
import { parseComprobanteValidationConfig } from "@/lib/chat/comprobante-validation-types";
import {
  getOmnicanalScope,
  isOmnicanalAdminScope,
  OMNICANAL_IMPOSSIBLE_CONVERSATION_ID,
  resolveQueueIdsForUsuarios,
  shouldBypassOmnicanalConversationScope,
} from "@/lib/chat/omnicanal-scope";
import { buildPgOmnicanalConversationScopeAndClause } from "@/lib/chat/omnicanal-scope-pg";
import { pgSelectChatAgentIdsForUsuarios } from "@/lib/chat/omnicanal-scope-pg";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import type {
  ChatInboxFilters,
  ConversacionesVista,
  InboxConversation,
} from "@/lib/chat/actions";
import { normalizeChannelType } from "@/lib/chat/channel-type-utils";

type FlowCtx = {
  supabase: AppSupabaseClient;
  catalogSr: AppSupabaseClient;
  empresa_id: string;
  usuario_id: string;
};

function isoPg(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

async function pgActiveFlowCodes(pool: Pool, schema: string, empresaId: string): Promise<Set<string>> {
  try {
    const qt = quoteSchemaTable(schema, "chat_flows");
    const q = `
      SELECT flow_code::text AS flow_code FROM ${qt}
      WHERE empresa_id = $1::uuid
        AND COALESCE(activo, false) = true
        AND (
          trim(coalesce(channel::text, '')) = ''
          OR lower(trim(coalesce(channel::text, ''))) = 'whatsapp'
        )
    `;
    const r = await pool.query(q, [empresaId]);
    return new Set(
      (r.rows ?? [])
        .map((row: { flow_code?: string }) => String(row.flow_code ?? "").trim())
        .filter(Boolean)
    );
  } catch (e) {
    console.warn("[bot-routing]", "pgActiveFlowCodes_failed", {
      empresa_id: empresaId,
      schema,
      message: e instanceof Error ? e.message : String(e),
    });
    return new Set();
  }
}

async function pgFetchConversationsWithColumns(
  pool: Pool,
  schema: string,
  whereSql: string,
  params: unknown[],
  variant: "full" | "legacy" | "min"
): Promise<Record<string, unknown>[] | null> {
  const qt = quoteSchemaTable(schema, "chat_conversations");
  const colsFull = `
    id, status, priority, queue_id, assignment_wait_code, assigned_agent_id,
    last_message_at, last_message_preview, unread_count, contact_id, channel_id,
    flow_code, flow_status, human_taken_over, active_flow_session_id
  `;
  const colsLegacy = `
    id, status, priority, queue_id, assigned_agent_id,
    last_message_at, last_message_preview, unread_count, contact_id, channel_id,
    flow_code, flow_status, human_taken_over, active_flow_session_id
  `;
  const colsMin = `
    id, status, queue_id, assigned_agent_id,
    last_message_at, last_message_preview, unread_count, contact_id, channel_id,
    flow_code, flow_status, human_taken_over, active_flow_session_id
  `;
  const cols = variant === "full" ? colsFull : variant === "legacy" ? colsLegacy : colsMin;
  const q = `
    SELECT ${cols}
    FROM ${qt}
    WHERE ${whereSql}
    ORDER BY last_message_at DESC NULLS LAST
  `;
  try {
    const r = await pool.query(q, params);
    return (r.rows ?? []) as Record<string, unknown>[];
  } catch {
    return null;
  }
}

async function pgMapLastMessageByConversation(
  pool: Pool,
  schema: string,
  empresaId: string,
  convIds: string[]
): Promise<Record<string, { created_at: string; from_me: boolean }>> {
  const unique = [...new Set(convIds.map((x) => x.trim()).filter(Boolean))];
  const out: Record<string, { created_at: string; from_me: boolean }> = {};
  if (unique.length === 0) return out;
  const qt = quoteSchemaTable(schema, "chat_messages");
  const batchSize = 80;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const q = `
      SELECT conversation_id::text AS conversation_id, created_at, from_me
      FROM (
        SELECT conversation_id, created_at, from_me,
          ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
        FROM ${qt}
        WHERE empresa_id = $1::uuid AND conversation_id = ANY($2::uuid[])
      ) x
      WHERE rn = 1
    `;
    try {
      const r = await pool.query(q, [empresaId, batch]);
      for (const row of r.rows ?? []) {
        const cid = String((row as { conversation_id?: string }).conversation_id ?? "").trim();
        if (!cid) continue;
        const created_at = isoPg((row as { created_at?: unknown }).created_at) ?? "";
        if (!created_at) continue;
        out[cid] = {
          created_at,
          from_me: Boolean((row as { from_me?: boolean }).from_me),
        };
      }
    } catch {
      /* ignore batch */
    }
  }
  return out;
}

/** Inbox/Bot/Historial con SQL directo en schema tenant (PostgREST sin exponer `erp_*`). */
export async function fetchChatConversationsFromTenantPg(
  pool: Pool,
  dataSchema: string,
  vista: ConversacionesVista,
  filters: ChatInboxFilters | undefined,
  ctx: FlowCtx
): Promise<InboxConversation[]> {
  const { supabase, catalogSr, empresa_id, usuario_id } = ctx;

  const activeFlowCodeSet = await pgActiveFlowCodes(pool, dataSchema, empresa_id);
  if (vista === "bot" && activeFlowCodeSet.size === 0) {
    return [];
  }

  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
    tenantDataSchema: dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  const params: unknown[] = [empresa_id];
  let pi = 2;
  let whereParts: string[] = [`empresa_id = $1::uuid`];

  if (vista === "inbox") {
    whereParts.push(`status IN ('open','pending')`);
  } else if (vista === "bot") {
    whereParts.push(`COALESCE(human_taken_over, false) = false`);
    whereParts.push(`status IN ('open','pending')`);
    whereParts.push(`active_flow_session_id IS NOT NULL`);
  } else if (vista === "historial") {
    whereParts.push(`status = 'closed'`);
  }

  const assignment = filters?.assignment ?? "all";
  if (assignment === "mine") {
    const mids = await pgSelectChatAgentIdsForUsuarios(pool, dataSchema, empresa_id, [usuario_id], true);
    const mids2 =
      mids.length > 0 ? mids : await pgSelectChatAgentIdsForUsuarios(pool, dataSchema, empresa_id, [usuario_id], false);
    if (mids2.length > 0) {
      whereParts.push(`assigned_agent_id = ANY($${pi}::uuid[])`);
      params.push(mids2);
      pi++;
    }
  } else if (assignment === "unassigned") {
    whereParts.push(`assigned_agent_id IS NULL`);
  }

  const fq = filters?.queue_id?.trim();
  if (fq) {
    let queueOk = true;
    if (!bypass && !isOmnicanalAdminScope(scope)) {
      const allowedQueues = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds, dataSchema);
      queueOk = allowedQueues.includes(fq);
    }
    if (queueOk) {
      whereParts.push(`queue_id = $${pi}::uuid`);
      params.push(fq);
      pi++;
    } else {
      whereParts.push(`id = $${pi}::uuid`);
      params.push(OMNICANAL_IMPOSSIBLE_CONVERSATION_ID);
      pi++;
    }
  }

  const fs = filters?.status?.trim().toLowerCase();
  if (fs && ["open", "pending", "closed"].includes(fs)) {
    whereParts.push(`status = $${pi}`);
    params.push(fs);
    pi++;
  }

  const fp = filters?.priority?.trim().toLowerCase();
  if (fp && ["low", "medium", "high"].includes(fp)) {
    whereParts.push(`priority = $${pi}`);
    params.push(fp);
    pi++;
  }

  if (!bypass) {
    const scopeSql = await buildPgOmnicanalConversationScopeAndClause(
      pool,
      dataSchema,
      empresa_id,
      scope,
      pi
    );
    whereParts.push(`(${scopeSql.sql})`);
    params.push(...scopeSql.params);
    pi = scopeSql.nextOffset;
  }

  const whereSql = whereParts.join(" AND ");

  let list =
    (await pgFetchConversationsWithColumns(pool, dataSchema, whereSql, params, "full")) ??
    (await pgFetchConversationsWithColumns(pool, dataSchema, whereSql, params, "legacy")) ??
    (await pgFetchConversationsWithColumns(pool, dataSchema, whereSql, params, "min")) ??
    [];

  const totalAfterQuery = list.length;

  const sessionIds = [
    ...new Set(
      list
        .map((row) => String((row as { active_flow_session_id?: string | null }).active_flow_session_id ?? "").trim())
        .filter(Boolean)
    ),
  ];
  const flowSessionById = new Map<string, FlowSessionRowMin>();
  const sch = dataSchema;
  const sessQt = quoteSchemaTable(sch, "chat_flow_sessions");
  const sessionChunk = 100;
  for (let i = 0; i < sessionIds.length; i += sessionChunk) {
    const chunk = sessionIds.slice(i, i + sessionChunk);
    try {
      const qr = await pool.query(
        `
        SELECT id::text, status::text, flow_code::text, conversation_id::text
        FROM ${sessQt}
        WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])
      `,
        [empresa_id, chunk]
      );
      for (const [k, v] of buildFlowSessionMap(qr.rows as FlowSessionRowMin[]).entries()) {
        flowSessionById.set(k, v);
      }
    } catch {
      /* sin sesiones */
    }
  }

  const isActivelyBot = (row: Record<string, unknown>) =>
    isActivelyBotHandledConversation(row, activeFlowCodeSet, flowSessionById);

  let classifiedAsActivelyBot = 0;
  if (vista === "inbox") {
    list = list.filter((row) => {
      const b = isActivelyBot(row);
      if (b) classifiedAsActivelyBot += 1;
      return !b;
    });
  } else if (vista === "bot") {
    list = list.filter((row) => {
      const b = isActivelyBot(row);
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
    source: "tenant_pg",
  });

  if (list.length === 0) return [];

  const convIdList = list.map((row) => String(row.id ?? "").trim()).filter(Boolean);

  const awaitingById: Record<string, string | null> = {};
  const clientTurnById: Record<string, string | null> = {};
  if (convIdList.length > 0) {
    try {
      const { data: rpcRows, error: rpcErr } = await catalogSr.rpc("neura_inbox_awaiting_reply_since_batch", {
        p_schema: dataSchema,
        p_empresa_id: empresa_id,
        p_conversation_ids: convIdList,
      });
      if (!rpcErr && Array.isArray(rpcRows)) {
        for (const r of rpcRows as {
          conversation_id?: string;
          awaiting_since?: string | null;
          client_turn_since?: string | null;
        }[]) {
          const id = String(r.conversation_id ?? "").trim();
          if (!id) continue;
          awaitingById[id] = r.awaiting_since ?? null;
          clientTurnById[id] = r.client_turn_since ?? null;
        }
      } else if (rpcErr) {
        console.warn("[fetchChatConversations] awaiting_reply RPC:", rpcErr.message);
      }
    } catch (e) {
      console.warn("[fetchChatConversations] awaiting_reply RPC:", e instanceof Error ? e.message : e);
    }

    const lastByConv = await pgMapLastMessageByConversation(pool, sch, empresa_id, convIdList);
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
    try {
      const chQt = quoteSchemaTable(sch, "chat_channels");
      const chr = await pool.query(
        `SELECT id::text, type::text, nombre::text, config FROM ${chQt}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, channelIds]
      );
      channelById = Object.fromEntries(
        (chr.rows ?? []).map((r: Record<string, unknown>) => {
          const id = String(r.id ?? "").trim();
          const cfg = r.config;
          const compOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? parseComprobanteValidationConfig(cfg as Record<string, unknown>).enabled
              : false;
          const qrOn =
            cfg && typeof cfg === "object" && !Array.isArray(cfg)
              ? (cfg as Record<string, unknown>).quick_replies_inbox_enabled !== false
              : true;
          return [
            id,
            {
              type: (r.type as string) ?? "whatsapp",
              nombre: (r.nombre as string) ?? null,
              comprobante_validation_enabled: compOn,
              quick_replies_inbox_enabled: qrOn,
            },
          ];
        })
      );
    } catch {
      console.warn("[fetchChatConversations] chat_channels pg batch falló");
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
    try {
      const qq = quoteSchemaTable(sch, "chat_queues");
      const qr = await pool.query(
        `SELECT id::text, nombre::text FROM ${qq}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, queueIds]
      );
      queueNombreById = Object.fromEntries(
        (qr.rows ?? []).map((r: { id?: string; nombre?: string | null }) => [
          String(r.id ?? ""),
          r.nombre ?? null,
        ])
      );
    } catch {
      console.warn("[fetchChatConversations] chat_queues pg batch falló");
    }
  }

  let agentUsuarioById: Record<string, string> = {};
  if (assignedAgentIds.length > 0) {
    try {
      const aq = quoteSchemaTable(sch, "chat_agents");
      const ar = await pool.query(
        `SELECT id::text, usuario_id::text FROM ${aq}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, assignedAgentIds]
      );
      agentUsuarioById = Object.fromEntries(
        (ar.rows ?? []).map((r: { id?: string; usuario_id?: string }) => [
          String(r.id ?? ""),
          String(r.usuario_id ?? ""),
        ])
      );
    } catch {
      console.warn("[fetchChatConversations] chat_agents pg batch falló");
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
    try {
      const cq = quoteSchemaTable(sch, "chat_contacts");
      const cr = await pool.query(
        `SELECT id::text, name::text, phone_number::text, cliente_id::uuid, crm_prospecto_id::uuid
         FROM ${cq}
         WHERE empresa_id = $1::uuid AND id = ANY($2::uuid[])`,
        [empresa_id, contactIds]
      );
      byId = Object.fromEntries((cr.rows ?? []).map((c) => [String(c.id), c as Record<string, unknown>]));
    } catch {
      console.warn("[fetchChatConversations] chat_contacts pg batch falló");
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

  const priorityFallback = (row: Record<string, unknown>): string =>
    row.priority != null && String(row.priority).trim() !== ""
      ? String(row.priority)
      : "medium";

  return list.map((row) => {
    const c = byId[row.contact_id as string] as
      | {
          id?: string;
          name?: string | null;
          phone_number?: string;
          cliente_id?: string | null;
          crm_prospecto_id?: string | null;
        }
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
    const waitCode = ((row as { assignment_wait_code?: string | null }).assignment_wait_code ?? null) as string | null;
    const aid = (row.assigned_agent_id as string | null | undefined)?.trim();
    const uid = aid ? agentUsuarioById[aid] : undefined;
    const uMeta = uid ? usuarioNombreById[uid] : undefined;
    const assignedName =
      (uMeta?.nombre?.trim() || uMeta?.email?.trim() || null) as string | null;
    const rid = String(row.id ?? "").trim();
    return {
      id: rid,
      status: row.status as string,
      priority: priorityFallback(row),
      queue_id: (row.queue_id as string | null) ?? null,
      queue_name: qRowNombre ?? null,
      assignment_wait_code: typeof waitCode === "string" && waitCode.trim() ? waitCode.trim() : null,
      assigned_agent_id: (row.assigned_agent_id as string | null) ?? null,
      assigned_agent_name: assignedName,
      last_message_at: isoPg(row.last_message_at),
      last_message_preview: (row.last_message_preview as string | null) ?? null,
      unread_count: Number(row.unread_count ?? 0) || 0,
      flow_status: String((row as { flow_status?: string | null }).flow_status ?? ""),
      human_taken_over: Boolean(row.human_taken_over),
      channel: {
        id: channelId,
        type: normalizeChannelType(channelType),
        nombre: channelNombre,
        comprobante_validation_enabled: compValEnabled,
        quick_replies_inbox_enabled: qrInboxEnabled,
      },
      contact: {
        id: c?.id ?? (row.contact_id as string),
        name: c?.name ?? null,
        phone_number: c?.phone_number ?? "",
        cliente_id: c?.cliente_id != null ? String(c.cliente_id) : null,
        crm_prospecto_id: c?.crm_prospecto_id != null ? String(c.crm_prospecto_id) : null,
      },
      awaiting_agent_reply_since: awaitingById[rid] ?? null,
      awaiting_client_reply_since: clientTurnById[rid] ?? null,
    };
  });
}
