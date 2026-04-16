/**
 * Alta de lead CRM + enlace a `chat_contacts` vía Postgres (mismo pool que webhooks YCloud).
 * Evita depender de que PostgREST exponga `crm_*` en schemas tenant (`erp_*`).
 *
 * Schemas `er_<uuid>` (solo omnicanal) no contienen `crm_*`: el FK de `chat_contacts.crm_prospecto_id`
 * apunta a `zentra_erp.crm_prospectos`. Se detecta con `information_schema` y se escribe CRM ahí.
 */
import type { Pool, PoolClient } from "pg";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";

const LOG = "[crm][whatsapp-inbound-lead-pg]";

/** Schemas `er_*` omnicanal suelen tener solo `chat_*`; CRM vive en la plantilla compartida. */
async function resolveCrmDataSchema(client: PoolClient, chatSchema: string): Promise<string | null> {
  const r1 = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables t
       WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' AND t.table_name = 'crm_prospectos'
     ) AS ok`,
    [chatSchema]
  );
  if (r1.rows[0]?.ok) return chatSchema;

  const app = assertAllowedChatDataSchema(SUPABASE_APP_SCHEMA);
  if (app === chatSchema) return null;

  const r2 = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables t
       WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' AND t.table_name = 'crm_prospectos'
     ) AS ok`,
    [app]
  );
  if (r2.rows[0]?.ok) {
    console.info(LOG, "crm_schema_plantilla", { chat_schema: chatSchema, crm_schema: app });
    return app;
  }
  return null;
}

function nextNumeroControlFromLast(last: string | null | undefined): string {
  const m = (last ?? "").match(/CRM-(\d+)/i);
  const next = (parseInt(m?.[1] ?? "0", 10) || 0) + 1;
  return `CRM-${String(next).padStart(6, "0")}`;
}

