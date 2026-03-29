import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMPROBANTE_BUTTON_IDS,
  type ComprobanteEstadoValidacion,
  type ComprobanteValidationSettings,
  type OnMissingBehavior,
  type OcrFieldKey,
  parseComprobanteValidationConfig,
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_HASH_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_OCR_BANCO_FIELD,
  SORTEO_COMPROBANTE_OCR_FECHA_FIELD,
  SORTEO_COMPROBANTE_OCR_HORA_FIELD,
  SORTEO_COMPROBANTE_OCR_MONTO_FIELD,
  SORTEO_COMPROBANTE_OCR_REF_FIELD,
  SORTEO_COMPROBANTE_OCR_TEXT_FIELD,
  SORTEO_COMPROBANTE_VALIDACION_ID_FIELD,
} from "@/lib/chat/comprobante-validation-types";
import { runGoogleVisionDocumentOcr } from "@/lib/chat/comprobante-vision-ocr";
import {
  SORTEO_COMPROBANTE_MEDIA_ID_FIELD,
  SORTEO_COMPROBANTE_URL_FIELD,
} from "@/lib/sorteos/sorteo-order-from-chat";

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function ocrFingerprint(fullText: string): string {
  const n = normalizeWs(fullText).toLowerCase();
  if (!n) return "";
  return createHash("sha256").update(n, "utf8").digest("hex");
}

export type ExtractedReceiptFields = {
  monto: string;
  referencia: string;
  fecha: string;
  hora: string;
  banco: string;
  texto_completo: string;
};

/** Heurística liviana para comprobantes PY / transferencias (no reemplaza revisión humana). */
export function extractReceiptFieldsFromOcr(fullText: string): ExtractedReceiptFields {
  const t = fullText || "";
  const lines = t.split(/\r?\n/).map((l) => l.trim());

  let monto = "";
  const montoRe = /(?:Gs\.?\s*|₲\s*|PYG\s*)?(\d{1,3}(?:\.\d{3})+|\d{4,})/gi;
  let m: RegExpExecArray | null;
  const montos: string[] = [];
  while ((m = montoRe.exec(t)) !== null) {
    const raw = m[1]?.replace(/\./g, "") ?? "";
    if (raw.length >= 4) montos.push(raw);
  }
  if (montos.length > 0) {
    monto = montos.sort((a, b) => b.length - a.length)[0] ?? "";
  }

  let referencia = "";
  // `referencia` antes de `ref` para no matchear el prefijo "Ref" de la palabra "Referencia".
  const refRe =
    /(?:referencia|operaci[oó]n|comprobante|n[°º]|cod\.?|nro\.?|ref\.?)\s*[:\s.-]*([A-Z0-9][A-Z0-9\-/.]{5,})/i;
  const refM = t.match(refRe);
  if (refM?.[1]) referencia = refM[1].trim();

  let fecha = "";
  const fechaRe = /\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/;
  const fm = t.match(fechaRe);
  if (fm?.[1]) fecha = fm[1];

  let hora = "";
  const horaRe = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/;
  const hm = t.match(horaRe);
  if (hm?.[1]) hora = hm[1];

  let banco = "";
  const banks = [
    "itaú",
    "itau",
    "continental",
    "banco nacional",
    "sudameris",
    "gnb",
    "ueno",
    "basa",
    "familiar",
    "regional",
    "bancop",
    "visión",
    "vision",
    "atlas",
    "bbva",
    "interfisa",
    "amambay",
    "zeta",
  ];
  const tl = t.toLowerCase();
  for (const b of banks) {
    if (tl.includes(b)) {
      banco = b.replace(/\b\w/g, (c) => c.toUpperCase());
      break;
    }
  }

  return {
    monto,
    referencia,
    fecha,
    hora,
    banco,
    texto_completo: normalizeWs(t),
  };
}

function fieldValue(key: OcrFieldKey, extracted: ExtractedReceiptFields): string {
  return extracted[key]?.trim() ?? "";
}

function rankMissing(b: OnMissingBehavior): number {
  if (b === "bloquear") return 3;
  if (b === "revision_manual") return 2;
  return 1;
}

function worstMissing(a: OnMissingBehavior, b: OnMissingBehavior): OnMissingBehavior {
  return rankMissing(a) >= rankMissing(b) ? a : b;
}

