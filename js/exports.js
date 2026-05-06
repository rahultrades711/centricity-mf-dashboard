/*
 * Centricity MF Screener Dashboard — exports.js
 *
 * Wires html2pdf.js and pptxgenjs to "Download as PDF" / "Download as PPT"
 * buttons. Both libraries load lazily via dynamic <script> insertion the
 * first time an export is requested — keeps the initial page weight low.
 *
 * CDN versions pinned (per Cowork direction 2026-05-05): never @latest.
 *   html2pdf.js 0.10.1
 *   pptxgenjs   3.12.0
 *
 * Exposes window.Exports with three categories of helper:
 *
 *   1. Generic primitives (used by Fund Detail one-pager, future pages)
 *      • exportPDF(target, fileBase, opts)            — html2pdf on a DOM element
 *      • exportPPT(content, fileBase)                 — single-slide pptx
 *
 *   2. Screener-specific branded builders (Cowork 2026-05-06 — Fix-List 1)
 *      • buildScreenerPDF({ funds, columns, filtersCaption, cycleLabel, fileBase })
 *      • buildScreenerPPT({ funds, columns, filtersCaption, cycleLabel, fileBase })
 *      Both produce a full Centricity-branded export: black header bar with
 *      white ALL-CAPS title ("CENTRICITY MUTUAL FUND SCREENER · 15th Apr 2026"),
 *      Cambria throughout, palette respected, the current filter state
 *      captured in a small caption above the table.
 *
 *   3. init() — kept for any future declarative button wiring; current pages
 *      attach handlers directly so no auto-discovery is required.
 *
 * Usage:
 *   await Exports.buildScreenerPDF({
 *     funds: filtered, columns: SCREENER_COLS,
 *     filtersCaption: 'Equity + Hybrid · 26 categories · AUM ≥ ₹5,000 Cr',
 *     cycleLabel: '15th Apr 2026',
 *     fileBase: 'Centricity-Screener-15Apr2026',
 *   });
 */
