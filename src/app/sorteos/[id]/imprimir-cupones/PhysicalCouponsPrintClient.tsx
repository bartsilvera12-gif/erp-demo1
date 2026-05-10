"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type {
  EntradaImpresionContext,
  PhysicalCouponPrintRow,
} from "@/lib/sorteos/physical-coupons-print";
import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";

const COLS = 2;
const ROWS = 5;
const PER_PAGE = COLS * ROWS;

const ESTADOS: { value: SorteoEntradaEstadoPago; label: string }[] = [
  { value: "confirmado", label: "Confirmado" },
  { value: "pendiente_revision", label: "Pendiente de revisión" },
  { value: "pendiente", label: "Pendiente" },
  { value: "rechazado", label: "Rechazado" },
];

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Documento HTML mínimo solo con cupones (sin AppShell). Evita overflow/h-svh del ERP en impresión.
 */
function buildPhysicalCouponsPrintDocument(rows: PhysicalCouponPrintRow[], documentTitle: string): string {
  const pages = chunk(rows, PER_PAGE);
  const pagesHtml = pages
    .map((pageRows) => {
      const articles = pageRows
        .map((row) => {
          const nombre = row.nombre_participante ? escapeHtml(row.nombre_participante) : "";
          const docLine = row.documento_masked ? `<p>Doc. ${escapeHtml(row.documento_masked)}</p>` : "";
          const telLine = row.whatsapp_masked ? `<p>Tel. ${escapeHtml(row.whatsapp_masked)}</p>` : "";
          return `
            <article class="coupon-card">
              <div class="coupon-top">
                <p class="coupon-sorteo">${escapeHtml(row.sorteo_nombre)}</p>
                <p class="coupon-numero">${escapeHtml(row.numero_cupon)}</p>
                <p class="coupon-orden">Orden <strong>${escapeHtml(String(row.numero_orden))}</strong></p>
              </div>
              <div class="coupon-bottom">
                ${nombre ? `<p class="coupon-nombre">${nombre}</p>` : `<p class="coupon-nombre muted">—</p>`}
                ${docLine}
                ${telLine}
                <p class="coupon-fecha">${escapeHtml(row.fecha_display)}</p>
              </div>
            </article>`;
        })
        .join("");
      const padCount = Math.max(0, PER_PAGE - pageRows.length);
      const pads = Array.from({ length: padCount })
        .map(() => `<div class="coupon-pad" aria-hidden="true"></div>`)
        .join("");
      return `<section class="coupon-page">${articles}${pads}</section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(documentTitle)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #0f172a; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .coupon-page {
    display: grid;
    grid-template-columns: repeat(${COLS}, minmax(0, 1fr));
    gap: 10px;
    grid-auto-rows: minmax(28mm, auto);
    max-width: 190mm;
    margin: 0 auto;
    break-after: page;
    page-break-after: always;
  }
  .coupon-page:last-child { break-after: auto; page-break-after: auto; }
  .coupon-card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border: 1px dashed #64748b;
    border-radius: 8px;
    padding: 10px;
    text-align: center;
    background: #fff;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .coupon-sorteo { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0; }
  .coupon-numero { font-size: 1.625rem; font-weight: 800; margin: 4px 0; font-variant-numeric: tabular-nums; }
  .coupon-orden { font-size: 12px; color: #475569; margin: 0; }
  .coupon-bottom { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #334155; }
  .coupon-nombre { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .coupon-nombre.muted { color: #94a3b8; }
  .coupon-fecha { margin: 4px 0 0; color: #64748b; font-size: 11px; }
  .coupon-pad { visibility: hidden; break-inside: avoid; }
  @media print {
    html, body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
${pagesHtml}
</body>
</html>`;
}

export default function PhysicalCouponsPrintClient({
  sorteoId,
  sorteoNombre,
  rows,
  error,
  q,
  estado,
  fechaDesde,
  fechaHasta,
  entradaId,
  entradaContext,
}: {
  sorteoId: string;
  sorteoNombre: string;
  rows: PhysicalCouponPrintRow[];
  error: string | null;
  q: string;
  estado: SorteoEntradaEstadoPago;
  fechaDesde: string;
  fechaHasta: string;
  entradaId: string | null;
  entradaContext: EntradaImpresionContext | null;
}) {
  const router = useRouter();
  const pages = chunk(rows, PER_PAGE);

  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirmOk, setConfirmOk] = useState(false);

  const modoEntrada = Boolean(entradaId && entradaContext);
  const yaImpreso = Boolean(entradaContext?.cupones_impresos_at);
  const mostrarConfirmar = modoEntrada && Boolean(entradaId) && !yaImpreso && !confirmOk;

  useEffect(() => {
    document.documentElement.classList.add("physical-coupons-print-page");
    return () => {
      document.documentElement.classList.remove("physical-coupons-print-page");
    };
  }, []);

  function handlePrint() {
    if (rows.length === 0) return;
    const title = sorteoNombre.trim() || "Cupones sorteo";
    const html = buildPhysicalCouponsPrintDocument(rows, title);
    /* Sin noopener en features: si no, algunos navegadores devuelven null y no podemos llamar a print(). */
    const w = window.open("", "_blank");
    if (!w) {
      window.alert(
        "No se pudo abrir la ventana de impresión. Permití ventanas emergentes para este sitio, o usá Ctrl+P en esta página."
      );
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    const runPrint = () => {
      try {
        w.focus();
        w.print();
      } catch {
        /* noop */
      }
    };
    if (w.document.readyState === "complete") {
      window.setTimeout(runPrint, 100);
    } else {
      w.addEventListener("load", () => window.setTimeout(runPrint, 100));
    }
  }

  async function handleConfirmarImpresion() {
    if (!entradaId) return;
    setConfirmPending(true);
    setConfirmErr(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/entradas/${encodeURIComponent(entradaId)}/confirmar-impresion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sorteo_id: sorteoId }),
        }
      );
      const raw = await res.text();
      if (!res.ok) {
        setConfirmErr(raw || `Error ${res.status}`);
        return;
      }
      setConfirmOk(true);
      router.refresh();
    } catch (e) {
      setConfirmErr(e instanceof Error ? e.message : "Error al confirmar");
    } finally {
      setConfirmPending(false);
    }
  }

  return (
    <>
      <style>{`
        @media print {
          @page { size: A4; margin: 10mm; }
          .no-print { display: none !important; }
          .print-page-break { break-after: page; page-break-after: always; }
          .print-page-break:last-child { break-after: auto; page-break-after: auto; }
          .physical-coupons-print-area article {
            break-inside: avoid;
            page-break-inside: avoid;
          }
        }
      `}</style>

      <div className="space-y-6 max-w-5xl">
        <div className="no-print flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <Link href="/sorteos" className="hover:text-slate-800">
            Sorteos
          </Link>
          <span>/</span>
          <Link href={`/sorteos/${encodeURIComponent(sorteoId)}/editar`} className="hover:text-slate-800">
            Editar sorteo
          </Link>
          <span>/</span>
          <span className="font-medium text-slate-800">Imprimir cupones</span>
        </div>

        <div className="no-print space-y-2">
          <h1 className="text-2xl font-bold text-slate-900">Imprimir cupones para urna</h1>
          <p className="text-slate-600 text-sm">
            Se imprimirá un cupón físico por cada cupón confirmado del sorteo.
          </p>
          {!modoEntrada ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              Solo se incluyen cupones de compras confirmadas, salvo que cambies el filtro de estado de pago.
            </p>
          ) : null}
          <p className="text-xs text-slate-500">
            Fecha en el cupón: se usa la fecha de pago si existe; si no, la fecha de creación de la orden.
          </p>
          <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
            <strong className="text-slate-800">Impresión:</strong> esta vista está pensada para hoja{" "}
            <strong>A4</strong>. Si en el cuadro de impresión del navegador ves la URL o la fecha arriba/abajo,
            desactivá <strong>«Encabezados y pies de página»</strong> (Chrome/Edge: Más ajustes / Options).
            Para ticketera térmica habría que usar otro formato (mejora futura).
          </p>
        </div>

        {modoEntrada && entradaContext ? (
          <div className="no-print rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
            <p className="font-semibold">
              Imprimiendo cupones de la orden N°{" "}
              <span className="tabular-nums">{entradaContext.numero_orden}</span>
            </p>
            <p>
              Cliente: <strong>{entradaContext.nombre_participante || "—"}</strong>
            </p>
            <p>
              Cantidad de cupones:{" "}
              <strong className="tabular-nums">{entradaContext.cantidad_cupones}</strong>
            </p>
            {yaImpreso ? (
              <p className="mt-2 text-xs text-emerald-900">
                Impresión ya registrada{" "}
                {entradaContext.cupones_impresos_at
                  ? new Date(entradaContext.cupones_impresos_at).toLocaleString("es-PY")
                  : ""}
                .
              </p>
            ) : null}
          </div>
        ) : null}

        {confirmOk ? (
          <div className="no-print rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
            Impresión confirmada correctamente.
          </div>
        ) : null}

        {confirmErr ? (
          <div className="no-print rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            {confirmErr}
          </div>
        ) : null}

        {!modoEntrada ? (
          <form
            method="get"
            className="no-print flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
          >
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Buscar
              <input
                name="q"
                type="search"
                defaultValue={q}
                placeholder="Nombre, doc., teléfono u orden"
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm min-w-[200px]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Estado de pago
              <select
                name="estado"
                defaultValue={estado}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              >
                {ESTADOS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Desde
              <input
                name="fecha_desde"
                type="date"
                defaultValue={fechaDesde}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Hasta
              <input
                name="fecha_hasta"
                type="date"
                defaultValue={fechaHasta}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
            >
              Aplicar filtros
            </button>
          </form>
        ) : (
          <div className="no-print flex flex-wrap gap-2">
            <Link
              href={`/sorteos/${encodeURIComponent(sorteoId)}/imprimir-cupones`}
              className="text-sm font-medium text-[#0EA5E9] hover:underline"
            >
              Ver todos los cupones del sorteo (sin filtrar por orden)
            </Link>
          </div>
        )}

        <div className="no-print flex flex-wrap items-center gap-3">
          <p className="text-sm font-medium text-slate-800">
            Cupones listos para imprimir: <span className="tabular-nums">{rows.length}</span>
          </p>
          {sorteoNombre ? (
            <span className="text-sm text-slate-500">
              Sorteo: <strong className="font-semibold text-slate-700">{sorteoNombre}</strong>
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="no-print rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            {error}
          </div>
        ) : null}

        <div className="no-print flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            onClick={handlePrint}
            disabled={rows.length === 0}
            className="rounded-lg bg-[#0EA5E9] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0284C7] disabled:opacity-50 disabled:pointer-events-none"
          >
            Imprimir cupones
          </button>
          <p className="text-xs text-slate-500 max-w-xl">
            Se abrirá una ventana solo con los cupones (sin menú del ERP). Si la impresora muestra URL o fecha,
            desactivá encabezados y pies de página en el diálogo de impresión.
          </p>

          {mostrarConfirmar ? (
            <button
              type="button"
              onClick={() => void handleConfirmarImpresion()}
              disabled={confirmPending || rows.length === 0}
              className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {confirmPending ? "Confirmando…" : "Confirmar impresión"}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => router.push(`/sorteos/${encodeURIComponent(sorteoId)}/editar`)}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            Volver al sorteo
          </button>
          <button
            type="button"
            onClick={() => router.push("/sorteos/cupones")}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            Volver a Cupones
          </button>
        </div>

        <div
          className="physical-coupons-print-area print-area rounded-xl border border-slate-200 bg-white p-4 print:border-0 print:p-0"
          data-print-area="physical-coupons"
        >
          {rows.length === 0 && !error ? (
            <p className="no-print text-sm text-slate-500">No hay cupones con los filtros seleccionados.</p>
          ) : null}

          {pages.map((pageRows, pi) => (
            <div
              key={pi}
              className={`print-page-break mx-auto max-w-[190mm] ${pi > 0 ? "mt-8 print:mt-0" : ""}`}
            >
              <div
                className="grid gap-3 print:gap-2"
                style={{
                  gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                  gridAutoRows: "minmax(28mm, auto)",
                }}
              >
                {pageRows.map((row) => (
                  <article
                    key={row.cupon_id}
                    className="flex flex-col justify-between rounded-lg border border-dashed border-slate-400 bg-slate-50/80 p-3 text-center shadow-sm print:bg-white print:shadow-none break-inside-avoid page-break-inside-avoid"
                  >
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {row.sorteo_nombre}
                      </p>
                      <p className="text-2xl font-bold tabular-nums text-slate-900">{row.numero_cupon}</p>
                      <p className="text-xs text-slate-600">
                        Orden <span className="font-semibold tabular-nums">{row.numero_orden}</span>
                      </p>
                    </div>
                    <div className="mt-2 space-y-0.5 border-t border-slate-200 pt-2 text-[11px] text-slate-700">
                      {row.nombre_participante ? (
                        <p className="truncate" title={row.nombre_participante}>
                          {row.nombre_participante}
                        </p>
                      ) : (
                        <p className="text-slate-400">—</p>
                      )}
                      {row.documento_masked ? <p>Doc. {row.documento_masked}</p> : null}
                      {row.whatsapp_masked ? <p>Tel. {row.whatsapp_masked}</p> : null}
                      <p className="text-slate-500">{row.fecha_display}</p>
                    </div>
                  </article>
                ))}
                {Array.from({ length: Math.max(0, PER_PAGE - pageRows.length) }).map((_, i) => (
                  <div
                    key={`pad-${pi}-${i}`}
                    className="rounded-lg border border-transparent print:hidden"
                    aria-hidden
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
