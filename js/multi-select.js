/*
 * Centricity MF Screener Dashboard — js/multi-select.js
 *
 * Reusable multi-select-with-search-and-select-all component. Used by Home's
 * Asset Class and SEBI Category filters; will be reused by the Screener's
 * left-rail filter chips and Compare's fund picker. Build once, mount many.
 *
 * No framework, no build step. Vanilla DOM. Brand-compliant via centricity.css's
 * `.multi-select` ruleset (palette, Cambria, focus rings — no Tailwind).
 *
 * v2+ MULTI-PRODUCT NOTE:
 * Item shape supports a `group` field for sub-class grouping (e.g., the
 * Equity (21) / Hybrid (5) headers on the SEBI Category filter). When the
 * project expands to PMS + AIF (per CLAUDE.md §4.1 4×3 grid), a second-level
 * `family` field will sit ABOVE `group` — top-level grouping by product family
 * (MF / PMS / AIF), with `group` continuing as the within-MF sub-class layer.
 * The renderer already iterates `groups` generically; adding `family` is a
 * data-shape change only, no component rewrite.
 *
 * API
 * ====
 *   const ms = MultiSelect.create(targetEl, {
 *     items:             [{value, label, group?, disabled?}, ...],
 *     selected:          ['v1', 'v2'],          // initial selection
 *     onChange:          (selectedArr) => {},   // fires on every toggle
 *     label:             'Asset class',         // accessible label
 *     placeholder:       'All asset classes',   // button text when all checked
 *     noneLabel:         'None selected',
 *     allLabel:          'All asset classes',
 *     oneLabel:          (item) => `${item.label} only`,
 *     manyLabel:         (n) => `${n} selected`,
 *     searchPlaceholder: 'Search…',
 *     groups:            true,                  // enable group headers
 *   });
 *   ms.getSelected();           // -> array of values
 *   ms.setSelected(arr);        // programmatic update; fires onChange
 *   ms.refresh(newItems, opts); // rebuild items (e.g. when Asset Class
 *                               // selection changes the SEBI category list);
 *                               // preserves checks for items that survive
 *   ms.destroy();               // tear down event listeners
 *
 * Item shape
 * ==========
 *   { value: string,    // unique key, what onChange returns
 *     label: string,    // human-readable
 *     group?: string,   // optional grouping header (e.g. 'Equity', 'Hybrid')
 *     disabled?: bool   // greyed out, not selectable (e.g. 'Debt — pending v1.x')
 *   }
 *
 * Built-in behaviours
 * ===================
 *   • Click outside / ESC to close
 *   • Search input filters visible items by case-insensitive substring
 *   • Tri-state Select-all toggle (checked / unchecked / indeterminate)
 *   • Disabled rows render greyed and ignore clicks
 *   • Group headers are non-clickable separators when groups: true
 *   • Keyboard: Up/Down to move focus, Space to toggle, ESC to close
 *   • Focus rings: Warm Gold (Brand Standards §6)
 */