(function () {
  'use strict';

  const CDN = {
    html2pdf: 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
    // pptxgen.min.js (the non-bundle build) requires a separately-loaded JSZip
    // global; the .bundle.min.js inlines JSZip and self-registers
    // window.PptxGenJS, which is what we need.
    pptxgen:  'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.min.js',
  };

  const _loaded = {};

  function _loadScript(url) {
    if (_loaded[url]) return _loaded[url];
    _loaded[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
    return _loaded[url];
  }

  /* -------------------------------------------------------- *
   *  PDF export (html2pdf.js)
   * -------------------------------------------------------- */
  /**
   * Render an element to a branded one-pager PDF.
   * @param {HTMLElement|string} target  element or selector
   * @param {string} fileBase            filename without extension
   * @param {object} [opts]              forwarded to html2pdf options
   */
  async function exportPDF(target, fileBase, opts) {
    await _loadScript(CDN.html2pdf);
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('exportPDF: target not found');

    const filename = (fileBase || 'Centricity-export') + '.pdf';
    const options = Object.assign({
      margin:       [12, 12, 14, 12],
      filename:     filename,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true, letterRendering: true, logging: false },
      jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak:    { mode: ['avoid-all', 'css', 'legacy'] },
    }, opts || {});

    return window.html2pdf().set(options).from(el).save();
  }

  /* -------------------------------------------------------- *
   *  PPT export (pptxgenjs) — minimal v1 implementation
   *  Builds a single 16:9 title-and-table slide. Per-screen wrappers
   *  in Step 4 wiring will pass richer content (per-fund slide, charts)
   *  but the foundation lives here.
   * -------------------------------------------------------- */
  /**
   * Build a one-slide PPTX with title, subtitle, and an optional 2D table.
   * Returns a Promise that resolves when the file has been triggered for
   * download.
   *
   * @param {object} content
   * @param {string} content.title
   * @param {string} [content.subtitle]
   * @param {string[]} [content.tableHeader]
   * @param {(string|number)[][]} [content.tableRows]
   * @param {string} fileBase
   */
  async function exportPPT(content, fileBase) {
    await _loadScript(CDN.pptxgen);
    if (!content || !content.title) throw new Error('exportPPT: content.title required');

    const pres = new window.PptxGenJS();
    pres.defineLayout({ name: 'CENTRICITY_16x9', width: 13.333, height: 7.5 });
    pres.layout = 'CENTRICITY_16x9';

    // Brand defaults
    const PALETTE = {
      black: '000000', gold: 'BD9568', tan: 'DBC8B2',
      grey: '666666',  red: '931621', white: 'FFFFFF',
    };
    const FONT = 'Cambria';

    const slide = pres.addSlide();
    slide.background = { fill: PALETTE.white };

    // Header bar — black with gold underline
    slide.addShape(pres.ShapeType.rect, {
      x: 0, y: 0, w: 13.333, h: 0.55, fill: { color: PALETTE.black }, line: { color: PALETTE.black },
    });
    slide.addShape(pres.ShapeType.rect, {
      x: 0, y: 0.53, w: 13.333, h: 0.04, fill: { color: PALETTE.gold }, line: { color: PALETTE.gold },
    });
    slide.addText('CENTRICITY MF SCREENER', {
      x: 0.4, y: 0.06, w: 8, h: 0.43,
      color: PALETTE.white, fontFace: FONT, fontSize: 14, bold: true, charSpacing: 4,
    });
    slide.addText('Confidential', {
      x: 11, y: 0.06, w: 2, h: 0.43,
      color: PALETTE.gold, fontFace: FONT, fontSize: 11, charSpacing: 3, align: 'right',
    });

    // Title block
    slide.addText(content.title, {
      x: 0.5, y: 0.85, w: 12.5, h: 0.8,
      color: PALETTE.black, fontFace: FONT, fontSize: 28, bold: true,
    });
    if (content.subtitle) {
      slide.addText(content.subtitle, {
        x: 0.5, y: 1.65, w: 12.5, h: 0.4,
        color: PALETTE.grey, fontFace: FONT, fontSize: 14,
      });
    }

    // Optional table
    if (content.tableHeader && content.tableRows) {
      const headerRow = content.tableHeader.map(h => ({
        text: String(h),
        options: { bold: true, color: PALETTE.white, fill: { color: PALETTE.black }, fontSize: 10, fontFace: FONT },
      }));
      const bodyRows = content.tableRows.map(row => row.map(cell => ({
        text: String(cell == null ? '—' : cell),
        options: { color: PALETTE.black, fontSize: 10, fontFace: FONT },
      })));
      slide.addTable([headerRow].concat(bodyRows), {
        x: 0.5, y: 2.2, w: 12.3,
        border: { type: 'solid', color: PALETTE.tan, pt: 0.5 },
        rowH: 0.32,
      });
    }

    // Footer
    slide.addShape(pres.ShapeType.rect, {
      x: 0, y: 7.1, w: 13.333, h: 0.4, fill: { color: PALETTE.black }, line: { color: PALETTE.black },
    });
    slide.addText('Centricity WealthTech | Products Team', {
      x: 0.4, y: 7.18, w: 6, h: 0.25,
      color: PALETTE.white, fontFace: FONT, fontSize: 10, charSpacing: 2,
    });
    slide.addText(content.subtitle || '', {
      x: 7, y: 7.18, w: 6, h: 0.25,
      color: PALETTE.gold, fontFace: FONT, fontSize: 10, align: 'right',
    });

    const filename = (fileBase || 'Centricity-export') + '.pptx';
    return pres.writeFile({ fileName: filename });
  }

  /* -------------------------------------------------------- *
   *  Screener-specific branded PDF + PPT builders
   *  (Cowork 2026-05-06 — Screener Fix-List 1)
   *
   *  Both consume the same { funds, columns, filtersCaption, cycleLabel, fileBase }
   *  shape and produce a Centricity-branded export. PDF goes A4 landscape so
   *  11 columns breathe; PPT is 16:9 with one slide per ~25 rows.
   *
   *  `columns` is an array of { label, key, fmt, align, neg } where:
   *      label : header text (rendered ALL CAPS in the printed header)
   *      key   : value extractor — either a string field name on the fund
   *              record, or a function (fund) => any
   *      fmt   : optional value formatter (value) => string
   *      align : 'left' | 'center' | 'right' (default 'center')
   *      neg   : true to apply Dark Red colour to negative numerics
   * -------------------------------------------------------- */
  const BRAND = {
    black: '#000000', gold: '#BD9568', tan: '#DBC8B2',
    grey: '#666666',  red:  '#931621', white: '#FFFFFF',
    rule: '#D9D9D9',
  };
  const BRAND_HEX = {
    black: '000000', gold: 'BD9568', tan: 'DBC8B2',
    grey: '666666',  red:  '931621', white: 'FFFFFF',
  };
  const FONT = 'Cambria';

  function _pickValue(fund, col) {
    if (typeof col.key === 'function') return col.key(fund);
    return fund ? fund[col.key] : undefined;
  }

  function _formatCell(fund, col) {
    const raw = _pickValue(fund, col);
    if (col.fmt) return col.fmt(raw, fund);
    if (raw == null) return '—';
    return String(raw);
  }

  /**
   * Build a Centricity-branded PDF of a Screener table snapshot.
   * Constructs an off-screen element, runs html2pdf on it, then disposes.
   */
  async function buildScreenerPDF(opts) {
    await _loadScript(CDN.html2pdf);
    opts = opts || {};
    const funds = Array.isArray(opts.funds) ? opts.funds : [];
    const columns = Array.isArray(opts.columns) ? opts.columns : [];
    const cycleLabel = opts.cycleLabel || '';
    const filtersCaption = opts.filtersCaption || '';
    const fileBase = opts.fileBase || 'Centricity-Screener';

    const root = document.createElement('div');
    root.style.cssText = [
      'position:fixed', 'left:-99999px', 'top:0',
      'width:1180px', 'background:#FFFFFF',
      'font-family:Cambria,Georgia,Times New Roman,serif',
      'color:#000000', 'font-size:11px', 'line-height:1.4',
      'padding:24px 32px',
    ].join(';');

    // Brand header bar
    const headerHtml = `
      <div style="background:${BRAND.black};color:${BRAND.white};padding:14px 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid ${BRAND.gold};">
        <div style="font-family:Cambria;letter-spacing:.18em;font-weight:700;font-size:15px;text-transform:uppercase;">
          Centricity Mutual Fund Screener
          <span style="color:${BRAND.gold};margin:0 10px;">·</span>
          <span style="color:${BRAND.gold};">${_escapeHtml(cycleLabel)}</span>
        </div>
        <div style="font-family:Cambria;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:${BRAND.gold};">Confidential</div>
      </div>
    `;

    const captionHtml = `
      <div style="margin:14px 0 6px;font-size:11px;color:${BRAND.grey};letter-spacing:.02em;">
        <b style="color:${BRAND.black};letter-spacing:.18em;text-transform:uppercase;font-size:9.5px;margin-right:8px;">Filters</b>
        ${_escapeHtml(filtersCaption || 'No filters applied')}
        <span style="float:right;color:${BRAND.grey};">${funds.length.toLocaleString('en-IN')} funds shown</span>
      </div>
    `;

    const ths = columns.map(col => {
      const align = col.align || 'center';
      return `<th style="background:${BRAND.black};color:${BRAND.white};padding:8px 6px;text-align:${align};font-size:10px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;border-right:1px solid rgba(255,255,255,.10);">${_escapeHtml(col.label)}</th>`;
    }).join('');

    const trs = funds.map((f, idx) => {
      const tds = columns.map(col => {
        const align = col.align || 'center';
        const text = _formatCell(f, col);
        let color = BRAND.black;
        const raw = _pickValue(f, col);
        if (col.neg && typeof raw === 'number' && raw < 0) color = BRAND.red;
        return `<td style="padding:6px;text-align:${align};color:${color};border-bottom:1px solid ${BRAND.rule};font-size:10.5px;">${_escapeHtml(text)}</td>`;
      }).join('');
      const bg = idx % 2 === 1 ? 'background:rgba(217,217,217,.18);' : '';
      return `<tr style="${bg}">${tds}</tr>`;
    }).join('');

    const tableHtml = `
      <table style="width:100%;border-collapse:collapse;margin-top:6px;font-feature-settings:'tnum';font-variant-numeric:tabular-nums;">
        <thead><tr>${ths}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    `;

    const footerHtml = `
      <div style="margin-top:18px;padding-top:10px;border-top:1px solid ${BRAND.rule};font-size:9.5px;color:${BRAND.grey};display:flex;justify-content:space-between;letter-spacing:.04em;">
        <span><b style="color:${BRAND.gold};">CENTRICITY WEALTHTECH</b> · Products Team · Confidential</span>
        <span>Generated ${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
    `;

    root.innerHTML = headerHtml + captionHtml + tableHtml + footerHtml;
    document.body.appendChild(root);

    try {
      const filename = fileBase + '.pdf';
      const options = {
        margin:       [10, 10, 10, 10],
        filename:     filename,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true, letterRendering: true, logging: false },
        jsPDF:        { unit: 'mm', format: 'a4', orientation: 'landscape' },
        pagebreak:    { mode: ['css', 'legacy'] },
      };
      await window.html2pdf().set(options).from(root).save();
    } finally {
      if (root.parentNode) root.parentNode.removeChild(root);
    }
  }

  /**
   * Build a Centricity-branded PPTX deck — one slide per ~25 funds.
   */
  async function buildScreenerPPT(opts) {
    await _loadScript(CDN.pptxgen);
    opts = opts || {};
    const funds = Array.isArray(opts.funds) ? opts.funds : [];
    const columns = Array.isArray(opts.columns) ? opts.columns : [];
    const cycleLabel = opts.cycleLabel || '';
    const filtersCaption = opts.filtersCaption || '';
    const fileBase = opts.fileBase || 'Centricity-Screener';
    const rowsPerSlide = opts.rowsPerSlide || 25;

    const pres = new window.PptxGenJS();
    pres.defineLayout({ name: 'CENTRICITY_16x9', width: 13.333, height: 7.5 });
    pres.layout = 'CENTRICITY_16x9';

    const headerRow = columns.map(col => ({
      text: String(col.label || '').toUpperCase(),
      options: {
        bold: true, color: BRAND_HEX.white, fill: { color: BRAND_HEX.black },
        fontSize: 9, fontFace: FONT, align: 'center',
        charSpacing: 1.5,
      },
    }));

    const slideCount = Math.max(1, Math.ceil(funds.length / rowsPerSlide));

    for (let s = 0; s < slideCount; s++) {
      const start = s * rowsPerSlide;
      const slice = funds.slice(start, start + rowsPerSlide);
      const slide = pres.addSlide();
      slide.background = { fill: BRAND_HEX.white };

      // Header bar
      slide.addShape(pres.ShapeType.rect, {
        x: 0, y: 0, w: 13.333, h: 0.55,
        fill: { color: BRAND_HEX.black }, line: { color: BRAND_HEX.black },
      });
      slide.addShape(pres.ShapeType.rect, {
        x: 0, y: 0.53, w: 13.333, h: 0.04,
        fill: { color: BRAND_HEX.gold }, line: { color: BRAND_HEX.gold },
      });
      slide.addText([
        { text: 'CENTRICITY MUTUAL FUND SCREENER', options: { color: BRAND_HEX.white, bold: true } },
        { text: '   ·   ',  options: { color: BRAND_HEX.gold } },
        { text: cycleLabel, options: { color: BRAND_HEX.gold, bold: true } },
      ], {
        x: 0.4, y: 0.06, w: 10, h: 0.43,
        fontFace: FONT, fontSize: 14, charSpacing: 4,
      });
      slide.addText('Confidential', {
        x: 11, y: 0.06, w: 2, h: 0.43,
        color: BRAND_HEX.gold, fontFace: FONT, fontSize: 10, charSpacing: 3, align: 'right',
      });

      // Filters caption + slide indicator
      slide.addText([
        { text: 'FILTERS  ', options: { color: BRAND_HEX.black, bold: true, fontSize: 9, charSpacing: 2 } },
        { text: filtersCaption || 'No filters applied', options: { color: BRAND_HEX.grey, fontSize: 10 } },
      ], {
        x: 0.4, y: 0.7, w: 10, h: 0.35,
        fontFace: FONT,
      });
      slide.addText(
        `Slide ${s + 1} of ${slideCount}  ·  ${funds.length.toLocaleString('en-IN')} funds`,
        {
          x: 10.5, y: 0.7, w: 2.5, h: 0.35,
          color: BRAND_HEX.grey, fontFace: FONT, fontSize: 9, align: 'right',
        },
      );

      // Table — header + body rows
      const bodyRows = slice.map((f) => columns.map(col => {
        const text = _formatCell(f, col);
        const raw = _pickValue(f, col);
        const align = col.align || 'center';
        const isNeg = col.neg && typeof raw === 'number' && raw < 0;
        return {
          text: String(text == null ? '—' : text),
          options: {
            color: isNeg ? BRAND_HEX.red : BRAND_HEX.black,
            fontSize: 9, fontFace: FONT, align,
          },
        };
      }));

      slide.addTable([headerRow].concat(bodyRows), {
        x: 0.4, y: 1.15, w: 12.5,
        border: { type: 'solid', color: BRAND_HEX.tan, pt: 0.5 },
        rowH: 0.22,
      });

      // Footer
      slide.addShape(pres.ShapeType.rect, {
        x: 0, y: 7.1, w: 13.333, h: 0.4,
        fill: { color: BRAND_HEX.black }, line: { color: BRAND_HEX.black },
      });
      slide.addText('CENTRICITY WEALTHTECH  ·  Products Team  ·  Confidential', {
        x: 0.4, y: 7.18, w: 8, h: 0.25,
        color: BRAND_HEX.white, fontFace: FONT, fontSize: 9, charSpacing: 2,
      });
      slide.addText(`As on ${cycleLabel}`, {
        x: 8.5, y: 7.18, w: 4.5, h: 0.25,
        color: BRAND_HEX.gold, fontFace: FONT, fontSize: 9, align: 'right',
      });
    }

    const filename = fileBase + '.pptx';
    return pres.writeFile({ fileName: filename });
  }

  function _escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* -------------------------------------------------------- *
   *  Auto-wire buttons declared via data-attributes
   *  <button data-export-pdf="#some-element" data-export-name="MyExport">…</button>
   * -------------------------------------------------------- */
  function init() {
    document.querySelectorAll('[data-export-pdf]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const target = btn.getAttribute('data-export-pdf');
        const name = btn.getAttribute('data-export-name') || 'Centricity-export';
        try {
          await exportPDF(target, name);
        } catch (err) {
          console.error('exportPDF failed:', err);
        }
      });
    });
    document.querySelectorAll('[data-export-ppt]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        // Per-screen handlers should listen for this; default does nothing
        // to avoid generating empty decks.
        const ev = new CustomEvent('centricity:export-ppt', { detail: { source: btn } });
        document.dispatchEvent(ev);
      });
    });
  }

  window.Exports = {
    exportPDF,
    exportPPT,
    buildScreenerPDF,
    buildScreenerPPT,
    init,
  };
})();
