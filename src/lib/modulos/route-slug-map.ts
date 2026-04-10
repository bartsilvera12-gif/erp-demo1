/**
 * Asocia pathname del App Router a slug de `modulos.slug`.
 * `null` = no aplica gate de módulo (acceso con sesión).
 */

/** Orden del menú lateral (misma idea que Sidebar): primera entrada accesible = “home” sin dashboard. */
const SIDEBAR_SLUG_HREF_ORDER: { slug: string; href: string }[] = [
  { slug: "dashboard", href: "/" },
  { slug: "conversaciones", href: "/dashboard/conversaciones" },
  { slug: "historial-omnicanal", href: "/dashboard/historial-omnicanal" },
  { slug: "colas-agentes", href: "/dashboard/colas-agentes" },
  { slug: "ventas", href: "/ventas" },
  { slug: "inventario", href: "/inventario" },
  { slug: "clientes", href: "/clientes" },
  { slug: "compras", href: "/compras" },
  { slug: "gastos", href: "/gastos" },
  { slug: "pagos", href: "/pagos" },
  { slug: "usuarios", href: "/usuarios" },
  { slug: "configuracion", href: "/configuracion" },
  { slug: "planes", href: "/planes" },
  { slug: "gestion-clientes", href: "/gestion-clientes" },
  { slug: "crm", href: "/crm" },
  { slug: "marketing", href: "/marketing" },
  { slug: "sorteos", href: "/sorteos" },
];

/** Slugs otorgados explícitamente o por alias (p. ej. `clientes` incluye gestión de cartera). */
export function isModuleSlugGranted(routeSlug: string, grantedSlugs: Set<string>): boolean {
  if (grantedSlugs.has(routeSlug)) return true;
  if (routeSlug === "conversaciones" && grantedSlugs.has("omnicanal")) return true;
  if (routeSlug === "gestion-clientes" && grantedSlugs.has("clientes")) return true;
  return false;
}

/**
 * Acceso a un ítem del menú (super admin ve todo; resto según empresa_modulos ∩ usuario_modulos).
 */
export function canAccessSidebarSlug(
  slug: string,
  grantedSlugs: Set<string>,
  esSuperAdmin: boolean
): boolean {
  if (esSuperAdmin) return true;
  if (slug === "dashboard") return grantedSlugs.has("dashboard");
  if (slug === "conversaciones" || slug === "historial-omnicanal" || slug === "colas-agentes") {
    return grantedSlugs.has("conversaciones") || grantedSlugs.has("omnicanal");
  }
  return isModuleSlugGranted(slug, grantedSlugs);
}

/** Primera ruta de app a la que puede entrar el usuario (p. ej. tras login en `/` sin módulo dashboard). */
export function firstAccessibleHref(
  grantedSlugs: Set<string>,
  opts?: { superAdmin?: boolean }
): string {
  if (opts?.superAdmin) return "/";
  for (const { slug, href } of SIDEBAR_SLUG_HREF_ORDER) {
    if (canAccessSidebarSlug(slug, grantedSlugs, false)) return href;
  }
  return "/login";
}

export function pathRequiresModuleSlug(pathname: string): string | null {
  const p = pathname.split("?")[0] ?? pathname;
  if (!p) return null;
  if (p === "/") return "dashboard";
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
