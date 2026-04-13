"use client";

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type {
  FacturaElectronicaDTO,
  SifenCancelacionPreviewDTO,
  SifenConsultaLoteUltimaPersistida,
} from "@/lib/sifen/types";
import { decodeXmlNumericEntities } from "@/lib/sifen/decode-xml-entities";
import { SifenEstadoBadge, labelSifenEstado } from "./SifenEstadoBadge";
import { FacturaCorreccionFiscalNC } from "@/components/facturas/FacturaCorreccionFiscalNC";

type Resumen = {
  sifen_config_exists: boolean;
  sifen_config_activa: boolean;
  sifen_ambiente: string | null;
  sifen_plazo_cancelacion_horas: number;
  factura_electronica: FacturaElectronicaDTO | null;
  cancelacion: SifenCancelacionPreviewDTO | null;
};

type PasoEmisionKey = "comercial" | "borrador" | "xml" | "firma" | "set" | "aprobacion";

type PasoEmisionEstado = "pendiente" | "listo" | "espera" | "rechazado";

const PASOS_EMISION: { key: PasoEmisionKey; label: string }[] = [
  { key: "comercial", label: "Comercial" },
  { key: "borrador", label: "Borrador" },
  { key: "xml", label: "XML" },
  { key: "firma", label: "Firma" },
  { key: "set", label: "SET" },
  { key: "aprobacion", label: "Aprobación" },
];

/** Mensaje en lenguaje simple + estado de cada paso del circuito (solo UI). */
function resolverEstadoEmisionVisual(resumen: Resumen): {
  mensaje: string;
  pasos: Record<PasoEmisionKey, PasoEmisionEstado>;
} {
  const sinConfigActiva = !resumen.sifen_config_activa;
  const pendientes: Record<PasoEmisionKey, PasoEmisionEstado> = {
    comercial: "pendiente",
    borrador: "pendiente",
    xml: "pendiente",
    firma: "pendiente",
    set: "pendiente",
    aprobacion: "pendiente",
  };
  const soloComercial: Record<PasoEmisionKey, PasoEmisionEstado> = {
    ...pendientes,
    comercial: "listo",
  };

  if (sinConfigActiva) {
    return {
      mensaje: "Esta empresa aún no tiene configurada la facturación electrónica.",
      pasos: soloComercial,
    };
  }

  const fe = resumen.factura_electronica;
  if (!fe) {
    return {
      mensaje: "Factura comercial creada. Aún no se inició el proceso electrónico.",
      pasos: soloComercial,
    };
  }

  const e = String(fe.estado_sifen);

  switch (e) {
    case "borrador":
      return {
        mensaje: "Borrador electrónico generado. Aún no fue convertido en XML fiscal.",
        pasos: { ...soloComercial, borrador: "listo" },
      };
    case "generado":
      return {
        mensaje: "XML generado. Aún no fue firmado digitalmente.",
        pasos: { ...soloComercial, borrador: "listo", xml: "listo" },
      };
    case "firmado":
      return {
        mensaje:
          "Documento firmado digitalmente. Aún no fue enviado a SET, por lo tanto todavía no es una factura electrónica emitida legalmente.",
        pasos: { ...soloComercial, borrador: "listo", xml: "listo", firma: "listo" },
      };
    case "enviado":
      return {
        mensaje: "Documento enviado a SET. Pendiente de confirmación.",
        pasos: {
          ...soloComercial,
          borrador: "listo",
          xml: "listo",
          firma: "listo",
          set: "espera",
        },
      };
    case "aprobado":
      return {
        mensaje: "Factura electrónica aprobada correctamente.",
        pasos: {
          comercial: "listo",
          borrador: "listo",
          xml: "listo",
          firma: "listo",
          set: "listo",
          aprobacion: "listo",
        },
      };
    case "cancelado":
      return {
        mensaje: "Documento electrónico cancelado en el ERP (trazabilidad conservada).",
        pasos: {
          comercial: "listo",
          borrador: "listo",
          xml: "listo",
          firma: "listo",
          set: "listo",
          aprobacion: "listo",
        },
      };
    case "rechazado":
      return {
        mensaje: "SET rechazó el documento. Revisar observaciones.",
        pasos: {
          comercial: "listo",
          borrador: "listo",
          xml: "listo",
          firma: "listo",
          set: "listo",
          aprobacion: "rechazado",
        },
      };
    case "error_envio":
      return {
        mensaje: fe.error?.trim()
          ? `El envío a SET (TEST) no se completó: ${fe.error.trim()}`
          : "El envío del lote a SET (TEST) no se completó. Revisá el mensaje técnico abajo o reintentá.",
        pasos: {
          ...soloComercial,
          borrador: "listo",
          xml: "listo",
          firma: "listo",
          set: "rechazado",
        },
      };
    default:
      return {
        mensaje:
          "Hay un registro electrónico asociado, pero el estado no es el esperado. Revisá el detalle técnico o contactá soporte.",
        pasos: { ...soloComercial, borrador: "listo" },
      };
  }
}

