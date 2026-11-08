(function () {
  const state = { ready: false, errors: [], spec: null, cards: {}, current: null };

  function frame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  function pagesOf() {
    const pages = state.spec && Array.isArray(state.spec.pages) ? state.spec.pages : [];
    return pages.length > 0 ? pages.map((p) => p.id) : ['main'];
  }
  function componentsOf(pageId) {
    const page = (state.spec && state.spec.pages || []).find((p) => p.id === pageId);
    return page && Array.isArray(page.components) ? page.components : [];
  }
  function filtersOf(pageId) {
    return componentsOf(pageId)
      .filter((c) => c && c.type === 'filter')
      .map((c) => {
        let values = ['one', 'two'];
        if (c.options && Array.isArray(c.options.list)) {
          const vs = c.options.list.map((o) => (o && typeof o === 'object' ? o.value : o)).filter((v) => v != null);
          if (vs.length > 0) values = vs.map(String);
        }
        return { id: c.id, values: values };
      });
  }
  function actionsOf(pageId) {
    const ids = new Set();
    for (const c of componentsOf(pageId)) {
      if (!c) continue;
      if (c.type === 'button' && c.action && c.action.action) ids.add(c.action.action);
      if (c.type === 'form' && c.submit && c.submit.action) ids.add(c.submit.action);
      if (c.type === 'table' && Array.isArray(c.rowActions)) for (const a of c.rowActions) if (a && a.action) ids.add(a.action);
    }
    if (ids.size === 0 && pageId === pagesOf()[0]) for (const id of Object.keys(state.cards)) ids.add(id);
    return Array.from(ids);
  }

  const api = {
    get ready() { return state.ready; },
    get errors() { return state.errors.slice(); },
    pages: pagesOf,
    filters: filtersOf,
    actions: actionsOf,
    async show(pageId) {
      state.current = pageId;
      const el = document.getElementById('page');
      if (el) el.textContent = 'page: ' + pageId;
      await frame();
    },
    async setFilter(id, value) {
      const el = document.getElementById('page');
      if (el) el.setAttribute('data-filter-' + id, String(value));
      await frame();
    },
    async prepare(actionId) {
      const box = document.getElementById('card');
      if (box) { box.hidden = false; box.textContent = 'card: ' + actionId + ' ' + JSON.stringify(state.cards[actionId] || {}); }
      await frame();
    },
    async closeCard() {
      const box = document.getElementById('card');
      if (box) { box.hidden = true; box.textContent = ''; }
      await frame();
    },
  };
  window.__wkFixture = api;

  function boot() {
    fetch('./fixture.json')
      .then((r) => r.json())
      .then((f) => {
        state.spec = f && f.spec ? f.spec : { pages: [] };
        state.cards = f && f.cards ? f.cards : {};
        return api.show(pagesOf()[0]);
      })
      .then(() => { state.ready = true; })
      .catch((e) => { state.errors.push(String(e)); state.ready = true; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
