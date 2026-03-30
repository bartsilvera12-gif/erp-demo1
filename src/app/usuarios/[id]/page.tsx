"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";

const fLabel = "block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1";
const fInput =
  "w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/20 bg-white";

function SectionCard({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
      <div className="flex items-center gap-2 mb-5 pb-2 border-b border-gray-100">
        <span className="text-base">{icon}</span>
        <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </section>
  );
}

type ModuloOpt = { id: string; nombre: string; slug: string };

type Usuario = {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  fecha_nacimiento: string | null;
  rol: string | null;
  estado: string | null;
  created_at: string;
  modulo_ids?: string[];
  modulos_empresa?: ModuloOpt[];
  puede_editar_modulos?: boolean;
};

function UsuarioDetailContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = String(params?.id ?? "");
  const editMode = searchParams?.get("edit") === "1";

  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [editing, setEditing] = useState(editMode);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [form, setForm] = useState({
    nombre: "",
    email: "",
    telefono: "",
    fecha_nacimiento: "",
    estado: "activo" as "activo" | "inactivo",
    modulo_ids: [] as string[],
  });

  useEffect(() => {
    if (!id) return;
    setLoadError(null);
    fetch(`/api/empresas/usuarios/${id}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `Error ${r.status}`);
        return data;
      })
      .then((data) => {
        const u = data as Usuario;
        setUsuario(u);
        setForm({
          nombre: u.nombre ?? "",
          email: u.email ?? "",
          telefono: u.telefono ?? "",
          fecha_nacimiento: u.fecha_nacimiento ? u.fecha_nacimiento.slice(0, 10) : "",
          estado: (u.estado as "activo" | "inactivo") ?? "activo",
          modulo_ids: u.modulo_ids ?? [],
        });
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "No se pudo cargar el usuario");
      });
  }, [id]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value, type } = e.target;
    if (type === "checkbox" && name.startsWith("modulo_")) {
      const id = (e.target as HTMLInputElement).value;
      const checked = (e.target as HTMLInputElement).checked;
      setForm((prev) => ({
        ...prev,
        modulo_ids: checked ? [...prev.modulo_ids, id] : prev.modulo_ids.filter((m) => m !== id),
      }));
      return;
    }
    setForm((prev) => ({
      ...prev,
      [name]: name === "email" ? value.toLowerCase() : name === "nombre" ? value.toUpperCase() : value,
    }));
  }

  async function handleGuardar(e: React.FormEvent) {
    e.preventDefault();
    if (!usuario) return;
    setFormError(null);
    setSuccessMessage(null);
    if (!form.nombre.trim()) {
      setFormError("El nombre es obligatorio.");
      return;
    }
    if (!form.email.trim()) {
      setFormError("El email es obligatorio.");
      return;
    }

    setGuardando(true);
    try {
      const body: Record<string, unknown> = {
        nombre: form.nombre.trim(),
        email: form.email.trim().toLowerCase(),
        telefono: form.telefono.trim() || undefined,
        fecha_nacimiento: form.fecha_nacimiento || undefined,
        estado: form.estado,
      };
      if (usuario.puede_editar_modulos) {
        body.modulo_ids = form.modulo_ids;
      }

      const res = await fetch(`/api/empresas/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? `Error al guardar (${res.status})`);
      }
      setUsuario({
        ...usuario,
        nombre: form.nombre.trim(),
        email: form.email.trim().toLowerCase(),
        telefono: form.telefono.trim() || null,
        fecha_nacimiento: form.fecha_nacimiento || null,
        estado: form.estado,
        modulo_ids: usuario.puede_editar_modulos ? [...form.modulo_ids] : usuario.modulo_ids,
      });
      setEditing(false);
      setSuccessMessage("Cambios guardados correctamente en la base de datos.");
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setGuardando(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Link href="/usuarios" className="hover:text-gray-700 transition-colors">
            Usuarios
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Error</span>
        </div>
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-4">
          <p className="font-medium">{loadError}</p>
          <p className="text-xs text-red-600 mt-2">Los cambios no se guardaron. Verificá que tenés permiso para editar este usuario.</p>
        </div>
        <Link
          href="/usuarios"
          className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800"
        >
          ← Volver a usuarios
        </Link>
      </div>
    );
  }

  if (!usuario) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-gray-400">
        Cargando…
      </div>
    );
  }

  function formatFecha(s?: string | null) {
    if (!s) return "—";
    const [y, m, d] = s.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/usuarios" className="hover:text-gray-700 transition-colors">
          Usuarios
        </Link>
        <span>/</span>
        <span className="text-gray-700 font-medium">{usuario.nombre ?? usuario.email}</span>
      </div>

      {successMessage && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-xl px-4 py-3">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 shrink-0 text-green-600">
            <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
          </svg>
          <span className="font-medium">{successMessage}</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-bold shrink-0 bg-violet-500">
            {(usuario.nombre ?? usuario.email)
              .split(" ")
              .slice(0, 2)
              .map((w) => w[0])
              .join("")
              .toUpperCase() || "?"}
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">{usuario.nombre ?? "—"}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{usuario.email}</p>
            <span
              className={`inline-flex mt-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                usuario.estado === "activo" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {usuario.estado ?? "activo"}
            </span>
          </div>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors text-gray-700"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M2.695 14.763l-1.262 3.154a.5.5 0 0 0 .65.65l3.155-1.262a4 4 0 0 0 1.343-.885L17.5 5.5a2.121 2.121 0 0 0-3-3L3.58 13.42a4 4 0 0 0-.885 1.343Z" />
            </svg>
            Editar
          </button>
        )}
      </div>

      {!editing && (
        <div className="space-y-6">
          <SectionCard title="Datos personales" icon="👤">
            <div className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm">
              {[
                { label: "Nombre", value: usuario.nombre ?? "—" },
                { label: "Email", value: usuario.email },
                { label: "Teléfono", value: usuario.telefono ?? "—" },
                { label: "Fecha nacimiento", value: formatFecha(usuario.fecha_nacimiento) },
              ].map((i) => (
                <div key={i.label}>
                  <p className="text-xs text-gray-400">{i.label}</p>
                  <p className="font-medium text-gray-800">{i.value}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          {(usuario.modulos_empresa?.length ?? 0) > 0 && (
            <SectionCard title="Módulos del usuario" icon="📦">
              <p className="text-xs text-gray-500 mb-3">
                Solo se listan módulos habilitados para la empresa. El acceso efectivo es la intersección con lo asignado a este usuario.
              </p>
              <ul className="flex flex-wrap gap-2">
                {(usuario.modulos_empresa ?? [])
                  .filter((m) => (usuario.modulo_ids ?? []).includes(m.id))
                  .map((m) => (
                    <li
                      key={m.id}
                      className="text-sm font-medium px-3 py-1 rounded-full bg-slate-100 text-slate-800 border border-slate-200"
                    >
                      {m.nombre}
                    </li>
                  ))}
              </ul>
              {(usuario.modulo_ids ?? []).length === 0 && (
                <p className="text-sm text-amber-700 mt-2">Sin módulos asignados (solo verá el inicio hasta que un administrador asigne módulos).</p>
              )}
            </SectionCard>
          )}
        </div>
      )}

      {editing && (
        <form onSubmit={handleGuardar} className="space-y-6">
          {formError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
              {formError}
            </div>
          )}

          <SectionCard title="Datos personales" icon="👤">
            <div className="space-y-4">
              <div>
                <label className={fLabel}>Nombre completo *</label>
                <input
                  type="text"
                  name="nombre"
                  value={form.nombre}
                  onChange={handleChange}
                  className={`${fInput} uppercase`}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={fLabel}>Email *</label>
                  <input
                    type="email"
                    name="email"
                    value={form.email}
                    onChange={handleChange}
                    className={fInput}
                    required
                  />
                </div>
                <div>
                  <label className={fLabel}>Teléfono</label>
                  <input type="text" name="telefono" value={form.telefono} onChange={handleChange} className={fInput} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={fLabel}>Fecha de nacimiento</label>
                  <input
                    type="date"
                    name="fecha_nacimiento"
                    value={form.fecha_nacimiento}
                    onChange={handleChange}
                    className={fInput}
                  />
                </div>
                <div>
                  <label className={fLabel}>Estado</label>
                  <select name="estado" value={form.estado} onChange={handleChange} className={fInput}>
                    <option value="activo">Activo</option>
                    <option value="inactivo">Inactivo</option>
                  </select>
                </div>
              </div>
            </div>
          </SectionCard>

          {usuario.puede_editar_modulos && (usuario.modulos_empresa?.length ?? 0) > 0 && (
            <SectionCard title="Módulos del usuario" icon="📦">
              <p className="text-xs text-gray-500 mb-4">
                Marcá solo los módulos que esta persona puede usar. La lista muestra únicamente lo habilitado para tu empresa.
              </p>
              <div className="space-y-2">
                {(usuario.modulos_empresa ?? []).map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-2.5 cursor-pointer hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      name={`modulo_${m.id}`}
                      value={m.id}
                      checked={form.modulo_ids.includes(m.id)}
                      onChange={handleChange}
                      className="rounded border-gray-300 text-gray-900 focus:ring-gray-900/20"
                    />
                    <span className="text-sm font-medium text-gray-800">{m.nombre}</span>
                    <span className="text-xs text-gray-400 ml-auto font-mono">{m.slug}</span>
                  </label>
                ))}
              </div>
            </SectionCard>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={guardando}
              className="bg-gray-900 text-white text-sm font-semibold px-6 py-2.5 rounded-lg hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              {guardando ? "Guardando…" : "Guardar cambios"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-sm text-gray-500 hover:text-gray-800 transition-colors px-4 py-2.5"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function UsuarioDetailPage() {
  return (
    <Suspense
      fallback={<div className="flex items-center justify-center py-24 text-sm text-gray-400">Cargando…</div>}
    >
      <UsuarioDetailContent />
    </Suspense>
  );
}
