# Crear un schema ERP nuevo, autónomo e independiente

Guía para clonar la estructura del ERP a un **schema nuevo, 100 % independiente y vacío**
(sin datos), y conectar toda la app a él. Pensado para **Supabase self-hosted**.

> **Molde:** `enlodemari` (el schema que la app usa hoy).
> **Resultado:** un schema nuevo con todas las tablas, funciones, triggers, RLS,
> vistas y realtime — sin filas — y sin dependencias hacia `enlodemari`/`zentra_erp`/`public`.

---

## 0. Por qué clonar y no "replayar" migraciones

Las 152 migraciones de `supabase/migrations/` quedaron a medio migrar (objetos repartidos
entre `public` y `zentra_erp`), así que replayarlas en un schema nuevo es frágil. En cambio,
**clonamos la estructura real y sana del schema que funciona hoy** (`enlodemari`) reescribiendo
todas las referencias internas al nombre nuevo. Es lo mismo que se hizo para crear `enlodemari`.

Datos que hacen el clon seguro y simple (verificados en este repo):
- Sin tipos/enums/domains propios.
- Todas las PK con `gen_random_uuid()` (sin `serial`/secuencias).
- Única extensión: `pg_trgm` (global, ya instalada).

---

## 1. Prerrequisitos

```bash
npm install          # instala dependencias (pg, dotenv) si aún no lo hiciste
```

Creá un archivo `.env.local` en la raíz con la **conexión directa** a tu Postgres
(usuario `postgres`/superusuario — necesario para crear schema, grants y SECURITY DEFINER):

```
SUPABASE_DB_URL=postgresql://postgres:TU_PASSWORD@TU_HOST:5432/postgres
```

> El clonador usa solo `SUPABASE_DB_URL`. Las variables de la app (`NEXT_PUBLIC_SUPABASE_URL`,
> keys, etc.) se configuran en el paso 4.

---

## 2. Clonar la estructura (vacía)

Elegí el nombre del schema nuevo. Recomendado: prefijo `erp_` (varios paths del código
escanean schemas `^erp_...`), aunque cualquier identificador válido funciona.

```bash
npm run db:clone-schema -- --target erp_nuevo
```

Variantes:

```bash
# Recrear si el schema ya existe (DROP CASCADE + clon limpio)
npm run db:clone-schema -- --target erp_nuevo --drop

# Cambiar el molde de origen
npm run db:clone-schema -- --target erp_nuevo --source enlodemari

# Clonar + copiar SOLO catálogo de producto (no datos de cliente)
npm run db:clone-schema -- --target erp_nuevo --seed-catalog

# Solo verificar un schema ya creado
npm run db:clone-schema -- --target erp_nuevo --verify-only
```

Al final imprime un reporte: tablas destino/origen, funciones, policies RLS, tablas con RLS,
tablas en realtime, **filas totales (debe ser 0)**, tablas faltantes y **FKs que aún cuelguen
de un schema viejo** (debe ser 0).

> Las funciones `neura_%` (plumbing multi-tenant) se omiten a propósito, así que el conteo de
> funciones destino será un poco menor que el de origen. Es lo esperado.

---

## 3. (Opcional) Seed del catálogo

Un schema 100 % vacío no muestra módulos ni permite armar el login. El catálogo de módulos y
planes es **dato de producto**, no del cliente. Para copiarlo:

```bash
npm run db:clone-schema -- --target erp_nuevo --seed-catalog
# o eligiendo las tablas:
npm run db:clone-schema -- --target erp_nuevo --seed-catalog --seed-tables modulos,planes
```

---

## 4. Conectar la app al schema nuevo

### 4.1 Variable de entorno (runtime)

Toda la app resuelve el schema desde **una sola variable**. En `.env.local` (y en el entorno
de producción/Vercel si aplica):

```
NEURA_CLIENT_SCHEMA=erp_nuevo
```

Con esto, los clientes Supabase (browser/server/service-role) y el pool `pg` del chat apuntan
al schema nuevo. **No hay que tocar código.** El allow-list del chat
(`assertAllowedChatDataSchema`) lo acepta automáticamente porque coincide con el schema activo.

> Opcional: si querés que el **default del repo** sea el nuevo (sin depender de la env var),
> cambiá `"enlodemari"` por `"erp_nuevo"` en `src/lib/supabase/schema.ts:9`.

### 4.2 Exponer el schema en PostgREST (self-hosted) — **imprescindible**

PostgREST solo sirve los schemas listados en su config. En tu `docker-compose.yml` de Supabase,
servicio **`rest`**, agregá el schema nuevo:

```yaml
rest:
  environment:
    PGRST_DB_SCHEMAS: "public,graphql_public,erp_nuevo"        # + tu schema
    PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions,erp_nuevo"  # + tu schema
```

Reiniciá el servicio:

```bash
docker compose restart rest
```

> El clonador ya hace `NOTIFY pgrst, 'reload schema'`, pero **agregar el schema a
> `PGRST_DB_SCHEMAS` y reiniciar** es obligatorio para que sea visible vía API.

### 4.3 `supabase/config.toml` (si usás Supabase CLI local)

Agregá el schema a las dos listas:

```toml
schemas = ["public", "graphql_public", "enlodemari", "zentra_erp", "erp_nuevo"]
extra_search_path = ["erp_nuevo", "public", "extensions"]
```

---

## 5. Bootstrap de login

`auth.users` es global del proyecto (no se clona). Para entrar al ERP con el schema nuevo
necesitás, dentro de `erp_nuevo`:

1. Una fila en `empresas`.
2. Una fila en `usuarios` vinculada a tu usuario de `auth.users` (super-admin).
3. Filas en `empresa_modulos` / `usuario_modulos` para habilitar módulos.

> Decime el email/UUID del usuario de `auth.users` que querés como super-admin y la empresa
> inicial, y te genero el SQL exacto de bootstrap (está fuera del clon porque depende de tus datos).

---

## 6. Verificación final

```bash
npm run db:clone-schema -- --target erp_nuevo --verify-only   # estructura
npm run dev                                                    # levantar la app
```

Checklist:
- [ ] Reporte sin tablas faltantes ni FKs colgando de schemas viejos.
- [ ] `rest` reiniciado con `PGRST_DB_SCHEMAS` incluyendo el schema nuevo.
- [ ] `NEURA_CLIENT_SCHEMA=erp_nuevo` en el entorno.
- [ ] Login OK tras el bootstrap del paso 5.

---

## 7. Rollback

El schema nuevo es aditivo y no toca los existentes. Para descartarlo:

```sql
DROP SCHEMA erp_nuevo CASCADE;
-- y quitar las tablas de la publicación realtime si quedaron:
-- (DROP SCHEMA CASCADE ya las remueve de supabase_realtime)
```

Quitá el schema de `PGRST_DB_SCHEMAS`, reiniciá `rest`, y volvé `NEURA_CLIENT_SCHEMA` al anterior.

---

## Artefactos

- `scripts/sql/neura_clone_schema_full.sql` — función `public.neura_clone_schema_full(src, tgt, drop)`.
- `scripts/clone-erp-schema.cjs` — runner (clona, opcional seed, verifica).
- `package.json` → `npm run db:clone-schema`.
