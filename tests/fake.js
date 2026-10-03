'use strict';
/* ---------------- Firestore / Auth وهميان ---------------- */

function makeFake() {
  const store = {}; // col -> Map(id -> data)
  const col = (n) => (store[n] = store[n] || new Map());
  const users = new Map(); // uid -> {uid,email,displayName,password,customClaims}
  let uidSeq = 1;

  const snapOf = (c, id) => {
    const data = col(c).get(id);
    return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined), ref: docRef(c, id) };
  };
  function docRef(c, id) {
    return {
      _c: c,
      _id: id,
      id,
      get: async () => snapOf(c, id),
      set: async (d) => void col(c).set(id, { ...d }),
      update: async (d) => {
        if (!col(c).has(id)) throw new Error('NOT_FOUND ' + c + '/' + id);
        col(c).set(id, { ...col(c).get(id), ...d });
      },
      delete: async () => void col(c).delete(id)
    };
  }
  function query(c, filters = [], order = null, lim = Infinity) {
    const q = {
      where: (f, op, v) => query(c, [...filters, [f, op, v]], order, lim),
      orderBy: (f) => query(c, filters, f, lim),
      limit: (n) => query(c, filters, order, n),
      get: async () => {
        let rows = [...col(c).entries()].filter(([, d]) =>
          filters.every(([f, op, v]) => (op === '==' ? d[f] === v : op === 'in' ? v.includes(d[f]) : op === '>' ? d[f] > v : false))
        );
        if (order) rows.sort((a, b) => (typeof a[1][order] === 'number' ? a[1][order] - b[1][order] : String(a[1][order]).localeCompare(String(b[1][order]))));
        rows = rows.slice(0, lim);
        const docs = rows.map(([id]) => snapOf(c, id));
        return { docs, size: docs.length, empty: docs.length === 0 };
      }
    };
    return q;
  }
  let autoId = 1;
  const db = {
    _store: store,
    collection: (c) => ({
      doc: (id) => docRef(c, String(id)),
      add: async (d) => {
        const id = 'auto' + autoId++;
        col(c).set(id, { ...d });
        return docRef(c, id);
      },
      ...query(c)
    }),
    batch: () => {
      const ops = [];
      return {
        delete: (r) => ops.push(() => r.delete()),
        update: (r, d) => ops.push(() => r.update(d)),
        commit: async () => {
          for (const o of ops) await o();
        }
      };
    },
    runTransaction: async (fn) => {
      const tx = {
        get: async (r) => r.get(),
        set: (r, d) => writes.push(() => r.set(d)),
        update: (r, d) => writes.push(() => r.update(d)),
        delete: (r) => writes.push(() => r.delete())
      };
      const writes = [];
      const out = await fn(tx);
      for (const w of writes) await w();
      return out;
    }
  };

  const tokens = new Map(); // 'cookie-uid' -> uid
  const auth = {
    _users: users,
    createUser: async ({ email, password, displayName }) => {
      if ([...users.values()].some((u) => u.email === email)) {
        const e = new Error('exists');
        e.code = 'auth/email-already-exists';
        throw e;
      }
      const uid = 'u' + uidSeq++;
      const u = { uid, email, password, displayName, customClaims: null };
      users.set(uid, u);
      return u;
    },
    setCustomUserClaims: async (uid, claims) => void (users.get(uid).customClaims = claims),
    getUserByEmail: async (email) => {
      const u = [...users.values()].find((x) => x.email === email);
      if (!u) {
        const e = new Error('nf');
        e.code = 'auth/user-not-found';
        throw e;
      }
      return u;
    },
    getUser: async (uid) => users.get(uid),
    updateUser: async (uid, patch) => Object.assign(users.get(uid), patch),
    deleteUser: async (uid) => void users.delete(uid),
    revokeRefreshTokens: async (uid) => void (users.get(uid) && (users.get(uid).revoked = true)),
    listUsers: async () => ({ users: [...users.values()] }),
    verifyIdToken: async (t) => {
      const u = users.get(t.replace('idtoken-', ''));
      if (!u) throw new Error('bad');
      return { uid: u.uid, email: u.email, name: u.displayName, ...(u.customClaims || {}) };
    },
    createSessionCookie: async (t) => {
      const u = users.get(t.replace('idtoken-', ''));
      if (u) u.revoked = false;
      return 'cookie-' + t.replace('idtoken-', '');
    },
    verifySessionCookie: async (c) => {
      const u = users.get(String(c).replace('cookie-', ''));
      if (!u || u.revoked) throw new Error('bad cookie');
      return { uid: u.uid, email: u.email, name: u.displayName, ...(u.customClaims || {}) };
    }
  };
  void tokens;
  return { db, auth };
}


module.exports = { makeFake };
