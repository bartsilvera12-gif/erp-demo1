/**
 * Asocia pathname del App Router a slug de `modulos.slug`.
 * `null` = no aplica gate de módulo (acceso con sesión).
 */

export function pathRequiresModuleSlug(pathname: string): string | null {
  const p = pathname.split("?")[0] ?? pathname;
  if (!p || p === "/") return null;
  if (p.startsWith("/login")) return null;
  if (p.startsWith("/admin")) return null;
  if (p.startsWith("/api")) return null;
  if (p.startsWith("/usuarios")) return "usuarios";

  if (p.startsWith("/dashboard")) return "conversaciones";
  if (p.startsWith("/ventas")) return "ventas";
  if (p.startsWith("/inventario")) return "inventario";
  if (p.startsWith("/clientes")) return "clientes";
  if (p.startsWith("/compras")) return "compras";
  if (p.startsWith("/gastos")) return "gastos";
  if (p.startsWith("/pagos")) return "pagos";
  if (p.startsWith("/configuracion")) return "configuracion";
  if (p.startsWith("/planes")) return "planes";
  if (p.startsWith("/gestion-clientes")) return "gestion-clientes";
  if (p.startsWith("/crm")) return "crm";
  if (p.startsWith("/marketing")) return "marketing";
  if (p.startsWith("/sorteos")) return "sorteos";
  return null;
}
