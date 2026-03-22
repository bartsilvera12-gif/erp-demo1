/**
 * Cliente API para crear registros vía endpoints REST.
 * Usa la sesión del usuario (cookies) para autenticación.
 */

async function apiPost<T>(path: string, data: Record<string, unknown>): Promise<{ success: true; data: T } | { success: false; error: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) {
    return { success: false, error: json?.error ?? `Error ${res.status}` };
  }
  return json as { success: true; data: T };
}

export async function apiCreateCliente(data: {
  tipo_cliente?: string;
  tipo_servicio_cliente?: string;
  empresa?: string;
  nombre_contacto: string;
  ruc?: string;
  documento?: string;
  telefono?: string;
  email?: string;
  direccion?: string;
  ciudad?: string;
  pais?: string;
  condicion_pago?: string;
  moneda_preferida?: string;
  estado?: string;
}): Promise<{ id: string; [key: string]: unknown } | null> {
  const result = await apiPost<{ id: string; [key: string]: unknown }>("/api/clientes", data);
  return result.success ? result.data : null;
}

/** Obtiene datos previos para dar de baja (suscripciones, factura pendiente). */
export async function apiGetBajaOperativaPreview(clienteId: string): Promise<{
  suscripciones_activas: number;
  factura_pendiente_mes: { id: string; numero_factura: string; monto: number } | null;
  suscripciones: { id: string; precio: number; moneda: string }[];
} | null> {
  const res = await fetch(`/api/clientes/${clienteId}/baja-operativa`);
  const json = await res.json();
  if (!res.ok) return null;
  return json?.data ?? null;
}

/** Dar de baja operativa al cliente. Solo admin. Motivo obligatorio. */
export async function apiBajaOperativaCliente(
  clienteId: string,
  motivo: string,
  anularFacturaPendiente: boolean
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/clientes/${clienteId}/baja-operativa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motivo: motivo.trim(), anular_factura_pendiente: anularFacturaPendiente }),
  });
  const json = await res.json();
  if (!res.ok) {
    return { ok: false, error: json?.error ?? `Error ${res.status}` };
  }
  return { ok: true };
}

/** Eliminación lógica del cliente. Solo admin. Requiere motivo. */
export async function apiDeleteCliente(id: string, deletionReason: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/clientes/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deletion_reason: deletionReason }),
  });
  const json = await res.json();
  if (!res.ok) {
    return { ok: false, error: json?.error ?? `Error ${res.status}` };
  }
  return { ok: true };
}


export async function apiCreateFactura(data: {
  cliente_id: string;
  numero_factura: string;
  fecha: string;
  fecha_vencimiento: string;
  monto: number;
  tipo?: string;
  moneda?: string;
}): Promise<{ id: string; [key: string]: unknown } | null> {
  const result = await apiPost<{ id: string; [key: string]: unknown }>("/api/facturas", data);
  return result.success ? result.data : null;
}

export async function apiCreatePago(data: {
  factura_id: string;
  monto: number;
  fecha_pago: string;
  metodo_pago?: string;
  referencia?: string;
}): Promise<{ id: string; [key: string]: unknown } | null> {
  const result = await apiPost<{ id: string; [key: string]: unknown }>("/api/pagos", data);
  return result.success ? result.data : null;
}

export async function apiCreateSuscripcion(data: {
  cliente_id: string;
  plan_id?: string | null;
  precio: number;
  moneda?: string;
  fecha_inicio: string;
  duracion_meses?: number;
  dia_facturacion?: number;
  dia_vencimiento?: number;
  generar_factura_este_mes?: boolean;
}): Promise<{ id: string; [key: string]: unknown } | null> {
  const result = await apiPost<{ id: string; [key: string]: unknown }>("/api/suscripciones", data);
  return result.success ? result.data : null;
}
