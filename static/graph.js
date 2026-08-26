/* sb-graph: Obsidian-style force graph over a SilverBullet space.
 *
 * Canvas renderer. The SVG version created one DOM element per link, which at
 * ~1200 links cost about 21ms a frame. Canvas batches every link into a couple
 * of Path2D strokes instead, and draws nothing at all once the layout settles.
 */
(function (global) {
  "use strict";

  var PALETTE = [
    "#7c9fe8", "#e8a87c", "#8ed6a0", "#d68ec4", "#e8d47c",
    "#7cd6d6", "#c48ee8", "#e88e8e", "#9ee87c", "#8e9ee8"
  ];

  var DEFAULTS = {
    charge: -170,        // repulsion between nodes
    linkDistance: 55,    // preferred edge length
    linkStrength: 0.35,  // how rigidly edges hold that length
    gravity: 0.06,       // pull toward centre; keeps orphans from flying off
    collide: 5,          // extra spacing around each node
    nodeScale: 1,        // node radius multiplier
    labelDegree: 4,      // hide labels below this many links
    showLabels: true,
    showUnresolved: true,
    pinOnDrag: false     // keep a node where you drop it, Obsidian-style release if off
  };

  var STORE_KEY = "sb-graph:params";

  var srcId = function (l) { return typeof l.source === "object" ? l.source.id : l.source; };
  var dstId = function (l) { return typeof l.target === "object" ? l.target.id : l.target; };

  function loadParams() {
    var p = {};
    for (var k in DEFAULTS) p[k] = DEFAULTS[k];
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var j in saved) if (j in DEFAULTS) p[j] = saved[j];
      }
    } catch (e) { /* private mode, corrupt value: defaults are fine */ }
    return p;
  }

  function saveParams(p) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch (e) { /* non-fatal */ }
  }

  function GraphView(opts) {
    var el = document.querySelector(opts.container);
    var compact = !!opts.compact;
    // The compact preview deliberately ignores saved settings: it is a fixed
    // thumbnail, and inheriting the full view's sliders made it sprawl off-frame.
    var P = compact ? Object.assign({}, DEFAULTS) : loadParams();
    if (compact) {
      P.linkDistance = 26;
      P.charge = -55;
      P.collide = 3;
      P.showLabels = false;
      P.showUnresolved = false;
    }

    var state = {
      nodes: [], links: [],
      raw: { nodes: [], links: [] },
      sbUrl: "",
      byId: new Map(),
      neighbours: new Map(),
      pos: new Map(),
      sim: null,
      transform: d3.zoomIdentity,
      hover: null,
      query: "",
      queryMiss: new Set(),
      frozen: false,
      userMoved: false,
      dragMoved: false,
      drawPending: false,
      rt: null
    };

    var canvas = document.createElement("canvas");
    canvas.className = "graph-canvas";
    el.appendChild(canvas);
    var ctx = canvas.getContext("2d");

    var colour = d3.scaleOrdinal(PALETTE);

    // ---- theme colours (canvas needs real values, not CSS classes) ----
    var theme = {};
    function readTheme() {
      var cs = getComputedStyle(document.documentElement);
      theme.link = cs.getPropertyValue("--link").trim() || "#b9bfc9";
      theme.linkHot = cs.getPropertyValue("--link-hot").trim() || "#4b5563";
      theme.fg = cs.getPropertyValue("--fg").trim() || "#23262b";
      theme.muted = cs.getPropertyValue("--muted").trim() || "#6b7280";
    }
    readTheme();
    if (global.matchMedia) {
      var mq = global.matchMedia("(prefers-color-scheme: dark)");
      var onScheme = function () { readTheme(); scheduleDraw(); };
      if (mq.addEventListener) mq.addEventListener("change", onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }

    function size() {
      var r = el.getBoundingClientRect();
      return { w: Math.max(r.width, 50), h: Math.max(r.height, 50) };
    }

    function resizeCanvas() {
      var s = size();
      var dpr = global.devicePixelRatio || 1;
      canvas.width = Math.round(s.w * dpr);
      canvas.height = Math.round(s.h * dpr);
      canvas.style.width = s.w + "px";
      canvas.style.height = s.h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function radius(n) {
      var base = compact
        ? 2.5 + Math.min(Math.sqrt(n.degree) * 1.1, 6)
        : 4 + Math.min(Math.sqrt(n.degree) * 1.8, 14);
      return base * P.nodeScale;
    }

    // ---- drawing ------------------------------------------------------
    function scheduleDraw() {
      if (state.drawPending) return;
      state.drawPending = true;
      global.requestAnimationFrame(function () {
        state.drawPending = false;
        draw();
      });
    }

    function draw() {
      var s = size();
      var t = state.transform;
      ctx.clearRect(0, 0, s.w, s.h);
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      var hot = state.hover ? (state.neighbours.get(state.hover) || new Set()) : null;
      var hasQuery = state.queryMiss.size > 0;
      var i, n, l;

      // --- links: every edge batched into at most three stroked paths ---
      ctx.lineWidth = 1 / t.k;
      var normal = new Path2D(), dashed = new Path2D(), hotPath = new Path2D();
      for (i = 0; i < state.links.length; i++) {
        l = state.links[i];
        if (!l.source || !l.target) continue;
        var isHot = state.hover &&
          (l.source.id === state.hover || l.target.id === state.hover);
        var p = isHot ? hotPath : (l.unresolved ? dashed : normal);
        p.moveTo(l.source.x, l.source.y);
        p.lineTo(l.target.x, l.target.y);
      }
      ctx.strokeStyle = theme.link;
      ctx.globalAlpha = state.hover ? 0.07 : 0.55;
      ctx.stroke(normal);
      ctx.setLineDash([2 / t.k, 3 / t.k]);
      ctx.globalAlpha = state.hover ? 0.05 : 0.32;
      ctx.stroke(dashed);
      ctx.setLineDash([]);
      if (state.hover) {
        ctx.strokeStyle = theme.linkHot;
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.6 / t.k;
        ctx.stroke(hotPath);
      }

      // --- nodes: grouped by colour and state, one fill per bucket ---
      var buckets = new Map();
      for (i = 0; i < state.nodes.length; i++) {
        n = state.nodes[i];
        var alpha = 1;
        if (hasQuery && state.queryMiss.has(n.id)) alpha = 0.06;
        else if (state.hover && !(n.id === state.hover || hot.has(n.id))) alpha = 0.16;
        var key = colour(n.folder) + "|" + (n.exists ? "s" : "g") + "|" + alpha;
        var b = buckets.get(key);
        if (!b) {
          b = { path: new Path2D(), col: colour(n.folder), solid: n.exists, alpha: alpha };
          buckets.set(key, b);
        }
        var r = radius(n);
        b.path.moveTo(n.x + r, n.y);
        b.path.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      buckets.forEach(function (b) {
        ctx.globalAlpha = b.alpha;
        if (b.solid) {
          ctx.fillStyle = b.col;
          ctx.fill(b.path);
        } else {
          ctx.setLineDash([2 / t.k, 2 / t.k]);
          ctx.strokeStyle = b.col;
          ctx.lineWidth = 1.4 / t.k;
          ctx.stroke(b.path);
          ctx.setLineDash([]);
        }
      });

      // mark pinned nodes so it is obvious which ones are held in place
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = theme.fg;
      ctx.lineWidth = 1 / t.k;
      for (i = 0; i < state.nodes.length; i++) {
        n = state.nodes[i];
        if (!n.pinned) continue;
        var pr = radius(n) + 2.5 / t.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, pr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ring the hovered node
      if (state.hover) {
        var hn = state.byId.get(state.hover);
        if (hn) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = theme.fg;
          ctx.lineWidth = 2 / t.k;
          ctx.beginPath();
          ctx.arc(hn.x, hn.y, radius(hn) + 1.5 / t.k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // --- labels: only what is legible and worth reading ---
      if (P.showLabels && t.k > 0.35) {
        ctx.globalAlpha = 1;
        var fs = Math.max(8.5 / t.k, 3);
        ctx.font = fs + "px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (i = 0; i < state.nodes.length; i++) {
          var m = state.nodes[i];
          var near = state.hover && (m.id === state.hover || hot.has(m.id));
          if (state.hover && !near) continue;
          if (!near && m.degree < P.labelDegree) continue;
          if (hasQuery && state.queryMiss.has(m.id)) continue;
          ctx.fillStyle = near ? theme.fg : theme.muted;
          ctx.fillText(m.title, m.x, m.y - radius(m) - 2 / t.k);
        }
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // ---- picking --------------------------------------------------------
    function nodeAt(px, py) {
      var t = state.transform;
      var x = (px - t.x) / t.k, y = (py - t.y) / t.k;
      var best = null, bestD = Infinity;
      for (var i = 0; i < state.nodes.length; i++) {
        var n = state.nodes[i];
        var r = radius(n) + 3 / t.k;
        var dx = n.x - x, dy = n.y - y;
        var d = dx * dx + dy * dy;
        if (d < r * r && d < bestD) { bestD = d; best = n; }
      }
      return best;
    }

    // A TouchEvent has no clientX of its own; it lives on the Touch object.
    // Reading ev.clientX directly yielded NaN and broke every touch gesture.
    function pointer(ev) {
      if (!ev) return [-1e6, -1e6];
      var src = ev;
      if (ev.touches && ev.touches.length) src = ev.touches[0];
      else if (ev.changedTouches && ev.changedTouches.length) src = ev.changedTouches[0];
      if (typeof src.clientX !== "number") return [-1e6, -1e6];
      var r = canvas.getBoundingClientRect();
      return [src.clientX - r.left, src.clientY - r.top];
    }

    // ---- simulation ------------------------------------------------------
    function buildNeighbours() {
      var m = new Map();
      state.links.forEach(function (l) {
        var a = srcId(l), b = dstId(l);
        if (!m.has(a)) m.set(a, new Set());
        if (!m.has(b)) m.set(b, new Set());
        m.get(a).add(b);
        m.get(b).add(a);
      });
      state.neighbours = m;
    }

    function applyForces(reheat) {
      if (!state.sim) return;
      var s = size();
      state.sim.force("link").distance(P.linkDistance).strength(P.linkStrength);
      state.sim.force("charge").strength(P.charge);
      state.sim.force("collide").radius(function (d) { return radius(d) + P.collide; });
      state.sim.force("x").x(s.w / 2).strength(P.gravity);
      state.sim.force("y").y(s.h / 2).strength(P.gravity);
      if (reheat && !state.frozen) state.sim.alpha(0.5).restart();
    }

    function build() {
      resizeCanvas();

      var visible = state.raw.nodes.filter(function (n) {
        return P.showUnresolved || n.exists;
      });
      var keep = new Set(visible.map(function (n) { return n.id; }));

      state.nodes = visible.map(function (n) {
        var saved = state.pos.get(n.id);
        var o = Object.assign({}, n);
        if (saved) { o.x = saved.x; o.y = saved.y; }
        return o;
      });
      state.byId = new Map(state.nodes.map(function (n) { return [n.id, n]; }));

      state.links = state.raw.links
        .filter(function (l) { return keep.has(srcId(l)) && keep.has(dstId(l)); })
        .map(function (l) {
          return {
            source: state.byId.get(srcId(l)),
            target: state.byId.get(dstId(l)),
            unresolved: l.unresolved
          };
        })
        .filter(function (l) { return l.source && l.target; });

      buildNeighbours();
      applyQuery();

      if (state.sim) state.sim.stop();
      state.sim = d3.forceSimulation(state.nodes)
        .force("link", d3.forceLink(state.links).id(function (d) { return d.id; }))
        .force("charge", d3.forceManyBody())
        .force("collide", d3.forceCollide())
        .force("x", d3.forceX())
        .force("y", d3.forceY())
        // Settle faster than d3's default 0.0228. The extra precision is
        // invisible at this node count and costs a second of spinning.
        .alphaDecay(0.035)
        .alpha(0.9);
      applyForces(false);

      state.sim.on("tick", scheduleDraw);
      state.sim.on("end", function () {
        state.nodes.forEach(function (n) { state.pos.set(n.id, { x: n.x, y: n.y }); });
        // Re-frame after every settle until the user pans or zooms themselves.
        if (!state.userMoved) fit(400);
        scheduleDraw();
      });
      if (state.frozen) state.sim.stop();
      scheduleDraw();
    }

    // ---- view fitting ------------------------------------------------------
    function fit(duration) {
      if (!state.nodes.length) return;
      var xs = [], ys = [];
      state.nodes.forEach(function (n) {
        if (isFinite(n.x) && isFinite(n.y)) { xs.push(n.x); ys.push(n.y); }
      });
      if (!xs.length) return;
      xs.sort(function (a, b) { return a - b; });
      ys.sort(function (a, b) { return a - b; });
      // Trim the extreme 2%: a couple of stray orphans should not decide the
      // zoom level for the other 96%.
      var lo = Math.floor(xs.length * 0.02);
      var hi = Math.max(lo, Math.ceil(xs.length * 0.98) - 1);
      var minX = xs[lo], maxX = xs[hi], minY = ys[lo], maxY = ys[hi];
      var s = size();
      var pad = compact ? 14 : 34;
      var k = Math.min((s.w - pad * 2) / Math.max(maxX - minX, 1),
                       (s.h - pad * 2) / Math.max(maxY - minY, 1), 3);
      var tr = d3.zoomIdentity
        .translate(s.w / 2 - k * (minX + maxX) / 2, s.h / 2 - k * (minY + maxY) / 2)
        .scale(k);
      var sel = d3.select(canvas);
      if (duration) sel.transition().duration(duration).call(zoom.transform, tr);
      else sel.call(zoom.transform, tr);
    }

    // ---- interaction --------------------------------------------------------
    // d3 only binds touch listeners when it detects a touch device, via
    // navigator.maxTouchPoints. That detection is unreliable (it reports 0 under
    // device emulation, and on some in-app browsers), and when it says no, touch
    // silently does nothing at all. Always bind: on a mouse-only machine the
    // touch listeners simply never fire.
    var alwaysTouchable = function () { return true; };

    var zoom = d3.zoom()
      .touchable(alwaysTouchable)
      .scaleExtent([0.05, 8])
      // Zoom and drag share this canvas. Without this filter a press on a node
      // starts BOTH a node drag and a canvas pan, and the node appears stuck to
      // the background instead of following the cursor.
      .filter(function (ev) {
        if (ev.type === "mousedown" || ev.type === "touchstart" ||
            ev.type === "pointerdown") {
          var p = pointer(ev);
          if (nodeAt(p[0], p[1])) return false;
        }
        return (!ev.ctrlKey || ev.type === "wheel") && !ev.button;
      })
      .on("zoom", function (ev) {
        state.transform = ev.transform;
        // sourceEvent is null for our own programmatic fit transitions.
        if (ev.sourceEvent) state.userMoved = true;
        scheduleDraw();
      });

    d3.select(canvas)
      .call(zoom)
      .call(d3.drag()
        .touchable(alwaysTouchable)
        // d3-drag computes its deltas in whatever space the subject reports, so
        // the subject is returned in SCREEN coordinates and inverted on each
        // move. Returning simulation coordinates drifted once the view was
        // zoomed, and broke outright on touch.
        .subject(function (ev) {
          var p = pointer(ev.sourceEvent);
          var n = nodeAt(p[0], p[1]);
          if (!n) return null;
          return {
            node: n,
            x: state.transform.applyX(n.x),
            y: state.transform.applyY(n.y)
          };
        })
        .on("start", function (ev) {
          if (!ev.subject) return;
          if (ev.sourceEvent && ev.sourceEvent.stopPropagation) {
            ev.sourceEvent.stopPropagation();
          }
          state.dragMoved = false;
          var n = ev.subject.node;
          if (!state.frozen) state.sim.alphaTarget(0.25).restart();
          n.fx = n.x;
          n.fy = n.y;
        })
        .on("drag", function (ev) {
          if (!ev.subject) return;
          state.dragMoved = true;
          var n = ev.subject.node;
          var nx = state.transform.invertX(ev.x);
          var ny = state.transform.invertY(ev.y);
          n.fx = nx;
          n.fy = ny;
          // Also move x/y directly. The simulation normally copies fx->x on its
          // next tick, but when it is settled or frozen no tick ever comes and
          // the node would sit still while the pointer walked away from it.
          n.x = nx;
          n.y = ny;
          scheduleDraw();
        })
        .on("end", function (ev) {
          if (!ev.subject) return;
          var n = ev.subject.node;
          if (!state.frozen) state.sim.alphaTarget(0);
          if (P.pinOnDrag) {
            n.pinned = true;               // stays exactly where it was dropped
          } else {
            n.fx = null;                   // rejoins the simulation, like Obsidian
            n.fy = null;
            // Give the layout enough energy to actually relax around the new
            // position. A quick flick never lets alpha rise on its own, and the
            // node would just sit wherever it was dropped.
            if (!state.frozen) {
              state.sim.alpha(Math.max(state.sim.alpha(), 0.3)).restart();
            }
          }
          scheduleDraw();
        }));

    // d3-zoom binds double-click to zoom-in; reclaim it for unpinning.
    d3.select(canvas).on("dblclick.zoom", null);

    // d3-zoom writes `touch-action: none` as an INLINE style, which no
    // stylesheet rule can override. That is correct for the full view, but in
    // the embedded thumbnail it means the graph eats every finger-scroll and a
    // phone user cannot scroll past it on the home page. Hand the gesture back.
    if (compact) canvas.style.touchAction = "auto";

    canvas.addEventListener("mousemove", function (ev) {
      var p = pointer(ev);
      var n = nodeAt(p[0], p[1]);
      var id = n ? n.id : null;
      if (id !== state.hover) {
        state.hover = id;
        canvas.style.cursor = id ? "pointer" : "grab";
        scheduleDraw();
      }
    });
    canvas.addEventListener("mouseleave", function () {
      if (state.hover) { state.hover = null; scheduleDraw(); }
    });
    canvas.addEventListener("dblclick", function (ev) {
      var p = pointer(ev);
      var n = nodeAt(p[0], p[1]);
      if (n) {
        n.pinned = false; n.fx = null; n.fy = null;
      } else {
        state.nodes.forEach(function (m) { m.pinned = false; m.fx = null; m.fy = null; });
      }
      if (!state.frozen) state.sim.alpha(0.3).restart();
      scheduleDraw();
    });

    canvas.addEventListener("click", function (ev) {
      // On touch a drag ends with a click too; opening the page mid-rearrange
      // would be maddening.
      if (state.dragMoved) { state.dragMoved = false; return; }
      var p = pointer(ev);
      var n = nodeAt(p[0], p[1]);
      if (n) openPage(n);
    });

    function openPage(d) {
      if (!d.exists || !state.sbUrl) return;
      var url = state.sbUrl + "/" + d.id.split("/").map(encodeURIComponent).join("/");
      global.open(url, "_blank", "noopener");
    }

    function applyQuery() {
      state.queryMiss = new Set();
      if (!state.query) return;
      state.nodes.forEach(function (n) {
        if (n.id.toLowerCase().indexOf(state.query) === -1) state.queryMiss.add(n.id);
      });
    }

    global.addEventListener("resize", function () {
      clearTimeout(state.rt);
      state.rt = setTimeout(function () {
        resizeCanvas();
        applyForces(true);
        scheduleDraw();
      }, 200);
    });

    // ---- public API -----------------------------------------------------------
    function load() {
      return fetch("api/graph", { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("graph fetch failed: " + r.status);
        return r.json();
      }).then(function (payload) {
        state.raw = { nodes: payload.nodes, links: payload.links };
        state.sbUrl = payload.sbUrl || "";
        build();
        if (opts.onStats) opts.onStats(payload.stats, payload);
        return payload;
      });
    }

    function live() {
      var es = new EventSource("api/events");
      var first = true;
      es.onmessage = function () {
        if (first) { first = false; return; }
        load().catch(function (e) { console.warn("[sb-graph] reload failed", e); });
      };
    }

    return {
      load: load,
      live: live,
      params: function () { return P; },
      defaults: function () { return DEFAULTS; },
      setParam: function (name, value) {
        if (!(name in DEFAULTS)) return;
        P[name] = value;
        saveParams(P);
        if (name === "showUnresolved") { build(); return; }
        if (name === "showLabels" || name === "labelDegree" || name === "pinOnDrag") {
          scheduleDraw();
          return;
        }
        applyForces(true);
        scheduleDraw();
      },
      unpinAll: function () {
        state.nodes.forEach(function (m) { m.pinned = false; m.fx = null; m.fy = null; });
        if (!state.frozen) state.sim.alpha(0.3).restart();
        scheduleDraw();
      },
      resetParams: function () {
        for (var k in DEFAULTS) P[k] = DEFAULTS[k];
        saveParams(P);
        state.userMoved = false;
        build();
      },
      freeze: function (on) {
        state.frozen = !!on;
        if (!state.sim) return;
        if (state.frozen) state.sim.stop();
        else state.sim.alpha(0.3).restart();
      },
      setQuery: function (q) {
        state.query = (q || "").trim().toLowerCase();
        applyQuery();
        scheduleDraw();
      },
      folders: function () {
        var m = new Map();
        state.raw.nodes.forEach(function (n) { m.set(n.folder, colour(n.folder)); });
        return Array.from(m, function (e) { return { name: e[0], col: e[1] }; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
      },
      reset: function () { state.userMoved = false; fit(400); }
    };
  }

  global.GraphView = GraphView;
})(window);
