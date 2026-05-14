# Propuesta final — Tracevault 1.0.0: arranque de app, scopes nombrados, lectura/escritura separadas

| Campo | Valor |
|--------|--------|
| **Versión objetivo** | **`1.0.0`** — primera línea base **estable y óptima** de la librería. |
| **Adoptantes** | No hay aplicaciones en producción dependiendo de la API actual; **no** es requisito conservar las fábricas públicas de bajo nivel si entorpecen el diseño. |
| **Estado** | **Final** — lista para implementación y revisión de código. |
| **Sustituye** | [`0.5.0-init-and-named-scopes.md`](./0.5.0-init-and-named-scopes.md) (modelo obsoleto). |

---

## 1. Resumen ejecutivo

La API recomendada y **canónica** en **1.0.0** es **`startTracevault`**: una sola llamada al levantar la aplicación que (opcionalmente) **asegura el esquema en PostgreSQL**, abre **hasta dos pools** (`pg.Pool`) — escritura y lectura — y devuelve un **`TracevaultApp`** con **`emit` / `emitDiff`**, **`getScope(nombre)`**, **`query`** (Read API) y **`close`**.

- **Scopes por nombre:** `const UserAudit = tracevault.getScope("users")` — mismos pools de toda la app, otra tabla; handles **cacheables** por nombre (sin pool por scope).
- **Seguridad:** en producción, **`readConnectionString`** apunta a un **rol solo `SELECT`**; **`connectionString`** a un rol con **`INSERT`** (y permisos de DDL si `ensureSchema` está activo). En local se puede omitir `readConnectionString` y usar un solo rol (documentado).
- **API legacy:** `createTracevault`, `createTracevaultQuery` y el subpath **`tracevault/query`** pueden **deprecarse** (`@deprecated` + JSDoc + CHANGELOG) o **eliminarse del surface público** si la implementación queda más simple (p. ej. solo uso interno). La decisión concreta (deprecar en 1.0.0 y borrar en 2.0.0 vs. borrar ya en 1.0.0) se documenta en **CHANGELOG** y README de migración desde `0.4.x`.

---

## 2. Problema

Hoy el integrador combina DDL manual o `generateInitSql`, `createTracevault`, `createTracevaultQuery` y `scope({ tableName })` con posibles **dos configuraciones** desalineadas. Para **1.0.0** se prioriza **una superficie óptima** (`startTracevault` + `TracevaultApp`), no mantener dos formas de hacer lo mismo en igualdad de condiciones.

---

## 3. Objetivos

1. Al iniciar la app: **asegurar tablas** (idempotente, alineado con el DDL canónico) + **pools de runtime** listos.
2. Runtime: **`getScope("alias")`** sin crear pools adicionales; solo cambia la tabla efectiva.
3. Read API integrada en el mismo objeto (`query` en raíz y por scope) usando el **pool de lectura**.
4. **Superficie pública mínima y coherente** para 1.0.0; eliminar o deprecar lo que compita con ese modelo sin aportar casos reales de adopción.

### 3.1 No objetivos (1.0.0)

- Renombrar `emit` / `emitDiff` ni introducir `audit` como nombre principal.
- Motor de migraciones versionado (Prisma/Knex-style).
- `schema.tabla` calificado en identificadores salvo que se extienda validación y quoting en driver/reader en el mismo release.
- Singleton global de módulo (`getTracevault()` implícito): el patrón recomendado es **una instancia** creada en el bootstrap de la app e inyectada donde haga falta.

---

## 4. API pública

### 4.1 Entrada: `startTracevault(options)`

