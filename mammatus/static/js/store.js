// Minimal reactive store: set() notifies subscribers of the keys that changed.

export function createStore(initial) {
  const state = { ...initial };
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const changed = [];
      for (const [k, v] of Object.entries(patch)) {
        if (state[k] !== v) { state[k] = v; changed.push(k); }
      }
      if (changed.length) for (const s of subs) if (!s.keys || s.keys.some((k) => changed.includes(k))) s.fn(state, changed);
    },
    on(keys, fn) {
      const s = { keys: keys ? [].concat(keys) : null, fn };
      subs.add(s);
      return () => subs.delete(s);
    },
  };
}