export async function ensureWhatsappInboundCrmLeadPg(input: {
  pool: Pool;
  data_schema: string;
  empresa_id: string;
  contact_id: string;
  conversation_id: string;
  channel_id: string;
  first_message_preview: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const schema = assertAllowedChatDataSchema(input.data_schema);
  const ct = quoteSchemaTable(schema, "chat_contacts");
  const conv = quoteSchemaTable(schema, "chat_conversations");
  const ch = quoteSchemaTable(schema, "chat_channels");
  const ag = quoteSchemaTable(schema, "chat_agents");

  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query(
      `SELECT id::text, crm_prospecto_id::text, phone_number::text, name::text
       FROM ${ct}
       WHERE id = $1::uuid AND empresa_id = $2::uuid
       FOR SHARE`,
      [input.contact_id, input.empresa_id]
    );
    const row0 = cur.rows[0] as
      | { id: string; crm_prospecto_id: string | null; phone_number: string | null; name: string | null }
      | undefined;
    if (!row0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Contacto no encontrado (PG)" };
    }
    if (row0.crm_prospecto_id && String(row0.crm_prospecto_id).trim()) {
      await client.query("COMMIT");
      return { ok: true };
    }

    const crmSchema = await resolveCrmDataSchema(client, schema);
    if (!crmSchema) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: `No hay tabla crm_prospectos en "${schema}" ni en "${SUPABASE_APP_SCHEMA}"`,
      };
    }
    const ce = quoteSchemaTable(crmSchema, "crm_etapas");
    const cp = quoteSchemaTable(crmSchema, "crm_prospectos");
    const cn = quoteSchemaTable(crmSchema, "crm_notas");

    let etapaCodigo = "LEAD";
    try {
      const etRes = await client.query(
        `SELECT codigo::text AS codigo
         FROM ${ce}
         WHERE empresa_id = $1::uuid AND activo = true
         ORDER BY orden ASC NULLS LAST`,
        [input.empresa_id]
      );
      const etRows = (etRes.rows ?? []) as { codigo: string }[];
      const terminal = new Set(["GANADO", "PERDIDO"]);
      etapaCodigo =
        etRows.find((r) => r.codigo && !terminal.has(String(r.codigo).toUpperCase()))?.codigo ??
        etRows[0]?.codigo ??
        "LEAD";
      etapaCodigo = String(etapaCodigo || "LEAD").trim() || "LEAD";
      if (etRows.length === 0) {
        console.warn(LOG, "crm_etapas_vacío_usando_LEAD", {
          empresa_id: input.empresa_id,
          chat_schema: schema,
          crm_schema: crmSchema,
        });
      }
    } catch (e) {
      console.warn(LOG, "crm_etapas_omitido", e instanceof Error ? e.message : e);
      etapaCodigo = "LEAD";
    }

    let creadoPor = "WhatsApp";
    try {
      const chRes = await client.query(
        `SELECT nombre::text AS nombre, provider::text AS provider, type::text AS type
         FROM ${ch}
         WHERE id = $1::uuid AND empresa_id = $2::uuid
         LIMIT 1`,
        [input.channel_id, input.empresa_id]
      );
      const chRow = chRes.rows[0] as { nombre?: string | null; provider?: string | null; type?: string | null } | undefined;
      const nombre = chRow?.nombre?.trim();
      creadoPor =
        nombre ||
        (String(chRow?.provider ?? "whatsapp").toLowerCase() === "ycloud"
          ? `WhatsApp (${String(chRow?.type ?? "whatsapp")}) · YCloud`
          : `WhatsApp (${String(chRow?.type ?? "whatsapp")})`);
    } catch (e) {
      console.warn(LOG, "canal_nombre_omitido", e instanceof Error ? e.message : e);
    }

    const advRes = await client.query(
      `SELECT trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) AS full_name,
              u.email::text AS email
       FROM ${conv} c
       LEFT JOIN ${ag} a ON a.id = c.assigned_agent_id AND a.empresa_id = c.empresa_id
       LEFT JOIN public.usuarios u ON u.id = a.usuario_id
       WHERE c.id = $1::uuid AND c.empresa_id = $2::uuid
       LIMIT 1`,
      [input.conversation_id, input.empresa_id]
    );
    const adv = advRes.rows[0] as { full_name?: string | null; email?: string | null } | undefined;
    const responsable =
      (adv?.full_name?.trim() || adv?.email?.trim() || null) as string | null;

    const phone = String(row0.phone_number ?? "").trim();
    const displayName = String(row0.name ?? "").trim() || phone || "Contacto WhatsApp";

    const lastNum = await client.query(
      `SELECT numero_control::text AS numero_control
       FROM ${cp}
       WHERE empresa_id = $1::uuid
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [input.empresa_id]
    );
    const numeroControl = nextNumeroControlFromLast(
      (lastNum.rows[0] as { numero_control?: string } | undefined)?.numero_control
    );

    const ins = await client.query(
      `INSERT INTO ${cp} (
         empresa_id, numero_control, empresa, contacto, email, telefono,
         servicio, valor_estimado, etapa, proxima_accion, fecha_proxima_accion,
         creado_por, origen_creacion, origen_detalle, responsable
       ) VALUES (
         $1::uuid, $2::text, $3::text, $4::text, NULL, $5::text,
         $6::text, 0, $7::text, NULL, NULL,
         $8::text, 'whatsapp', NULL, $9::text
       )
       RETURNING id::text`,
      [
        input.empresa_id,
        numeroControl,
        "WhatsApp",
        displayName,
        phone || null,
        "Consulta por WhatsApp",
        etapaCodigo,
        creadoPor,
        responsable,
      ]
    );
    const prospectoId = (ins.rows[0] as { id?: string } | undefined)?.id;
    if (!prospectoId) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Insert CRM sin id" };
    }

    const preview = input.first_message_preview?.trim();
    if (preview) {
      await client.query(
        `INSERT INTO ${cn} (empresa_id, prospecto_id, texto)
         VALUES ($1::uuid, $2::uuid, $3::text)`,
        [input.empresa_id, prospectoId, preview]
      );
    }

    await client.query(
      `UPDATE ${ct}
       SET crm_prospecto_id = $1::uuid, updated_at = now()
       WHERE id = $2::uuid AND empresa_id = $3::uuid`,
      [prospectoId, input.contact_id, input.empresa_id]
    );

    await client.query("COMMIT");
    console.info(LOG, "lead_creado", {
      prospecto_id: prospectoId,
      contact_id: input.contact_id,
      chat_schema: schema,
      crm_schema: crmSchema,
    });
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    console.error(LOG, "error", msg);
    return { ok: false, error: msg };
  } finally {
    client.release();
  }
}