```ts
import { startTracevault } from "tracevault";

const tracevault = await startTracevault({
  driver: "postgres",
  /** Rol con INSERT (y DDL si `bootstrap.ensureSchema` crea tablas). */
  connectionString: process.env.DATABASE_URL_WRITE!,
  /** Opcional. Si se omite → misma URL que `connectionString` (solo desarrollo / mismo rol). */
  readConnectionString: process.env.DATABASE_URL_READ,
  defaultScope: "default",
  scopes: {
    default: { tableName: "audit_logs" },
    users: { tableName: "audit_user_events" },
    billing: { tableName: "audit_billing_events" },
  },
  bootstrap: {
    /** Default recomendado: `true`. Si `false`, no ejecuta DDL (migraciones externas). */
    ensureSchema: true,
  },
  // Opcional: opciones de comportamiento (defaultMode, maskFields, asyncBatchSize, …)
});
```

**Nombre del export:** `startTracevault` (definitivo salvo choque de nombres en implementación; alternativas documentadas en CHANGELOG si se renombra).

**Retorno:** `Promise<TracevaultApp>`.

### 4.2 Salida: `TracevaultApp` (forma lógica)

| Miembro | Descripción |
|---------|-------------|
| `emit` / `emitDiff` / `flush` | Escritura en la tabla del **`defaultScope`** (pool **escritura**). |
| `getScope(name)` | Devuelve handle con `emit`, `emitDiff`, `flush`, `query` para la tabla de `scopes[name]` (mismos pools). |
| `query` | Read API (`findMany`, `findById`, `count`, …) sobre **`defaultScope`** (pool **lectura**). |
| `close()` | `pool.end()` del pool de escritura y del de lectura (orden: drenar colas / cerrar writers → `end` write → `end` read, o el orden que garantice tests; documentar en README). |
| `healthcheck()` | Opcional: `true` solo si **ambos** pools responden (o API explícita write/read si se prefiere en implementación). |

### 4.3 Ejemplos de uso

```ts
await tracevault.emit({ event: "system.ready", data: { version: "1.0.0" } });

const UserAudit = tracevault.getScope("users");
await UserAudit.emit({ event: "user.created", target: { type: "user", id: "u1" } });

const rows = await tracevault.query.findMany({ event: "user.created", limit: 50 });
const billing = await tracevault.getScope("billing").query.findMany({
  event: "invoice.paid",
  limit: 20,
});

await tracevault.close();
```

---

## 5. Pools y seguridad

| Escenario | Pools |
|-----------|--------|
| Producción recomendada | **2:** `connectionString` (write), `readConnectionString` (read-only). |
| Local / tests | **1:** solo `connectionString`; read reutiliza write. |

**Límites:** fijar `max` (y demás opciones de `Pool`) de forma razonable por defecto; permitir override opcional en config avanzada si hace falta en una versión posterior.

**DDL:** solo con credencial con permisos de esquema (típicamente **write** o rol de migración). **Nunca** usar el pool del rol solo lectura para `CREATE TABLE` / `CREATE INDEX`.

**Bootstrap DDL transitorio:** cliente único o pool `max: 1` **solo** durante el paso `ensureSchema`, cerrado antes o alineado con la vida del pool write — sin dejar conexiones colgadas.

---

## 6. Configuración y validación

- **`scopes`:** `Record<string, { tableName: string }>`. Claves = alias lógicos (regex acordada, p. ej. `^[a-zA-Z][a-zA-Z0-9_-]*$`). Valores: `tableName` con **`assertValidTableName`** actual.
- **`defaultScope`:** obligatorio; debe existir en `scopes`.
- **Tablas físicas duplicadas:** dos alias al mismo `tableName` es válido; ejecutar DDL **una vez** por nombre físico único.
- **Scopes solo por nombre en la API pública:** la tabla física no forma parte del flujo de uso diario; queda en la config de arranque.

---

## 7. Bootstrap de esquema

- Una **única fuente de verdad** del DDL en código: refactor interno para que `generateInitSql` (si se mantiene como utilidad para operadores/migraciones) y el runner de `ensureSchema` compartan la misma definición (evita divergencia con `sql/*.sql` y README).
- Comportamiento idempotente: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc., equivalente al contrato documentado del DDL canónico.
- Tabla existente **incompatible** con el esquema esperado: fallar en bootstrap con error claro (`ConfigError`); no prometer migraciones column-by-column complejas en 1.0.0.