function clasePaso(estado: PasoEmisionEstado): string {
  switch (estado) {
    case "listo":
      return "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200/80 shadow-sm";
    case "espera":
      return "bg-amber-50 text-amber-900 ring-1 ring-amber-200/80 shadow-sm";
    case "rechazado":
      return "bg-red-50 text-red-800 ring-1 ring-red-200/80 shadow-sm";
    default:
      return "bg-slate-100 text-slate-400 ring-1 ring-slate-200/80";
  }
}

function EstadoEmisionElectronicaBlock({ resumen }: { resumen: Resumen }) {
  const { mensaje, pasos } = resolverEstadoEmisionVisual(resumen);
  const sinConfigActiva = !resumen.sifen_config_activa;

  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-b from-slate-50/80 to-white px-4 py-4 space-y-3">
      <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider">Estado de emisión electrónica</h4>
      <p className="text-sm text-slate-800 leading-relaxed font-medium">{mensaje}</p>
      {sinConfigActiva && (
        <p className="text-xs text-slate-500">
          Si corresponde, podés configurarla en{" "}
          <a href="/configuracion/facturacion-electronica" className="text-[#0EA5E9] font-semibold underline hover:no-underline">
            Configuración → Facturación electrónica
          </a>
          .
        </p>
      )}

      <div className="pt-1">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Avance del proceso</p>
        <div className="flex flex-wrap items-center gap-y-2 gap-x-0.5">
          {PASOS_EMISION.map((p, i) => (
            <Fragment key={p.key}>
              {i > 0 && (
                <span
                  className={`mx-0.5 sm:mx-1 text-xs select-none ${
                    pasos[PASOS_EMISION[i - 1].key] === "listo" ? "text-emerald-400" : "text-slate-200"
                  }`}
                  aria-hidden
                >
                  →
                </span>
              )}
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] sm:text-xs font-semibold ${clasePaso(pasos[p.key])}`}
              >
                {p.label}
              </span>
            </Fragment>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 mt-2 leading-snug">
          Verde: listo · Gris: pendiente · Ámbar: en espera de respuesta · Rojo: rechazo en SET
        </p>
      </div>
    </div>
  );
}

/** Alineado a POST …/sifen/xml: se puede regenerar en `enviado` para corregir DE rechazado o pendiente. */
const XML_BLOQUEADOS = new Set(["aprobado", "cancelado"]);
const FIRMAR_BLOQUEADOS = new Set(["aprobado", "enviado", "cancelado"]);

/** Texto cuando consulta-lote no trae `gResProcLote` (0365 ≠ “sigue en cola”). */
function mensajeConsultaSinFilasPorCdc(uc: SifenConsultaLoteUltimaPersistida): string {
  const rawCod = (uc.dCodResLot ?? "").trim();
  const codSinCeros = rawCod.replace(/^0+/, "") || rawCod;
  const msg = (uc.dMsgResLot ?? "").toLowerCase();
  const loteCancelado =
    codSinCeros === "365" || /\b0365\b/.test(rawCod) || msg.includes("cancelad");
  if (loteCancelado) {
    return (
      "SET respondió que el lote está cancelado y no incluyó filas por CDC. " +
      "Eso es habitual cuando recibe-lote devolvió 0301 (todos los DE rechazados): el motivo del rechazo no se repite aquí por documento. " +
      "Revisá en TEST duplicidad de timbrado + establecimiento + punto de expedición + número de documento, el XML frente al XSD y el certificado usado al firmar."
    );
  }
  return (
    "Sin detalle por CDC en esta respuesta. Si el envío fue hace poco, el lote podría seguir en proceso: reintentá la consulta en unos minutos."
  );
}

async function readApiError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
}

function formatLimiteCancelacion(iso: string | null): string {
  if (iso == null || !iso.trim()) return "—";
  try {
    return new Date(iso).toLocaleString("es-PY", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export function FacturaElectronicaPanel({
  facturaId,
  clienteId,
  facturaComercial,
  resumen,
  loadingResumen,
  onResumenLoaded,
  onComercialUpdated,
}: {
  facturaId: string;
  /** Para atajo «cancelar y reemitir» (ficha cliente). */
  clienteId: string;
  /** Datos comerciales para NC (saldo = monto de la NC en v1). */
  facturaComercial: {
    monto: number;
    saldo: number;
    estado: string;
    moneda: string;
    cliente_display: string;
  };
  resumen: Resumen | null;
  loadingResumen: boolean;
  onResumenLoaded: (r: Resumen) => void;
  /** Tras anular la factura comercial (cancelación DE). */
  onComercialUpdated?: () => void | Promise<void>;
}) {
  const router = useRouter();
  const [action, setAction] = useState<
    "borrador" | "xml" | "firmar" | "enviar" | "consulta-lote" | "cancelar-de" | null
  >(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [cancelModal, setCancelModal] = useState<"cancelar" | "reemitir" | null>(null);
  const [motivoCancel, setMotivoCancel] = useState("");

  const refresh = useCallback(async (): Promise<Resumen | null> => {
    const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/resumen`, {
      cache: "no-store",
    });
    const j = (await res.json()) as { success?: boolean; data?: Resumen };
    if (res.ok && j.success && j.data) {
      const merged: Resumen = {
        ...j.data,
        sifen_plazo_cancelacion_horas: j.data.sifen_plazo_cancelacion_horas ?? j.data.cancelacion?.plazo_horas ?? 48,
        cancelacion: j.data.cancelacion ?? null,
      };
      onResumenLoaded(merged);
      return merged;
    }
    return null;
  }, [facturaId, onResumenLoaded]);

  const ejecutarCancelacion = async (reemitirTrasOk: boolean) => {
    setFlash(null);
    const m = motivoCancel.trim();
    if (m.length < 5) {
      setFlash({ kind: "err", text: "Indicá un motivo de al menos 5 caracteres." });
      return;
    }
    setAction("cancelar-de");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/cancelar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: m }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      setFlash({ kind: "ok", text: "Documento electrónico cancelado en el ERP. La factura comercial quedó anulada." });
      setCancelModal(null);
      setMotivoCancel("");
      await refresh();
      await onComercialUpdated?.();
      if (reemitirTrasOk && clienteId.trim()) {
        router.push(`/clientes/${encodeURIComponent(clienteId.trim())}`);
      }
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  const run = async (kind: "borrador" | "xml" | "firmar") => {
    setFlash(null);
    setAction(kind);
    try {
      const path =
        kind === "borrador"
          ? `/api/facturas/${facturaId}/sifen/borrador`
          : kind === "xml"
            ? `/api/facturas/${facturaId}/sifen/xml`
            : `/api/facturas/${facturaId}/sifen/firmar`;
      const res = await fetchWithSupabaseSession(path, { method: "POST" });
      if (!res.ok) {
        setFlash({ kind: "err", text: await readApiError(res) });
        return;
      }
      setFlash({
        kind: "ok",
        text:
          kind === "borrador"
            ? "Borrador electrónico listo."
            : kind === "xml"
              ? "XML generado correctamente."
              : "XML firmado correctamente.",
      });
      await refresh();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  const etiquetaAmbienteSet =
    resumen?.sifen_ambiente === "produccion" ? "producción" : "pruebas (TEST)";

  const runEnviar = async () => {
    setFlash(null);
    setAction("enviar");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/enviar`, { method: "POST" });
      const j = (await res.json()) as {
        success?: boolean;
        data?: {
          factura_electronica?: FacturaElectronicaDTO;
          recibe_lote?: {
            loteRecibido?: boolean;
            loteNoEncolado?: boolean;
            dCodRes?: string | null;
            dProtConsLote?: string | null;
            httpStatus?: number;
          };
        };
        error?: string;
      };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }

      const feResp = j.data?.factura_electronica;
      const rec = j.data?.recibe_lote;
      const cod = String(rec?.dCodRes ?? "").trim();
      const codSinCerosIni = cod.replace(/^0+/, "") || "";
      const codigoEs0300 = cod === "0300" || codSinCerosIni === "300";
      const prot =
        rec?.dProtConsLote == null ? "" : String(rec.dProtConsLote).trim();
      const http2xx =
        rec?.httpStatus != null && rec.httpStatus >= 200 && rec.httpStatus < 300;

      /** Solo éxito real: no mostrar verde si la API guardó error_envio / rechazo de lote. */
      const loteAceptado =
        feResp?.estado_sifen === "enviado" ||
        rec?.loteRecibido === true ||
        codigoEs0300 ||
        (http2xx && prot.length > 0 && rec?.loteNoEncolado !== true);

      if (!loteAceptado) {
        if (resumen != null && feResp) {
          onResumenLoaded({ ...resumen, factura_electronica: feResp });
        }
        setFlash({
          kind: "err",
          text:
            feResp?.error?.trim() ??
            "SET no aceptó el lote. Revisá el mensaje técnico abajo o reintentá el envío.",
        });
        await refresh();
        return;
      }

      if (resumen != null && feResp) {
        onResumenLoaded({ ...resumen, factura_electronica: feResp });
      }
      setFlash({
        kind: "ok",
        text: `Lote enviado correctamente a SET (${etiquetaAmbienteSet})`,
      });

      const loaded = await refresh();
      if (
        feResp &&
        feResp.estado_sifen === "enviado" &&
        loaded?.factura_electronica?.estado_sifen === "error_envio" &&
        loaded.factura_electronica.id === feResp.id
      ) {
        onResumenLoaded({ ...loaded, factura_electronica: feResp });
      }
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  const runConsultaLote = async () => {
    setFlash(null);
    setAction("consulta-lote");
    try {
      const res = await fetchWithSupabaseSession(`/api/facturas/${facturaId}/sifen/consulta-lote`, {
        method: "POST",
      });
      const j = (await res.json()) as {
        success?: boolean;
        data?: {
          consulta_lote?: {
            dCodResLot?: string | null;
            dMsgResLot?: string | null;
            resumenInferido?: string | null;
            estadoActualizado?: boolean;
          };
        };
        error?: string;
      };
      if (!res.ok || !j.success) {
        setFlash({ kind: "err", text: j.error ?? `Error ${res.status}` });
        return;
      }
      const c = j.data?.consulta_lote;
      const msg =
        c?.resumenInferido?.trim() ||
        (c?.dCodResLot != null
          ? `${c.dCodResLot}${c.dMsgResLot != null ? ` — ${c.dMsgResLot}` : ""}`
          : null) ||
        "Consulta lote completada.";
      setFlash({ kind: "ok", text: msg });
      await refresh();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setAction(null);
    }
  };

  const fe = resumen?.factura_electronica ?? null;
  const estado = fe?.estado_sifen ?? null;
  const estadoLabel = fe ? labelSifenEstado(estado) : "Sin SIFEN";

  const puedeBorrador = Boolean(resumen?.sifen_config_activa) && !fe;
  const puedeGenerarXml =
    Boolean(resumen?.sifen_config_activa) && fe != null && !XML_BLOQUEADOS.has(String(estado));
  const puedeFirmar =
    Boolean(resumen?.sifen_config_activa) &&
    fe != null &&
    Boolean(fe.xml_path?.trim()) &&
    !FIRMAR_BLOQUEADOS.has(String(estado)) &&
    estado !== "firmado";

  const puedeConsultarLote =
    Boolean(resumen?.sifen_config_activa) && Boolean(fe?.sifen_d_prot_cons_lote?.trim());

  const ultimaConsulta = fe?.sifen_ultima_respuesta_consulta_lote ?? null;

  /** El campo `error` solo aplica a fallos de envío/rechazo; no mostrar texto viejo si ya está enviado/aprobado/etc. */
  const mostrarErrorPersistido =
    Boolean(fe?.error?.trim()) && (estado === "error_envio" || estado === "rechazado");

  const deAprobado = Boolean(fe && String(estado) === "aprobado");

  return (
    <div className="space-y-4">
      <FacturaCorreccionFiscalNC
        facturaId={facturaId}
        clienteId={clienteId}
        clienteDisplay={facturaComercial.cliente_display}
        monto={facturaComercial.monto}
        saldo={facturaComercial.saldo}
        estado={facturaComercial.estado}
        moneda={facturaComercial.moneda}
        puedeCancelarDe={Boolean(resumen?.cancelacion?.puede_cancelar)}
        deAprobado={deAprobado}
        onAfterNcMutation={onComercialUpdated}
      />

    <div className="rounded-xl border border-slate-200 bg-white shadow-sm p-5 space-y-4">
      <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wide border-b border-slate-100 pb-2">
        Facturación electrónica (SIFEN)
      </h3>

      {loadingResumen && (
        <p className="text-sm text-slate-400">Cargando estado SIFEN…</p>
      )}

      {!loadingResumen && resumen && <EstadoEmisionElectronicaBlock resumen={resumen} />}

      {!loadingResumen && resumen && (
        <>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider pt-1">
            Detalle técnico y acciones
          </p>
          <div className="grid gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-500">Estado SIFEN:</span>
              <SifenEstadoBadge estadoSifen={fe ? estado : null} mostrarPistaEnvioSet={false} />
              {!fe && <span className="text-slate-400">({estadoLabel})</span>}
            </div>
            {fe && resumen.cancelacion && estado === "aprobado" && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {resumen.cancelacion.puede_cancelar ? (
                  <span
                    className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200"
                    title={`Plazo configurado: ${resumen.sifen_plazo_cancelacion_horas ?? resumen.cancelacion.plazo_horas} h desde aprobación SET`}
                  >
                    Cancelable hasta {formatLimiteCancelacion(resumen.cancelacion.cancelable_hasta)}
                  </span>
                ) : resumen.cancelacion.requiere_nota_credito ? (
                  <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold bg-amber-50 text-amber-900 ring-1 ring-amber-200">
                    Requiere Nota de Crédito
                  </span>
                ) : (
                  resumen.cancelacion.motivo_bloqueo && (
                    <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium bg-slate-100 text-slate-700 ring-1 ring-slate-200">
                      {resumen.cancelacion.motivo_bloqueo}
                    </span>
                  )
                )}
              </div>
            )}
            {fe && estado === "cancelado" && fe.sifen_cancelado_at && (
              <p className="text-xs text-slate-600 pt-1">
                <span className="font-semibold text-slate-700">Cancelado en ERP:</span>{" "}
                {formatLimiteCancelacion(fe.sifen_cancelado_at)}
                {fe.sifen_cancelacion_motivo?.trim() ? (
                  <>
                    {" "}
                    — <span className="text-slate-500">Motivo:</span> {fe.sifen_cancelacion_motivo.trim()}
                  </>
                ) : null}
              </p>
            )}
            {fe && estado === "aprobado" && resumen.cancelacion && (
              <div className="flex flex-wrap gap-2 pt-2">
                {resumen.cancelacion.puede_cancelar ? (
                  <>
                    <button
                      type="button"
                      disabled={action !== null}
                      onClick={() => {
                        setMotivoCancel("");
                        setCancelModal("cancelar");
                      }}
                      className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-700 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-rose-800"
                    >
                      Cancelar factura (DE)
                    </button>
                    <button
                      type="button"
                      disabled={action !== null}
                      onClick={() => {
                        setMotivoCancel("");
                        setCancelModal("reemitir");
                      }}
                      className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 text-slate-800 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
                    >
                      Cancelar y reemitir
                    </button>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">
                    La cancelación del DE no está disponible. Usá el bloque «Corrección fiscal» arriba para la nota de
                    crédito cuando corresponda.
                  </p>
                )}
              </div>
            )}
            {fe && (
              <>
                <p className="text-slate-600">
                  <span className="text-slate-400">ID documento electrónico:</span>{" "}
                  <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{fe.id}</code>
                </p>
                <p className="text-slate-600 break-all">
                  <span className="text-slate-400">xml_path:</span>{" "}
                  <code className="text-xs">{fe.xml_path ?? "—"}</code>
                </p>
                <p className="text-slate-600 break-all">
                  <span className="text-slate-400">xml_firmado_path:</span>{" "}
                  <code className="text-xs">{fe.xml_firmado_path ?? "—"}</code>
                </p>
                {fe.cdc && (
                  <p className="text-slate-600 break-all">
                    <span className="text-slate-400">CDC:</span> <code className="text-xs">{fe.cdc}</code>
                  </p>
                )}
                {fe.sifen_d_prot_cons_lote?.trim() && (
                  <p className="text-slate-600 break-all">
                    <span className="text-slate-400">dProtConsLote (SET):</span>{" "}
                    <code className="text-xs">{fe.sifen_d_prot_cons_lote}</code>
                  </p>
                )}
                {ultimaConsulta && (
                  <div className="rounded-lg border border-sky-100 bg-sky-50/60 px-3 py-2 text-xs space-y-1.5">
                    <p className="font-semibold text-sky-900">
                      Última consulta lote ({etiquetaAmbienteSet})
                    </p>
                    <p className="text-slate-700">
                      <span className="text-slate-500">dCodResLot:</span>{" "}
                      <code className="bg-white/80 px-1 rounded">
                        {ultimaConsulta.dCodResLot ?? "—"}
                      </code>
                    </p>
                    <p className="text-slate-700 break-words">
                      <span className="text-slate-500">dMsgResLot:</span>{" "}
                      {ultimaConsulta.dMsgResLot ?? "—"}
                    </p>
                    {ultimaConsulta.detallePorCdc.length > 0 && (
                      <ul className="list-disc pl-4 space-y-2 text-slate-800">
                        {ultimaConsulta.detallePorCdc.map((d) => (
                          <li key={d.cdc}>
                            <span className="text-slate-500">CDC:</span>{" "}
                            <code className="bg-white/80 px-1 rounded break-all">{d.cdc}</code>
                            <br />
                            <span className="text-slate-500">dEstRes:</span> {d.dEstRes}
                            {d.dProtAut != null && d.dProtAut !== "" && (
                              <>
                                <br />
                                <span className="text-slate-500">dProtAut:</span> {d.dProtAut}
                              </>
                            )}
                            {d.grupoRes.length > 0 && (
                              <ul className="list-circle pl-4 mt-1 space-y-0.5">
                                {d.grupoRes.map((g, i) => (
                                  <li key={`${d.cdc}-${g.dCodRes}-${i}`}>
                                    <code>{g.dCodRes}</code> — {decodeXmlNumericEntities(g.dMsgRes)}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {ultimaConsulta.loteSinDetalleCdc && !ultimaConsulta.soapFault && (
                      <p className="text-amber-900 leading-snug">{mensajeConsultaSinFilasPorCdc(ultimaConsulta)}</p>
                    )}
                    {ultimaConsulta.soapFault && ultimaConsulta.faultString && (
                      <p className="text-red-700">Fault: {ultimaConsulta.faultString}</p>
                    )}
                  </div>
                )}
                {mostrarErrorPersistido && (
                  <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2 whitespace-pre-wrap">
                    <span className="font-semibold">Error: </span>
                    {decodeXmlNumericEntities(fe.error ?? "")}
                  </div>
                )}
              </>
            )}
          </div>

          {flash && (
            <div
              className={`rounded-lg text-sm px-4 py-2 ${
                flash.kind === "ok"
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}
            >
              {decodeXmlNumericEntities(flash.text)}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={!puedeBorrador || action !== null}
              onClick={() => run("borrador")}
              className="px-3 py-2 text-xs font-semibold rounded-lg bg-slate-900 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-800"
            >
              {action === "borrador" ? "Generando…" : "Generar borrador"}
            </button>
            <button
              type="button"
              disabled={!puedeGenerarXml || action !== null}
              onClick={() => run("xml")}
              className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 text-slate-800 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              {action === "xml"
                ? "Generando XML…"
                : fe?.xml_path?.trim()
                  ? "Regenerar XML"
                  : "Generar XML"}
            </button>
            <button
              type="button"
              disabled={!puedeFirmar || action !== null}
              onClick={() => run("firmar")}
              className="px-3 py-2 text-xs font-semibold rounded-lg border border-indigo-300 text-indigo-900 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-50"
            >
              {action === "firmar" ? "Firmando…" : "Firmar XML"}
            </button>
          </div>

          {fe && puedeConsultarLote && (
            <div className="rounded-lg border border-sky-200 bg-sky-50/40 px-4 py-3 space-y-2">
              <p className="text-[10px] font-bold text-sky-900/70 uppercase tracking-wide">
                Consulta asíncrona (SET)
              </p>
              <div className="flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-2">
                <button
                  type="button"
                  disabled={action !== null}
                  onClick={() => void runConsultaLote()}
                  className="w-fit px-3 py-2 text-xs font-semibold rounded-lg bg-sky-600 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-sky-700"
                >
                  {action === "consulta-lote" ? "Consultando…" : "Consultar lote SET"}
                </button>
                <p className="text-xs text-slate-600">
                  Usa el protocolo guardado tras enviar el lote (mismo ambiente que en configuración).
                </p>
              </div>
            </div>
          )}

          {fe && estado === "firmado" && (
            <div className="rounded-lg border border-dashed border-violet-200 bg-violet-50/50 px-4 py-3 space-y-2">
              <p className="text-[10px] font-bold text-violet-900/70 uppercase tracking-wide">Siguiente paso</p>
              <div className="flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-2 sm:gap-3">
                <button
                  type="button"
                  disabled={action !== null}
                  onClick={() => void runEnviar()}
                  className="w-fit px-3 py-2 text-xs font-semibold rounded-lg bg-violet-600 text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-violet-700"
                >
                  {action === "enviar" ? "Enviando a SET…" : "Enviar a SET"}
                </button>
                <p className="text-xs text-violet-900/75 font-medium">
                  Ambiente según Configuración → Facturación electrónica ({etiquetaAmbienteSet}). Certificado
                  y CSC deben coincidir con ese ambiente.
                </p>
              </div>
              <p className="text-xs text-slate-700 leading-relaxed">
                Al enviar, el documento pasa a estado enviado en el ERP; SET procesa el lote de forma asíncrona.
              </p>
            </div>
          )}

          {fe && (
            <div className="text-xs text-slate-400 pt-2 border-t border-slate-100 space-y-1">
              <p>
                Debug:{" "}
                <a className="text-[#0EA5E9] hover:underline" href={`/api/facturas/${facturaId}/sifen/payload`} target="_blank" rel="noreferrer">
                  payload JSON
                </a>
                {" · "}
                <a className="text-[#0EA5E9] hover:underline" href={`/api/facturas/${facturaId}/sifen/documento`} target="_blank" rel="noreferrer">
                  documento
                </a>
              </p>
            </div>
          )}
        </>
      )}

      {cancelModal != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sifen-cancel-title"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 space-y-4 border border-slate-200">
            <h4 id="sifen-cancel-title" className="text-sm font-bold text-slate-900">
              {cancelModal === "reemitir"
                ? "Cancelar documento y continuar en cliente"
                : "Cancelar documento electrónico (ERP)"}
            </h4>
            <p className="text-xs text-slate-600 leading-relaxed">
              Se registrará la cancelación lógica del DE, la factura comercial pasará a{" "}
              <span className="font-semibold">Anulado</span> y quedará trazabilidad. No se elimina ningún registro.
              {cancelModal === "reemitir" ? " Luego podés emitir una nueva factura desde la ficha del cliente." : ""}
            </p>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Motivo (obligatorio)
              <textarea
                value={motivoCancel}
                onChange={(e) => setMotivoCancel(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]"
                placeholder="Ej.: error en datos del cliente acordado verbalmente"
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={action !== null}
                onClick={() => {
                  setCancelModal(null);
                  setMotivoCancel("");
                }}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={action !== null}
                onClick={() => void ejecutarCancelacion(cancelModal === "reemitir")}
                className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-700 text-white hover:bg-rose-800 disabled:opacity-50"
              >
                {action === "cancelar-de" ? "Procesando…" : "Confirmar cancelación"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
    </div>
  );
}
