/*
 * Centricity MF Screener Dashboard — archive.html page logic
 * Calendar grid of every cycle the dashboard has data for. Click → load that
 * cycle into memory and set it as the current visited cycle (other pages
 * pick it up on next nav).
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', main);

  async function main() {
    let manifest, latestCycle, activeDate;
    try {
      manifest = await Cycle.getManifest();
      const latestDate = manifest.latest || manifest.cycles[0].date;
      latestCycle = await DataLoader.loadCycle(latestDate);
      activeDate = await Cycle.getActiveCycle();
    } catch (err) {
      renderLoadError(err);
      return;
    }
    document.getElementById('footUpdated').textContent = 'Last updated · ' + latestCycle.cycle_meta.as_on_display;

    renderGrid(manifest, activeDate, latestCycle);
  }

  function renderLoadError(err) {
    document.getElementById('mainArea').innerHTML = `
      <div class="empty-state" style="margin:48px 56px;">
        <div class="ring-motif"></div>
        <h3>Could not load cycle archive</h3>
        <p><span style="color:var(--red)">${(err && err.message) || err}</span></p>
      </div>`;
  }

  function renderGrid(manifest, currentDate, latestCycle) {
    const grid = document.getElementById('arcGrid');
    const cycles = (manifest.cycles || []).slice()
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    if (cycles.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="ring-motif"></div>
          <h3>No cycles in the archive yet</h3>
          <p>Drop a Whitelisting Excel into <code>data/</code> and push to GitHub —
             the Action will produce the first cycle JSON within 60 seconds.</p>
        </div>`;
      return;
    }

    grid.innerHTML = cycles.map(c => {
      const isCurrent = c.date === currentDate;
      const tagPrefix = isCurrent ? 'Currently viewing' : 'Cycle';
      // Best-effort meta from latestCycle if this IS latest — otherwise generic
      const meta = (c.date === latestCycle.cycle_meta.cycle_date)
        ? `<b>${latestCycle.cycle_meta.total_funds.toLocaleString('en-IN')}</b> funds across <b>${latestCycle.cycle_meta.category_count}</b> categories`
        : 'Click to load';
      return `
        <div class="arc-tile ${isCurrent ? 'current' : ''}" data-date="${c.date}" tabindex="0" role="button">
          <span class="tag">${tagPrefix}</span>
          <h3>${escapeHtml(DataLoader.fmtCycleLabelDate(c.date))}</h3>
          <div class="sub">As on ${escapeHtml(DataLoader.fmtDate(c.date))}</div>
          <div class="stats">${meta}</div>
          <div class="cta">${isCurrent ? 'Active →' : 'Load this cycle →'}</div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.arc-tile').forEach(tile => {
      tile.addEventListener('click', async () => {
        const date = tile.getAttribute('data-date');
        try {
          await DataLoader.loadCycle(date);
          await Cycle.setActiveCycle(date);
          showToast(`Loaded ${date}. Other screens will use this cycle.`);
          // Re-render to update "current" badge
          renderGrid(await Cycle.getManifest(), date, await DataLoader.loadCycle(date));
        } catch (e) {
          showToast('Could not load ' + date);
        }
      });
    });
  }

  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t || !msg) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
})();