---

## 8. Arquitectura de implementación

```
startTracevault(config)
  ├─ validate (scopes, defaultScope, names, tableNames)
  ├─ if bootstrap.ensureSchema:
  │    └─ for each distinct tableName → run shared DDL (connection: write / migrator)
  ├─ new Pool(write)   → escritura (defaultScope + tablas por scope)
  ├─ new Pool(read)    → lectura (fallback: same URL as write)
  ├─ wire defaultScope emit + query
  └─ getScope(name) → cached handle { emit, emitDiff, flush, query } delegating to same pools
```

La implementación puede **factorizar** la lógica actual de driver, reader, cola y normalización **sin** exponer los mismos entrypoints públicos que en `0.4.x`, si eso reduce duplicación y superficie.

---

## 9. Superficie pública y legacy (1.0.0)

| Pieza | Dirección recomendada |
|--------|------------------------|
| **`startTracevault`**, **`TracevaultApp`**, tipos asociados | **API pública principal** desde `tracevault`. |
| **`generateInitSql`** | **Mantener** como utilidad para quien aplica DDL fuera de Node (ops, pipelines), o documentar equivalente; compartir núcleo con `ensureSchema`. |
| **`createTracevault`**, **`createTracevaultQuery`**, export **`tracevault/query`** | **Deprecar** (señal en tipos + README + CHANGELOG) **y/o retirar** del package público. Si se retiran, el **CHANGELOG de 1.0.0** lista breaking changes y un único camino de migración hacia `startTracevault`. |

No hay requisito de compatibilidad con consumidores inexistentes; la barra es **claridad**, **seguridad por defecto** (dos roles) y **mantenibilidad** del código.

---

## 10. Semver y comunicación de release

- **`1.0.0`** comunica “API estable que pretendemos respetar en versiones minor/patch según SemVer”.
- Cualquier **breaking** respecto a `0.4.x` (exports, subpaths, firmas) se concentra en este release y se describe en **CHANGELOG.md** bajo *Migrating from 0.4.x*.

---

## 11. Tests

- `ensureSchema: true` → tablas creadas → `emit` + `query.findMany` funcionan.
- Dos URLs distintas (si el entorno de CI lo permite) o mock: lectura no usa pool de escritura para `findMany`.
- `getScope("users")` llamado dos veces → misma identidad de handle si se cachea (opcional assert).
- `close()` → ambos pools cerrados; operaciones posteriores fallan de forma definida.
- Idempotencia: segundo arranque con mismas tablas no rompe (comportamiento documentado).

---

## 12. Documentación y release

- **README:** flujo único recomendado (`startTracevault`, `readConnectionString`, scopes, cierre); sección breve de migración desde `0.4.x` si hubo removals.
- **README / security:** rol solo lectura para `readConnectionString`.
- **CHANGELOG.md:** entrada **`1.0.0`** con breaking changes explícitos y guía de adopción.

---

## 13. Checklist de implementación

- [ ] Refactor DDL compartido (`ensureSchema` + utilidad SQL exportada si aplica)
- [ ] Dos pools (write/read) + cierre / healthcheck coherentes
- [ ] `startTracevault` + tipos + tests de integración
- [ ] Validación de nombres de scope + tests unitarios
- [ ] `getScope` con cache + `query` por scope
- [ ] Decisión explícita: deprecar vs. eliminar APIs `0.4.x` + reflejar en exports (`package.json` `exports`)
- [ ] README + CHANGELOG + bump **`package.json` → `1.0.0`**

---

## 14. Riesgos y seguimiento

- Longitud de nombres de tabla/índice vs límite PostgreSQL 63 caracteres.
- **Serverless:** documentar reutilización de instancia / límites de pool.
- **Futuro:** opciones de `Pool` en config; verificación de esquema vía `information_schema`; soporte `schema.table`.

---

*Fin de la propuesta final.*
