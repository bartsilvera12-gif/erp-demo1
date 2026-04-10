"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getCurrentUser, getSession } from "@/lib/auth";
import { isBootstrapSuperAdminEmail } from "@/lib/auth/super-admin-bootstrap-email";
import { pathRequiresModuleSlug } from "@/lib/modulos/route-slug-map";

const PUBLIC_ROUTES = ["/login"];

type ModuleAccess = { superAdmin: boolean; slugs: Set<string> };

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<ModuleAccess | null>(null);

  const isPublic = useMemo(
    () => !!(pathname && PUBLIC_ROUTES.includes(pathname)),
    [pathname]
  );

  useEffect(() => {
    if (isPublic) {
      setLoading(false);
      setAccess(null);
      return;
    }

    let cancelled = false;

    async function checkAuthAndModules() {
      setLoading(true);
      const session = await getSession();
      if (cancelled) return;
      if (!session) {
        router.push("/login");
        setLoading(false);
        return;
      }

      const res = await fetchWithSupabaseSession("/api/empresas/module-access", {
        cache: "no-store",
      });
      if (cancelled) return;

      let superAdmin = false;
      let slugs: string[] = [];

      const bootstrapSuper = isBootstrapSuperAdminEmail(session.user.email ?? null);

      if (res.ok) {
        const data = (await res.json()) as { superAdmin?: boolean; slugs?: string[] };
        superAdmin = !!data.superAdmin || bootstrapSuper;
        slugs = Array.isArray(data.slugs) ? data.slugs : [];
      } else {
        superAdmin = bootstrapSuper;
      }

      if (!superAdmin) {
        try {
          const cu = await getCurrentUser();
          if ((cu?.rol ?? "").trim() === "super_admin") superAdmin = true;
        } catch {
          /* sin fila usuarios en cliente */
        }
      }

      setAccess({
        superAdmin,
        slugs: new Set(slugs),
      });
      setLoading(false);
    }

    checkAuthAndModules();
    return () => {
      cancelled = true;
    };
  }, [isPublic, router]);

  useEffect(() => {
    if (loading || isPublic || !access || !pathname) return;

    if (pathname.startsWith("/admin") && !access.superAdmin) {
      router.replace("/");
      return;
    }

    const slug = pathRequiresModuleSlug(pathname);
    if (slug && !access.superAdmin && !access.slugs.has(slug)) {
      router.replace("/");
    }
  }, [pathname, access, loading, isPublic, router]);

  if (loading && !isPublic) {
    return (
      <div className="flex items-center justify-center min-h-screen text-sm text-gray-400">
        Cargando…
      </div>
    );
  }

  return <>{children}</>;
}