(function () {
  'use strict';

  let _instanceCounter = 0;

  /**
   * @param {HTMLElement} targetEl  the element where the button + popover mount
   * @param {object} options
   * @returns {object} instance with getSelected/setSelected/refresh/destroy
   */
  function create(targetEl, options) {
    if (!targetEl) throw new Error('MultiSelect: target element required');
    options = options || {};

    /* ---------- internal state ---------- */
    const id = ++_instanceCounter;
    let items = (options.items || []).slice();
    let selected = new Set(options.selected || []);
    let searchQuery = '';
    let isOpen = false;
    let focusedIndex = -1;

    const cfg = {
      label:              options.label              || '',
      allLabel:           options.allLabel           || 'All',
      noneLabel:          options.noneLabel          || 'None selected',
      oneLabel:           options.oneLabel           || ((item) => `${item.label} only`),
      manyLabel:          options.manyLabel          || ((n) => `${n} selected`),
      searchPlaceholder:  options.searchPlaceholder  || 'Search…',
      groups:             !!options.groups,
      onChange:           typeof options.onChange === 'function' ? options.onChange : () => {},
    };

    /* ---------- DOM scaffolding ---------- */
    targetEl.innerHTML = '';
    targetEl.classList.add('multi-select');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ms-button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', cfg.label);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'ms-label';
    btn.appendChild(labelSpan);

    const caret = document.createElement('span');
    caret.className = 'ms-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    btn.appendChild(caret);

    const popover = document.createElement('div');
    popover.className = 'ms-popover';
    popover.setAttribute('role', 'listbox');
    popover.setAttribute('aria-multiselectable', 'true');
    popover.hidden = true;

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ms-search';
    searchInput.placeholder = cfg.searchPlaceholder;
    searchInput.setAttribute('aria-label', 'Filter ' + cfg.label);
    popover.appendChild(searchInput);

    const selectAllRow = document.createElement('div');
    selectAllRow.className = 'ms-row ms-row-toggle';
    selectAllRow.setAttribute('role', 'option');
    selectAllRow.setAttribute('tabindex', '-1');
    selectAllRow.dataset.kind = 'select-all';
    const selectAllBox = document.createElement('span');
    selectAllBox.className = 'ms-checkbox';
    selectAllRow.appendChild(selectAllBox);
    const selectAllText = document.createElement('span');
    selectAllText.className = 'ms-row-text';
    selectAllText.textContent = 'Select all';
    selectAllRow.appendChild(selectAllText);
    popover.appendChild(selectAllRow);

    const list = document.createElement('div');
    list.className = 'ms-list';
    popover.appendChild(list);

    targetEl.appendChild(btn);
    targetEl.appendChild(popover);

    /* ---------- helpers ---------- */
    const enabledItems  = () => items.filter(i => !i.disabled);
    const visibleItems  = () => {
      if (!searchQuery) return enabledItems();
      const q = searchQuery.toLowerCase();
      return enabledItems().filter(i => (i.label || '').toLowerCase().includes(q));
    };
    const allEnabledChecked = () => {
      const en = enabledItems();
      return en.length > 0 && en.every(i => selected.has(i.value));
    };
    const noneChecked = () => {
      return enabledItems().every(i => !selected.has(i.value));
    };

    function renderButton() {
      const checkedEnabled = enabledItems().filter(i => selected.has(i.value));
      let text;
      if (checkedEnabled.length === 0) text = cfg.noneLabel;
      else if (checkedEnabled.length === enabledItems().length) text = cfg.allLabel;
      else if (checkedEnabled.length === 1) text = cfg.oneLabel(checkedEnabled[0]);
      else text = cfg.manyLabel(checkedEnabled.length);
      labelSpan.textContent = text;
    }

    function renderSelectAll() {
      selectAllBox.classList.remove('checked', 'indeterminate');
      const allOn = allEnabledChecked();
      const noneOn = noneChecked();
      if (allOn) {
        selectAllBox.classList.add('checked');
        selectAllText.textContent = 'Clear all';
      } else if (noneOn) {
        selectAllText.textContent = 'Select all';
      } else {
        selectAllBox.classList.add('indeterminate');
        selectAllText.textContent = `Select all (${enabledItems().filter(i => selected.has(i.value)).length}/${enabledItems().length} selected)`;
      }
    }

    function renderList() {
      list.innerHTML = '';
      const v = visibleItems();
      // Render with grouping if enabled
      if (cfg.groups) {
        const order = [];
        const seen = new Set();
        v.forEach(i => {
          const g = i.group || '';
          if (!seen.has(g)) { seen.add(g); order.push(g); }
        });
        order.forEach(g => {
          if (g) {
            const groupItems = v.filter(i => (i.group || '') === g);
            const header = document.createElement('div');
            header.className = 'ms-group-header';
            header.setAttribute('aria-hidden', 'true');
            header.textContent = `${g} (${groupItems.length})`;
            list.appendChild(header);
            groupItems.forEach(i => list.appendChild(renderItemRow(i)));
          } else {
            v.filter(i => !i.group).forEach(i => list.appendChild(renderItemRow(i)));
          }
        });
      } else {
        v.forEach(i => list.appendChild(renderItemRow(i)));
      }
      // Plus any disabled items always shown if no search query
      if (!searchQuery) {
        items.filter(i => i.disabled).forEach(i => list.appendChild(renderItemRow(i)));
      }
      // Empty-state
      if (list.children.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ms-empty';
        empty.textContent = 'No matches';
        list.appendChild(empty);
      }
    }

    function renderItemRow(item) {
      const row = document.createElement('div');
      row.className = 'ms-row';
      if (item.disabled) row.classList.add('ms-row-disabled');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', selected.has(item.value) ? 'true' : 'false');
      row.setAttribute('tabindex', '-1');
      row.dataset.value = item.value;

      const box = document.createElement('span');
      box.className = 'ms-checkbox';
      if (selected.has(item.value)) box.classList.add('checked');
      row.appendChild(box);

      const text = document.createElement('span');
      text.className = 'ms-row-text';
      text.textContent = item.label;
      row.appendChild(text);

      return row;
    }

    function renderAll() {
      renderButton();
      renderSelectAll();
      renderList();
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      popover.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      targetEl.classList.add('open');
      // give search focus on open
      setTimeout(() => searchInput.focus(), 0);
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onDocKey, true);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      popover.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      targetEl.classList.remove('open');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onDocKey, true);
      focusedIndex = -1;
    }

    function toggle() { isOpen ? close() : open(); }

    /* ---------- event handlers ---------- */
    function onDocClick(e) {
      if (!targetEl.contains(e.target)) close();
    }
    function onDocKey(e) {
      if (e.key === 'Escape') { close(); btn.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const rows = Array.from(list.querySelectorAll('.ms-row:not(.ms-row-disabled)'));
        if (rows.length === 0) return;
        e.preventDefault();
        focusedIndex = e.key === 'ArrowDown'
          ? Math.min(focusedIndex + 1, rows.length - 1)
          : Math.max(focusedIndex - 1, 0);
        rows[focusedIndex].focus();
      } else if (e.key === ' ' && document.activeElement
                 && document.activeElement.classList.contains('ms-row')) {
        e.preventDefault();
        document.activeElement.click();
      }
    }

    btn.addEventListener('click', (e) => { e.preventDefault(); toggle(); });

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value || '';
      renderList();
    });

    selectAllRow.addEventListener('click', () => {
      // Tri-state: any non-all state collapses to "all on"; "all on" → "all off"
      if (allEnabledChecked()) {
        // clear all enabled
        enabledItems().forEach(i => selected.delete(i.value));
      } else {
        enabledItems().forEach(i => selected.add(i.value));
      }
      cfg.onChange(getSelected());
      renderAll();
    });

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.ms-row');
      if (!row || row.classList.contains('ms-row-disabled')) return;
      const value = row.dataset.value;
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      cfg.onChange(getSelected());
      renderAll();
    });

    /* ---------- public methods ---------- */
    function getSelected() {
      // Return values in items order (stable), enabled-only
      return enabledItems().filter(i => selected.has(i.value)).map(i => i.value);
    }

    function setSelected(arr) {
      selected = new Set(arr || []);
      cfg.onChange(getSelected());
      renderAll();
    }

    function refresh(newItems, opts) {
      opts = opts || {};
      // Preserve check state for items that survive the rebuild.
      const survivingValues = new Set((newItems || []).map(i => i.value));
      const carriedSelected = new Set();
      selected.forEach(v => { if (survivingValues.has(v)) carriedSelected.add(v); });
      // For brand-new items (in newItems but not previously known),
      // default-check unless the caller said otherwise.
      const previousValues = new Set(items.map(i => i.value));
      const defaultCheckNew = opts.defaultCheckNew !== false;
      if (defaultCheckNew) {
        (newItems || []).forEach(i => {
          if (!previousValues.has(i.value) && !i.disabled) carriedSelected.add(i.value);
        });
      }
      items = (newItems || []).slice();
      selected = carriedSelected;
      cfg.onChange(getSelected());
      renderAll();
    }

    function destroy() {
      close();
      btn.removeEventListener('click', toggle);
      targetEl.classList.remove('multi-select', 'open');
      targetEl.innerHTML = '';
    }

    /* ---------- initial paint ---------- */
    renderAll();

    return { id, getSelected, setSelected, refresh, destroy };
  }

  /* ============================================================
   *  TILES MODE (Cowork 2026-05-06 — Screener Fix-List 1 §E)
   *
   *  Inline horizontal tile-row for at-most-a-handful selections (Asset
   *  Class). Each item renders as a click-to-toggle card with the same
   *  shape as MultiSelect items: { value, label, group?, disabled?, sub? }.
   *  Returns the same { getSelected, setSelected, refresh, destroy } API
   *  so callers can swap factories without touching their handlers.
   *
   *  Behavioural difference from the dropdown form:
   *    • No popover, no search — every choice is always visible
   *    • `keepAtLeastOne: true` (default) prevents the user from
   *      deselecting the last selected tile
   *    • `sub` (optional per-item secondary line, e.g., a count) renders
   *      under the label
   *
   *  Visual rules — see screener.css `.tile-select`. Selected tile gets
   *  Warm Gold border + Light Tan fill; unselected sits on white with a
   *  hairline grey border (Brand Standards §2 + §6).
   * ============================================================ */
  function createTiles(targetEl, options) {
    if (!targetEl) throw new Error('MultiSelect.createTiles: target element required');
    options = options || {};
    let items = (options.items || []).slice();
    let selected = new Set(options.selected || []);
    const cfg = {
      onChange:        typeof options.onChange === 'function' ? options.onChange : () => {},
      keepAtLeastOne:  options.keepAtLeastOne !== false,
      ariaLabel:       options.label || 'Tile selection',
    };

    targetEl.innerHTML = '';
    targetEl.classList.add('tile-select');
    targetEl.setAttribute('role', 'group');
    targetEl.setAttribute('aria-label', cfg.ariaLabel);

    function render() {
      targetEl.innerHTML = items.map(item => {
        const checked = selected.has(item.value);
        const dis = item.disabled ? 'disabled' : '';
        const cls = ['tile', checked ? 'on' : '', item.disabled ? 'disabled' : ''].filter(Boolean).join(' ');
        const sub = item.sub ? `<span class="sub">${escape(item.sub)}</span>` : '';
        return `
          <button type="button" class="${cls}" data-value="${escape(item.value)}"
                  aria-pressed="${checked ? 'true' : 'false'}" ${dis}>
            <span class="lbl">${escape(item.label || item.value)}</span>
            ${sub}
          </button>`;
      }).join('');

      targetEl.querySelectorAll('button.tile').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.hasAttribute('disabled')) return;
          const value = btn.getAttribute('data-value');
          if (selected.has(value)) {
            if (cfg.keepAtLeastOne && selected.size <= 1) return;  // refuse last-deselect
            selected.delete(value);
          } else {
            selected.add(value);
          }
          render();
          cfg.onChange(getSelected());
        });
      });
    }

    function escape(s) {
      if (s == null) return '';
      return String(s).replace(/[&<>"']/g, c =>
        ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function getSelected() {
      return items.filter(i => !i.disabled && selected.has(i.value)).map(i => i.value);
    }
    function setSelected(arr) {
      const sane = (arr || []).filter(v => items.some(i => i.value === v && !i.disabled));
      if (cfg.keepAtLeastOne && sane.length === 0 && items.some(i => !i.disabled)) {
        // Refuse empty selection — fall back to first enabled item
        const first = items.find(i => !i.disabled);
        if (first) sane.push(first.value);
      }
      selected = new Set(sane);
      render();
      cfg.onChange(getSelected());
    }
    function refresh(newItems) {
      items = (newItems || []).slice();
      // Drop selections that no longer exist
      const valid = new Set(items.filter(i => !i.disabled).map(i => i.value));
      selected = new Set(Array.from(selected).filter(v => valid.has(v)));
      if (cfg.keepAtLeastOne && selected.size === 0 && items.some(i => !i.disabled)) {
        selected.add(items.find(i => !i.disabled).value);
      }
      render();
      cfg.onChange(getSelected());
    }
    function destroy() {
      targetEl.classList.remove('tile-select');
      targetEl.innerHTML = '';
    }

    render();
    return { getSelected, setSelected, refresh, destroy };
  }

  window.MultiSelect = { create, createTiles };
})();
