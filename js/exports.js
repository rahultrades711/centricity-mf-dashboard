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
 * Exposes window.Exports.
 *
 * Usage from a page:
 *   <button data-export-target="#fund-detail-page" data-export-name="ICICI-Pru-Bluechip">PDF</button>
 *   Exports.init();   // attaches click handlers
 * Or programmatically:
 *   Exports.exportPDF(document.getElementById('fund-detail-page'), 'ICICI-Pru-Bluechip');
 */
(function () {
  'use strict';

  const CDN = {
    html2pdf: 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
    pptxgen:  'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.min.js',
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
    init,
  };
})();
