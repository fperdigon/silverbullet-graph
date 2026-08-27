/* 3D view, kept deliberately separate from graph.js.
   The 2D canvas renderer is the thing people actually use; it should not carry
   a 1.3MB WebGL dependency in its critical path, and it should not break if the
   3D library changes under it. So this module owns the whole 3D lifecycle and
   the vendor script is fetched only when someone first switches to 3D. */
(function (global) {
  "use strict";

  var SCRIPT = "static/vendor/3d-force-graph.min.js";
  var loading = null;

  /* Load the vendor bundle once, at most. Returns the same promise to every
     caller so a double-click on the toggle cannot start two downloads. */
  function loadLib() {
    if (global.ForceGraph3D) return Promise.resolve(global.ForceGraph3D);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = SCRIPT + (global.SB_ASSET_V ? "?v=" + global.SB_ASSET_V : "");
      s.async = true;
      s.onload = function () {
        if (global.ForceGraph3D) resolve(global.ForceGraph3D);
        else reject(new Error("3d-force-graph loaded but exported nothing"));
      };
      s.onerror = function () { reject(new Error("could not load " + SCRIPT)); };
      document.head.appendChild(s);
    });
    // A failed load must not poison every later attempt.
    loading.catch(function () { loading = null; });
    return loading;
  }

  function themeColours() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fallback) {
      return (cs.getPropertyValue(name) || "").trim() || fallback;
    }
    return {
      bg: v("--bg", "#ffffff"),
      link: v("--link", "#b9bfc9"),
      muted: v("--muted", "#6b7280")
    };
  }

  /* opts: { container, sbUrl, folderColour, onClose } */
  function Graph3D(opts) {
    var el = typeof opts.container === "string"
      ? document.querySelector(opts.container) : opts.container;
    var fg = null;
    var current = { nodes: [], links: [] };
    var destroyed = false;
    var fitPending = true;

    function colourFor(n) {
      if (!n.exists) return themeColours().muted;
      return opts.folderColour ? opts.folderColour(n.folder) : "#7c9fe8";
    }

    function start(data) {
      return loadLib().then(function (ForceGraph3D) {
        if (destroyed) return null;
        var t = themeColours();
        fg = ForceGraph3D()(el)
          .backgroundColor(t.bg)
          .showNavInfo(false)
          .nodeLabel(function (n) { return n.id; })
          .nodeColor(colourFor)
          .nodeVal(function (n) { return 1 + (n.degree || 0) * 0.6; })
          .nodeOpacity(0.92)
          .linkColor(function () { return t.link; })
          .linkOpacity(0.35)
          .linkWidth(0.4)
          .warmupTicks(40)
          .cooldownTime(6000)
          // Frame the graph once the layout settles. Guarded by a flag so a
          // later re-settle does not yank the camera away from wherever the
          // viewer has just orbited to.
          .onEngineStop(function () {
            if (fitPending && fg) { fitPending = false; fg.zoomToFit(600, 20); }
          })
          .onNodeClick(function (n) {
            // Same behaviour as a click in 2D: open the page in SilverBullet.
            if (!opts.sbUrl || !n || !n.exists) return;
            var url = opts.sbUrl + "/" +
              n.id.split("/").map(encodeURIComponent).join("/");
            global.open(url, "_blank", "noopener");
          })
          // Dragging a node in 3D pins it, which is the same contract the 2D
          // view offers, and the only way to hand-arrange a 3D layout.
          .onNodeDragEnd(function (n) { n.fx = n.x; n.fy = n.y; n.fz = n.z; });

        setData(data);
        resize();
        return fg;
      });
    }

    /* The library mutates the objects it is given (it writes x/y/z and swaps
       link endpoints for node references), so hand it copies. Sharing the 2D
       view's arrays would corrupt them. */
    function setData(data) {
      current = {
        nodes: (data.nodes || []).map(function (n) { return Object.assign({}, n); }),
        links: (data.links || []).map(function (l) {
          return { source: l.source, target: l.target, unresolved: l.unresolved };
        })
      };
      if (fg) fg.graphData(current);
    }

    /* Re-frame on the next settle. Called when the visible set changes enough
       that the old camera no longer makes sense, e.g. a folder was switched
       off in the legend. */
    function refit() { fitPending = true; }

    function resize() {
      if (!fg || !el) return;
      var r = el.getBoundingClientRect();
      if (r.width && r.height) fg.width(r.width).height(r.height);
    }

    function repaintTheme() {
      if (!fg) return;
      var t = themeColours();
      fg.backgroundColor(t.bg)
        .linkColor(function () { return t.link; })
        .nodeColor(colourFor);
    }

    function destroy() {
      destroyed = true;
      if (fg) {
        // _destructor releases the WebGL context. Without it, toggling in and
        // out of 3D leaks a renderer per visit and the browser eventually drops
        // the oldest context, blanking the view.
        try { fg._destructor(); } catch (e) { /* older builds lack it */ }
        fg = null;
      }
      if (el) el.innerHTML = "";
    }

    return {
      start: start,
      setData: setData,
      resize: resize,
      refit: refit,
      repaintTheme: repaintTheme,
      destroy: destroy,
      isReady: function () { return !!fg; }
    };
  }

  global.Graph3D = Graph3D;
})(window);
