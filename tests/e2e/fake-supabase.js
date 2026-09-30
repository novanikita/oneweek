/* In-memory stand-in for the subset of supabase-js the app uses. */
(function () {
  const USER = { id: "u1", email: "test@example.com" };
  const SESSION = { user: USER, access_token: "fake" };

  const db = { tasks: [], workspaces: [], user_settings: [] };
  let idSeq = 0;
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const nextId = (prefix) => `${prefix}-${++idSeq}`;
  const nowIso = () => new Date((clock += 1000)).toISOString();
  window.__fakeDb = db;
  window.__fakeLog = [];

  const DEFAULTS = {
    tasks: () => ({
      id: nextId("task"),
      created_at: nowIso(),
      content: "",
      completed: false,
      is_subtask: false,
      is_main: false,
      color: null,
      day_name: null,
      position: 0,
      workspace_id: null,
    }),
    workspaces: () => ({ id: nextId("ws"), created_at: nowIso(), position: 0, is_default: false }),
    user_settings: () => ({ custom_themes: [], theme_updated_at: nowIso() }),
  };
  const PK = { tasks: "id", workspaces: "id", user_settings: "user_id" };

  function violation(table) {
    if (table === "tasks") {
      const seen = new Set();
      for (const r of db.tasks) {
        if (r.type !== "general" || !r.is_main || r.is_subtask) continue;
        const k = `${r.user_id}|${r.workspace_id}|${r.date}`;
        if (seen.has(k)) return "tasks_one_main_thing_idx";
        seen.add(k);
      }
    }
    if (table === "workspaces") {
      const seen = new Set();
      for (const r of db.workspaces) {
        if (!r.is_default) continue;
        if (seen.has(r.user_id)) return "workspaces_one_default_per_user_idx";
        seen.add(r.user_id);
      }
    }
    return null;
  }
  const dupError = (name) => ({
    code: "23505",
    message: `duplicate key value violates unique constraint "${name}"`,
  });

  function pick(row, cols) {
    if (!cols || cols.trim() === "*") return { ...row };
    const out = {};
    for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) out[c] = row[c] ?? null;
    return out;
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.op = "select";
      this.filters = [];
      this.orders = [];
      this.cols = "*";
      this.returning = null;
      this.mode = null;
      this.countHead = false;
    }
    select(cols = "*", opts = {}) {
      if (this.op === "select") this.cols = cols;
      else this.returning = cols;
      if (opts.head) this.countHead = true;
      return this;
    }
    insert(payload) { this.op = "insert"; this.payload = payload; return this; }
    upsert(payload) { this.op = "upsert"; this.payload = payload; return this; }
    update(payload) { this.op = "update"; this.payload = payload; return this; }
    delete() { this.op = "delete"; return this; }
    eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
    is(col, val) { this.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
    gte(col, val) { this.filters.push((r) => r[col] != null && r[col] >= val); return this; }
    lte(col, val) { this.filters.push((r) => r[col] != null && r[col] <= val); return this; }
    order(col, { ascending = true } = {}) { this.orders.push([col, ascending]); return this; }
    single() { this.mode = "single"; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    then(resolve, reject) {
      return new Promise((r) => setTimeout(r, 3))
        .then(() =>
          window.__fakeOffline
            ? { data: null, error: { message: "TypeError: Failed to fetch" } }
            : this.run()
        )
        .then(resolve, reject);
    }
    match(r) { return this.filters.every((f) => f(r)); }
    shape(rows) {
      if (this.mode === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
      }
      if (this.mode === "maybe") {
        return rows.length <= 1
          ? { data: rows[0] ?? null, error: null }
          : { data: null, error: { message: "multiple rows" } };
      }
      return { data: rows, error: null };
    }
    run() {
      const table = db[this.table];
      const snapshot = JSON.stringify(db);
      const rollback = () => {
        const prev = JSON.parse(snapshot);
        for (const k of Object.keys(db)) db[k] = prev[k];
      };
      window.__fakeLog.push(`${this.op} ${this.table}`);

      if (this.op === "select") {
        let rows = table.filter((r) => this.match(r));
        if (this.countHead) return { data: null, count: rows.length, error: null };
        for (const [col, asc] of [...this.orders].reverse()) {
          rows = rows.slice().sort((a, b) => {
            const x = a[col];
            const y = b[col];
            if (x == null && y == null) return 0;
            if (x == null) return 1;
            if (y == null) return -1;
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
          });
        }
        return this.shape(rows.map((r) => pick(r, this.cols)));
      }

      if (this.op === "insert" || this.op === "upsert") {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const out = [];
        for (const p of list) {
          const key = PK[this.table];
          const existing = this.op === "upsert" ? table.find((r) => r[key] === p[key]) : null;
          if (existing) {
            Object.assign(existing, p);
            out.push(existing);
          } else {
            const row = { ...DEFAULTS[this.table](), ...p };
            table.push(row);
            out.push(row);
          }
        }
        const v = violation(this.table);
        if (v) { rollback(); return { data: null, error: dupError(v) }; }
        if (this.returning == null) return { data: null, error: null };
        return this.shape(out.map((r) => pick(r, this.returning)));
      }

      if (this.op === "update") {
        const rows = table.filter((r) => this.match(r));
        for (const r of rows) Object.assign(r, this.payload);
        const v = violation(this.table);
        if (v) { rollback(); return { data: null, error: dupError(v) }; }
        return this.returning == null ? { data: null, error: null } : this.shape(rows.map((r) => pick(r, this.returning)));
      }

      if (this.op === "delete") {
        const rows = table.filter((r) => this.match(r));
        if (this.table === "workspaces" && rows.some((r) => r.is_default)) {
          return { data: null, error: { message: "Cannot delete default workspace" } };
        }
        db[this.table] = table.filter((r) => !this.match(r));
        if (this.table === "workspaces") {
          const gone = new Set(rows.map((r) => r.id));
          db.tasks = db.tasks.filter((t) => !gone.has(t.workspace_id));
        }
        return { data: null, error: null };
      }
      throw new Error(`unsupported op ${this.op}`);
    }
  }

  const authListeners = [];
  let signedIn = true;
  window.supabaseClient = {
    rpc: async (name, args) => {
      await new Promise((r) => setTimeout(r, 3));
      if (window.__fakeOffline) return { data: null, error: { message: "TypeError: Failed to fetch" } };
      window.__fakeLog.push(`rpc ${name}`);
      if (name !== "set_task_positions") return { data: null, error: { message: `unknown rpc ${name}` } };
      args.ids.forEach((id, i) => {
        const row = db.tasks.find((t) => t.id === id && t.user_id === USER.id);
        if (row) row.position = args.positions[i];
      });
      return { data: null, error: null };
    },
    from: (table) => {
      if (!db[table]) throw new Error(`unknown table ${table}`);
      return new Query(table);
    },
    auth: {
      getSession: async () => ({ data: { session: signedIn ? SESSION : null }, error: null }),
      onAuthStateChange(cb) {
        authListeners.push(cb);
        setTimeout(() => cb("INITIAL_SESSION", SESSION), 5);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signOut: async (opts) => {
        if (window.__fakeOffline && opts?.scope !== "local") {
          return { error: { message: "TypeError: Failed to fetch" } };
        }
        signedIn = false;
        setTimeout(() => authListeners.forEach((cb) => cb("SIGNED_OUT", null)), 5);
        return { error: null };
      },
      verifyOtp: async () => ({ error: null }),
      signInWithPassword: async () => ({ error: null }),
      signUp: async () => ({ data: { session: SESSION }, error: null }),
      resend: async () => ({ error: null }),
    },
  };
})();
