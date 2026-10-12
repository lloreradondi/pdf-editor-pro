/*
  PDF Editor Pro — POC
  ---------------------------------------------------------------------------
  A minimal but working, 100% in-browser PDF editor.
    - View: pdf.js renders pages to canvas.
    - Edit: add text, highlights, signature images; reorder/rotate/delete pages.
    - Save: pdf-lib rebuilds the PDF with your edits and downloads it.
  Files never leave the browser. Free export gets a diagonal watermark; Pro removes it.

  Freemium mechanics mirror the Invoice Generator: one isPro() gate,
  activateLicense(key) returns a Promise so Gumroad online verify slots in later.
*/
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Config — fill these after creating the Gumroad product (see MONEY-PLAN.md)
   * ------------------------------------------------------------------ */
  var GUMROAD_BUY_URL = "";        // e.g. "https://you.gumroad.com/l/xxxx"
  var GUMROAD_PRODUCT_ID = "";     // permalink
  var GUMROAD_API_PRODUCT_ID = ""; // API product token from the license block
  var PRO_PRICE = "$9";

  var LICENSE_KEY_STORE = "pdfEditor.license.v1";

  // pdf.js worker
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  var PDFLib = window.PDFLib;

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  var state = {
    pdfjsDoc: null,     // rendered doc
    origBytes: null,    // ArrayBuffer of the opened file (source for pdf-lib)
    pageOrder: [],      // display order -> original 0-based page index
    rotations: {},      // origIdx -> degrees (0/90/180/270), applied on export
    overlays: {},       // origIdx -> [items]
    scale: 1.25,
    tool: "select",
    selectedId: null,
    pendingSig: null,   // { dataUrl, ratio } waiting to be placed
    sigDataUrl: null    // last drawn signature
  };
  var undoStack = [], redoStack = [];
  var uid = 0;
  function nextId() { return "el" + (++uid); }

  /* ------------------------------------------------------------------ *
   * Tiny DOM helpers
   * ------------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function show(node, yes) { node.classList.toggle("is-hidden", !yes); }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; show(t, true);
    clearTimeout(toast._t); toast._t = setTimeout(function () { show(t, false); }, 2200);
  }

  /* ------------------------------------------------------------------ *
   * License / Pro gate
   * ------------------------------------------------------------------ */
  function loadLicense() {
    try { return JSON.parse(localStorage.getItem(LICENSE_KEY_STORE) || "null"); }
    catch (e) { return null; }
  }
  function saveLicense(lic) { localStorage.setItem(LICENSE_KEY_STORE, JSON.stringify(lic)); }
  function isPro() { var l = loadLicense(); return !!(l && l.valid); }

  // Returns a Promise so an online check can be added without changing callers.
  function activateLicense(key) {
    key = (key || "").trim();
    if (!key) return Promise.resolve({ ok: false, msg: "Enter your license key." });
    if (GUMROAD_PRODUCT_ID || GUMROAD_API_PRODUCT_ID) {
      return verifyWithGumroad(key).then(function (res) {
        if (res.ok) { saveLicense({ key: key, valid: true, at: Date.now() }); }
        return res;
      });
    }
    // No product configured yet (POC): accept any non-empty key locally so the
    // Pro flow is demonstrable. Swap in Gumroad verify by setting the config vars.
    saveLicense({ key: key, valid: true, at: Date.now(), local: true });
    return Promise.resolve({ ok: true, msg: "Activated (local POC mode)." });
  }

  function verifyWithGumroad(key) {
    var body = new URLSearchParams();
    if (GUMROAD_API_PRODUCT_ID) body.set("product_id", GUMROAD_API_PRODUCT_ID);
    else body.set("product_permalink", GUMROAD_PRODUCT_ID);
    body.set("license_key", key);
    body.set("increment_uses_count", "false");
    return fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.success) return { ok: false, msg: "Invalid license key." };
        var p = data.purchase || {};
        if (p.refunded || p.chargebacked || p.disputed)
          return { ok: false, msg: "This license was refunded or disputed." };
        return { ok: true, msg: "Activated. Watermark removed." };
      })
      .catch(function () { return { ok: false, msg: "Could not verify right now. Try again." }; });
  }

  function deactivate() {
    localStorage.removeItem(LICENSE_KEY_STORE);
    refreshProUI(); renderAll();
    toast("Pro removed from this browser.");
  }

  function refreshProUI() {
    var pro = isPro();
    show($("proStatus"), pro);
    show($("getProBtn"), !pro);
    show($("deactivateBtn"), pro);
    $("proPrice").textContent = PRO_PRICE;
    var buy = $("buyLink");
    buy.setAttribute("href", GUMROAD_BUY_URL || "#");
    $("getProBtn").textContent = "Get Pro — " + PRO_PRICE;
  }

  /* ------------------------------------------------------------------ *
   * History (undo / redo)
   * ------------------------------------------------------------------ */
  function snapshot() {
    return JSON.stringify({
      pageOrder: state.pageOrder,
      rotations: state.rotations,
      overlays: state.overlays
    });
  }
  function pushHistory() { undoStack.push(snapshot()); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
  function applySnap(s) {
    var o = JSON.parse(s);
    state.pageOrder = o.pageOrder; state.rotations = o.rotations; state.overlays = o.overlays;
    state.selectedId = null; renderAll();
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); applySnap(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); applySnap(redoStack.pop()); }

  /* ------------------------------------------------------------------ *
   * Open a PDF
   * ------------------------------------------------------------------ */
  function openFile(file) {
    if (!file || file.type !== "application/pdf") { toast("Please choose a PDF file."); return; }
    var reader = new FileReader();
    reader.onload = function (e) {
      var buf = e.target.result;
      state.origBytes = buf.slice(0); // keep a copy for pdf-lib
      pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise.then(function (doc) {
        state.pdfjsDoc = doc;
        state.pageOrder = [];
        state.rotations = {};
        state.overlays = {};
        for (var i = 0; i < doc.numPages; i++) { state.pageOrder.push(i); state.overlays[i] = []; }
        undoStack.length = 0; redoStack.length = 0;
        show($("dropzone"), false);
        show($("pageWrap"), true);
        show($("sidebar"), true);
        show($("toolbar"), true);
        setTool("select");
        renderAll();
        toast("Loaded " + doc.numPages + " page(s).");
      }).catch(function (err) {
        console.error(err); toast("Could not open this PDF.");
      });
    };
    reader.readAsArrayBuffer(file);
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  function renderAll() {
    renderPages();
    renderThumbs();
    $("zoomLabel").textContent = Math.round(state.scale * 100) + "%";
  }

  function renderPages() {
    var stack = $("pageStack");
    stack.innerHTML = "";
    state.pageOrder.forEach(function (origIdx, displayIdx) {
      var holder = el("div", "page-holder");
      holder.dataset.orig = origIdx;
      var canvas = el("canvas");
      holder.appendChild(canvas);
      var overlay = el("div", "overlay");
      holder.appendChild(overlay);
      stack.appendChild(holder);

      state.pdfjsDoc.getPage(origIdx + 1).then(function (page) {
        var viewport = page.getViewport({ scale: state.scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        holder.style.width = viewport.width + "px";
        holder.style.height = viewport.height + "px";
        page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport });
        drawOverlayItems(overlay, origIdx, viewport.width, viewport.height);
        wirePageInteractions(holder, overlay, origIdx);
        // rotation badge (rotation is applied on export)
        if (state.rotations[origIdx]) {
          var b = el("div");
          b.textContent = "⟳ exports rotated " + state.rotations[origIdx] + "°";
          b.style.cssText = "position:absolute;top:6px;left:6px;background:#fef3c7;color:#92400e;font-size:11px;padding:2px 6px;border-radius:6px;";
          overlay.appendChild(b);
        }
      });
    });
  }

  function drawOverlayItems(overlay, origIdx, w, h) {
    (state.overlays[origIdx] || []).forEach(function (item) {
      var node = buildItemNode(item, origIdx, w, h);
      overlay.appendChild(node);
    });
  }

  function buildItemNode(item, origIdx, w, h) {
    var node = el("div", "ov-item ov-" + item.type);
    node.dataset.id = item.id;
    node.style.left = (item.fx * w) + "px";
    node.style.top = (item.fy * h) + "px";
    if (item.type === "text") {
      node.classList.add("ov-text");
      node.style.fontSize = (item.size * state.scale) + "px";
      node.style.color = item.color;
      node.contentEditable = "true";
      node.textContent = item.text;
      node.addEventListener("input", function () { item.text = node.textContent; });
      node.addEventListener("blur", function () { item.text = node.textContent; pushHistory(); });
    } else if (item.type === "highlight") {
      node.style.width = (item.fw * w) + "px";
      node.style.height = (item.fh * h) + "px";
      node.style.background = hexToRgba(item.color, 0.4);
    } else if (item.type === "img") {
      node.style.width = (item.fw * w) + "px";
      node.style.height = (item.fh * h) + "px";
      var image = new Image(); image.src = item.dataUrl;
      node.appendChild(image);
    }
    var del = el("button", "ov-del"); del.textContent = "×";
    del.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
    del.addEventListener("click", function (ev) {
      ev.stopPropagation();
      pushHistory();
      state.overlays[origIdx] = state.overlays[origIdx].filter(function (x) { return x.id !== item.id; });
      renderPages();
    });
    node.appendChild(del);
    if (item.id === state.selectedId) node.classList.add("is-selected");
    return node;
  }

  function renderThumbs() {
    var box = $("thumbs");
    box.innerHTML = "";
    state.pageOrder.forEach(function (origIdx, displayIdx) {
      var t = el("div", "thumb");
      t.dataset.display = displayIdx;
      var canvas = el("canvas");
      t.appendChild(canvas);
      var num = el("div", "thumb__num"); num.textContent = (displayIdx + 1); t.appendChild(num);

      var ops = el("div", "thumb__ops");
      ops.appendChild(makeOp("↑", "Move up", function (e) { e.stopPropagation(); movePage(displayIdx, -1); }));
      ops.appendChild(makeOp("↓", "Move down", function (e) { e.stopPropagation(); movePage(displayIdx, 1); }));
      ops.appendChild(makeOp("⟳", "Rotate 90°", function (e) { e.stopPropagation(); rotatePage(origIdx); }));
      ops.appendChild(makeOp("🗑", "Delete page", function (e) { e.stopPropagation(); deletePage(displayIdx); }));
      t.appendChild(ops);

      t.addEventListener("click", function () { scrollToPage(displayIdx); });
      box.appendChild(t);

      state.pdfjsDoc.getPage(origIdx + 1).then(function (page) {
        var vp = page.getViewport({ scale: 0.28 });
        canvas.width = vp.width; canvas.height = vp.height;
        page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
      });
    });
  }
  function makeOp(txt, title, fn) {
    var b = el("button", "thumb__op"); b.textContent = txt; b.title = title;
    b.addEventListener("click", fn); return b;
  }

  function scrollToPage(displayIdx) {
    var holders = $("pageStack").children;
    if (holders[displayIdx]) holders[displayIdx].scrollIntoView({ behavior: "smooth", block: "start" });
    [].forEach.call($("thumbs").children, function (t, i) { t.classList.toggle("is-active", i === displayIdx); });
  }

  /* ------------------------------------------------------------------ *
   * Page operations
   * ------------------------------------------------------------------ */
  function movePage(displayIdx, dir) {
    var to = displayIdx + dir;
    if (to < 0 || to >= state.pageOrder.length) return;
    pushHistory();
    var arr = state.pageOrder;
    var tmp = arr[displayIdx]; arr[displayIdx] = arr[to]; arr[to] = tmp;
    renderAll();
  }
  function rotatePage(origIdx) {
    pushHistory();
    state.rotations[origIdx] = ((state.rotations[origIdx] || 0) + 90) % 360;
    renderPages();
  }
  function deletePage(displayIdx) {
    if (state.pageOrder.length <= 1) { toast("A PDF needs at least one page."); return; }
    pushHistory();
    state.pageOrder.splice(displayIdx, 1);
    renderAll();
  }

  /* ------------------------------------------------------------------ *
   * Tools + page interactions
   * ------------------------------------------------------------------ */
  function setTool(name) {
    state.tool = name;
    [].forEach.call(document.querySelectorAll(".tool"), function (b) {
      b.classList.toggle("is-active", b.dataset.tool === name);
    });
    if (name === "signature" && !state.sigDataUrl) openSigModal();
    if (name === "signature" && state.sigDataUrl) state.pendingSig = { dataUrl: state.sigDataUrl };
  }

  function selectItem(id) {
    state.selectedId = id;
    [].forEach.call(document.querySelectorAll(".ov-item"), function (n) {
      n.classList.toggle("is-selected", n.dataset.id === id);
    });
  }

  function wirePageInteractions(holder, overlay, origIdx) {
    var w = holder.offsetWidth, h = holder.offsetHeight;

    // Placing / drawing on the page background
    overlay.addEventListener("mousedown", function (ev) {
      if (ev.target !== overlay) return; // clicked an existing item
      var rect = holder.getBoundingClientRect();
      var fx = (ev.clientX - rect.left) / rect.width;
      var fy = (ev.clientY - rect.top) / rect.height;

      if (state.tool === "select") { selectItem(null); return; }

      if (state.tool === "text") {
        pushHistory();
        var item = { id: nextId(), type: "text", fx: fx, fy: fy,
          size: parseInt($("sizePicker").value, 10) || 16,
          color: $("colorPicker").value, text: "Text" };
        state.overlays[origIdx].push(item);
        renderPages();
        // focus the new node for immediate typing
        setTimeout(function () {
          var n = document.querySelector('.ov-item[data-id="' + item.id + '"]');
          if (n) { selectItem(item.id); n.focus(); document.execCommand && document.execCommand("selectAll", false, null); }
        }, 0);
        return;
      }

      if (state.tool === "highlight") {
        drawRectDrag(ev, holder, function (r) {
          if (r.fw < 0.01 || r.fh < 0.01) return;
          pushHistory();
          state.overlays[origIdx].push({ id: nextId(), type: "highlight",
            fx: r.fx, fy: r.fy, fw: r.fw, fh: r.fh, color: $("colorPicker").value });
          renderPages();
        });
        return;
      }

      if (state.tool === "signature" && state.pendingSig) {
        placeSignature(origIdx, fx, fy);
        return;
      }
    });

    // Dragging existing items (select tool)
    overlay.addEventListener("mousedown", function (ev) {
      var node = ev.target.closest ? ev.target.closest(".ov-item") : null;
      if (!node || node.parentNode !== overlay) return;
      var id = node.dataset.id;
      var item = findItem(origIdx, id);
      if (!item) return;
      selectItem(id);
      // Let text editing happen: don't drag if already focused (editing)
      if (item.type === "text" && document.activeElement === node) return;

      var rect = holder.getBoundingClientRect();
      var startX = ev.clientX, startY = ev.clientY, moved = false;
      var startFx = item.fx, startFy = item.fy;

      function onMove(e) {
        var dx = (e.clientX - startX) / rect.width;
        var dy = (e.clientY - startY) / rect.height;
        if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) moved = true;
        if (!moved) return;
        if (item.type === "text" && document.activeElement === node) return;
        ev.preventDefault();
        item.fx = Math.max(0, Math.min(1, startFx + dx));
        item.fy = Math.max(0, Math.min(1, startFy + dy));
        node.style.left = (item.fx * rect.width) + "px";
        node.style.top = (item.fy * rect.height) + "px";
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (moved) pushHistory();
        else if (item.type === "text") node.focus(); // click without move => edit
      }
      if (!(item.type === "text" && document.activeElement === node)) ev.preventDefault();
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function drawRectDrag(startEv, holder, done) {
    var rect = holder.getBoundingClientRect();
    var x0 = (startEv.clientX - rect.left), y0 = (startEv.clientY - rect.top);
    var ghost = el("div"); ghost.style.cssText =
      "position:absolute;border:1px dashed #2563eb;background:rgba(37,99,235,.12);pointer-events:none;";
    holder.querySelector(".overlay").appendChild(ghost);
    function mv(e) {
      var x1 = e.clientX - rect.left, y1 = e.clientY - rect.top;
      ghost.style.left = Math.min(x0, x1) + "px";
      ghost.style.top = Math.min(y0, y1) + "px";
      ghost.style.width = Math.abs(x1 - x0) + "px";
      ghost.style.height = Math.abs(y1 - y0) + "px";
    }
    function up(e) {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      var x1 = e.clientX - rect.left, y1 = e.clientY - rect.top;
      ghost.remove();
      done({
        fx: Math.min(x0, x1) / rect.width,
        fy: Math.min(y0, y1) / rect.height,
        fw: Math.abs(x1 - x0) / rect.width,
        fh: Math.abs(y1 - y0) / rect.height
      });
    }
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  }

  function findItem(origIdx, id) {
    return (state.overlays[origIdx] || []).filter(function (x) { return x.id === id; })[0];
  }

  function placeSignature(origIdx, fx, fy) {
    // The signature pad is 440x180; keep that aspect as fractions of the page box.
    // On-screen and export both use these fractions, so they stay consistent.
    var fw = 0.28, fh = fw * (180 / 440);
    pushHistory();
    state.overlays[origIdx].push({ id: nextId(), type: "img",
      fx: Math.max(0, fx - fw / 2), fy: Math.max(0, fy - fh / 2),
      fw: fw, fh: fh, dataUrl: state.pendingSig.dataUrl });
    renderPages();
  }

  /* ------------------------------------------------------------------ *
   * Signature pad
   * ------------------------------------------------------------------ */
  function openSigModal() { show($("sigModal"), true); initSigPad(); }
  function initSigPad() {
    var c = $("sigPad"), ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#0f172a";
    var drawing = false, last = null;
    function pos(e) {
      var r = c.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (c.width / r.width), y: (p.clientY - r.top) * (c.height / r.height) };
    }
    function start(e) { drawing = true; last = pos(e); e.preventDefault(); }
    function move(e) { if (!drawing) return; var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; e.preventDefault(); }
    function end() { drawing = false; }
    c.onmousedown = start; c.onmousemove = move; c.onmouseup = end; c.onmouseleave = end;
    c.ontouchstart = start; c.ontouchmove = move; c.ontouchend = end;
    initSigPad._canvas = c;
  }

  /* ------------------------------------------------------------------ *
   * Export via pdf-lib
   * ------------------------------------------------------------------ */
  function download() {
    if (!state.origBytes) { toast("Open a PDF first."); return; }
    toast("Building your PDF…");
    buildPdf().then(function (bytes) {
      var blob = new Blob([bytes], { type: "application/pdf" });
      var a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = "edited.pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }).catch(function (err) { console.error(err); toast("Export failed."); });
  }

  function buildPdf() {
    var rgb = PDFLib.rgb, degrees = PDFLib.degrees, StandardFonts = PDFLib.StandardFonts;
    return PDFLib.PDFDocument.load(state.origBytes).then(function (src) {
      return PDFLib.PDFDocument.create().then(function (out) {
        return out.embedFont(StandardFonts.Helvetica).then(function (font) {
          return out.copyPages(src, state.pageOrder).then(function (pages) {
            var chain = Promise.resolve();
            pages.forEach(function (page, i) {
              var origIdx = state.pageOrder[i];
              out.addPage(page);
              var size = page.getSize();
              var w = size.width, h = size.height;

              (state.overlays[origIdx] || []).forEach(function (item) {
                if (item.type === "text") {
                  var c = hexToRgb01(item.color);
                  page.drawText(item.text || "", {
                    x: item.fx * w,
                    y: h - item.fy * h - item.size,
                    size: item.size, font: font,
                    color: rgb(c.r, c.g, c.b),
                    lineHeight: item.size * 1.15
                  });
                } else if (item.type === "highlight") {
                  var hc = hexToRgb01(item.color);
                  page.drawRectangle({
                    x: item.fx * w, y: h - (item.fy + item.fh) * h,
                    width: item.fw * w, height: item.fh * h,
                    color: rgb(hc.r, hc.g, hc.b), opacity: 0.4
                  });
                } else if (item.type === "img") {
                  chain = chain.then(function () {
                    return embedDataUrl(out, item.dataUrl).then(function (png) {
                      page.drawImage(png, {
                        x: item.fx * w, y: h - (item.fy + item.fh) * h,
                        width: item.fw * w, height: item.fh * h
                      });
                    });
                  });
                }
              });

              if (state.rotations[origIdx]) page.setRotation(degrees(state.rotations[origIdx]));

              // Free watermark stamp (Pro removes it)
              if (!isPro()) {
                chain = chain.then(function () {
                  page.drawText("Made with PDF Editor Pro — Free version", {
                    x: w * 0.14, y: h * 0.5, size: Math.max(14, w * 0.03),
                    font: font, color: rgb(0.6, 0.6, 0.6), rotate: degrees(35), opacity: 0.25
                  });
                });
              }
            });
            return chain.then(function () { return out.save(); });
          });
        });
      });
    });
  }

  function embedDataUrl(doc, dataUrl) {
    var isPng = /^data:image\/png/i.test(dataUrl);
    var bytes = dataUrlToBytes(dataUrl);
    return isPng ? doc.embedPng(bytes) : doc.embedJpg(bytes);
  }
  function dataUrlToBytes(dataUrl) {
    var b = atob(dataUrl.split(",")[1]);
    var arr = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
    return arr;
  }

  /* ------------------------------------------------------------------ *
   * Color helpers
   * ------------------------------------------------------------------ */
  function hexToRgb01(hex) {
    var n = parseInt((hex || "#000000").slice(1), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }
  function hexToRgba(hex, a) {
    var c = hexToRgb01(hex);
    return "rgba(" + Math.round(c.r * 255) + "," + Math.round(c.g * 255) + "," + Math.round(c.b * 255) + "," + a + ")";
  }

  /* ------------------------------------------------------------------ *
   * Wire up UI
   * ------------------------------------------------------------------ */
  function init() {
    if (!window.pdfjsLib || !window.PDFLib) {
      toast("PDF libraries failed to load (check your connection).");
    }
    refreshProUI();

    // Open
    $("openBtn").addEventListener("click", function () { $("fileInput").click(); });
    $("openBtn2").addEventListener("click", function () { $("fileInput").click(); });
    $("fileInput").addEventListener("change", function (e) { if (e.target.files[0]) openFile(e.target.files[0]); });

    // Drag & drop
    var dz = $("dropzone");
    ["dragenter", "dragover"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("is-drag"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("is-drag"); });
    });
    dz.addEventListener("drop", function (e) { if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]); });

    // Tools
    [].forEach.call(document.querySelectorAll(".tool"), function (b) {
      b.addEventListener("click", function () { setTool(b.dataset.tool); });
    });

    // Zoom
    $("zoomIn").addEventListener("click", function () { state.scale = Math.min(3, state.scale + 0.15); renderAll(); });
    $("zoomOut").addEventListener("click", function () { state.scale = Math.max(0.4, state.scale - 0.15); renderAll(); });

    // Undo/redo
    $("undoBtn").addEventListener("click", undo);
    $("redoBtn").addEventListener("click", redo);

    // Download
    $("downloadBtn").addEventListener("click", download);

    // Signature modal
    $("sigCancel").addEventListener("click", function () { show($("sigModal"), false); setTool("select"); });
    $("sigClear").addEventListener("click", function () { initSigPad(); });
    $("sigUse").addEventListener("click", function () {
      var c = $("sigPad");
      state.sigDataUrl = c.toDataURL("image/png");
      state.pendingSig = { dataUrl: state.sigDataUrl };
      show($("sigModal"), false);
      toast("Now click on the page to place your signature.");
    });

    // Pro modal
    $("getProBtn").addEventListener("click", function () { show($("proModal"), true); });
    $("proClose").addEventListener("click", function () { show($("proModal"), false); });
    $("activateBtn").addEventListener("click", function () {
      var msg = $("licenseMsg"); msg.className = "license-msg"; msg.textContent = "Checking…";
      activateLicense($("licenseInput").value).then(function (res) {
        msg.textContent = res.msg;
        msg.classList.add(res.ok ? "ok" : "err");
        if (res.ok) { refreshProUI(); renderAll(); setTimeout(function () { show($("proModal"), false); }, 900); }
      });
    });
    $("deactivateBtn").addEventListener("click", deactivate);

    // Keyboard shortcuts
    document.addEventListener("keydown", function (e) {
      if (e.target.isContentEditable || e.target.tagName === "INPUT") {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if (e.key === "v") setTool("select");
      else if (e.key === "t") setTool("text");
      else if (e.key === "h") setTool("highlight");
      else if (e.key === "s") setTool("signature");
      else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
        Object.keys(state.overlays).forEach(function (k) {
          state.overlays[k] = state.overlays[k].filter(function (x) { return x.id !== state.selectedId; });
        });
        state.selectedId = null; pushHistory(); renderPages();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
