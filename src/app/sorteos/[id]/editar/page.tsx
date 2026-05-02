"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getSorteoById, updateSorteo } from "@/lib/sorteos/actions";
import type { SorteoEstado, SorteoTicketDeliveryMode } from "@/lib/sorteos/types";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { normalizeTicketImageConfig } from "@/lib/sorteos/sorteo-ticket-types";

export default function EditarSorteoPage() {
  const params = useParams();
  const id = String(params?.id ?? "");
  const router = useRouter();
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [precio, setPrecio] = useState(0);
  const [maxBoletos, setMaxBoletos] = useState(100);
  const [fechaSorteo, setFechaSorteo] = useState("");
  const [estado, setEstado] = useState<SorteoEstado>("activo");
  const [imagenUrl, setImagenUrl] = useState("");
  const [datosBancarios, setDatosBancarios] = useState("{}");
  const [ticketDeliveryMode, setTicketDeliveryMode] = useState<SorteoTicketDeliveryMode>("text_only");
  const [ticketCaption, setTicketCaption] = useState("");
  const [ticketTitle, setTicketTitle] = useState("");
  const [ticketLegal, setTicketLegal] = useState("");
  const [ticketStub, setTicketStub] = useState("");
  /** Resto de claves de ticket_image_config (colores, show*) para no pisarlas al guardar. */
  const [ticketImageConfigBase, setTicketImageConfigBase] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (!id) return;
    getSorteoById(id)
      .then((s) => {
        if (!s) {
          setError("Sorteo no encontrado");
          return;
        }
        setNombre(s.nombre);
        setDescripcion(s.descripcion ?? "");
        setPrecio(s.precio_por_boleto);
        setMaxBoletos(s.max_boletos);
        if (s.fecha_sorteo) {
          const d = new Date(s.fecha_sorteo);
          const pad = (n: number) => String(n).padStart(2, "0");
          setFechaSorteo(
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
          );
        }
        setEstado(s.estado);
        setImagenUrl(s.imagen_url ?? "");
        setDatosBancarios(JSON.stringify(s.datos_bancarios ?? {}, null, 2));
        setTicketDeliveryMode((s.ticket_delivery_mode as SorteoTicketDeliveryMode) ?? "text_only");
        const tic = normalizeTicketImageConfig(s.ticket_image_config);
        setTicketImageConfigBase(
          s.ticket_image_config &&
            typeof s.ticket_image_config === "object" &&
            s.ticket_image_config !== null &&
            !Array.isArray(s.ticket_image_config)
            ? { ...(s.ticket_image_config as Record<string, unknown>) }
            : {}
        );
        setTicketTitle(typeof tic.title === "string" ? tic.title : "");
        setTicketCaption(typeof tic.caption === "string" ? tic.caption : "");
        setTicketLegal(typeof tic.legalFooter === "string" ? tic.legalFooter : "");
        setTicketStub(typeof tic.ticket_image_only_stub === "string" ? tic.ticket_image_only_stub : "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
      .finally(() => setCargando(false));
  }, [id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const nombreTrim = nombre.trim();
    if (!nombreTrim) {
      setError("El nombre del sorteo es obligatorio.");
      return;
    }
    if (!Number.isFinite(precio) || precio < 0) {
      setError("El precio por boleto debe ser un número válido mayor o igual a 0.");
      return;
    }
    if (!Number.isFinite(maxBoletos) || maxBoletos < 1) {
      setError("El máximo de boletos debe ser al menos 1.");
      return;
    }

    let json: Record<string, unknown> = {};
    try {
      json = datosBancarios.trim() ? (JSON.parse(datosBancarios) as Record<string, unknown>) : {};
    } catch {
      setError("Datos bancarios: el JSON no es válido. Revisá comillas y comas.");
      return;
    }

    let fechaIso: string | null = null;
    if (fechaSorteo.trim()) {
      const d = new Date(fechaSorteo);
      if (Number.isNaN(d.getTime())) {
        setError("La fecha del sorteo no es válida.");
        return;
      }
      fechaIso = d.toISOString();
    }

    const tit = ticketTitle.trim();
    const cap = ticketCaption.trim();
    const leg = ticketLegal.trim();
    const stu = ticketStub.trim();
    const ticketMerged: Record<string, unknown> = {
      showLogo: true,
      showClienteNombre: true,
      showDocumento: true,
      showTelefono: true,
      showNumeroOrden: true,
      showCupones: true,
      showSorteoNombre: true,
      primaryColor: "#0f172a",
      secondaryColor: "#64748b",
      backgroundColor: "#f8fafc",
      ...ticketImageConfigBase,
    };
    if (tit) ticketMerged.title = tit;
    else delete ticketMerged.title;
    if (cap) ticketMerged.caption = cap;
    else delete ticketMerged.caption;
    if (leg) ticketMerged.legalFooter = leg;
    else delete ticketMerged.legalFooter;
    if (stu) ticketMerged.ticket_image_only_stub = stu;
    else delete ticketMerged.ticket_image_only_stub;

    setGuardando(true);
    try {
      const updated = await updateSorteo(id, {
        nombre: nombreTrim,
        descripcion,
        precio_por_boleto: precio,
        max_boletos: maxBoletos,
        fecha_sorteo: fechaIso,
        estado,
        datos_bancarios: json,
        imagen_url: imagenUrl.trim() || null,
        ticket_delivery_mode: ticketDeliveryMode,
        ticket_image_config: ticketMerged,
      });
      if (updated.ticket_image_config && typeof updated.ticket_image_config === "object") {
        setTicketImageConfigBase({ ...(updated.ticket_image_config as Record<string, unknown>) });
      }
      setSuccess("Cambios guardados correctamente.");
      router.refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al guardar";
      setError(msg);
      console.error("[editar sorteo]", err);
    } finally {
      setGuardando(false);
    }
  }

  if (cargando) {
    return <div className="py-16 text-center text-slate-400 text-sm animate-pulse">Cargando…</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/sorteos" className="hover:text-slate-800">
          Sorteos
        </Link>
        <span>/</span>
        <span className="text-slate-800 font-medium">Editar</span>
      </div>
      <h1 className="text-2xl font-bold text-gray-800">Editar sorteo</h1>
      <div className="pt-1 flex flex-wrap gap-2">
        <Link
          href={`/configuracion/conversaciones/flujos?sorteo_id=${encodeURIComponent(id)}`}
          className="inline-flex items-center rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
        >
          Flujo WhatsApp para este sorteo
        </Link>
        <Link
          href={`/sorteos/${id}/revendedores`}
          className="inline-flex items-center rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-700 hover:bg-sky-100"
        >
          Revendedores y enlaces de referido
        </Link>
        <Link
          href="/sorteos/tickets"
          className="inline-flex items-center rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100"
        >
          Tickets / Comprobantes
        </Link>
      </div>
      <p className="text-sm text-slate-600 max-w-3xl">
        El botón <strong className="font-medium text-slate-800">Tickets / Comprobantes</strong> abre el reservorio de
        envíos. La <strong className="font-medium text-slate-800">configuración del ticket</strong> (modo, texto, logo y
        fondo) está en esta misma página, en la sección{" "}
        <a href="#respuesta-ticket" className="text-violet-700 underline underline-offset-2">
          Respuesta al comprador / Ticket
        </a>
        .
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div
          className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm rounded-lg px-4 py-2"
          role="status"
        >
          {success}{" "}
          <Link href="/sorteos" className="font-medium text-emerald-800 underline underline-offset-2">
            Ver listado de sorteos
          </Link>
        </div>
      )}

      <form noValidate onSubmit={handleSubmit} className="space-y-6">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-slate-800 border-b border-slate-100 pb-2">Datos del sorteo</h2>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
          <textarea
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm min-h-[80px]"
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Precio por boleto (₲)</label>
            <input
              type="number"
              min={0}
              step={1}
              required
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={precio}
              onChange={(e) => setPrecio(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Máx. boletos</label>
            <input
              type="number"
              min={1}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={Number.isFinite(maxBoletos) ? maxBoletos : ""}
              onChange={(e) => {
                const v = e.target.value;
                setMaxBoletos(v === "" ? 0 : Number(v));
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Fecha del sorteo</label>
            <input
              type="datetime-local"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={fechaSorteo}
              onChange={(e) => setFechaSorteo(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Estado</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={estado}
              onChange={(e) => setEstado(e.target.value as SorteoEstado)}
            >
              <option value="activo">activo</option>
              <option value="pausado">pausado</option>
              <option value="cerrado">cerrado</option>
              <option value="finalizado">finalizado</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">URL imagen</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={imagenUrl}
            onChange={(e) => setImagenUrl(e.target.value)}
          />
        </div>
        </section>

        <section
          id="respuesta-ticket"
          className="rounded-xl border-2 border-violet-300 bg-gradient-to-b from-violet-50/90 to-white p-6 shadow-md space-y-4 scroll-mt-6"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-900">Respuesta al comprador / Ticket</h2>
            <p className="text-xs text-slate-600 mt-1">
              Define cómo responde el sistema tras la compra en WhatsApp: solo texto, texto más imagen del ticket, o solo
              imagen. Los archivos de logo y fondo se suben a Storage al elegir archivo; el resto se persiste al pulsar{" "}
              <span className="font-medium">Guardar</span> (incluye{" "}
              <code className="rounded bg-violet-100/80 px-1">ticket_delivery_mode</code> y{" "}
              <code className="rounded bg-violet-100/80 px-1">ticket_image_config</code> en la base).
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Modo de respuesta</label>
            <select
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
              value={ticketDeliveryMode}
              onChange={(e) => setTicketDeliveryMode(e.target.value as SorteoTicketDeliveryMode)}
            >
              <option value="text_only">Solo mensaje de texto (sin ticket PNG)</option>
              <option value="text_and_image">Texto + ticket en imagen</option>
              <option value="image_only">Solo ticket en imagen</option>
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Título en el ticket</label>
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={ticketTitle}
                onChange={(e) => setTicketTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Caption WhatsApp (imagen)</label>
              <input
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                value={ticketCaption}
                onChange={(e) => setTicketCaption(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">Texto legal / pie</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={ticketLegal}
              onChange={(e) => setTicketLegal(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">
              Texto corto (solo ticket imagen — opcional)
            </label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={ticketStub}
              onChange={(e) => setTicketStub(e.target.value)}
              placeholder="Listo, generamos tu comprobante…"
            />
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            <label className="flex items-center gap-2">
              Logo sorteo
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="text-xs"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f || !id) return;
                  const fd = new FormData();
                  fd.set("sorteo_id", id);
                  fd.set("kind", "logo");
                  fd.set("file", f);
                  const res = await fetchWithSupabaseSession("/api/sorteos/ticket-assets", {
                    method: "POST",
                    body: fd,
                  });
                  if (!res.ok) alert(await res.text());
                  else alert("Logo subido.");
                }}
              />
            </label>
            <label className="flex items-center gap-2">
              Fondo (opcional)
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="text-xs"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f || !id) return;
                  const fd = new FormData();
                  fd.set("sorteo_id", id);
                  fd.set("kind", "background");
                  fd.set("file", f);
                  const res = await fetchWithSupabaseSession("/api/sorteos/ticket-assets", {
                    method: "POST",
                    body: fd,
                  });
                  if (!res.ok) alert(await res.text());
                  else alert("Fondo subido.");
                }}
              />
            </label>
          </div>
          <p className="text-xs text-slate-600 border-t border-violet-200/80 pt-3">
            Al guardar el formulario, el ticket generado usará empresa + datos del comprador del flujo. Podés revisar
            envíos en el reservorio <strong>Tickets / Comprobantes</strong>.
          </p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-slate-800 border-b border-slate-100 pb-2">Datos bancarios</h2>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Datos bancarios (JSON)</label>
          <textarea
            className="w-full font-mono text-xs border border-slate-200 rounded-lg px-3 py-2 min-h-[100px]"
            value={datosBancarios}
            onChange={(e) => setDatosBancarios(e.target.value)}
          />
        </div>
        </section>
        <div className="flex gap-3 pt-1">
          <button
            type="submit"
            disabled={guardando}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-50 text-white px-5 py-2.5 rounded-lg text-sm font-medium"
          >
            {guardando ? "Guardando…" : "Guardar"}
          </button>
          <Link href="/sorteos" className="px-5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">
            Volver
          </Link>
        </div>
      </form>
    </div>
  );
}
