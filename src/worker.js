// 天性光谱 · test-code backend
// Static files come from ./public; /api/* is handled here.
// Codes live in one SQLite-backed Durable Object, so no extra Cloudflare setup is needed.
import { DurableObject } from "cloudflare:workers";

// SHA-256 of the admin key. The key itself is never stored in this repo.
const ADMIN_HASH = "23f295963c2b9ff55966d7c35fe33df0f494597a1d350028ae83eb6f237af032";
const VALID_MS = 7 * 24 * 3600 * 1000; // 7 days after first use
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function normalize(raw) {
  let c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.startsWith("TX")) c = c.slice(2);
  if (c.length !== 8) return null;
  return "TX-" + c.slice(0, 4) + "-" + c.slice(4);
}
function newCode() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += ALPHA[x % 32];
  return "TX-" + s.slice(0, 4) + "-" + s.slice(4);
}

export class CodeStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, created INTEGER NOT NULL, device TEXT, first_used INTEGER, batch TEXT)"
    );
  }
  row(code) {
    return this.sql.exec("SELECT * FROM codes WHERE code = ?", code).toArray()[0] || null;
  }
  // bind=true on redeem (claims an unused code); bind=false only re-checks a saved unlock
  use(code, device, bind) {
    const r = this.row(code);
    const now = Date.now();
    if (!r) return { status: "invalid" };
    if (r.first_used && now > r.first_used + VALID_MS) return { status: "expired", expires: r.first_used + VALID_MS };
    if (r.device && r.device !== device) return { status: "other_device" };
    if (!r.device) {
      if (!bind) return { status: "invalid" };
      const first = r.first_used || now;
      this.sql.exec("UPDATE codes SET device = ?, first_used = ? WHERE code = ?", device, first, code);
      return { status: "ok", expires: first + VALID_MS };
    }
    return { status: "ok", expires: r.first_used + VALID_MS };
  }
  generate(n, batch) {
    const out = [];
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      while (out.length < n) {
        const c = newCode();
        if (this.row(c)) continue;
        this.sql.exec("INSERT INTO codes (code, created, batch) VALUES (?, ?, ?)", c, now, batch);
        out.push(c);
      }
    });
    return out;
  }
  importCodes(list, batch) {
    let added = 0;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const raw of list) {
        const c = normalize(raw);
        if (!c || this.row(c)) continue;
        this.sql.exec("INSERT INTO codes (code, created, batch) VALUES (?, ?, ?)", c, now, batch);
        added++;
      }
    });
    return added;
  }
  stats() {
    const cut = Date.now() - VALID_MS;
    const one = (q, ...a) => this.sql.exec(q, ...a).toArray()[0].n;
    return {
      total: one("SELECT COUNT(*) AS n FROM codes"),
      unused: one("SELECT COUNT(*) AS n FROM codes WHERE first_used IS NULL"),
      active: one("SELECT COUNT(*) AS n FROM codes WHERE first_used >= ?", cut),
      expired: one("SELECT COUNT(*) AS n FROM codes WHERE first_used < ?", cut)
    };
  }
  list(status) {
    const cut = Date.now() - VALID_MS;
    const q = {
      unused: ["SELECT * FROM codes WHERE first_used IS NULL ORDER BY created, code"],
      active: ["SELECT * FROM codes WHERE first_used >= ? ORDER BY first_used DESC", cut],
      expired: ["SELECT * FROM codes WHERE first_used < ? ORDER BY first_used DESC", cut],
      all: ["SELECT * FROM codes ORDER BY created, code"]
    }[status] || ["SELECT * FROM codes WHERE first_used IS NULL ORDER BY created, code"];
    return this.sql.exec(...q).toArray();
  }
  lookup(code) {
    const r = this.row(code);
    if (!r) return null;
    return { ...r, expires: r.first_used ? r.first_used + VALID_MS : null };
  }
  // lets a buyer move to a new phone; the 7-day clock keeps running
  resetDevice(code) {
    const r = this.row(code);
    if (!r) return false;
    this.sql.exec("UPDATE codes SET device = NULL WHERE code = ?", code);
    return true;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

async function isAdmin(req) {
  const key = req.headers.get("x-admin-key") || "";
  if (!key) return false;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === ADMIN_HASH;
}

function toCSV(rows) {
  const fmt = t => (t ? new Date(t + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16) : "");
  const lines = ["测试码,状态,首次使用(北京时间),到期(北京时间),批次"];
  const now = Date.now();
  for (const r of rows) {
    const st = !r.first_used ? "未使用" : now > r.first_used + VALID_MS ? "已过期" : "使用中";
    lines.push([r.code, st, fmt(r.first_used), fmt(r.first_used && r.first_used + VALID_MS), r.batch || ""].join(","));
  }
  return "﻿" + lines.join("\n") + "\n";
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    const store = env.CODES.get(env.CODES.idFromName("main"));
    try {
      if (p === "/api/health") return json({ ok: true });

      if (p === "/api/redeem" || p === "/api/check") {
        if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const b = await req.json().catch(() => ({}));
        const code = normalize(b.code);
        const device = String(b.device || "").slice(0, 80);
        if (!code || device.length < 8) return json({ status: "invalid" });
        return json(await store.use(code, device, p === "/api/redeem"));
      }

      if (p.startsWith("/api/admin/")) {
        if (!(await isAdmin(req))) return json({ error: "unauthorized" }, 401);
        if (p === "/api/admin/stats") return json(await store.stats());
        if (p === "/api/admin/generate" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const n = Math.max(1, Math.min(5000, parseInt(b.n, 10) || 100));
          const batch = String(b.batch || new Date().toISOString().slice(0, 10)).slice(0, 40);
          return json({ codes: await store.generate(n, batch) });
        }
        if (p === "/api/admin/import" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const list = Array.isArray(b.codes) ? b.codes.slice(0, 20000) : [];
          return json({ added: await store.importCodes(list, String(b.batch || "import").slice(0, 40)) });
        }
        if (p === "/api/admin/lookup") {
          const code = normalize(url.searchParams.get("code"));
          return json({ code: code ? await store.lookup(code) : null });
        }
        if (p === "/api/admin/reset" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          const code = normalize(b.code);
          return json({ ok: code ? await store.resetDevice(code) : false });
        }
        if (p === "/api/admin/export") {
          const rows = await store.list(url.searchParams.get("status") || "unused");
          return new Response(toCSV(rows), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="tianxing-codes-${url.searchParams.get("status") || "unused"}.csv"`,
              "cache-control": "no-store"
            }
          });
        }
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server_error" }, 500);
    }
  }
};
