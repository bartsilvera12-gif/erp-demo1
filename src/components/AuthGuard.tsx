"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { getSession } from "@/lib/auth";
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

      const res = await fetch("/api/empresas/module-access", { cache: "no-store" });
      if (cancelled) return;
      if (!res.ok) {
        setAccess({ superAdmin: false, slugs: new Set() });
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { superAdmin?: boolean; slugs?: string[] };
      setAccess({
        superAdmin: !!data.superAdmin,
        slugs: new Set(Array.isArray(data.slugs) ? data.slugs : []),
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