async function existsHashDuplicate(
  supabase: SupabaseClient,
  empresaId: string,
  hash: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("chat_comprobante_validaciones")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("comprobante_hash", hash)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

async function existsOcrRefDuplicate(
  supabase: SupabaseClient,
  empresaId: string,
  refNorm: string,
  sameFlowSessionId: string
): Promise<boolean> {
  if (!refNorm) return false;
  const { data, error } = await supabase
    .from("chat_comprobante_validaciones")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("ocr_referencia", refNorm)
    .eq("estado_validacion", "valido")
    .neq("flow_session_id", sameFlowSessionId)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

async function existsOcrFingerprintDuplicate(
  supabase: SupabaseClient,
  empresaId: string,
  fp: string,
  excludeId?: string
): Promise<boolean> {
  if (!fp) return false;
  const { data, error } = await supabase
    .from("chat_comprobante_validaciones")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("ocr_fingerprint", fp)
    .in("estado_validacion", ["valido", "revision_manual"])
    .limit(5);
  if (error || !data?.length) return false;
  for (const row of data) {
    const id = (row as { id: string }).id;
    if (excludeId && id === excludeId) continue;
    return true;
  }
  return false;
}

export type ComprobantePipelineResult =
  | { kind: "disabled" }
  | {
      kind: "resolved";
      validationId: string;
      estado: ComprobanteEstadoValidacion;
      motivo: string;
      flowUpserts: Array<{
        empresa_id: string;
        conversation_id: string;
        flow_code: string;
        flow_session_id: string;
        field_name: string;
        field_value: string;
      }>;
      advance: boolean;
      sendInteractive?: { body: string; buttons: { id: string; title: string }[] };
      sendText?: string;
      humanTakeover?: boolean;
    };

type PipelineCtx = {
  supabase: SupabaseClient;
  empresaId: string;
  conversationId: string;
  channelId: string;
  flowCode: string;
  flowSessionId: string;
  mediaId: string;
  publicUrl: string;
  bytes: Buffer;
  mimeType: string;
  settings: ComprobanteValidationSettings;
  /**
   * Solo pruebas automatizadas: si se define, no se llama a Vision y se usa como texto OCR crudo.
   */
  ocrTextOverride?: string | null;
};

async function insertValidationRow(
  supabase: SupabaseClient,
  input: {
    empresa_id: string;
    conversation_id: string;
    flow_session_id: string;
    channel_id: string;
    flow_code: string;
    comprobante_url: string;
    comprobante_media_id: string;
    comprobante_hash: string;
    estado_validacion: ComprobanteEstadoValidacion;
    motivo_validacion: string;
    ocr_text_raw: string | null;
    ocr_monto: string | null;
    ocr_referencia: string | null;
    ocr_fecha: string | null;
    ocr_hora: string | null;
    ocr_banco: string | null;
    ocr_fingerprint: string | null;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("chat_comprobante_validaciones")
    .insert(input)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = (data as { id?: string })?.id;
  if (!id) throw new Error("No se pudo crear registro de validación");
  return id;
}

export async function runComprobanteValidationPipeline(ctx: PipelineCtx): Promise<ComprobantePipelineResult> {
  const { supabase, settings } = ctx;
  if (!settings.enabled) {
    return { kind: "disabled" };
  }

  const hash = sha256Hex(ctx.bytes);
  const fc = ctx.flowCode.trim();
  const sid = ctx.flowSessionId.trim();

  type FlowUpsertRow = {
    empresa_id: string;
    conversation_id: string;
    flow_code: string;
    flow_session_id: string;
    field_name: string;
    field_value: string;
  };

  const baseUpserts = (extra: Array<[string, string]>): FlowUpsertRow[] => {
    const pairs: Array<[string, string]> = [
      [SORTEO_COMPROBANTE_URL_FIELD, ctx.publicUrl],
      [SORTEO_COMPROBANTE_MEDIA_ID_FIELD, ctx.mediaId],
      [SORTEO_COMPROBANTE_HASH_FIELD, hash],
      ...extra,
    ];
    return pairs.map(([field_name, field_value]) => ({
      empresa_id: ctx.empresaId,
      conversation_id: ctx.conversationId,
      flow_code: fc,
      flow_session_id: sid,
      field_name,
      field_value,
    }));
  };

  // --- Hash duplicado ---
  if (settings.deteccion_duplicados_hash && settings.bloquear_por_hash_duplicado) {
    const dup = await existsHashDuplicate(supabase, ctx.empresaId, hash);
    if (dup) {
      const validationId = await insertValidationRow(supabase, {
        empresa_id: ctx.empresaId,
        conversation_id: ctx.conversationId,
        flow_session_id: sid,
        channel_id: ctx.channelId,
        flow_code: fc,
        comprobante_url: ctx.publicUrl,
        comprobante_media_id: ctx.mediaId,
        comprobante_hash: hash,
        estado_validacion: "duplicado_hash",
        motivo_validacion: "hash_duplicado_empresa",
        ocr_text_raw: null,
        ocr_monto: null,
        ocr_referencia: null,
        ocr_fecha: null,
        ocr_hora: null,
        ocr_banco: null,
        ocr_fingerprint: null,
      });
      return {
        kind: "resolved",
        validationId,
        estado: "duplicado_hash",
        motivo: "hash_duplicado_empresa",
        flowUpserts: baseUpserts([
          [SORTEO_COMPROBANTE_VALIDACION_ID_FIELD, validationId],
          [SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD, "duplicado_hash"],
          [SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD, "hash_duplicado_empresa"],
        ]),
        advance: false,
        sendInteractive: {
          body: settings.messages.hash_duplicado,
          buttons: [
            { id: COMPROBANTE_BUTTON_IDS.enviar_otro, title: settings.messages.boton_otro_titulo.slice(0, 20) },
            {
              id: COMPROBANTE_BUTTON_IDS.hablar_asesor,
              title: settings.messages.boton_asesor_titulo.slice(0, 20),
            },
          ],
        },
      };
    }
  }

  // --- OCR (siempre se intenta si el hash no está duplicado; PDF sin API async → fallo controlado) ---
  const mime = (ctx.mimeType || "").toLowerCase();
  const isPdf = mime.includes("pdf");
  let fullText = "";
  let ocrFailedReason: string | null = null;

  if (!isPdf) {
    if (ctx.ocrTextOverride !== undefined && ctx.ocrTextOverride !== null) {
      fullText = ctx.ocrTextOverride;
    } else {
      try {
        const r = await runGoogleVisionDocumentOcr(ctx.bytes);
        fullText = r.fullText;
      } catch (e) {
        ocrFailedReason = e instanceof Error ? e.message : "ocr_error";
      }
    }
  } else {
    ocrFailedReason = "pdf_sin_ocr_automatico";
  }

  const ocrInsuficiente = !fullText.trim() || Boolean(ocrFailedReason);

  if (settings.ocr_obligatorio && ocrInsuficiente) {
    const motivo = ocrFailedReason ?? "ocr_vacio";
    const behavior = settings.ocr_fallo_comportamiento;
    const estadoInsert: ComprobanteEstadoValidacion =
      behavior === "bloquear" ? "ocr_error" : behavior === "revision_manual" ? "revision_manual" : "valido";

    const validationId = await insertValidationRow(supabase, {
      empresa_id: ctx.empresaId,
      conversation_id: ctx.conversationId,
      flow_session_id: sid,
      channel_id: ctx.channelId,
      flow_code: fc,
      comprobante_url: ctx.publicUrl,
      comprobante_media_id: ctx.mediaId,
      comprobante_hash: hash,
      estado_validacion: estadoInsert,
      motivo_validacion: motivo,
      ocr_text_raw: fullText || null,
      ocr_monto: null,
      ocr_referencia: null,
      ocr_fecha: null,
      ocr_hora: null,
      ocr_banco: null,
      ocr_fingerprint: null,
    });

    const estado: ComprobanteEstadoValidacion = estadoInsert;

    const ups = baseUpserts([
      [SORTEO_COMPROBANTE_VALIDACION_ID_FIELD, validationId],
      [SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD, estado],
      [SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD, motivo],
      [SORTEO_COMPROBANTE_OCR_TEXT_FIELD, fullText],
    ]);

    if (behavior === "bloquear") {
      return {
        kind: "resolved",
        validationId,
        estado,
        motivo,
        flowUpserts: ups,
        advance: false,
        sendInteractive: {
          body: settings.messages.ocr_insuficiente,
          buttons: [
            { id: COMPROBANTE_BUTTON_IDS.enviar_otro, title: settings.messages.boton_otro_titulo.slice(0, 20) },
            {
              id: COMPROBANTE_BUTTON_IDS.hablar_asesor,
              title: settings.messages.boton_asesor_titulo.slice(0, 20),
            },
          ],
        },
      };
    }
    if (behavior === "revision_manual") {
      const takeover = settings.revision_manual_activar_takeover;
      return {
        kind: "resolved",
        validationId,
        estado,
        motivo,
        flowUpserts: ups,
        advance: !takeover,
        sendText: settings.messages.revision_manual,
        humanTakeover: takeover,
      };
    }
    // continuar sin OCR útil: marcamos válido para no frenar operación (config explícita)
    return {
      kind: "resolved",
      validationId,
      estado: "valido",
      motivo: "ocr_omitido_continuar",
      flowUpserts: ups,
      advance: true,
    };
  }

  // OCR no obligatorio pero insuficiente: seguir con texto vacío (puede disparar reglas por campo).
  if (!fullText.trim() && !settings.ocr_obligatorio && ocrInsuficiente) {
    fullText = "";
  }

  const extracted = extractReceiptFieldsFromOcr(fullText);
  const fp =
    settings.ocr_fields.texto_completo.use_duplicate_detection && extracted.texto_completo
      ? ocrFingerprint(extracted.texto_completo)
      : null;

  const refStored = extracted.referencia.trim().toUpperCase() || null;

  // --- Reglas campos analizados / obligatorios ---
  let missingWorst: OnMissingBehavior = "continuar";
  const missingParts: string[] = [];
  const keys: OcrFieldKey[] = ["monto", "referencia", "fecha", "hora", "banco", "texto_completo"];
  for (const key of keys) {
    const rule = settings.ocr_fields[key];
    if (!rule.analyzed) continue;
    const val = fieldValue(key, extracted);
    if (!val && rule.required) {
      missingWorst = worstMissing(missingWorst, rule.on_missing);
      missingParts.push(key);
    }
  }

  // --- Duplicado OCR (referencia o huella texto) ---
  let duplicadoOcr = false;
  if (settings.bloquear_por_ocr_duplicado) {
    if (settings.ocr_fields.referencia.use_duplicate_detection && refStored) {
      duplicadoOcr = await existsOcrRefDuplicate(supabase, ctx.empresaId, refStored, sid);
    }
    if (!duplicadoOcr && settings.ocr_fields.texto_completo.use_duplicate_detection && fp) {
      duplicadoOcr = await existsOcrFingerprintDuplicate(supabase, ctx.empresaId, fp, sid);
    }
  }

  // --- Sospecha heurística (solo si hubo texto OCR; si OCR es opcional y vino vacío, no forzar revisión por longitud) ---
  const sospecha =
    settings.revision_manual_si_sospecha_ocr &&
    settings.ocr_obligatorio &&
    fullText.length > 0 &&
    fullText.length < settings.ocr_min_chars_sospecha;

  // Resolver prioridad: duplicado OCR > missing bloquear > missing revision > sospecha > válido
  let estado: ComprobanteEstadoValidacion = "valido";
  let motivo = "ok";

  if (duplicadoOcr) {
    estado = "duplicado_ocr";
    motivo = "ocr_duplicado_referencia_o_huella";
  } else if (missingWorst === "bloquear") {
    estado = "ocr_error";
    motivo = `campo_obligatorio:${missingParts.join(",")}`;
  } else if (missingWorst === "revision_manual") {
    estado = "revision_manual";
    motivo = `campo_faltante_revision:${missingParts.join(",")}`;
  } else if (sospecha) {
    estado = "revision_manual";
    motivo = "ocr_texto_corto_sospecha";
  }

  const validationId = await insertValidationRow(supabase, {
    empresa_id: ctx.empresaId,
    conversation_id: ctx.conversationId,
    flow_session_id: sid,
    channel_id: ctx.channelId,
    flow_code: fc,
    comprobante_url: ctx.publicUrl,
    comprobante_media_id: ctx.mediaId,
    comprobante_hash: hash,
    estado_validacion: estado,
    motivo_validacion: motivo,
    ocr_text_raw: fullText || null,
    ocr_monto: extracted.monto || null,
    ocr_referencia: refStored,
    ocr_fecha: extracted.fecha || null,
    ocr_hora: extracted.hora || null,
    ocr_banco: extracted.banco || null,
    ocr_fingerprint: fp,
  });

  const flowUpserts = baseUpserts([
    [SORTEO_COMPROBANTE_VALIDACION_ID_FIELD, validationId],
    [SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD, estado],
    [SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD, motivo],
    [SORTEO_COMPROBANTE_OCR_TEXT_FIELD, fullText],
    [SORTEO_COMPROBANTE_OCR_MONTO_FIELD, extracted.monto],
    [SORTEO_COMPROBANTE_OCR_REF_FIELD, extracted.referencia],
    [SORTEO_COMPROBANTE_OCR_FECHA_FIELD, extracted.fecha],
    [SORTEO_COMPROBANTE_OCR_HORA_FIELD, extracted.hora],
    [SORTEO_COMPROBANTE_OCR_BANCO_FIELD, extracted.banco],
  ]);

  if (estado === "duplicado_ocr") {
    return {
      kind: "resolved",
      validationId,
      estado,
      motivo,
      flowUpserts,
      advance: false,
      sendInteractive: {
        body: settings.messages.ocr_duplicado,
        buttons: [
          { id: COMPROBANTE_BUTTON_IDS.enviar_otro, title: settings.messages.boton_otro_titulo.slice(0, 20) },
          {
            id: COMPROBANTE_BUTTON_IDS.hablar_asesor,
            title: settings.messages.boton_asesor_titulo.slice(0, 20),
          },
        ],
      },
    };
  }

  if (estado === "ocr_error" && missingWorst === "bloquear") {
    return {
      kind: "resolved",
      validationId,
      estado,
      motivo,
      flowUpserts,
      advance: false,
      sendInteractive: {
        body: settings.messages.ocr_insuficiente,
        buttons: [
          { id: COMPROBANTE_BUTTON_IDS.enviar_otro, title: settings.messages.boton_otro_titulo.slice(0, 20) },
          {
            id: COMPROBANTE_BUTTON_IDS.hablar_asesor,
            title: settings.messages.boton_asesor_titulo.slice(0, 20),
          },
        ],
      },
    };
  }

  if (estado === "revision_manual") {
    const takeover = settings.revision_manual_activar_takeover;
    return {
      kind: "resolved",
      validationId,
      estado,
      motivo,
      flowUpserts,
      // Con takeover el bot no debe avanzar el flujo: queda a cargo del operador humano.
      advance: !takeover,
      sendText: settings.messages.revision_manual,
      humanTakeover: takeover,
    };
  }

  return {
    kind: "resolved",
    validationId,
    estado: "valido",
    motivo: "ok",
    flowUpserts,
    advance: true,
  };
}

const DEFAULT_MSG_COMPROBANTE_NO_CIERRA =
  "Todavía no podemos cerrar esta compra: el comprobante debe estar validado. Si ya enviaste uno, esperá la revisión o contactá a un asesor.";

/** Mensaje al cliente cuando toca Confirmar pero `estado_validacion` ≠ valido. */
export async function mensajeClienteComprobanteNoValido(
  supabase: SupabaseClient,
  conversationId: string,
  estado: string
): Promise<string> {
  const { data: conv, error } = await supabase
    .from("chat_conversations")
    .select("channel_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conv?.channel_id) return DEFAULT_MSG_COMPROBANTE_NO_CIERRA;
  const { data: ch } = await supabase
    .from("chat_channels")
    .select("config")
    .eq("id", conv.channel_id as string)
    .maybeSingle();
  const s = parseComprobanteValidationConfig(ch?.config);
  if (estado === "revision_manual") return s.messages.revision_manual;
  if (estado === "duplicado_hash") return s.messages.hash_duplicado;
  if (estado === "duplicado_ocr") return s.messages.ocr_duplicado;
  if (estado === "ocr_error") return s.messages.ocr_insuficiente;
  return DEFAULT_MSG_COMPROBANTE_NO_CIERRA;
}
