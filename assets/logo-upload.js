/**
 * <logo-upload> — customer artwork upload with print-quality checks + live preview.
 *
 * Layers:
 *  1. Format gate  — SVG/PDF auto-pass as vector; PNG/JPG/WebP continue; everything else rejected.
 *  2. Resolution   — hard block below warnWidth px, warning between warnWidth and minWidth.
 *  3. Background   — canvas corner sampling flags opaque near-white backgrounds (JPG always flagged).
 *  4. Human review — hidden `_Logo QC` line item property tells the merchant which orders need cleanup.
 *
 * Cart safety: when a file is attached, the add-to-cart submit is intercepted in the capture
 * phase (before any theme AJAX handler can JSON-serialize the form and drop the file) and the
 * form is either natively submitted (multipart) or POSTed as FormData to /cart/add.js.
 */
(function () {
  'use strict';

  if (customElements.get('logo-upload')) return;

  var VECTOR_EXT = { svg: 'SVG (vector)', pdf: 'PDF (vector)' };
  var RASTER_EXT = { png: 'PNG (raster)', jpg: 'JPG (raster)', jpeg: 'JPG (raster)', webp: 'WebP (raster)' };

  function ext(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function formatBytes(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  function truncateMiddle(str, max) {
    if (!str || str.length <= max) return str;
    var half = Math.floor((max - 1) / 2);
    return str.slice(0, half) + '\u2026' + str.slice(-half);
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  var LogoUpload = function () {
    return Reflect.construct(HTMLElement, [], LogoUpload);
  };
  LogoUpload.prototype = Object.create(HTMLElement.prototype);
  LogoUpload.prototype.constructor = LogoUpload;
  Object.setPrototypeOf(LogoUpload, HTMLElement);

  LogoUpload.prototype.connectedCallback = function () {
    // Element may reconnect (theme editor reloads, relocation). Init only once.
    if (this._initialized) return;

    var cfgEl = this.querySelector('[data-logo-upload-config]');
    try {
      this.cfg = JSON.parse(cfgEl.textContent);
    } catch (e) {
      this.cfg = { required: false, minWidth: 1500, warnWidth: 1000, maxFileMB: 20, enablePreview: false, messages: {} };
    }

    // Standalone-section mode: optionally move into the product info column.
    // Moving = disconnect + reconnect, so do it before init and let the
    // second connectedCallback continue past this block.
    if (!this._movedOnce && this.cfg.placement && this.cfg.placement !== 'standalone') {
      this._movedOnce = true;
      if (this.relocate()) return;
    }
    this._movedOnce = true;

    this.formId = this.dataset.formId || '';
    this.form = this.formId ? document.getElementById(this.formId) : null;
    if (!this.form) {
      this.form = this.discoverForm();
      if (this.form) {
        if (!this.form.id) this.form.id = 'ProductForm-logo-upload-' + (this.dataset.productId || 'x');
        this.formId = this.form.id;
      }
    }
    this.associateInputs();

    this.input = this.querySelector('.logo-upload__input');
    this.dropzone = this.querySelector('[data-dropzone]');
    this.card = this.querySelector('[data-file-card]');
    this.thumbImg = this.querySelector('[data-thumb-img]');
    this.thumbIcon = this.querySelector('[data-thumb-icon]');
    this.filenameEl = this.querySelector('[data-filename]');
    this.filemetaEl = this.querySelector('[data-filemeta]');
    this.badgeEl = this.querySelector('[data-badge]');
    this.statusEl = this.querySelector('[data-status]');
    this.ackWrap = this.querySelector('[data-ack-wrap]');
    this.ack = this.querySelector('[data-ack]');
    this.rights = this.querySelector('[data-rights]');
    this.props = {
      filename: this.querySelector('[data-prop-filename]'),
      dimensions: this.querySelector('[data-prop-dimensions]'),
      format: this.querySelector('[data-prop-format]'),
      qc: this.querySelector('[data-prop-qc]')
    };

    this.state = { file: null, status: 'empty', objectUrl: null, submitting: false };

    this.bindDropzone();
    this.bindCard();
    this.bindFormGuard();
    if (this.cfg.enablePreview) {
      this.mountOverlay();
      this.bindGalleryRefresh();
    }

    this._initialized = true;
  };

  /**
   * Standalone mode: find the product's add-to-cart form on the page.
   * Prefers the theme's ProductForm-* id, then any /cart/add form with a
   * real submit control, skipping Shopify's hidden installments form.
   */
  LogoUpload.prototype.discoverForm = function () {
    var forms = Array.prototype.slice.call(document.querySelectorAll('form[action*="/cart/add"]'));
    forms = forms.filter(function (f) {
      return !/installment/i.test((f.id || '') + ' ' + (f.className || ''));
    });
    if (!forms.length) return null;

    var byId = forms.filter(function (f) { return /^ProductForm/i.test(f.id || ''); });
    var pool = byId.length ? byId : forms;

    for (var i = 0; i < pool.length; i++) {
      var f = pool[i];
      var hasSubmit =
        f.querySelector('[type="submit"], [name="add"]') ||
        (f.id && document.querySelector('[type="submit"][form="' + f.id + '"], [name="add"][form="' + f.id + '"]'));
      if (hasSubmit) return f;
    }
    return pool[0];
  };

  /** Bind our inputs (file, checkboxes, hidden QC props) to the discovered form. */
  LogoUpload.prototype.associateInputs = function () {
    if (!this.formId) return;
    var formId = this.formId;
    this.querySelectorAll('[data-associate-form]').forEach(function (el) {
      el.setAttribute('form', formId);
    });
  };

  /** Visually move the uploader into the product info column. Returns true if moved. */
  LogoUpload.prototype.relocate = function () {
    var info = document.querySelector('product-info') || document.querySelector('.product__info');
    if (!info) return false;

    // Clean up a stale copy left behind by a theme-editor section reload.
    var selfId = this.id;
    document.querySelectorAll('logo-upload').forEach(function (el) {
      if (el.id === selfId && el !== this) el.remove();
    }, this);

    var moved = false;
    if (this.cfg.placement === 'before_buy_buttons') {
      var btn = info.querySelector('[name="add"], [type="submit"]');
      var anchor = btn && (btn.closest('.product-form') || btn.closest('form') || btn.parentElement);
      if (anchor && anchor.parentElement) {
        anchor.parentElement.insertBefore(this, anchor);
        moved = true;
      }
    }
    if (!moved) {
      info.appendChild(this); // product_info_end + fallback
      moved = true;
    }

    this.classList.add('is-inlined');
    // Hide the now-empty standalone shell — but ONLY if it's genuinely separate.
    // When the uploader is a block inside the product section, that shell also holds
    // the product-info we just moved into; hiding it would blank the whole product.
    var shell = document.getElementById('shopify-section-' + this.dataset.sectionId);
    if (shell && !shell.contains(this) && !shell.contains(info)) shell.style.display = 'none';
    return moved;
  };

  LogoUpload.prototype.disconnectedCallback = function () {
    if (!this._initialized) return; // relocation move, not a real teardown
    this.revokeUrl();
    if (this.boundGuard) document.removeEventListener('submit', this.boundGuard, true);
    if (this.onVariantChange) {
      if (this.form) this.form.removeEventListener('variant:change', this.onVariantChange);
      document.removeEventListener('variant:change', this.onVariantChange);
    }
    this._initialized = false;
  };

  /* ------------------------------------------------------------------ */
  /* Dropzone + file card                                                */
  /* ------------------------------------------------------------------ */

  LogoUpload.prototype.bindDropzone = function () {
    var self = this;

    this.input.addEventListener('change', function () {
      if (self.input.files && self.input.files[0]) self.handleFile(self.input.files[0]);
    });

    // Keyboard: Enter/Space on the labelled dropzone opens the picker.
    this.dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        self.input.click();
      }
    });

    // Drag & drop (desktop). Guard the page against accidental drops opening the file.
    ['dragenter', 'dragover'].forEach(function (evt) {
      self.dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        self.dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      self.dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        self.dropzone.classList.remove('is-dragover');
      });
    });
    this.dropzone.addEventListener('drop', function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      self.assignToInput(file);
      self.handleFile(file);
    });
    if (!document.body.dataset.logoUploadDropGuard) {
      document.body.dataset.logoUploadDropGuard = 'true';
      window.addEventListener('dragover', function (e) { e.preventDefault(); });
      window.addEventListener('drop', function (e) { e.preventDefault(); });
    }
  };

  LogoUpload.prototype.bindCard = function () {
    var self = this;
    this.querySelector('[data-replace]').addEventListener('click', function () { self.input.click(); });
    this.querySelector('[data-remove]').addEventListener('click', function () { self.reset(); });
  };

  /** Drag & drop bypasses the input, so mirror the file into it for form submission. */
  LogoUpload.prototype.assignToInput = function (file) {
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      this.input.files = dt.files;
    } catch (e) {
      /* Very old browsers: fall back to click-to-upload only. */
    }
  };

  /* ------------------------------------------------------------------ */
  /* Validation pipeline                                                 */
  /* ------------------------------------------------------------------ */

  LogoUpload.prototype.handleFile = function (file) {
    var self = this;
    var msgs = this.cfg.messages;
    this.clearError();
    this.revokeUrl();

    var extension = ext(file.name);

    // HEIC/unsupported gate.
    if (extension === 'heic' || extension === 'heif' || /hei[cf]/.test(file.type)) {
      return this.rejectFile(msgs.heic);
    }
    if (!VECTOR_EXT[extension] && !RASTER_EXT[extension]) {
      return this.rejectFile(msgs.badFormat);
    }

    // Size gate.
    if (file.size > this.cfg.maxFileMB * 1048576) {
      return this.rejectFile((msgs.tooLarge || '').replace('{max}', this.cfg.maxFileMB));
    }

    this.state.file = file;

    if (VECTOR_EXT[extension]) {
      if (extension === 'pdf') {
        this.applyResult(file, {
          status: 'pass',
          badge: msgs.vectorPass,
          note: msgs.pdfNoPreview,
          format: VECTOR_EXT.pdf,
          dimensions: 'Vector \u2014 scalable',
          qc: 'PASSED \u2014 vector file',
          previewable: false
        });
      } else {
        // SVG previews fine in <img>.
        var url = URL.createObjectURL(file);
        this.state.objectUrl = url;
        this.applyResult(file, {
          status: 'pass',
          badge: msgs.vectorPass,
          format: VECTOR_EXT.svg,
          dimensions: 'Vector \u2014 scalable',
          qc: 'PASSED \u2014 vector file',
          previewable: true,
          url: url
        });
      }
      return;
    }

    // Raster: read dimensions, then background check.
    var url2 = URL.createObjectURL(file);
    var img = new Image();
    this.setBusy(true);
    img.onload = function () {
      self.setBusy(false);
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      var dims = w + ' \u00d7 ' + h + ' px';
      var format = RASTER_EXT[extension];

      if (w < self.cfg.warnWidth) {
        URL.revokeObjectURL(url2);
        return self.rejectFile(
          (msgs.tooSmall || '').replace('{width}', w).replace('{min}', self.cfg.minWidth)
        );
      }

      var warnings = [];
      var qcFlags = [];

      if (w < self.cfg.minWidth) {
        warnings.push((msgs.lowRes || '').replace('{width}', w));
        qcFlags.push('low resolution (' + dims + ')');
      }

      var bg = self.backgroundCheck(img, extension);
      if (bg === 'jpg') {
        warnings.push(msgs.jpgBg);
        qcFlags.push('JPG \u2014 no transparency');
      } else if (bg === 'opaque') {
        warnings.push(msgs.opaqueBg);
        qcFlags.push('solid background detected');
      }

      self.state.objectUrl = url2;
      self.applyResult(file, {
        status: warnings.length ? 'warn' : 'pass',
        badge: warnings.length ? 'Needs a quick check' : msgs.rasterPass,
        note: warnings.join(' '),
        format: format,
        dimensions: dims,
        qc: warnings.length ? 'NEEDS REVIEW \u2014 ' + qcFlags.join('; ') : 'PASSED \u2014 ' + dims,
        previewable: true,
        url: url2
      });
    };
    img.onerror = function () {
      self.setBusy(false);
      URL.revokeObjectURL(url2);
      self.rejectFile(msgs.readError);
    };
    img.src = url2;
  };

  /**
   * Samples the four corners + edge midpoints of the image on a small canvas.
   * Returns 'jpg' (format can't be transparent), 'opaque' (near-white solid bg), or null.
   */
  LogoUpload.prototype.backgroundCheck = function (img, extension) {
    if (extension === 'jpg' || extension === 'jpeg') return 'jpg';
    try {
      var size = 64;
      var canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      var points = [
        [1, 1], [size - 2, 1], [1, size - 2], [size - 2, size - 2],
        [size >> 1, 1], [size >> 1, size - 2], [1, size >> 1], [size - 2, size >> 1]
      ];
      var opaqueLight = 0;
      for (var i = 0; i < points.length; i++) {
        var d = ctx.getImageData(points[i][0], points[i][1], 1, 1).data;
        if (d[3] > 250 && d[0] > 235 && d[1] > 235 && d[2] > 235) opaqueLight++;
        if (d[3] < 250) return null; // any transparent edge pixel => transparent bg
      }
      return opaqueLight === points.length ? 'opaque' : null;
    } catch (e) {
      return null; // canvas blocked — skip the soft check, human review still applies
    }
  };

  /* ------------------------------------------------------------------ */
  /* State rendering                                                     */
  /* ------------------------------------------------------------------ */

  LogoUpload.prototype.applyResult = function (file, r) {
    this.state.status = r.status;

    // File card
    this.dropzone.hidden = true;
    this.card.hidden = false;
    this.filenameEl.textContent = truncateMiddle(file.name, 34);
    this.filenameEl.title = file.name;
    this.filemetaEl.textContent = formatBytes(file.size) + ' \u00b7 ' + r.dimensions;

    if (r.previewable && r.url) {
      this.thumbImg.src = r.url;
      this.thumbImg.hidden = false;
      this.thumbIcon.hidden = true;
    } else {
      this.thumbImg.hidden = true;
      this.thumbIcon.hidden = false;
    }

    this.badgeEl.hidden = false;
    this.badgeEl.textContent = r.badge;
    this.badgeEl.className = 'logo-upload__badge is-' + r.status;

    this.statusEl.className = 'logo-upload__status text-sm is-' + r.status;
    this.statusEl.textContent = r.note || '';

    // Warning acknowledgment
    if (this.ackWrap) {
      this.ackWrap.hidden = r.status !== 'warn';
      if (this.ack) this.ack.checked = false;
    }

    // Hidden QC properties
    this.setProp('filename', file.name);
    this.setProp('dimensions', r.dimensions);
    this.setProp('format', r.format);
    this.setProp('qc', r.qc);

    // Live preview overlay
    this.updateOverlay(r.previewable ? r.url : null);

    // Mobile: bring the preview into view — the money moment.
    if (this.cfg.enablePreview && r.previewable && window.innerWidth < 768 && this.overlay) {
      var media = this.overlay.closest('.media') || this.overlay;
      media.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    }

    this.dispatchEvent(new CustomEvent('logo-upload:change', { bubbles: true, detail: { status: r.status } }));
  };

  LogoUpload.prototype.rejectFile = function (message) {
    this.reset();
    this.showError(message);
  };

  LogoUpload.prototype.reset = function () {
    this.revokeUrl();
    this.state = { file: null, status: 'empty', objectUrl: null, submitting: false };
    this.input.value = '';
    this.card.hidden = true;
    this.dropzone.hidden = false;
    this.badgeEl.hidden = true;
    this.thumbImg.removeAttribute('src');
    if (this.ackWrap) {
      this.ackWrap.hidden = true;
      if (this.ack) this.ack.checked = false;
    }
    this.setProp('filename', '');
    this.setProp('dimensions', '');
    this.setProp('format', '');
    this.setProp('qc', '');
    this.classList.remove('has-error');
    this.statusEl.textContent = '';
    this.statusEl.className = 'logo-upload__status text-sm';
    this.updateOverlay(null);
  };

  LogoUpload.prototype.setProp = function (key, value) {
    var el = this.props[key];
    if (!el) return;
    el.value = value;
    el.disabled = !value; // disabled empty inputs never submit blank properties
  };

  LogoUpload.prototype.setBusy = function (busy) {
    this.classList.toggle('is-busy', busy);
    this.dropzone.setAttribute('aria-busy', busy ? 'true' : 'false');
  };

  LogoUpload.prototype.showError = function (message) {
    this.statusEl.className = 'logo-upload__status text-sm is-error';
    this.statusEl.textContent = message || '';
    this.classList.add('has-error');
  };

  LogoUpload.prototype.clearError = function () {
    this.classList.remove('has-error');
    if (this.statusEl.classList.contains('is-error')) {
      this.statusEl.textContent = '';
      this.statusEl.className = 'logo-upload__status text-sm';
    }
  };

  LogoUpload.prototype.revokeUrl = function () {
    if (this.state && this.state.objectUrl) {
      URL.revokeObjectURL(this.state.objectUrl);
      this.state.objectUrl = null;
    }
  };

  /* ------------------------------------------------------------------ */
  /* Live preview overlay on the gallery                                 */
  /* ------------------------------------------------------------------ */

  LogoUpload.prototype.mountOverlay = function () {
    var self = this;
    var section = document.getElementById('shopify-section-' + this.dataset.sectionId);
    var gallery =
      (section && section.querySelector('.product__gallery-container')) ||
      document.querySelector('.product__gallery-container') ||
      document.querySelector('media-gallery') ||
      section ||
      document;

    // Scope to the MAIN gallery slider so we skip the little thumbnails.
    var mainSlider =
      gallery.querySelector('[id^="SliderGallery"]') ||
      gallery.querySelector('slider-element') ||
      gallery;

    // Every main product image (so the preview follows the customer's colour choice).
    var items = mainSlider.querySelectorAll('[data-media-id]');
    if (!items.length) items = mainSlider.querySelectorAll('.product__media');
    if (!items.length) items = mainSlider.querySelectorAll('.media');
    if (!items.length) return;

    var tpl = this.querySelector('[data-overlay-template]');
    if (!tpl) return;

    // One or more print areas (e.g. one per chair). Fall back to the single box.
    var boxConfigs = (this.cfg.boxes && this.cfg.boxes.length)
      ? this.cfg.boxes
      : (this.cfg.box ? [this.cfg.box] : []);
    if (!boxConfigs.length) return;

    // Mount an identical overlay onto each image; track them all so updates apply everywhere.
    this.overlays = [];
    Array.prototype.forEach.call(items, function (item) {
      var host = item.querySelector('.media') || item;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

      // Theme editor reloads can leave a stale overlay behind.
      var stale = host.querySelector('.logo-upload-overlay');
      if (stale) stale.remove();

      var frag = tpl.content.cloneNode(true);
      var overlay = frag.querySelector('.logo-upload-overlay');
      var note = overlay.querySelector('.logo-upload-overlay__note');
      if (self.cfg.previewBlend && self.cfg.previewBlend !== 'normal') {
        overlay.setAttribute('data-blend', self.cfg.previewBlend);
      }

      // The template ships one box; clone it once per configured print area.
      var boxProto = overlay.querySelector('.logo-upload-overlay__box');
      if (boxProto) boxProto.remove();

      var boxes = [];
      boxConfigs.forEach(function (bc) {
        var boxEl = boxProto ? boxProto.cloneNode(true) : null;
        if (!boxEl) return;
        boxEl.style.top = bc.top + '%';
        boxEl.style.left = bc.left + '%';
        boxEl.style.width = bc.width + '%';
        boxEl.style.height = bc.height + '%';
        overlay.appendChild(boxEl);
        boxes.push({
          img: boxEl.querySelector('.logo-upload-overlay__img'),
          placeholder: boxEl.querySelector('.logo-upload-overlay__placeholder')
        });
      });

      if (self.cfg.showPlaceholder) overlay.classList.add('is-placeholder');

      host.appendChild(frag);
      self.overlays.push({ overlay: overlay, note: note, boxes: boxes });
    });

    // Primary reference (used for the mobile scroll-into-view "money moment").
    var primaryIndex = Math.max(0, Math.min(this.overlays.length - 1, (this.cfg.previewMediaPosition || 1) - 1));
    var primary = this.overlays[primaryIndex] || this.overlays[0];
    if (primary) this.overlay = primary.overlay;
  };

  LogoUpload.prototype.updateOverlay = function (url) {
    if (!this.overlays || !this.overlays.length) return;
    var showPlaceholder = this.cfg.showPlaceholder;
    this.overlays.forEach(function (o) {
      if (url) {
        o.overlay.classList.add('has-logo');
        o.overlay.classList.remove('is-placeholder');
        if (o.note) o.note.hidden = false;
        o.boxes.forEach(function (b) {
          if (b.img) { b.img.src = url; b.img.hidden = false; }
          if (b.placeholder) b.placeholder.hidden = true;
        });
      } else {
        o.overlay.classList.remove('has-logo');
        if (o.note) o.note.hidden = true;
        if (showPlaceholder) o.overlay.classList.add('is-placeholder');
        else o.overlay.classList.remove('is-placeholder');
        o.boxes.forEach(function (b) {
          if (b.img) { b.img.hidden = true; b.img.removeAttribute('src'); }
          if (b.placeholder) b.placeholder.hidden = !showPlaceholder;
        });
      }
    });
  };

  /**
   * The theme re-renders the gallery HTML on every variant change, which wipes the
   * overlays we injected. Re-mount them into the fresh media and re-apply the current
   * logo (or placeholder) so the preview survives a colour switch.
   */
  LogoUpload.prototype.bindGalleryRefresh = function () {
    var self = this;
    this.onVariantChange = function () {
      if (self._overlayRefreshScheduled) return;
      self._overlayRefreshScheduled = true;
      requestAnimationFrame(function () {
        self._overlayRefreshScheduled = false;
        self.mountOverlay();
        self.updateOverlay(self.state && self.state.objectUrl ? self.state.objectUrl : null);
      });
    };
    // The theme dispatches a non-bubbling `variant:change` on the product form.
    if (this.form) this.form.addEventListener('variant:change', this.onVariantChange);
    document.addEventListener('variant:change', this.onVariantChange);
  };

  /* ------------------------------------------------------------------ */
  /* Form guard + file-safe submission                                   */
  /* ------------------------------------------------------------------ */

  LogoUpload.prototype.bindFormGuard = function () {
    var self = this;

    // Capture phase on document: runs before theme AJAX handlers, and covers
    // the sticky buy button (it submits the same form via its form="" attribute).
    this.boundGuard = function (e) {
      var form = e.target;
      if (!(form instanceof HTMLFormElement)) return;

      // Late discovery: if we never found the form (e.g. it rendered after us), try again now.
      if (!self.formId) {
        var found = self.discoverForm();
        if (found) {
          if (!found.id) found.id = 'ProductForm-logo-upload-' + (self.dataset.productId || 'x');
          self.form = found;
          self.formId = found.id;
          self.associateInputs();
        }
      }
      if (form !== self.form && form.id !== self.formId) return;
      if (self.state.submitting) return;

      var msgs = self.cfg.messages;

      // 1) Required file
      if (self.cfg.required && !self.state.file) {
        e.preventDefault();
        e.stopImmediatePropagation();
        self.showError(msgs.required);
        self.scrollToSelf();
        return;
      }

      // 2) Warning acknowledgment
      if (self.state.file && self.state.status === 'warn' && self.ack && !self.ack.checked) {
        e.preventDefault();
        e.stopImmediatePropagation();
        self.showError(msgs.ackRequired);
        self.scrollToSelf();
        return;
      }

      // 3) Artwork rights
      if (self.state.file && self.rights && !self.rights.checked) {
        e.preventDefault();
        e.stopImmediatePropagation();
        self.showError(msgs.rightsRequired);
        self.scrollToSelf();
        return;
      }

      // 4) A file is attached: take over submission so no AJAX handler can drop it.
      if (self.state.file) {
        e.preventDefault();
        e.stopImmediatePropagation();
        self.clearError();
        self.submitWithFile(form);
      }
      // No file + not required: let the theme handle it normally.
    };
    document.addEventListener('submit', this.boundGuard, true);
  };

  LogoUpload.prototype.scrollToSelf = function () {
    this.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  };

  /** Product handle from the URL (works under locale/collection prefixes) or a snippet-provided one. */
  LogoUpload.prototype.productHandle = function () {
    var m = /\/products\/([^/?#]+)/.exec(window.location.pathname);
    return (m && m[1]) || this.dataset.productHandle || '';
  };

  /**
   * Fetch (once, cached) this product's real JSON. This is the single source of
   * truth for which variant ids actually exist — the ONLY reliable way to avoid
   * posting a stale/foreign id that Shopify rejects as "Cannot find variant".
   */
  LogoUpload.prototype.fetchProductJSON = function () {
    if (this._productJSON !== undefined) return Promise.resolve(this._productJSON);
    if (this._productJSONPromise) return this._productJSONPromise;
    var self = this;
    var handle = this.productHandle();
    if (!handle) { this._productJSON = null; return Promise.resolve(null); }
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    this._productJSONPromise = fetch(root + 'products/' + handle + '.js', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { self._productJSON = p || null; return self._productJSON; })
      .catch(function () { self._productJSON = null; return null; });
    return this._productJSONPromise;
  };

  /**
   * The variant id currently reflected in the product form / page — WITHOUT
   * scraping unrelated products elsewhere on the page (recommendations, recently
   * viewed, etc. all carry [data-variant-id] for OTHER products). Returned only as
   * a candidate; it is always reconciled against the real variant list before we submit.
   */
  LogoUpload.prototype.domVariantId = function (form) {
    // 1) The theme's own hidden id input — kept in sync with the selected variant.
    //    Dawn-style themes disable it and re-enable it in their own submit handler
    //    (which we've intercepted), so re-enable it here too.
    var idInput =
      (form && form.querySelector('input[name="id"], .product-variant-id')) ||
      (form && form.id && document.querySelector('[name="id"][form="' + form.id + '"]'));
    if (idInput) {
      idInput.disabled = false;
      if (idInput.value) return idInput.value;
    }
    // 2) The variant the theme mirrors into the URL (data-update-url).
    var m = /[?&]variant=(\d+)/.exec(window.location.search);
    if (m) return m[1];
    // 3) A directly-selected variant control (noscript <select>, simple radio pickers).
    var picked = document.querySelector('select[name="id"], input[name="id"]:checked');
    if (picked && picked.value) return picked.value;
    return '';
  };

  /**
   * Ask Shopify for a real variant id: honour ?variant= when it's valid, else the
   * first available variant, else the first variant. Authoritative fallback whenever
   * the DOM id is missing or isn't a real variant of this product.
   */
  LogoUpload.prototype.fetchVariantId = function () {
    return this.fetchProductJSON().then(function (p) {
      if (!p || !p.variants || !p.variants.length) return '';
      var m = /[?&]variant=(\d+)/.exec(window.location.search);
      if (m) {
        for (var i = 0; i < p.variants.length; i++) {
          if (String(p.variants[i].id) === m[1]) return m[1];
        }
      }
      var available = null;
      for (var j = 0; j < p.variants.length; j++) {
        if (p.variants[j].available) { available = p.variants[j]; break; }
      }
      return String((available || p.variants[0]).id);
    });
  };

  /**
   * Resolve a variant id GUARANTEED to be a real, current variant of THIS product.
   * We take the DOM's candidate, then reconcile it against the product's real variant
   * list (fetched once from Shopify, cached). A missing / stale / foreign id is exactly
   * what Shopify rejects as "Cannot find variant" — reconciliation removes that failure,
   * whether or not window.ShopifyAnalytics happens to be present.
   */
  LogoUpload.prototype.resolveVariantIdAsync = function (form) {
    var self = this;
    var candidate = this.domVariantId(form);
    return this.fetchProductJSON().then(function (p) {
      // No product JSON (network/edge case): trust the DOM candidate as best effort.
      if (!p || !p.variants || !p.variants.length) return candidate || '';
      for (var i = 0; i < p.variants.length; i++) {
        if (String(p.variants[i].id) === String(candidate)) return candidate;
      }
      // Candidate isn't a real variant of this product — resolve the correct one.
      return self.fetchVariantId();
    });
  };

  LogoUpload.prototype.submitWithFile = function (form) {
    var self = this;
    this.state.submitting = true;
    this.setSubmitButtons(form, true);

    // Guarantee a real variant id (fetching it from Shopify if the DOM has none)
    // before we submit either way, so neither path can post a bad id.
    this.resolveVariantIdAsync(form).then(function (variantId) {
      if (!variantId) {
        self.state.submitting = false;
        self.setSubmitButtons(form, false);
        self.showError('Please select a product option before adding to cart.');
        self.scrollToSelf();
        return;
      }
      if (self.cfg.afterAdd === 'native') self.submitNative(form, variantId);
      else self.submitAjax(form, variantId);
    });
  };

  /** Native multipart POST to /cart/add — Shopify redirects to /cart. */
  LogoUpload.prototype.submitNative = function (form, variantId) {
    form.method = 'post';
    form.enctype = 'multipart/form-data';
    if (!/\/cart\/add/.test(form.action)) form.action = window.Shopify && window.Shopify.routes ? window.Shopify.routes.root + 'cart/add' : '/cart/add';
    // Put the resolved id on the form, replacing a missing/wrong one Shopify would reject.
    var ownId = form.querySelector('[name="id"]:not([disabled])');
    if (ownId) {
      ownId.value = variantId;
    } else {
      var inj = document.createElement('input');
      inj.type = 'hidden';
      inj.name = 'id';
      inj.value = variantId;
      form.appendChild(inj);
    }
    HTMLFormElement.prototype.submit.call(form);
  };

  /** AJAX POST to /cart/add.js — FormData preserves the file, then land on the cart. */
  LogoUpload.prototype.submitAjax = function (form, variantId) {
    var self = this;
    var fd = new FormData(form);
    fd.set('id', variantId); // collapses any duplicate/stale id inputs to the resolved one

    /* Diagnostics — visible in the browser console (F12) */
    try {
      console.log('[logo-upload] form:', '#' + form.id, '| action:', form.action);
      console.log('[logo-upload] variant id sent:', fd.get('id') || '(MISSING)');
      console.log('[logo-upload] file attached:', fd.get(this.input.name) instanceof File ? this.input.files[0].name : '(MISSING)');
    } catch (e) { /* diagnostics only */ }

    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    var retried = false;

    var onDone = function () {
      // Let cart drawers know, then land on the cart — the one place the upload is always visible.
      document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
      document.dispatchEvent(new CustomEvent('cart:change', { bubbles: true }));
      window.location.href = root + 'cart';
    };

    var onFail = function (err) {
      self.state.submitting = false;
      self.setSubmitButtons(form, false);
      var msg = err.message || 'Add to cart failed';
      // "Cannot find variant" for an id that IS in the product's own JSON almost always
      // means the product isn't purchasable on the storefront (Draft, or not on the
      // Online Store sales channel) — a theme preview can show it but can't add it.
      // Log the specifics for a developer without exposing them to shoppers.
      if (/variant/i.test(msg)) {
        try {
          var tried = fd.get('id');
          var have = self._productJSON && self._productJSON.variants
            ? self._productJSON.variants.map(function (v) { return v.id; }).join(', ')
            : '(product JSON not loaded)';
          console.error('[logo-upload] add-to-cart rejected: "' + msg + '". id sent:', tried,
            '| handle:', self.productHandle(), '| product variants:', have,
            '\nIf the id sent is in that list, the product is likely a Draft / not on the Online Store sales channel.');
        } catch (e) { /* diagnostics only */ }
      }
      self.showError(msg);
      self.scrollToSelf();
    };

    var addToCart = function () {
      return fetch(root + 'cart/add.js', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: fd
      }).then(function (res) {
        if (!res.ok) return res.json().then(function (j) { throw new Error(j.description || j.message || 'Add to cart failed'); });
        return res.json();
      });
    };

    addToCart()
      .then(onDone)
      .catch(function (err) {
        // "Cannot find variant" is recoverable: re-fetch the real id and retry once.
        if (!retried && /variant/i.test(err.message || '')) {
          retried = true;
          return self.fetchVariantId().then(function (vid) {
            if (!vid) throw err;
            fd.set('id', vid);
            return addToCart().then(onDone);
          });
        }
        throw err;
      })
      .catch(onFail);
  };

  LogoUpload.prototype.setSubmitButtons = function (form, busy) {
    var msgs = this.cfg.messages;
    var buttons = Array.prototype.slice.call(form.querySelectorAll('[type="submit"]'));
    buttons = buttons.concat(Array.prototype.slice.call(document.querySelectorAll('[type="submit"][form="' + form.id + '"]')));
    buttons.forEach(function (btn) {
      btn.disabled = busy;
      btn.setAttribute('aria-busy', busy ? 'true' : 'false');
      if (busy && msgs.adding) {
        btn.dataset.logoUploadLabel = btn.textContent;
        var span = btn.querySelector('span') || btn;
        if (span.children.length === 0) span.textContent = msgs.adding;
      } else if (!busy && btn.dataset.logoUploadLabel) {
        var span2 = btn.querySelector('span') || btn;
        if (span2.children.length === 0) span2.textContent = btn.dataset.logoUploadLabel;
      }
    });
  };

  customElements.define('logo-upload', LogoUpload);
})();