/* 3D view, kept deliberately separate from graph.js.
   The 2D canvas renderer is the thing people actually use; it should not carry
   a 1.3MB WebGL dependency in its critical path, and it should not break if the
   3D library changes under it. So this module owns the whole 3D lifecycle and
   the vendor script is fetched only when someone first switches to 3D. */
(function (global) {
  "use strict";

  var SCRIPT = "static/vendor/3d-force-graph.min.js";
  var STORE_KEY = "sb-graph:3d";
  var DEFAULTS = { nodeSize: 1, linkOpacity: 0.35 };
  var loading = null;

  /* The 3D panel says settings are saved in this browser, same as the 2D one,
     so they have to actually be. */
  function loadParams() {
    var out = Object.assign({}, DEFAULTS);
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      if (raw) {
        var got = JSON.parse(raw);
        for (var k in DEFAULTS) if (typeof got[k] === "number") out[k] = got[k];
      }
    } catch (e) { /* corrupt or blocked storage is not worth failing over */ }
    return out;
  }

  function saveParams(P) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORE_KEY, JSON.stringify(P));
    } catch (e) { /* non-fatal */ }
  }

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
      fg: v("--fg", "#23262b"),
      link: v("--link", "#b9bfc9"),
      muted: v("--muted", "#6b7280")
    };
  }

  /* opts: { container, sbUrl, folderColour } */
  function Graph3D(opts) {
    var el = typeof opts.container === "string"
      ? document.querySelector(opts.container) : opts.container;
    var fg = null;
    var current = { nodes: [], links: [] };
    var destroyed = false;
    var fitPending = true;
    var active = false;

    // View settings that belong to 3D alone. Labels are deliberately NOT here:
    // one label setting drives both views, so the toolbar button means the same
    // thing wherever you press it.
    var P = loadParams();
    var labels = { mode: "auto", density: 0, rank: "depth" };
    var fitDist = 0;      // camera distance at the fitted view; the LOD reference
    var centre = { x: 0, y: 0, z: 0 };
    var query = "";
    var miss = null;          // null = no query; otherwise ids that do not match

    /* ---- label overlay -------------------------------------------------
       The bundle exports only ForceGraph3D, not the THREE namespace it embeds,
       so there is no way to build text sprites from here. Projecting node
       positions onto a plain 2D canvas laid over the WebGL one gets the same
       result, costs no extra dependency, and reuses the 2D view's typography
       and theme colours. */
    var over = document.createElement("canvas");
    over.className = "g3d-labels";
    var octx = over.getContext("2d");
    var rafId = 0;
    var camDir = null;        // reused THREE.Vector3, cloned off the camera

    function overlaySize() {
      var r = el.getBoundingClientRect();
      var dpr = global.devicePixelRatio || 1;
      var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (over.width !== w * dpr || over.height !== h * dpr) {
        over.width = w * dpr; over.height = h * dpr;
        over.style.width = w + "px"; over.style.height = h + "px";
      }
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    function drawLabels() {
      var size = overlaySize();
      octx.clearRect(0, 0, size.w, size.h);
      if (!fg || labels.mode === "off") return;

      var cam = fg.camera();
      if (!cam || !cam.position) return;
      // getWorldDirection needs a THREE.Vector3 to write into and we have no
      // constructor, so borrow one by cloning the camera's own position vector.
      if (!camDir) camDir = cam.position.clone();
      cam.getWorldDirection(camDir);
      var cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;

      var showAll = labels.mode === "all";
      // 3D has no single zoom factor, so distance from the camera stands in for
      // one: half the fitted distance reads as twice the zoom, measured against
      // the same fitted reference the 2D view uses.
      //
      // The distance is taken **per node**, not from the camera to the graph as
      // a whole. That is the difference between a 3D view and a 2D one: flying
      // into a cluster brings you close to a handful of nodes and no closer to
      // the rest, so a shared threshold would label the entire far side of the
      // graph at the same time and bury the thing you flew in to read. Here a
      // node you have come close to labels itself, and a distant one stays
      // silent unless it is high enough in the hierarchy to earn a label from
      // far away.
      var out = [], i, n, d;
      for (i = 0; i < current.nodes.length; i++) {
        n = current.nodes[i];
        if (n.x === undefined) continue;                       // not laid out yet
        if (miss && miss[n.id]) continue;
        var ex = n.x - cx, ey = n.y - cy, ez = n.z - cz;
        // Depth along the view axis. Negative means the node is behind the
        // camera, where projection mirrors it to a plausible-looking but wrong
        // screen position.
        d = ex * camDir.x + ey * camDir.y + ez * camDir.z;
        if (d <= 0) continue;
        if (!showAll) {
          // True distance to this node, not its depth along the view axis: a
          // node off to the side of a close-up shot is further away than the
          // axis suggests, and should label like it.
          var away = Math.hypot(ex, ey, ez);
          var zf = fitDist ? fitDist / Math.max(away, 1e-3) : 1;
          if (n.labelScore > global.SBGraphLOD.level(zf, labels.density)) continue;
        }
        var p = fg.graph2ScreenCoords(n.x, n.y, n.z);
        if (!p || p.x < -60 || p.y < -20 || p.x > size.w + 60 || p.y > size.h + 20) continue;
        out.push({ n: n, x: p.x, y: p.y, d: d });
      }
      if (!out.length) return;

      // Depth cue: near labels solid, far ones faded. Painting far-to-near also
      // means a near label wins any overlap.
      var lo = Infinity, hi = 0;
      for (i = 0; i < out.length; i++) {
        if (out[i].d < lo) lo = out[i].d;
        if (out[i].d > hi) hi = out[i].d;
      }
      var span = (hi - lo) || 1;
      out.sort(function (a, b) { return b.d - a.d; });

      var t = themeColours();
      octx.font = "11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";
      octx.textAlign = "center";
      octx.textBaseline = "bottom";
      octx.lineJoin = "round";
      octx.lineWidth = 3;
      for (i = 0; i < out.length; i++) {
        var o = out[i];
        octx.globalAlpha = 1 - 0.62 * ((o.d - lo) / span);
        // Halo in the background colour: without it, text sitting on a bundle
        // of links is unreadable.
        octx.strokeStyle = t.bg;
        octx.strokeText(o.n.title || o.n.id, o.x, o.y - 6);
        octx.fillStyle = t.fg;
        octx.fillText(o.n.title || o.n.id, o.x, o.y - 6);
      }
      octx.globalAlpha = 1;
    }

    /* The overlay has to repaint on every camera move, and orbiting emits no
       event, so it rides a frame loop. The loop only runs while the 3D view is
       on screen and labels are wanted. */
    function tick() {
      rafId = 0;
      if (destroyed || !active) return;
      drawLabels();
      rafId = global.requestAnimationFrame(tick);
    }
    function startLoop() {
      if (rafId || destroyed || !active) return;
      rafId = global.requestAnimationFrame(tick);
    }
    function stopLoop() {
      if (rafId) { global.cancelAnimationFrame(rafId); rafId = 0; }
      if (octx) {
        var size = overlaySize();
        octx.clearRect(0, 0, size.w, size.h);
      }
    }

    /* ---- appearance ---------------------------------------------------- */
    function colourFor(n) {
      var t = themeColours();
      if (miss && miss[n.id]) return t.link;   // dimmed, not hidden
      if (!n.exists) return t.muted;
      return opts.folderColour ? opts.folderColour(n.folder) : "#7c9fe8";
    }

    function valFor(n) { return (1 + (n.degree || 0) * 0.6) * P.nodeSize; }

    function start(data) {
      return loadLib().then(function (ForceGraph3D) {
        if (destroyed) return null;
        var t = themeColours();
        fg = ForceGraph3D()(el)
          .backgroundColor(t.bg)
          .showNavInfo(false)
          .nodeLabel(function (n) { return n.id; })
          .nodeColor(colourFor)
          .nodeVal(valFor)
          .nodeOpacity(0.92)
          .linkColor(function () { return t.link; })
          .linkOpacity(P.linkOpacity)
          .linkWidth(0.4)
          .warmupTicks(40)
          .cooldownTime(6000)
          // Frame the graph once the layout settles. Guarded by a flag so a
          // later re-settle does not yank the camera away from wherever the
          // viewer has just orbited to.
          .onEngineStop(function () {
            if (fitPending && fg) { fitPending = false; fit(600); }
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

        // Appended after the library has built its own canvas so it stacks on
        // top without needing a z-index fight.
        el.appendChild(over);
        el.addEventListener("pointerdown", onPointerDown);
        el.addEventListener("pointermove", onPointerMove);
        el.addEventListener("pointerup", onPointerUp);
        el.addEventListener("pointercancel", onPointerUp);
        setData(data);
        resize();
        startLoop();
        return fg;
      });
    }

    /* The library mutates the objects it is given (it writes x/y/z and swaps
       link endpoints for node references), so hand it copies. Sharing the 2D
       view's arrays would corrupt them. */
    function setData(data) {
      current = {
        nodes: global.SBGraphLOD.assign(
          (data.nodes || []).map(function (n) { return Object.assign({}, n); }),
          labels.rank),
        links: (data.links || []).map(function (l) {
          return { source: l.source, target: l.target, unresolved: l.unresolved };
        })
      };
      applyQuery();
      if (fg) fg.graphData(current);
    }

    function applyQuery() {
      if (!query) { miss = null; return; }
      miss = {};
      for (var i = 0; i < current.nodes.length; i++) {
        var n = current.nodes[i];
        if (n.id.toLowerCase().indexOf(query) === -1) miss[n.id] = true;
      }
    }

    function setQuery(q) {
      query = (q || "").trim().toLowerCase();
      applyQuery();
      if (fg) fg.nodeColor(colourFor);   // reassigning the accessor repaints
    }

    function setParam(key, value) {
      if (!(key in P)) return;
      P[key] = value;
      saveParams(P);
      applyParams();
    }

    function applyParams() {
      if (!fg) return;
      fg.nodeVal(valFor).linkOpacity(P.linkOpacity);
    }

    function params() { return Object.assign({}, P); }

    function resetParams() {
      P = Object.assign({}, DEFAULTS);
      saveParams(P);
      applyParams();
    }

    /* Dragging in 3D pins, and the 2D view's Unpin all cannot reach these
       nodes: they are copies, and they carry an fz the 2D simulation has no
       concept of. */
    function unpinAll() {
      for (var i = 0; i < current.nodes.length; i++) {
        var n = current.nodes[i];
        n.fx = null; n.fy = null; n.fz = null;
      }
      if (fg) fg.d3ReheatSimulation();
    }

    function setLabels(next) {
      if (typeof next.mode === "string") labels.mode = next.mode;
      if (typeof next.density === "number") labels.density = next.density;
      if (typeof next.rank === "string" && next.rank !== labels.rank) {
        labels.rank = next.rank;
        // Rescore in place. The nodes are the library's own objects by now, so
        // replacing them would restart the layout for a labelling change.
        global.SBGraphLOD.assign(current.nodes, labels.rank);
      }
      if (labels.mode !== "off" && active) startLoop(); else stopLoop();
    }

    /* Called when the 3D view comes on or off screen. A hidden container
       measures 0x0, so the overlay must not keep painting into it. */
    function setActive(on) {
      active = !!on;
      if (active) { resize(); if (labels.mode !== "off") startLoop(); }
      else stopLoop();
    }

    /* Re-frame on the next settle. Called when the visible set changes enough
       that the old camera no longer makes sense, e.g. a folder was switched
       off in the legend. */
    function refit() { fitPending = true; }

    /* Frame the graph properly. The library's own zoomToFit is not usable
       here: it measures the extent from the world origin rather than from where
       the graph actually is, and its distance formula divides by atan(fov)
       where the geometry calls for tan(fov/2). On a 372-node space that opened
       the 3D view as a knot of 2px dots in an empty frame.

       Fitting a sphere around the cloud is not enough either. A layout that is
       deep along the view axis has a large 3D radius but a small silhouette, so
       a sphere fit still pulls the camera much too far back. What has to fit is
       the extent perpendicular to where the camera is looking, per point, with
       each point's own depth taken into account.

       The 97th percentile keeps a handful of weakly-linked pages flung out by
       repulsion from dictating the zoom for everything else. They are still
       there; you scroll out to them rather than starting there. */
    function fit(ms) {
      if (!fg) return;
      var pts = [], i, n;
      for (i = 0; i < current.nodes.length; i++) {
        n = current.nodes[i];
        if (typeof n.x === "number") pts.push(n);
      }
      if (pts.length < 3) { fg.zoomToFit(ms, 20); return; }

      var cx = 0, cy = 0, cz = 0;
      for (i = 0; i < pts.length; i++) { cx += pts[i].x; cy += pts[i].y; cz += pts[i].z; }
      cx /= pts.length; cy /= pts.length; cz /= pts.length;

      var cam = fg.camera();
      // Camera basis, derived by hand: the bundle keeps its THREE namespace
      // private, so there are no vector helpers to borrow.
      var fx = cam.position.x - cx, fy = cam.position.y - cy, fz = cam.position.z - cz;
      var fl = Math.hypot(fx, fy, fz);
      if (!fl) { fx = 0; fy = 0; fz = 1; fl = 1; }
      fx /= fl; fy /= fl; fz /= fl;

      // right = worldUp x forward, falling back when the camera looks straight
      // down and that cross product collapses.
      var rx = fz, ry = 0, rz = -fx;
      var rl = Math.hypot(rx, ry, rz);
      if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; rl = 1; }
      rx /= rl; ry /= rl; rz /= rl;
      var ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;

      var tV = Math.tan(((cam.fov || 50) * Math.PI / 180) / 2);
      var tH = tV * (cam.aspect || 1);

      var need = [];
      for (i = 0; i < pts.length; i++) {
        var dx = pts[i].x - cx, dy = pts[i].y - cy, dz = pts[i].z - cz;
        var pf = dx * fx + dy * fy + dz * fz;    // toward the camera
        var pr = dx * rx + dy * ry + dz * rz;
        var pu = dx * ux + dy * uy + dz * uz;
        // Distance at which this point lands exactly on the frame edge.
        need.push(Math.max(Math.abs(pr) / tH, Math.abs(pu) / tV) + pf);
      }
      need.sort(function (a, b) { return a - b; });
      var dist = need[Math.min(need.length - 1, Math.floor(need.length * 0.97))];
      if (!(dist > 0)) dist = need[need.length - 1];
      if (!(dist > 0)) { fg.zoomToFit(ms, 20); return; }
      dist *= 1.08;   // a margin, rather than pressing nodes against the edge

      // Reference point for the label tiers: this distance is "fitted", and
      // the LOD threshold moves as the camera closes on or backs away from it.
      fitDist = dist;
      centre = { x: cx, y: cy, z: cz };
      fg.cameraPosition({
        x: cx + fx * dist, y: cy + fy * dist, z: cz + fz * dist
      }, centre, ms);
    }

    /* ---- camera driving ------------------------------------------------
       TrackballControls gives mouse verbs only: left-drag rotates, right-drag
       pans, the wheel zooms. There is no keyboard and there are no programmatic
       nudges, so buttons and keys have to move the camera directly. Each of
       these edits camera.position and the controls' own target, then lets the
       controls re-derive their internal state, which is the supported way to
       move a trackball camera from outside. */
    function ctrls() {
      try { return fg && fg.controls ? fg.controls() : null; } catch (e) { return null; }
    }

    function target() {
      var c = ctrls();
      return (c && c.target) ? c.target : centre;
    }

    // Rodrigues rotation. No THREE namespace to borrow a quaternion from.
    function rotAbout(v, ax, ang) {
      var c = Math.cos(ang), s = Math.sin(ang);
      var dot = v.x * ax.x + v.y * ax.y + v.z * ax.z;
      return {
        x: v.x * c + (ax.y * v.z - ax.z * v.y) * s + ax.x * dot * (1 - c),
        y: v.y * c + (ax.z * v.x - ax.x * v.z) * s + ax.y * dot * (1 - c),
        z: v.z * c + (ax.x * v.y - ax.y * v.x) * s + ax.z * dot * (1 - c)
      };
    }

    function norm(v) {
      var l = Math.hypot(v.x, v.y, v.z) || 1;
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    }

    function commit() {
      var c = ctrls();
      if (c && c.update) { try { c.update(); } catch (e) { /* mid-teardown */ } }
    }

    /* Orbit by whole degrees. Yaw turns about the camera's own up vector, so
       the horizon stays level; pitch turns about the screen-right axis and is
       clamped short of the poles, where the offset would line up with the up
       vector and the yaw axis would become undefined. */
    function orbit(yawDeg, pitchDeg) {
      if (!fg) return;
      var cam = fg.camera(), t = target();
      var off = { x: cam.position.x - t.x, y: cam.position.y - t.y, z: cam.position.z - t.z };
      var up = norm(cam.up || { x: 0, y: 1, z: 0 });

      if (yawDeg) off = rotAbout(off, up, yawDeg * Math.PI / 180);

      if (pitchDeg) {
        var f = norm({ x: -off.x, y: -off.y, z: -off.z });
        var right = norm({
          x: f.y * up.z - f.z * up.y,
          y: f.z * up.x - f.x * up.z,
          z: f.x * up.y - f.y * up.x
        });
        var next = rotAbout(off, right, pitchDeg * Math.PI / 180);
        var n = norm(next);
        // cos of the angle to the up axis; stop about 10 degrees short of it.
        var cosUp = n.x * up.x + n.y * up.y + n.z * up.z;
        if (Math.abs(cosUp) < 0.985) off = next;
      }

      cam.position.x = t.x + off.x;
      cam.position.y = t.y + off.y;
      cam.position.z = t.z + off.z;
      commit();
    }

    /* Pan in fractions of the viewport, so a press moves the same apparent
       amount whether you are far out or right up against a node. */
    function pan(fx, fy) {
      if (!fg) return;
      var cam = fg.camera(), t = target();
      var off = { x: cam.position.x - t.x, y: cam.position.y - t.y, z: cam.position.z - t.z };
      var dist = Math.hypot(off.x, off.y, off.z) || 1;
      var up = norm(cam.up || { x: 0, y: 1, z: 0 });
      var f = norm({ x: -off.x, y: -off.y, z: -off.z });
      var right = norm({
        x: f.y * up.z - f.z * up.y,
        y: f.z * up.x - f.x * up.z,
        z: f.x * up.y - f.y * up.x
      });
      var trueUp = {
        x: right.y * f.z - right.z * f.y,
        y: right.z * f.x - right.x * f.z,
        z: right.x * f.y - right.y * f.x
      };
      var span = 2 * Math.tan(((cam.fov || 50) * Math.PI / 180) / 2) * dist;
      var dx = right.x * fx * span + trueUp.x * fy * span;
      var dy = right.y * fx * span + trueUp.y * fy * span;
      var dz = right.z * fx * span + trueUp.z * fy * span;
      cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
      if (t !== centre) { t.x += dx; t.y += dy; t.z += dz; }
      commit();
    }

    /* factor < 1 moves in. Floored so repeated presses cannot land the camera
       exactly on the target, where the view direction becomes undefined. */
    function dolly(factor) {
      if (!fg) return;
      var cam = fg.camera(), t = target();
      var off = { x: cam.position.x - t.x, y: cam.position.y - t.y, z: cam.position.z - t.z };
      var dist = Math.hypot(off.x, off.y, off.z);
      if (!dist) return;
      var next = Math.max(dist * factor, 1);
      var k = next / dist;
      cam.position.x = t.x + off.x * k;
      cam.position.y = t.y + off.y * k;
      cam.position.z = t.z + off.z * k;
      commit();
    }

    /* Shift-drag pans.
       TrackballControls does not offer this: its modifier keys are A to force
       rotate, S to zoom and D to pan, and Shift means nothing to it. But the
       keyboard bindings here already read Shift as "pan", so Shift-drag doing
       nothing was a hole in a convention this code invented.

       Rather than fight the controls for the same drag, disable them for the
       duration and run the pan directly. Restoring on pointerup rather than on
       Shift being released keeps a gesture whole: letting go of the modifier
       mid-drag should not hand the camera back to the rotator halfway. */
    var panDrag = null;

    function onPointerDown(e) {
      if (!fg || e.button !== 0 || !e.shiftKey || panDrag) return;
      var c = ctrls();
      if (!c) return;
      panDrag = { x: e.clientX, y: e.clientY, wasEnabled: c.enabled !== false };
      c.enabled = false;
      e.preventDefault();
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) {} }
    }

    function onPointerMove(e) {
      if (!panDrag) return;
      var h = el.getBoundingClientRect().height || 1;
      // Height for both axes: pan() measures its fractions against the vertical
      // world span, so using width for x would make horizontal drags track the
      // cursor at the wrong rate on any non-square viewport.
      pan(-(e.clientX - panDrag.x) / h, (e.clientY - panDrag.y) / h);
      panDrag.x = e.clientX;
      panDrag.y = e.clientY;
    }

    function onPointerUp(e) {
      if (!panDrag) return;
      var c = ctrls();
      if (c) c.enabled = panDrag.wasEnabled;
      if (el.releasePointerCapture) { try { el.releasePointerCapture(e.pointerId); } catch (err) {} }
      panDrag = null;
    }

    /* Re-frame right now, for the toolbar's Fit view button: waiting for a
       settle that may never come again would make the button look broken. */
    function fitNow() { fit(600); }

    function resize() {
      if (!fg || !el) return;
      var r = el.getBoundingClientRect();
      if (r.width && r.height) fg.width(r.width).height(r.height);
      overlaySize();
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
      stopLoop();
      if (el) {
        el.removeEventListener("pointerdown", onPointerDown);
        el.removeEventListener("pointermove", onPointerMove);
        el.removeEventListener("pointerup", onPointerUp);
        el.removeEventListener("pointercancel", onPointerUp);
      }
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
      setQuery: setQuery,
      setParam: setParam,
      params: params,
      resetParams: resetParams,
      unpinAll: unpinAll,
      setLabels: setLabels,
      setActive: setActive,
      resize: resize,
      refit: refit,
      fitNow: fitNow,
      orbit: orbit,
      pan: pan,
      dolly: dolly,
      repaintTheme: repaintTheme,
      destroy: destroy,
      isReady: function () { return !!fg; }
    };
  }

  global.Graph3D = Graph3D;
})(window);
