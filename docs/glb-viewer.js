/*
 * glb-viewer – 3D model (GLB) viewer for Home Assistant Lovelace (Three.js)
 * Version: 0.3.42
 * Rotation around the vertical axis (left/right) + limited tilt (up/down),
 * configurable from the visual card editor (path to GLB, rotation/zoom limits).
 * Three.js is loaded from a CDN on first use (see `three_url`).
 */

const VERSION = "0.3.42";

// Base URL of the Three.js package; addons are loaded from <base>/examples/jsm/...
const THREE_URL = "https://esm.sh/three@0.170.0";

const DEFAULTS = {
  title: "",
  width: "", // empty = full column width; e.g. 600px or 80%
  height: "400px",
  hide_border: false, // hides the card border and shadow
  background: "", // empty = theme background; e.g. rgba(0, 0, 0, 0.5)
  // model orientation in degrees (rotates the model itself, not the camera)
  model_yaw: 0, // around the vertical axis
  model_pitch: 0, // forward/backward
  model_roll: 0, // sideways
  flip_x: false, // mirrored along the X axis
  flip_z: false, // mirrored along the Z axis
  // camera tilt above the horizon in degrees: 0 = from ground level, 90 = straight from above
  min_tilt: 5,
  max_tilt: 70,
  initial_tilt: 25,
  // horizontal angle; empty = unlimited
  min_azimuth: null,
  max_azimuth: null,
  initial_azimuth: 30,
  // zoom in %: 100 = the whole house fits in the card, more = closer, less = farther
  min_zoom: 50,
  max_zoom: 200,
  initial_zoom: 100,
  auto_rotate: false,
  auto_rotate_delay: 3000,
  rotation_per_second: 20, // °/s
  page_scroll: false, // touch: true = finger scrolls the page (disables tilting by touch)
  exposure: 1,
  shadow_intensity: 1,
  environment: "neutral",
  light_color: "", // CSS lighting color, e.g. #ffd9a0; empty = off
  night: "off", // off | on | sun | entity
  night_entity: "",
  night_ambient: 0.15, // minimum scene brightness at night (0 to 1)
  show_light_markers: false,
  home_label: "Whole house", // name of the default view (button)
  view_entity: "", // input_select whose options = view names
  enable_pan: true, // panning (right button, Shift+drag, two fingers)
  front_azimuth: 180, // compass direction the front of the model faces (0 = north, 90 = east, 180 = south, 270 = west)
  show_view_buttons: true,
  show_reload_button: true, // button to reload the model
  show_play_button: true, // play/stop button for auto-rotate
  window_glow: 1, // window glow when the light is on (0 = off)
  lights_shadows: true, // shadows from lights (central switch)
  lights_test: false, // test: turns on all lights regardless of entities
  view_duration: 1.5, // s
  // hidden_materials: ["roof_house"]
  // views: [{ name, azimuth, tilt, zoom, target: [x, y, z], hide: [material names], duration }]
  // lights: [{ name, entity, position: [x, y, z], color: [r, g, b], intensity, distance, shadows,
  //            use_entity_color, use_brightness, force_on }]
  three_url: THREE_URL,
};

const isEmpty = (v) => v === undefined || v === null || v === "";
const num = (v, d) => (isEmpty(v) || isNaN(Number(v)) ? d : Number(v));
const rad = (d) => (d * Math.PI) / 180;

function solidColorCanvas(color) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // stays white for an invalid color
  ctx.fillStyle = String(color);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

let libPromise = null;
let libBase = null;
function loadLibs(base) {
  if (libPromise && libBase !== base) libPromise = null;
  if (!libPromise) {
    libBase = base;
    libPromise = Promise.all([
      import(base),
      import(`${base}/examples/jsm/loaders/GLTFLoader.js`),
      import(`${base}/examples/jsm/controls/OrbitControls.js`),
      import(`${base}/examples/jsm/environments/RoomEnvironment.js`),
    ])
      .then(([THREE, gltf, orbit, room]) => ({
        THREE,
        base,
        GLTFLoader: gltf.GLTFLoader,
        OrbitControls: orbit.OrbitControls,
        RoomEnvironment: room.RoomEnvironment,
      }))
      .catch((e) => {
        libPromise = null;
        throw new Error(`Failed to load Three.js from ${base}: ${e && e.message ? e.message : e}`);
      });
  }
  return libPromise;
}

class DomViewerCard extends HTMLElement {
  static getStubConfig() {
    return { model: "/local/dom/dom.glb" };
  }

  static async getConfigElement() {
    return document.createElement("dom-viewer-card-editor");
  }

  constructor() {
    super();
    this._tick = this._tick.bind(this);
    this._raf = 0;
    this._dirty = true;
    this._pick = null;
    this._onPickEvent = this._onPickEvent.bind(this);
    this._onPickCancel = this._onPickCancel.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onCaptureEvent = this._onCaptureEvent.bind(this);
    this._onGotoEvent = this._onGotoEvent.bind(this);
    this._onReloadEvent = this._onReloadEvent.bind(this);
    this._view = null; // name of the active view (null = default)
    this._lastEntityView = null;
  }

  setConfig(config) {
    if (!config || !config.model) {
      throw new Error("Missing parameter 'model' (e.g. /local/dom/dom.glb)");
    }
    const cfgKey = JSON.stringify(config, (k, x) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]))
        : x
    );
    if (this._cfgKey === cfgKey && this._wrap) return; // unchanged configuration: nothing to redraw
    this._cfgKey = cfgKey;
    this._config = { ...DEFAULTS, ...config };
    if (!this._wrap) this._buildDom();
    this._applyLayout();
    if (this._ctx) {
      this._loadModel();
      this._applyConfig();
    } else if (this.isConnected) {
      this._start();
    }
  }

  getCardSize() {
    const h = parseInt(this._config?.height, 10);
    return Math.max(3, Math.round((isNaN(h) ? 400 : h) / 50));
  }

  connectedCallback() {
    clearTimeout(this._teardownTimer);
    window.addEventListener("glb-viewer-pick", this._onPickEvent);
    window.addEventListener("glb-viewer-pick-cancel", this._onPickCancel);
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("glb-viewer-capture", this._onCaptureEvent);
    window.addEventListener("glb-viewer-goto", this._onGotoEvent);
    window.addEventListener("glb-viewer-reload", this._onReloadEvent);
    (window.__glbViewerCards = window.__glbViewerCards || new Set()).add(this);
    if (this._config) this._start();
  }

  disconnectedCallback() {
    window.removeEventListener("glb-viewer-pick", this._onPickEvent);
    window.removeEventListener("glb-viewer-pick-cancel", this._onPickCancel);
    window.removeEventListener("keydown", this._onKey);
    window.removeEventListener("glb-viewer-capture", this._onCaptureEvent);
    window.removeEventListener("glb-viewer-goto", this._onGotoEvent);
    window.removeEventListener("glb-viewer-reload", this._onReloadEvent);
    if (window.__glbViewerCards) window.__glbViewerCards.delete(this);
    if (this._pick) this._endPick();
    this._pause();
    clearTimeout(this._teardownTimer);
    // if the card does not return to the page, the WebGL context is released
    this._teardownTimer = setTimeout(() => {
      if (!this.isConnected) this._dispose();
    }, 3000);
  }

  /* ---------------- DOM ---------------- */

  _buildDom() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const root = this.shadowRoot;
    root.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; }
      ha-card { overflow:hidden; }
      .wrap { position:relative; width:100%; }
      canvas { display:block; width:100%; height:100%; outline:none; }
      .msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
             color:var(--secondary-text-color); font-size:14px; padding:16px; text-align:center;
             pointer-events:none; }
      .err { color:var(--error-color); }
      .hint { position:absolute; top:8px; left:50%; transform:translateX(-50%); padding:6px 12px;
              border-radius:16px; background:rgba(0,0,0,.7); color:#fff; font-size:13px;
              pointer-events:none; z-index:2; white-space:nowrap; }
      .bar { position:absolute; left:0; right:0; bottom:8px; display:flex; gap:6px; flex-wrap:wrap;
             justify-content:center; padding:0 8px; z-index:2; }
      .chip { border:none; border-radius:16px; padding:6px 12px; font:inherit; font-size:13px;
              background:rgba(0,0,0,.55); color:#fff; cursor:pointer; }
      .reload, .play { position:absolute; top:8px; right:8px; z-index:2; width:32px; height:32px; border:none;
                border-radius:50%; background:rgba(0,0,0,.45); color:#fff; font-size:18px; line-height:1;
                cursor:pointer; opacity:.6; padding:0; }
      .reload:hover, .play:hover { opacity:1; }
      .play { right:48px; display:flex; align-items:center; justify-content:center; --mdc-icon-size:18px; }
      .reload.spin { animation:glbspin .8s linear infinite; }
      @keyframes glbspin { to { transform:rotate(360deg); } }
      .chip.active { background:var(--primary-color); color:var(--text-primary-color,#fff); }
    `;

    this._card = document.createElement("ha-card");
    this._wrap = document.createElement("div");
    this._wrap.className = "wrap";
    this._msg = document.createElement("div");
    this._msg.className = "msg";
    this._hint = document.createElement("div");
    this._hint.className = "hint";
    this._bar = document.createElement("div");
    this._bar.className = "bar";
    this._reloadBtn = document.createElement("button");
    this._reloadBtn.className = "reload";
    this._reloadBtn.title = "Reload model";
    this._reloadBtn.textContent = "↻";
    this._reloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._reloadModel();
    });
    this._wrap.appendChild(this._reloadBtn);
    this._playBtn = document.createElement("button");
    this._playBtn.className = "play";
    this._playBtn._icon = document.createElement("ha-icon");
    this._playBtn._icon.setAttribute("icon", "mdi:pause");
    this._playBtn.appendChild(this._playBtn._icon);
    this._playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleAuto();
    });
    this._wrap.appendChild(this._playBtn);
    this._card.appendChild(this._wrap);
    root.append(style, this._card);
    this._showMessage("Loading model...");
  }

  _showMessage(text, isError = false) {
    this._msg.textContent = text;
    this._msg.classList.toggle("err", isError);
    if (!this._msg.isConnected) this._wrap.appendChild(this._msg);
  }

  _hideMessage() {
    this._msg.remove();
  }

  _showError(text) {
    if (this._reloadBtn) this._reloadBtn.classList.remove("spin");
    this._showMessage(text, true);
  }

  _applyLayout() {
    const c = this._config;
    const css = (v) => (/^\d+(\.\d+)?$/.test(String(v).trim()) ? `${String(v).trim()}px` : String(v));

    this._wrap.style.height = css(c.height);
    if (this._reloadBtn) this._reloadBtn.style.display = c.show_reload_button === false ? "none" : "";
    this._updatePlayBtn();
    if (isEmpty(c.width)) {
      this.style.removeProperty("width");
      this.style.removeProperty("max-width");
      this.style.removeProperty("margin");
    } else {
      this.style.width = css(c.width);
      this.style.maxWidth = "100%";
      this.style.margin = "0 auto";
    }

    if (isEmpty(c.background)) this._card.style.removeProperty("--ha-card-background");
    else this._card.style.setProperty("--ha-card-background", String(c.background));

    const st = this._card.style;
    if (c.hide_border) {
      st.setProperty("--ha-card-border-width", "0px");
      st.setProperty("--ha-card-border-color", "transparent");
      st.setProperty("--ha-card-box-shadow", "none");
      st.setProperty("border", "none");
      st.setProperty("box-shadow", "none");
    } else {
      [
        "--ha-card-border-width",
        "--ha-card-border-color",
        "--ha-card-box-shadow",
        "border",
        "box-shadow",
      ].forEach((k) => st.removeProperty(k));
    }
    this._card.header = c.title || "";
  }

  /* ---------------- lifecycle ---------------- */

  _start() {
    if (this._ctx) {
      this._resume();
      return;
    }
    if (this._starting) return;
    this._starting = true;
    loadLibs(this._config.three_url)
      .then((lib) => {
        this._starting = false;
        if (!this.isConnected || this._ctx) return;
        this._init(lib);
      })
      .catch((e) => {
        this._starting = false;
        this._showError(e.message);
      });
  }

  _init(lib) {
    const { THREE, OrbitControls } = lib;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this._wrap.insertBefore(renderer.domElement, this._wrap.firstChild);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const group = new THREE.Group();
    scene.add(group);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.4);
    hemi.visible = false;
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    scene.add(sun.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.4 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const ctx = {
      lib,
      THREE,
      renderer,
      scene,
      camera,
      controls,
      group,
      hemi,
      sun,
      ground,
      pmrem: new THREE.PMREMGenerator(renderer),
      center: new THREE.Vector3(),
      radius: 0,
      fit: 0,
      model: null,
      loadedUrl: null,
      envKey: null,
      envTarget: null,
      neutralTarget: null,
      viewKey: null,
      interacting: false,
      lights: [],
      lightsKey: null,
      anyShadow: false,
      night: 0,
      nightTarget: 0,
      tween: null,
      mats: null,
      matState: null,
      shadowsStale: false,
    };
    sun.shadow.autoUpdate = false; // static scene, the shadow only needs to be rendered once
    sun.shadow.normalBias = 0.05;
    this._ctx = ctx;

    controls.addEventListener("start", () => {
      ctx.interacting = true;
      window.__glbViewerLastInteract = this;
      ctx.tween = null;
      this._flushShow();
      this._applyLimits();
      clearTimeout(this._arTimer);
      controls.autoRotate = false;
    });
    controls.addEventListener("end", () => {
      ctx.interacting = false;
      clearTimeout(this._arTimer);
      if (this._autoOn()) {
        this._arTimer = setTimeout(() => {
          controls.autoRotate = true;
        }, Math.max(0, num(this._config.auto_rotate_delay, 3000)));
      }
    });

    // click on the model (picking a light position)
    const el = renderer.domElement;
    el.addEventListener("pointerdown", (e) => {
      this._down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e) => {
      if (!this._pick || !this._down) return;
      if (Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > 5) return;
      this._doPick(e);
    });

    this._loadModel();
    this._applyConfig();
    this._resume();
  }

  _resume() {
    if (!this._ctx) return;
    if (!this._ro) this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._wrap);
    if (!this._raf) {
      this._last = performance.now();
      this._raf = requestAnimationFrame(this._tick);
    }
    this._resize();
    this._dirty = true;
  }

  _pause() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._ro) this._ro.disconnect();
  }

  _dispose() {
    this._pause();
    clearTimeout(this._arTimer);
    const ctx = this._ctx;
    if (!ctx) return;
    this._ctx = null;
    ctx.controls.dispose();
    ctx.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          Object.values(m).forEach((v) => v && v.isTexture && v.dispose());
          m.dispose();
        });
      }
    });
    if (ctx.envTarget) ctx.envTarget.dispose();
    if (ctx.neutralTarget && ctx.neutralTarget !== ctx.envTarget) ctx.neutralTarget.dispose();
    ctx.pmrem.dispose();
    ctx.renderer.dispose();
    ctx.renderer.forceContextLoss();
    ctx.renderer.domElement.remove();
  }

  _tick(now) {
    this._raf = requestAnimationFrame(this._tick);
    const ctx = this._ctx;
    if (!ctx) return;
    const dt = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    this._stepTween(ctx, now);
    this._animate(ctx, dt);
    if (this._animateMaterials(ctx, dt)) this._dirty = true;
    // auto-rotate with limits: the direction reverses at a limit (back and forth)
    if (ctx.controls.autoRotate && ctx.arBase) {
      const cn = ctx.controls;
      const th = cn.getAzimuthalAngle();
      const eps = 0.012;
      let dir = ctx.arDir || 1;
      if (dir > 0 && cn.minAzimuthAngle > -Math.PI + 0.01 && th <= cn.minAzimuthAngle + eps) dir = -1;
      else if (dir < 0 && cn.maxAzimuthAngle < Math.PI - 0.01 && th >= cn.maxAzimuthAngle - eps) dir = 1;
      if (dir !== ctx.arDir) {
        ctx.arDir = dir;
        cn.autoRotateSpeed = ctx.arBase * dir;
      }
    }
    const changed = ctx.controls.update(dt);
    // panning must not move the view away from the model
    if (ctx.controls.enablePan && !ctx.tween && ctx.radius && ctx.center) {
      const tg = ctx.controls.target;
      const off = tg.clone().sub(ctx.center);
      const lim = ctx.radius;
      if (off.length() > lim) {
        const fixed = ctx.center.clone().add(off.setLength(lim));
        ctx.camera.position.add(fixed.clone().sub(tg));
        tg.copy(fixed);
        this._dirty = true;
      }
    }
    if (changed || this._dirty) {
      this._dirty = false;
      if (ctx.shadowFull) this._renderFullShadows(ctx);
      ctx.renderer.render(ctx.scene, ctx.camera);
    }
  }

  _resize() {
    const ctx = this._ctx;
    if (!ctx) return;
    const w = this._wrap.clientWidth;
    const h = this._wrap.clientHeight;
    if (!w || !h) return;
    ctx.renderer.setSize(w, h, false);
    ctx.camera.aspect = w / h;
    ctx.camera.updateProjectionMatrix();
    this._applyLimits();
    this._dirty = true;
  }

  /* ---------------- model ---------------- */

  _loadModel() {
    const ctx = this._ctx;
    const url = this._config.model;
    if (!ctx || ctx.loadedUrl === url) return;
    ctx.loadedUrl = url;
    // on reload the browser cache is bypassed
    const bust = (window.__glbViewerBust || {})[url];
    const fetchUrl = bust ? url + (url.includes("?") ? "&" : "?") + "_=" + bust : url;
    this._showMessage("Loading model...");
    new ctx.lib.GLTFLoader().load(
      fetchUrl,
      (gltf) => {
        if (this._ctx !== ctx || ctx.loadedUrl !== url) return;
        this._setModel(gltf.scene);
      },
      undefined,
      () => {
        if (this._ctx !== ctx || ctx.loadedUrl !== url) return;
        this._showError("Failed to load the model: " + url);
      }
    );
  }

  _reloadModel() {
    const ctx = this._ctx;
    if (!ctx) return;
    // the reload time is shared by all cards (including the editor preview) so none loads a stale copy from the cache
    window.__glbViewerBust = window.__glbViewerBust || {};
    window.__glbViewerBust[this._config.model] = Date.now();
    window.dispatchEvent(new CustomEvent("glb-viewer-reload", { detail: { model: this._config.model } }));
  }

  _onReloadEvent(ev) {
    const ctx = this._ctx;
    const d = ev.detail || {};
    if (!ctx || !this._config || d.model !== this._config.model) return;
    ctx.loadedUrl = null;
    if (this._reloadBtn) this._reloadBtn.classList.add("spin");
    this._loadModel();
  }

  _setModel(root) {
    const ctx = this._ctx;
    if (ctx.model) {
      ctx.group.remove(ctx.model);
      ctx.model.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
            Object.values(m).forEach((v) => v && v.isTexture && v.dispose());
            m.dispose();
          });
        }
      });
    }
    ctx.group.add(root);
    ctx.model = root;

    const winNames = this._collectWindows(root);
    this._collectMaterials(root);
    this._applyMaterialColors();
    const meshes = new Set();
    const materials = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.name) meshes.add(o.name);
      o.castShadow = true;
      o.receiveShadow = false;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (m.name) materials.add(m.name);
        // glass must not cast a shadow so light can pass out through the window
        if (m.userData.glb && m.userData.glb.glass) o.castShadow = false;
      });
    });
    this._names = { meshes: [...meshes], materials: [...materials], windows: winNames };
    console.info("[glb-viewer] meshes:", this._names.meshes, "materials:", this._names.materials);

    // model size in its own coordinates (for the light editor)
    const gr = ctx.group.rotation.clone();
    const gs = ctx.group.scale.clone();
    ctx.group.rotation.set(0, 0, 0);
    ctx.group.scale.set(1, 1, 1);
    ctx.group.updateMatrixWorld(true);
    const lb = new ctx.THREE.Box3().setFromObject(root);
    ctx.group.rotation.copy(gr);
    ctx.group.scale.copy(gs);
    ctx.group.updateMatrixWorld(true);
    window.__glbViewerInfo = window.__glbViewerInfo || {};
    const info = (window.__glbViewerInfo[this._config.model] =
      window.__glbViewerInfo[this._config.model] || {});
    info.min = lb.min.toArray();
    info.max = lb.max.toArray();

    this._applyShadowReceive();
    const keepView = this._view; // the active view is kept when the model is reloaded
    ctx.viewKey = null; // forces the initial view to be applied
    this._hideMessage();
    if (this._reloadBtn) this._reloadBtn.classList.remove("spin");
    this._applyBounds();
    if (keepView && this._views().some((v) => v.name === keepView)) this._goToView(keepView, { instant: true });
    this._applyVisibility(true);
    this._renderViewBar();
    this._syncViewEntity(true);
    this._applyFocus();
    window.dispatchEvent(new CustomEvent("glb-viewer-info", { detail: { model: this._config.model } }));
    this._dirty = true;
  }

  /* ---------------- configuration ---------------- */

  _applyConfig() {
    const ctx = this._ctx;
    if (!ctx) return;
    const c = this._config;

    ctx.renderer.toneMappingExposure = num(c.exposure, 1);
    ctx.renderer.domElement.style.touchAction = c.page_scroll ? "pan-y" : "none";

    const si = Math.max(0, num(c.shadow_intensity, 1));
    ctx.ground.visible = si > 0;
    ctx.sun.castShadow = true; // the sun shadow falls on the model even when the ground shadow is off
    ctx.ground.material.opacity = Math.min(1, 0.4 * si);

    this._syncLights();
    this._applyEnv();
    this._applyAuto();
    this._updateNight();
    this._applyNightLevel();
    this._updateMarkers();
    this._applyBounds();
    this._applyMaterialColors();
    this._renderViewBar();
    this._syncViewEntity();
    this._applyFocus();
    this._dirty = true;
  }

  _applyAuto() {
    const ctx = this._ctx;
    const c = this._config;
    const rps = parseFloat(c.rotation_per_second);
    // OrbitControls: autoRotateSpeed 1 = 6 °/s (with update(deltaTime))
    ctx.arBase = (isNaN(rps) ? 20 : rps) / 6;
    ctx.controls.autoRotateSpeed = ctx.arBase * (ctx.arDir || 1);
    ctx.controls.enablePan = this._config.enable_pan !== false;
    clearTimeout(this._arTimer);
    if (!this._autoOn()) ctx.controls.autoRotate = false;
    else if (!ctx.interacting) ctx.controls.autoRotate = true;
  }

  _setEnv(target) {
    const ctx = this._ctx;
    ctx.scene.environment = target ? target.texture : null;
    if (ctx.envTarget && ctx.envTarget !== ctx.neutralTarget && ctx.envTarget !== target) {
      ctx.envTarget.dispose();
    }
    ctx.envTarget = target;
    this._dirty = true;
  }

  _applyEnv() {
    const ctx = this._ctx;
    const { THREE } = ctx;
    const c = this._config;
    const key = !isEmpty(c.light_color) ? `c:${c.light_color}` : `e:${c.environment || ""}`;
    if (key === ctx.envKey) return;
    ctx.envKey = key;
    ctx.hemi.visible = false;

    if (key.startsWith("c:")) {
      // lighting color: a uniform-color environment
      const tex = new THREE.CanvasTexture(solidColorCanvas(c.light_color));
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      this._setEnv(ctx.pmrem.fromEquirectangular(tex));
      tex.dispose();
      return;
    }

    const e = c.environment;
    if (!e) {
      this._setEnv(null);
    } else if (e === "neutral") {
      if (!ctx.neutralTarget) {
        ctx.neutralTarget = ctx.pmrem.fromScene(new ctx.lib.RoomEnvironment(), 0.04);
      }
      this._setEnv(ctx.neutralTarget);
    } else if (e === "legacy") {
      ctx.hemi.visible = true;
      this._setEnv(null);
    } else {
      this._setEnv(null);
      const isHdr = /\.hdr(\?|$)/i.test(e);
      const load = isHdr
        ? import(`${ctx.lib.base}/examples/jsm/loaders/RGBELoader.js`).then((m) =>
            new m.RGBELoader().loadAsync(e)
          )
        : new THREE.TextureLoader().loadAsync(e).then((t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            return t;
          });
      load
        .then((tex) => {
          if (this._ctx !== ctx || ctx.envKey !== key) {
            tex.dispose();
            return;
          }
          tex.mapping = THREE.EquirectangularReflectionMapping;
          this._setEnv(ctx.pmrem.fromEquirectangular(tex));
          tex.dispose();
        })
        .catch(() => console.warn("[glb-viewer] Failed to load the environment:", e));
    }
  }

  // orientation, model size, shadow and camera limits
  _applyBounds() {
    const ctx = this._ctx;
    if (!ctx || !ctx.model) return;
    const { THREE, group, sun, ground, controls } = ctx;
    const c = this._config;

    group.rotation.set(
      rad(num(c.model_pitch, 0)),
      rad(num(c.model_yaw, 0)),
      rad(num(c.model_roll, 0)),
      "YXZ"
    );
    group.scale.set(c.flip_x ? -1 : 1, 1, c.flip_z ? -1 : 1);
    group.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(ctx.model);
    if (box.isEmpty()) return;
    box.getCenter(ctx.center);
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.001);
    ctx.radius = r;

    if (!this._view && !ctx.tween) controls.target.copy(ctx.center);

    this._updateSun(true);
    const s = sun.shadow.camera;
    s.left = -r * 1.3;
    s.right = r * 1.3;
    s.top = r * 1.3;
    s.bottom = -r * 1.3;
    s.near = 0.1;
    s.far = r * 6;
    s.updateProjectionMatrix();

    this._refreshShadows();
    ground.position.set(ctx.center.x, box.min.y - r * 0.002, ctx.center.z);
    ground.scale.set(r * 6, r * 6, 1);

    this._applyLimits();

    const viewKey = JSON.stringify([
      c.model,
      c.initial_azimuth,
      c.initial_tilt,
      c.initial_zoom,
      c.model_yaw,
      c.model_pitch,
      c.model_roll,
      c.flip_x,
      c.flip_z,
    ]);
    if (viewKey !== ctx.viewKey) {
      ctx.viewKey = viewKey;
      this._view = null;
      ctx.tween = null;
      controls.target.copy(ctx.center);
      this._renderViewBar();
      this._resetView();
    }
    this._dirty = true;
  }

  // distance at which the whole model fits in the card (= zoom 100 %)
  _computeFit() {
    const ctx = this._ctx;
    const vfov = rad(ctx.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * ctx.camera.aspect);
    ctx.fit = ctx.radius / Math.sin(Math.min(vfov, hfov) / 2);
  }

  _applyLimits() {
    const ctx = this._ctx;
    if (!ctx || !ctx.model || !ctx.radius) return;
    const { controls, camera } = ctx;
    const c = this._config;
    this._computeFit();

    const zMin = Math.max(Math.min(num(c.min_zoom, 50), num(c.max_zoom, 200)), 1);
    const zMax = Math.max(Math.max(num(c.min_zoom, 50), num(c.max_zoom, 200)), 1);
    controls.minDistance = (ctx.fit * 100) / zMax;
    controls.maxDistance = (ctx.fit * 100) / zMin;

    // OrbitControls uses the polar angle from the vertical (0 = from above), hence 90 - tilt
    const tiltLo = Math.min(num(c.min_tilt, 5), num(c.max_tilt, 70));
    const tiltHi = Math.max(num(c.min_tilt, 5), num(c.max_tilt, 70));
    controls.minPolarAngle = rad(90 - tiltHi);
    controls.maxPolarAngle = rad(90 - tiltLo);

    // azimuth limits apply in OrbitControls only when both values are given
    const hasMin = !isEmpty(c.min_azimuth);
    const hasMax = !isEmpty(c.max_azimuth);
    if (!hasMin && !hasMax) {
      controls.minAzimuthAngle = -Infinity;
      controls.maxAzimuthAngle = Infinity;
    } else {
      controls.minAzimuthAngle = hasMin ? rad(num(c.min_azimuth, 0)) : -Math.PI;
      controls.maxAzimuthAngle = hasMax ? rad(num(c.max_azimuth, 0)) : Math.PI;
    }

    const av = this._activeView();
    if (av) {
      const vs = this._viewState(av);
      controls.minDistance = Math.min(controls.minDistance, vs.r * 0.999);
      controls.maxDistance = Math.max(controls.maxDistance, vs.r * 1.001);
      controls.minPolarAngle = Math.min(controls.minPolarAngle, vs.phi);
      controls.maxPolarAngle = Math.max(controls.maxPolarAngle, vs.phi);
      if (isFinite(controls.minAzimuthAngle) && isFinite(controls.maxAzimuthAngle)) {
        controls.minAzimuthAngle = Math.min(controls.minAzimuthAngle, vs.theta);
        controls.maxAzimuthAngle = Math.max(controls.maxAzimuthAngle, vs.theta);
      }
    }

    camera.near = Math.max(ctx.radius * 0.002, 0.01); // so near surfaces are not clipped at high zoom
    camera.far = ctx.fit * 10 + ctx.radius * 10;
    camera.updateProjectionMatrix();
  }

  _resetView() {
    const ctx = this._ctx;
    const { camera, controls } = ctx;
    const c = this._config;
    if (!ctx.fit) this._computeFit();
    const d = (ctx.fit * 100) / Math.max(num(c.initial_zoom, 100), 1);
    const polar = rad(90 - num(c.initial_tilt, 25));
    const az = rad(num(c.initial_azimuth, 0));
    const t = controls.target;
    camera.position.set(
      t.x + d * Math.sin(polar) * Math.sin(az),
      t.y + d * Math.cos(polar),
      t.z + d * Math.sin(polar) * Math.cos(az)
    );
    controls.update();
  }

  /* ---------------- Home Assistant state ---------------- */

  set hass(hass) {
    this._hass = hass;
    if (this._ctx) {
      this._updateSun();
      this._updateLightStates();
      this._syncViewEntity();
    }
  }

  /* ---------------- lights ---------------- */

  _syncLights() {
    const ctx = this._ctx;
    if (!ctx) return;
    const { THREE } = ctx;
    const c = this._config;
    const list = (Array.isArray(c.lights) ? c.lights : []).filter(
      (l) => l && !l.disabled && Array.isArray(l.position) && l.position.length === 3
    );
    const key = JSON.stringify(list) + (this._config.lights_shadows === false ? "|noshadow" : "");
    if (key === ctx.lightsKey) return;
    ctx.lightsKey = key;

    for (const ls of ctx.lights) {
      ctx.group.remove(ls.light);
      if (ls.light.dispose) ls.light.dispose();
      ctx.group.remove(ls.marker);
      ls.marker.geometry.dispose();
      ls.marker.material.dispose();
    }
    ctx.lights = [];

    let shadowCount = 0;
    for (const l of list) {
      const dist = Math.max(0, num(l.distance, 8));
      const light = new THREE.PointLight(0xffffff, 0, dist, 2);
      light.position.set(num(l.position[0], 0), num(l.position[1], 0), num(l.position[2], 0));

      // every light with a shadow is expensive, hence at most 6
      const shadow = !!l.shadows && !l.glow_only && this._config.lights_shadows !== false;
      if (shadow) {
        shadowCount++;
        light.castShadow = false; // switched on dynamically: at most 6 currently lit lights get a shadow (in order of turning on)
        light.shadow.mapSize.set(512, 512);
        light.shadow.bias = -0.002;
        light.shadow.normalBias = 0.04;
        light.shadow.camera.near = 0.1;
        light.shadow.camera.far = dist > 0 ? dist : 30;
        light.shadow.radius = Math.max(0, num(l.softness, 3)); // blurring of the shadow edges
        light.shadow.autoUpdate = false; // the house is static, the shadow only needs to be rendered once
        light.shadow.needsUpdate = true;
      }
      ctx.group.add(light);

      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffcc00, depthTest: false, transparent: true, opacity: 0.9 })
      );
      marker.position.copy(light.position);
      marker.renderOrder = 999;
      ctx.group.add(marker);

      ctx.lights.push({
        cfg: l,
        light,
        marker,
        shadow,
        base: l.glow_only ? 0 : Math.max(0, num(l.intensity, 30)), // glow_only: the light does not illuminate the model, it only makes the window glow
        cur: 0,
        target: 0,
        colorTarget: new THREE.Color(0xffd9a0),
        wins: new Set(this._windowKeys(l.windows)),
      });
    }

    ctx.anyShadow = shadowCount > 0;
    this._applyShadowReceive();
    this._updateMarkers();
    this._updateLightStates();
  }

  _toColor(target, v) {
    const { THREE } = this._ctx;
    if (Array.isArray(v) && v.length >= 3) {
      target.setRGB(num(v[0], 255) / 255, num(v[1], 255) / 255, num(v[2], 255) / 255, THREE.SRGBColorSpace);
    } else if (typeof v === "string" && v.trim()) {
      target.set(v.trim());
    } else {
      target.set(0xffd9a0);
    }
  }

  _updateLightStates() {
    const ctx = this._ctx;
    if (!ctx) return;
    const hass = this._hass;
    for (const ls of ctx.lights) {
      const l = ls.cfg;
      let target = 0;
      let rgb = null;
      const ents = [l.entity, ...(Array.isArray(l.entities) ? l.entities : [])].filter(Boolean);
      if (this._config.lights_test || l.force_on || !ents.length) {
        target = 1;
      } else {
        // the light turns on when any entity is on; brightness = the highest of those on, color from the first one that is on and has a color
        let anyOn = false;
        let bright = null;
        for (const e of ents) {
          const st = hass && hass.states ? hass.states[e] : null;
          if (!st || st.state !== "on") continue;
          anyOn = true;
          const a = st.attributes || {};
          if (l.use_brightness !== false && typeof a.brightness === "number") {
            bright = Math.max(bright === null ? 0 : bright, a.brightness / 255);
          }
          if (!rgb && l.use_entity_color !== false && Array.isArray(a.rgb_color)) rgb = a.rgb_color;
        }
        if (anyOn) target = bright === null ? 1 : Math.max(0.05, bright);
      }
      if (ls.target === 0 && target > 0 && ls.shadow) {
        ls.light.shadow.needsUpdate = true;
        ctx.shadowFull = true;
      }
      ls.target = target;
      this._toColor(ls.colorTarget, rgb || l.color);
      ls.light.color.copy(ls.colorTarget);
    }
    this._assignShadows();
    this._updateNight();
    this._dirty = true;
  }

  // shadows (expensive) are given to at most 6 currently lit lights, chosen in the order they were turned on
  _assignShadows() {
    const ctx = this._ctx;
    if (!ctx) return;
    const order = (ctx.shadowOrder || []).filter((ls) => ls.target > 0 && ctx.lights.includes(ls));
    for (const ls of ctx.lights) if (ls.shadow && ls.target > 0 && !order.includes(ls)) order.push(ls);
    ctx.shadowOrder = order;
    const win = new Set(order.slice(0, 6));
    for (const ls of ctx.lights) {
      if (!ls.shadow) continue;
      const want = win.has(ls);
      if (ls.light.castShadow !== want) {
        ls.light.castShadow = want;
        if (want) ls.light.shadow.needsUpdate = true;
        ctx.shadowFull = true;
      }
    }
  }

  _updateMarkers() {
    const ctx = this._ctx;
    if (!ctx) return;
    const show = !!this._config.show_light_markers || !!this._pick;
    for (const ls of ctx.lights) ls.marker.visible = show;
    this._dirty = true;
  }

  // shadows from lights fall only on surfaces that receive them (not glass)
  _applyShadowReceive() {
    const ctx = this._ctx;
    if (!ctx || !ctx.model) return;
    ctx.model.traverse((o) => {
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      const transparent = ms.some((m) => m.userData.glb && m.userData.glb.glass);
      const want = !transparent;
      if (o.receiveShadow !== want) {
        o.receiveShadow = want;
        ms.forEach((m) => {
          m.needsUpdate = true;
        });
      }
    });
    this._refreshShadows();
  }

  _refreshShadows() {
    const ctx = this._ctx;
    if (!ctx) return;
    ctx.sun.shadow.needsUpdate = true;
    for (const ls of ctx.lights) if (ls.shadow) ls.light.shadow.needsUpdate = true;
    ctx.shadowFull = true;
    this._dirty = true;
  }

  /* ---------------- night ---------------- */

  _updateNight() {
    const ctx = this._ctx;
    if (!ctx) return;
    const c = this._config;
    const states = this._hass && this._hass.states ? this._hass.states : {};
    let n = 0;
    if (c.night === "on") n = 1;
    else if (c.night === "sun") {
      const si = this._sunInfo();
      if (si) n = 1 - Math.min(1, Math.max(0, (si.el + 4) / 12)); // smooth twilight: from -4 to 8 degrees above the horizon
      else n = states["sun.sun"] && states["sun.sun"].state === "below_horizon" ? 1 : 0;
    }
    else if (c.night === "entity" && c.night_entity) {
      const s = states[c.night_entity] ? states[c.night_entity].state : "";
      n = s === "on" || s === "below_horizon" || s === "night" ? 1 : 0;
    }
    ctx.nightTarget = n;
    this._dirty = true;
  }

  _applyNightLevel() {
    const ctx = this._ctx;
    const k = ctx.night;
    const amb = num(this._config.night_ambient, 0.15);
    const sk = ctx.sunK === undefined ? 1 : ctx.sunK;
    // at night the brightness of the whole scene (ambient light and sky) is multiplied by the "night brightness" value; the sun does not shine at night
    const lvl = 1 + (amb - 1) * k;
    ctx.scene.environmentIntensity = lvl * (0.8 + 0.2 * sk);
    ctx.hemi.intensity = 1.4 * lvl;
    ctx.sun.intensity = 0.8 * sk * (1 - k);
    if (ctx.sunColor) ctx.sun.color.copy(ctx.sunColor);
    else ctx.sun.color.setRGB(1, 1, 1);
  }

  _animate(ctx, dt) {
    let busy = false;
    for (const ls of ctx.lights) {
      const diff = ls.target - ls.cur;
      if (Math.abs(diff) > 0.001) {
        ls.cur += diff * (1 - Math.exp(-dt * 6));
        busy = true;
      } else {
        ls.cur = ls.target;
      }
      ls.light.intensity = ls.base * ls.cur;
    }
    this._updateWindowGlow(ctx);
    // smooth sun movement (shadows are recomputed when the position changes)
    if (ctx.sunTarget && ctx.sunDir && ctx.sunDir.distanceToSquared(ctx.sunTarget) > 1e-8) {
      ctx.sunDir.lerp(ctx.sunTarget, 1 - Math.exp(-dt * 3)).normalize();
      this._placeSun();
      busy = true;
    }
    const nd = ctx.nightTarget - ctx.night;
    if (Math.abs(nd) > 0.001) {
      ctx.night += nd * (1 - Math.exp(-dt * 3));
      this._applyNightLevel();
      busy = true;
    } else if (ctx.night !== ctx.nightTarget) {
      ctx.night = ctx.nightTarget;
      this._applyNightLevel();
      busy = true;
    }
    if (busy) this._dirty = true;
  }

  /* ---------------- picking a position by click ---------------- */

  _showHint(text) {
    this._hint.textContent = text;
    if (!this._hint.isConnected) this._wrap.appendChild(this._hint);
  }

  _onPickEvent(ev) {
    const d = ev.detail || {};
    const ctx = this._ctx;
    if (!ctx || !ctx.model || !this.isConnected || d.model !== this._config.model) return;
    this._pick = { token: d.token };
    ctx.renderer.domElement.style.cursor = "crosshair";
    this._showHint("Click a spot in the model (Esc = cancel)");
    this._updateMarkers();
  }

  _onPickCancel() {
    if (this._pick) this._endPick();
  }

  _onKey(ev) {
    if (ev.key === "Escape" && this._pick) this._endPick();
  }

  _endPick() {
    this._pick = null;
    if (this._ctx) this._ctx.renderer.domElement.style.cursor = "";
    this._hint.remove();
    this._updateMarkers();
  }

  _doPick(ev) {
    const ctx = this._ctx;
    if (!ctx || !ctx.model || !this._pick) return;
    const { THREE } = ctx;
    const el = ctx.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, ctx.camera);
    const hits = rc.intersectObject(ctx.model, true).filter((h) => {
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      // clicks go through glass and hidden surfaces to whatever is behind them
      return !(m && ((m.userData.glb && m.userData.glb.glass) || m.visible === false));
    });
    if (!hits.length) return;

    const h = hits[0];
    const n = h.face.normal
      .clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld))
      .normalize();
    if (n.dot(rc.ray.direction) > 0) n.negate();

    // floor -> light 2 m above it, ceiling -> 0.3 m below it, wall -> 0.4 m from the wall
    const p = h.point.clone();
    if (n.y > 0.7) p.y += 2.0;
    else if (n.y < -0.7) p.y -= 0.3;
    else p.addScaledVector(n, 0.4);

    ctx.group.updateMatrixWorld(true);
    ctx.group.worldToLocal(p);
    const point = [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100);

    window.dispatchEvent(
      new CustomEvent("glb-viewer-picked", { detail: { token: this._pick.token, point } })
    );
    this._endPick();
  }

  /* ---------------- materials: hiding by name ---------------- */

  _collectMaterials(root) {
    const ctx = this._ctx;
    ctx.mats = new Map(); // material name -> [material]
    root.traverse((o) => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (!m.userData.glb) {
          m.userData.glb = {
            glass: !!(m.transparent || m.opacity < 1),
            transparent: m.transparent,
            opacity: m.opacity,
            depthWrite: m.depthWrite,
            orig: {
              color: m.color ? m.color.clone() : null,
              opacity: m.opacity,
              transparent: m.transparent,
              depthWrite: m.depthWrite,
            },
          };
        }
        const key = m.name || "(unnamed)";
        if (!ctx.mats.has(key)) ctx.mats.set(key, []);
        const arr = ctx.mats.get(key);
        if (!arr.includes(m)) arr.push(m);
      });
    });
    ctx.matState = new Map();

    const list = [...ctx.mats].map(([name, ms]) => {
      const m = ms[0];
      const hex = m.color && m.color.getHexString ? m.color.getHexString() : "999999";
      const g = m.userData.glb;
      const oc = g.orig && g.orig.color ? g.orig.color.getHexString() : hex;
      return { name, color: `#${oc}`, glass: !!g.glass, opacity: g.orig ? g.orig.opacity : 1 };
    });
    window.__glbViewerInfo = window.__glbViewerInfo || {};
    const info = (window.__glbViewerInfo[this._config.model] =
      window.__glbViewerInfo[this._config.model] || {});
    info.materials = list;
  }

  // custom material colors and transparency from `material_colors`: [{ name, color: "#rrggbb", opacity: 0..1 }]
  _applyMaterialColors() {
    const ctx = this._ctx;
    if (!ctx || !ctx.mats) return;
    const list = Array.isArray(this._config.material_colors) ? this._config.material_colors : [];
    const map = new Map(list.filter((x) => x && x.name).map((x) => [String(x.name), x]));
    for (const [name, ms] of ctx.mats) {
      const o = map.get(name) || {};
      const hasOp = o.opacity !== undefined && o.opacity !== null && o.opacity !== "" && !isNaN(Number(o.opacity));
      ms.forEach((m) => {
        const g = m.userData.glb;
        if (m.color && g.orig && g.orig.color) {
          if (o.color) m.color.set(String(o.color));
          else m.color.copy(g.orig.color);
        }
        g.opacity = hasOp ? Math.max(0, Math.min(1, Number(o.opacity))) : g.orig.opacity;
        g.transparent = g.orig.transparent || g.opacity < 1;
        g.depthWrite = g.opacity < 1 ? false : g.orig.depthWrite;
      });
    }
    // new values are carried over to the current visibility level (without interrupting a running transition)
    for (const [name, ms] of ctx.mats) {
      const st = ctx.matState && ctx.matState.get(name);
      if (st) this._setMaterialLevel(ms, st.cur);
    }
    this._applyVisibility(false, !!ctx.deferShow);
    this._dirty = true;
  }

  // hides materials from `hidden_materials` and from the active view (smoothly, via transparency)
  _applyVisibility(instant = false, defer = false) {
    const ctx = this._ctx;
    if (!ctx || !ctx.mats) return;
    const c = this._config;
    const hide = new Set((Array.isArray(c.hidden_materials) ? c.hidden_materials : []).map(String));
    const av = this._activeView();
    if (av && Array.isArray(av.hide)) av.hide.forEach((n) => hide.add(String(n)));
    // material transparency in the active view: fade: [{ name, opacity: 0..1 }] (hidden surfaces take precedence)
    const lvl = new Map();
    if (av && Array.isArray(av.fade)) {
      av.fade.forEach((x) => {
        if (x && x.name) lvl.set(String(x.name), Math.max(0, Math.min(1, num(x.opacity, 1))));
      });
    }

    // transparency is enabled only for materials that are ever hidden (otherwise the shader would be recompiled on every change)
    const fade = new Set(hide);
    this._views().forEach((v) => {
      (Array.isArray(v.hide) ? v.hide : []).forEach((n) => fade.add(String(n)));
      (Array.isArray(v.fade) ? v.fade : []).forEach((x) => x && x.name && fade.add(String(x.name)));
    });

    for (const [name, ms] of ctx.mats) {
      let st = ctx.matState.get(name);
      if (!st) {
        st = { cur: 1, target: 1 };
        ctx.matState.set(name, st);
      }
      ms.forEach((m) => {
        const want = fade.has(name) ? true : m.userData.glb.transparent;
        if (m.transparent !== want) {
          m.transparent = want;
          m.needsUpdate = true;
        }
      });
      const level = hide.has(name) ? 0 : lvl.has(name) ? lvl.get(name) : 1;
      if (defer && level > 0 && st.target === 0) {
        // showing again (e.g. the roof when returning to the default view) waits for the end of the camera move
        ctx.deferShow = true;
        continue;
      }
      st.target = level;
      if (instant) {
        st.cur = st.target;
        this._setMaterialLevel(ms, st.cur);
      }
    }
    this._dirty = true;
  }

  // shadows are computed once with all surfaces visible (including the roof); hiding does not change them
  _renderFullShadows(ctx) {
    ctx.shadowFull = false;
    if (!ctx.mats) return;
    for (const ms of ctx.mats.values()) ms.forEach((m) => (m.visible = true));
    ctx.renderer.render(ctx.scene, ctx.camera);
    for (const [name, ms] of ctx.mats) {
      const st = ctx.matState && ctx.matState.get(name);
      const vis = st ? st.cur > 0.01 : true;
      ms.forEach((m) => (m.visible = vis));
    }
  }

  _setMaterialLevel(ms, level) {
    ms.forEach((m) => {
      const g = m.userData.glb;
      m.opacity = g.opacity * level;
      m.visible = level > 0.01;
      m.depthWrite = level >= 0.99 ? g.depthWrite : false;
    });
  }

  _animateMaterials(ctx, dt) {
    if (!ctx.matState) return false;
    let busy = false;
    for (const [name, st] of ctx.matState) {
      if (st.cur === st.target) continue;
      const diff = st.target - st.cur;
      st.cur = Math.abs(diff) < 0.01 ? st.target : st.cur + diff * (1 - Math.exp(-dt * 5));
      this._setMaterialLevel(ctx.mats.get(name), st.cur);
      busy = true;
    }
    return busy;
  }


  /* ---------------- windows: glow of window glass when the room light is on ---------------- */

  // windows: a material named window_ / glass_ + <room>; (fallback: an equally named object in the model)
  _collectWindows(root) {
    const ctx = this._ctx;
    const re = /^(?:window|glass)_(.+)$/i;
    const wins = {};
    const clones = new Map();
    root.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material)) return;
      const m = o.material;
      let r = re.exec(m.name || "");
      let own = !!r;
      if (!r) r = re.exec(o.name || "");
      if (!r) return;
      const id = r[1].toLowerCase();
      let mat = m;
      if (!own) {
        // window recognized only by its object: it gets its own copy of the material so it can glow on its own
        const ck = id + "|" + m.uuid;
        mat = clones.get(ck);
        if (!mat) {
          mat = m.clone();
          clones.set(ck, mat);
        }
        o.material = mat;
      }
      if (mat.emissive && !mat.userData.winInit) {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 1;
        mat.userData.winInit = true;
      }
      const w = (wins[id] = wins[id] || { mats: [] });
      if (!w.mats.includes(mat)) w.mats.push(mat);
    });
    ctx.windows = wins;
    return Object.keys(wins);
  }

  _windowKeys(text) {
    return String(text || "")
      .split(/[,;\s]+/)
      .map((x) => x.trim().toLowerCase().replace(/^(window|glass)_/, ""))
      .filter(Boolean);
  }

  _updateWindowGlow(ctx) {
    if (!ctx.windows) return;
    const gain = Math.max(0, num(this._config.window_glow, 1));
    const nf = 0.2 + 0.8 * (ctx.night || 0); // weaker by day, full at night
    let changed = false;
    for (const id of Object.keys(ctx.windows)) {
      let best = null;
      for (const ls of ctx.lights) {
        if (ls.wins && ls.wins.has(id) && (!best || ls.cur > best.cur)) best = ls;
      }
      const lvl = best ? best.cur * nf * gain : 0;
      // the glow uses the glass material color (set in the materials); the material transparency naturally weakens it
      for (const m of ctx.windows[id].mats) {
        if (!m.emissive || !m.color) continue;
        // glow color: from the light entity (if "window_entity_color" is on), otherwise the material color
        const c = lvl > 0 ? (best && best.cfg.window_entity_color ? best.light.color : m.color) : null;
        const r = c ? c.r : 0, g = c ? c.g : 0, b = c ? c.b : 0;
        if (m.emissiveIntensity !== lvl || m.emissive.r !== r || m.emissive.g !== g || m.emissive.b !== b) {
          m.emissive.setRGB(r, g, b);
          m.emissiveIntensity = lvl;
          changed = true;
        }
      }
    }
    if (changed) this._dirty = true;
  }

  /* ---------------- real sun: direction, shadows, brightness ---------------- */

  // azimuth/elevation from the sun.sun entity (or `sun_entity`)
  _sunInfo() {
    const c = this._config;
    if (c.night !== "sun") return null; // the sun is tracked only in the "By the sun" night mode
    const st = this._hass && this._hass.states ? this._hass.states[c.sun_entity || "sun.sun"] : null;
    const a = st && st.attributes;
    if (!a) return null;
    const az = parseFloat(a.azimuth);
    const el = parseFloat(a.elevation);
    return isNaN(az) || isNaN(el) ? null : { az, el };
  }

  _updateSun(instant = false) {
    const ctx = this._ctx;
    if (!ctx || !ctx.center) return;
    const { THREE } = ctx;
    const info = this._sunInfo();
    // azimuth (compass direction) the front of the model (+z) faces; 180 = front faces south
    const c = this._config;
    const front = !isEmpty(c.front_azimuth) ? num(c.front_azimuth, 180) : 180 + num(c.north_offset, 0);
    const key = info ? `${info.az}|${info.el}|${front}` : "none";
    if (key === ctx.sunKey && !instant) return;
    ctx.sunKey = key;
    // console diagnostics (F12): why the sun entity is or is not tracked
    if (info) console.info("[glb-viewer] sun: azimuth", info.az, "elevacia", info.el, "front side", front);
    else {
      const eid = c.sun_entity || "sun.sun";
      const why =
        c.night !== "sun" ? "night mode is not set to By the sun"
        : !this._hass || !this._hass.states ? "the card does not have hass yet"
        : !this._hass.states[eid] ? "entity " + eid + " does not exist"
        : "entity has no azimuth/elevation attributes";
      if (ctx.sunWhy !== why) console.warn("[glb-viewer] sun is not tracked (fixed shadows):", why);
      ctx.sunWhy = why;
    }
    if (!info) {
      ctx.sunTarget = null;
      ctx.sunDir = null;
      ctx.sunK = 1;
      ctx.sunColor = null;
    } else {
      // front = +z of the scene, right side = +x; the angle is measured clockwise from above
      const rel = rad(info.az - front);
      const el = rad(Math.max(info.el, 3));
      const local = new THREE.Vector3(-Math.sin(rel) * Math.cos(el), Math.sin(el), Math.cos(rel) * Math.cos(el));
      // the direction is computed in scene coordinates (not the model's): the model rotation/mirroring settings do not apply,
      // front = the side you see at camera rotation 0 degrees
      ctx.sunTarget = local.normalize();
      if (!ctx.sunDir || instant) ctx.sunDir = ctx.sunTarget.clone();
      // brightness by sun height and a warmer color near the horizon
      const sinE = Math.sin(rad(Math.max(info.el, 0)));
      ctx.sunK = 0.35 + 0.65 * Math.min(1, sinE / 0.8);
      const warm = Math.min(1, Math.max(0, (info.el - 3) / 25));
      ctx.sunColor = new THREE.Color(1, 0.62, 0.38).lerp(new THREE.Color(1, 1, 1), warm);
    }
    this._placeSun();
    this._applyNightLevel();
    this._updateNight();
  }

  _placeSun() {
    const ctx = this._ctx;
    if (!ctx || !ctx.center || !ctx.radius) return;
    const r = ctx.radius;
    const sun = ctx.sun;
    if (ctx.sunDir) sun.position.copy(ctx.center).addScaledVector(ctx.sunDir, r * 2.2);
    else sun.position.set(ctx.center.x + r * 0.8, ctx.center.y + r * 2, ctx.center.z + r * 0.6);
    sun.target.position.copy(ctx.center);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    sun.shadow.needsUpdate = true;
    ctx.shadowFull = true;
    this._dirty = true;
  }

  /* ---------------- camera views ---------------- */

  _views() {
    return Array.isArray(this._config.views) ? this._config.views.filter((v) => v && v.name) : [];
  }

  _activeView() {
    return this._view ? this._views().find((v) => v.name === this._view) || null : null;
  }

  // target camera state for a view (null = default view of the whole house)
  _viewState(v) {
    const ctx = this._ctx;
    const { THREE } = ctx;
    const c = this._config;
    ctx.group.updateMatrixWorld(true);
    let target = ctx.center.clone();
    if (v && Array.isArray(v.target) && v.target.length === 3) {
      target = ctx.group.localToWorld(
        new THREE.Vector3(num(v.target[0], 0), num(v.target[1], 0), num(v.target[2], 0))
      );
    }
    const az = rad(num(v ? v.azimuth : undefined, num(c.initial_azimuth, 0)));
    const tilt = num(v ? v.tilt : undefined, num(c.initial_tilt, 25));
    const zoom = Math.max(num(v ? v.zoom : undefined, num(c.initial_zoom, 100)), 1);
    return {
      target,
      theta: az,
      phi: rad(90 - tilt),
      r: (ctx.fit * 100) / zoom,
    };
  }

  _currentSpherical() {
    const { camera, controls } = this._ctx;
    const off = camera.position.clone().sub(controls.target);
    const r = Math.max(off.length(), 1e-6);
    return {
      target: controls.target.clone(),
      r,
      phi: Math.acos(Math.max(-1, Math.min(1, off.y / r))),
      theta: Math.atan2(off.x, off.z),
    };
  }

  _placeCamera(s) {
    const { camera, controls } = this._ctx;
    const t = s.target;
    controls.target.copy(t);
    camera.position.set(
      t.x + s.r * Math.sin(s.phi) * Math.sin(s.theta),
      t.y + s.r * Math.cos(s.phi),
      t.z + s.r * Math.sin(s.phi) * Math.cos(s.theta)
    );
    controls.update();
  }

  _goToView(name, opts = {}) {
    const ctx = this._ctx;
    if (!ctx || !ctx.model || !ctx.fit) return;
    let v = name ? this._views().find((x) => x.name === name) : null;
    if (name && !v) name = null;
    this._view = name || null;
    this._renderViewBar();
    ctx.deferShow = false;
    this._applyVisibility(!!opts.instant, !opts.instant);
    this._applyLimits();

    const to = this._viewState(v);
    clearTimeout(this._arTimer);
    ctx.controls.autoRotate = false;
    if (opts.instant) {
      ctx.tween = null;
      this._placeCamera(to);
      this._armAutoRotate();
    } else {
      // limits are open during the move, otherwise the new (narrower) limits would immediately "pull" the camera and the move would jump at the start;
      // the limits are set only after the move ends
      this._openLimits();
      const secs = num(v ? v.duration : undefined, num(this._config.view_duration, 1.5));
      ctx.tween = {
        t0: performance.now(),
        dur: Math.max(secs, 0.01) * 1000,
        from: this._currentSpherical(),
        to,
      };
    }
    this._dirty = true;
  }

  // auto-rotate: enabled in the configuration and not stopped by the button on the card
  _autoOn() {
    // in a view other than the default, rotation is turned off (this._view is set in _goToView)
    return !!this._config.auto_rotate && !this._autoPaused && !this._view;
  }

  _updatePlayBtn() {
    const b = this._playBtn;
    if (!b) return;
    const show = !!this._config.auto_rotate && this._config.show_play_button !== false;
    b.style.display = show ? "" : "none";
    const icon = this._autoPaused ? "mdi:play" : "mdi:pause";
    b.title = this._autoPaused ? "Start rotation" : "Stop rotation";
    if (b._icon.getAttribute("icon") !== icon) b._icon.setAttribute("icon", icon);
  }

  _toggleAuto() {
    this._autoPaused = !this._autoPaused;
    this._updatePlayBtn();
    const ctx = this._ctx;
    if (!ctx) return;
    clearTimeout(this._arTimer);
    ctx.controls.autoRotate = !this._autoPaused && this._autoOn() && !ctx.interacting;
    this._dirty = true;
  }

  _openLimits() {
    const { controls } = this._ctx;
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
  }

  // after the move ends (or is interrupted), materials whose showing was deferred appear
  // after a view is edited in the editor, the card (even a newly created one) immediately switches to the edited view
  _applyFocus() {
    const f = window.__glbViewerFocus;
    const ctx = this._ctx;
    if (!f || !ctx || !ctx.model || !this._config || f.model !== this._config.model) return;
    if (Date.now() - f.t > 15000 || f.seq === this._focusSeq) return;
    this._focusSeq = f.seq;
    if (this._views().some((v) => v.name === f.name)) this._goToView(f.name, { instant: true });
  }

  _flushShow() {
    const ctx = this._ctx;
    if (ctx && ctx.deferShow) {
      ctx.deferShow = false;
      this._applyVisibility(false, false);
    }
  }

  _stepTween(ctx, now) {
    const tw = ctx.tween;
    if (!tw) return;
    const k = Math.max(0, Math.min((now - tw.t0) / tw.dur, 1));
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    let dTheta = tw.to.theta - tw.from.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta)); // shortest way around the house
    this._placeCamera({
      target: tw.from.target.clone().lerp(tw.to.target, e),
      theta: tw.from.theta + dTheta * e,
      phi: tw.from.phi + (tw.to.phi - tw.from.phi) * e,
      r: tw.from.r + (tw.to.r - tw.from.r) * e,
    });
    this._dirty = true;
    if (k >= 1) {
      ctx.tween = null;
      this._applyLimits();
      this._flushShow();
      this._armAutoRotate();
    }
  }

  _armAutoRotate() {
    const ctx = this._ctx;
    if (!ctx) return;
    clearTimeout(this._arTimer);
    ctx.controls.autoRotate = false;
    if (this._autoOn()) {
      this._arTimer = setTimeout(() => {
        if (this._ctx === ctx) ctx.controls.autoRotate = true;
      }, Math.max(0, num(this._config.auto_rotate_delay, 3000)));
    }
  }

  _renderViewBar() {
    if (!this._bar) return;
    const c = this._config;
    const views = this._views();
    if (this._view && !views.some((v) => v.name === this._view)) this._view = null;
    if (c.show_view_buttons === false || !views.length) {
      this._bar.remove();
      return;
    }
    this._bar.innerHTML = "";
    const add = (label, name) => {
      const b = document.createElement("button");
      b.className = (this._view || null) === name ? "chip active" : "chip";
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this._onViewButton(name);
      });
      this._bar.appendChild(b);
    };
    add(c.home_label || "Whole house", null);
    views.forEach((v) => add(v.name, v.name));
    if (!this._bar.isConnected) this._wrap.appendChild(this._bar);
  }

  _onViewButton(name) {
    const c = this._config;
    if (c.view_entity && this._hass && String(c.view_entity).startsWith("input_select.")) {
      this._hass.callService("input_select", "select_option", {
        entity_id: c.view_entity,
        option: name || c.home_label || "Whole house",
      });
      this._lastEntityView = name || c.home_label || "Whole house";
    }
    this._goToView(name);
  }

  // view by entity state (input_select); option names = view names
  _syncViewEntity(instant = false) {
    const ctx = this._ctx;
    const c = this._config;
    if (!ctx || !ctx.model || !c.view_entity || !this._hass || !this._hass.states) return;
    const st = this._hass.states[c.view_entity];
    if (!st) return;
    if (st.state === this._lastEntityView && !instant) return;
    this._lastEntityView = st.state;
    const name = this._views().some((v) => v.name === st.state) ? st.state : null;
    if (name === (this._view || null) && !instant) return;
    this._goToView(name, { instant });
  }

  // card in the editor dialog (preview)
  _inEditor() {
    let el = this;
    while (el) {
      const n = el.localName;
      if (n === "hui-card-preview" || n === "hui-dialog-edit-card" || n === "hui-card-element-editor") return true;
      el = el.parentNode || el.host;
    }
    return false;
  }

  // which card saves the view: first the card in the editor preview, otherwise the one last interacted with
  _captureOwner(model) {
    const cards = [...(window.__glbViewerCards || [])].filter(
      (c) => c.isConnected && c._ctx && c._ctx.model && c._config && c._config.model === model
    );
    const inEd = cards.filter((c) => c._inEditor());
    const pool = inEd.length ? inEd : cards;
    const last = window.__glbViewerLastInteract;
    if (last && pool.includes(last)) return last;
    return pool[pool.length - 1] || null;
  }

  _onCaptureEvent(ev) {
    const d = ev.detail || {};
    const ctx = this._ctx;
    if (!ctx || !ctx.model || !this.isConnected || d.model !== this._config.model) return;
    const owner = this._captureOwner(d.model);
    if (owner && owner !== this) return;
    const s = this._currentSpherical();
    ctx.group.updateMatrixWorld(true);
    const t = ctx.group.worldToLocal(s.target.clone());
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;
    const view = {
      azimuth: r1((s.theta * 180) / Math.PI),
      tilt: r1(90 - (s.phi * 180) / Math.PI),
      zoom: Math.round((ctx.fit * 100) / s.r),
      target: [r2(t.x), r2(t.y), r2(t.z)],
    };
    window.dispatchEvent(new CustomEvent("glb-viewer-captured", { detail: { token: d.token, view } }));
  }

  _onGotoEvent(ev) {
    const d = ev.detail || {};
    if (!this._ctx || !this.isConnected || d.model !== this._config.model) return;
    this._goToView(d.name || null);
  }
}

/* ------------------------------------------------------------------ */
/* Visual editor                                                      */
/* ------------------------------------------------------------------ */

const LABELS = {
  model: "Path to the GLB model (e.g. /local/dom/dom.glb)",
  title: "Title (optional)",
  width: "Card width (e.g. 600px or 80%, empty = full width)",
  height: "Card height (e.g. 400px)",
  hide_border: "Hide card border and shadow",
  lights_shadows: "Shadows from lights (all lights)",
  lights_test: "Turn on all lights (test)",
  background: "Card background (e.g. rgba(0, 0, 0, 0.5), empty = theme default)",
  model_yaw: "Model rotation (around the vertical axis)",
  model_pitch: "Model tilt forward/backward",
  model_roll: "Model tilt sideways",
  flip_x: "Mirror along the X axis",
  flip_z: "Mirror along the Z axis",
  min_tilt: "Tilt – minimum (lowest view)",
  max_tilt: "Tilt – maximum (highest view)",
  initial_tilt: "Tilt – initial",
  min_azimuth: "Rotation – minimum (°, empty = no limit)",
  max_azimuth: "Rotation – maximum (°, empty = no limit)",
  initial_azimuth: "Rotation – initial",
  min_zoom: "Zoom – farthest",
  max_zoom: "Zoom – closest",
  initial_zoom: "Zoom – initial",
  auto_rotate: "Auto-rotate",
  auto_rotate_delay: "Pause after touch before rotation resumes",
  rotation_per_second: "Auto-rotate speed (°/s)",
  enable_pan: "Panning (right button / Shift+drag / two fingers)",
  page_scroll: "Touch: finger scrolls the page (disables tilting by touch)",
  exposure: "Exposure",
  shadow_intensity: "Intensity of the ground shadow under the house",
  environment: "Environment (neutral / legacy / URL of an .hdr or image)",
  light_color: "Light color (CSS, e.g. #ffd9a0; empty = off)",
  night: "Night (scene darkening)",
  night_entity: "Night entity (on or below the horizon = night)",
  night_ambient: "Minimum scene brightness at night",
  window_glow: "Window glow when the light is on",
  front_azimuth: "The front of the house faces (°)",
  show_light_markers: "Show light positions (helper points)",
  home_label: "Name of the default view (button)",
  view_entity: "input_select entity for views (optional)",
  show_view_buttons: "Show view buttons on the card",
  show_reload_button: "Show the model reload button",
  show_play_button: "Show the play/stop button for auto-rotate",
  view_duration: "Camera transition duration (s)",
};

const HELPERS = {
  model_yaw: "If the house is turned the wrong way, set 90, 180 or -90 here",
  flip_x: "If the house is mirrored, try X; if that does not help, try Z",
  model_pitch: "Use only if the house is lying on its side or upside down",
  min_tilt: "0° = from ground level, 90° = straight from above",
  max_tilt: "Higher value = view more from above",
  min_zoom: "100 % = the whole house fits in the card, lower = farther away",
  max_zoom: "Higher value = closer (200 % = twice as close)",
  initial_zoom: "100 % = the whole house fits in the card",
  light_color: "Takes precedence over the Environment field. Darker color = darker model",
  night: "At night the scene darkens so the light from the rooms is visible",
  night_ambient: "Brightness never drops below this value, however dark it is outside: 0 = complete darkness, 1 = same as daytime",
  front_azimuth: "Compass direction that the side of the house seen in the initial view (camera rotation 0°) faces: 0 = north, 90 = east, 180 = south, 270 = west",
  show_light_markers: "Yellow spheres at the light positions, visible through walls",
  view_entity:
    "The input_select options must have the same names as the views (and the name of the default view). The buttons on the card set it and the card follows it.",
};

const deg = (min, max, mode = "slider") => ({
  number: { min, max, step: 1, mode, unit_of_measurement: "°" },
});
const pct = { number: { min: 20, max: 3000, step: 10, mode: "slider", unit_of_measurement: "%" } };

const SCHEMA = [
  { name: "model", required: true, selector: { text: {} } },
  { name: "title", selector: { text: {} } },
  {
    name: "",
    type: "grid",
    flatten: true,
    schema: [
      { name: "width", selector: { text: {} } },
      { name: "height", selector: { text: {} } },
    ],
  },
  { name: "background", selector: { text: {} } },
  { name: "hide_border", selector: { boolean: {} } },
  { name: "lights_shadows", selector: { boolean: {} } },
  { name: "lights_test", selector: { boolean: {} } },
  {
    name: "",
    type: "expandable",
    flatten: true,
    title: "Model orientation",
    schema: [
      { name: "model_yaw", selector: deg(-180, 180) },
      { name: "model_pitch", selector: deg(-180, 180) },
      { name: "model_roll", selector: deg(-180, 180) },
      { name: "flip_x", selector: { boolean: {} } },
      { name: "flip_z", selector: { boolean: {} } },
    ],
  },
  {
    name: "",
    type: "expandable",
    flatten: true,
    title: "Tilt (Y axis)",
    schema: [
      { name: "min_tilt", selector: deg(0, 90) },
      { name: "max_tilt", selector: deg(0, 90) },
      { name: "initial_tilt", selector: deg(0, 90) },
    ],
  },
  {
    name: "",
    type: "expandable",
    flatten: true,
    title: "Rotation (X axis)",
    schema: [
      { name: "min_azimuth", selector: deg(-360, 360, "box") },
      { name: "max_azimuth", selector: deg(-360, 360, "box") },
      { name: "initial_azimuth", selector: deg(-360, 360, "box") },
      { name: "auto_rotate", selector: { boolean: {} } },
      {
        name: "rotation_per_second",
        selector: {
          number: { min: 1, max: 180, step: 1, mode: "slider", unit_of_measurement: "°/s" },
        },
      },
      {
        name: "auto_rotate_delay",
        selector: {
          number: { min: 0, max: 10000, step: 100, mode: "slider", unit_of_measurement: "ms" },
        },
      },
      { name: "enable_pan", selector: { boolean: {} } },
      { name: "page_scroll", selector: { boolean: {} } },
    ],
  },
  {
    name: "",
    type: "expandable",
    flatten: true,
    title: "Zoom",
    schema: [
      { name: "min_zoom", selector: pct },
      { name: "max_zoom", selector: pct },
      { name: "initial_zoom", selector: pct },
    ],
  },
  {
    name: "",
    type: "expandable",
    flatten: true,
    title: "Appearance",
    schema: [
      { name: "exposure", selector: { number: { min: 0, max: 4, step: 0.1, mode: "slider" } } },
      {
        name: "shadow_intensity",
        selector: { number: { min: 0, max: 4, step: 0.1, mode: "slider" } },
      },
      { name: "light_color", selector: { text: {} } },
      { name: "environment", selector: { text: {} } },
    ],
  },
  {
    name: "",
    type: "expandable",
    flatten: true,
    title: "Night and light helper points",
    schema: [
      {
        name: "night",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "off", label: "Off (always day)" },
              { value: "on", label: "Always night" },
              { value: "sun", label: "By the sun (sun.sun) - shadows and brightness follow the real sun" },
              { value: "entity", label: "By entity" },
            ],
          },
        },
      },
      { name: "night_entity", selector: { entity: {} } },
      { name: "night_ambient", selector: { number: { min: 0, max: 1, step: 0.05, mode: "slider" } } },
      { name: "window_glow", selector: { number: { min: 0, max: 3, step: 0.1, mode: "slider" } } },
      { name: "front_azimuth", selector: { number: { min: 0, max: 360, step: 5, mode: "slider", unit_of_measurement: "°" } } },
      { name: "show_light_markers", selector: { boolean: {} } },
    ],
  },
  {
    name: "",
    type: "expandable",
    flatten: true,
    title: "Camera view settings",
    schema: [
      { name: "home_label", selector: { text: {} } },
      { name: "view_entity", selector: { entity: { domain: "input_select" } } },
      { name: "show_view_buttons", selector: { boolean: {} } },
      { name: "show_reload_button", selector: { boolean: {} } },
      { name: "show_play_button", selector: { boolean: {} } },
      {
        name: "view_duration",
        selector: { number: { min: 0.2, max: 5, step: 0.1, mode: "slider", unit_of_measurement: "s" } },
      },
    ],
  },
];

/* ---------------- lights ---------------- */

const LIGHT_LABELS = {
  window_entity_color: "Window glows in the entity color (otherwise in the material color)",
  glow_only: "Window glow only (the light does not illuminate the model)",
  disabled: "Light disabled (not used, stays saved)",
  windows: "Windows that glow with this light (e.g. kitchen, livingroom)",
  name: "Name",
  entities: "Entities (the light turns on when any of them is on)",
  x: "Position X (m)",
  y: "Position Y – height (m)",
  z: "Position Z (m)",
  color: "Light color",
  intensity: "Intensity",
  distance: "Range (m, 0 = unlimited)",
  shadows: "Shadows (walls block the light, glass lets it through)",
  softness: "Shadow softness (blurs the shadow edges outdoors)",
  use_entity_color: "Use color from the entity",
  use_brightness: "Use brightness from the entity",
};

const LIGHT_HELPERS = {
  entities: "Empty = the light is always on",
  x: "Model coordinates in meters",
  intensity: "Typical room 20 to 60",
  shadows: "Performance-heavy, at most 3 lights with shadows recommended",
  softness: "Applies only with shadows. Higher number = softer edges; large values may show banding",
  use_entity_color: "If the entity has a color (rgb_color), it is used instead of the color below",
};

const coord = { number: { mode: "box", step: 0.05, unit_of_measurement: "m" } };

const LIGHT_SCHEMA = [
  { name: "name", selector: { text: {} } },
  { name: "disabled", selector: { boolean: {} } },
  { name: "windows", selector: { text: {} } },
  { name: "glow_only", selector: { boolean: {} } },
  { name: "window_entity_color", selector: { boolean: {} } },
  { name: "entities", selector: { entity: { multiple: true, domain: ["light", "switch", "input_boolean"] } } },
  {
    name: "",
    type: "grid",
    flatten: true,
    schema: [
      { name: "x", selector: coord },
      { name: "y", selector: coord },
      { name: "z", selector: coord },
    ],
  },
  { name: "color", selector: { color_rgb: {} } },
  { name: "intensity", selector: { number: { min: 0, max: 200, step: 1, mode: "slider" } } },
  {
    name: "distance",
    selector: { number: { min: 0, max: 30, step: 0.5, mode: "slider", unit_of_measurement: "m" } },
  },
  { name: "shadows", selector: { boolean: {} } },
  { name: "softness", selector: { number: { min: 0, max: 10, step: 0.5, mode: "slider" } } },
  { name: "use_entity_color", selector: { boolean: {} } },
  { name: "use_brightness", selector: { boolean: {} } },
];

const DEFAULT_LIGHT_COLOR = [255, 217, 160];
const hasBounds = (info) => !!(info && Array.isArray(info.min) && Array.isArray(info.max));
const centerOf = (info) => [
  (info.min[0] + info.max[0]) / 2,
  (info.min[1] + info.max[1]) / 2,
  (info.min[2] + info.max[2]) / 2,
];
const round2 = (v) => Math.round(num(v, 0) * 100) / 100;

function parseColor(v) {
  if (Array.isArray(v) && v.length >= 3) return v.slice(0, 3).map((x) => Math.round(num(x, 255)));
  if (typeof v === "string") {
    const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
  }
  return DEFAULT_LIGHT_COLOR.slice();
}

function lightToForm(l) {
  const p = Array.isArray(l.position) ? l.position : [];
  return {
    name: l.name || "",
    disabled: !!l.disabled,
    glow_only: !!l.glow_only,
    window_entity_color: !!l.window_entity_color,
    windows: l.windows || "",
    entities: [l.entity, ...(Array.isArray(l.entities) ? l.entities : [])].filter((e, i, a) => e && a.indexOf(e) === i),
    x: num(p[0], 0),
    y: num(p[1], 2.2),
    z: num(p[2], 0),
    color: parseColor(l.color),
    intensity: num(l.intensity, 30),
    distance: num(l.distance, 8),
    shadows: !!l.shadows,
    softness: num(l.softness, 3),
    use_entity_color: l.use_entity_color !== false,
    use_brightness: l.use_brightness !== false,
  };
}

function formToLight(f) {
  const out = {};
  if (f.name) out.name = f.name;
  if (f.disabled) out.disabled = true;
  if (f.glow_only) out.glow_only = true;
  if (f.window_entity_color) out.window_entity_color = true;
  if (f.windows && String(f.windows).trim()) out.windows = String(f.windows).trim();
  const ents = Array.isArray(f.entities) ? f.entities.filter(Boolean) : [];
  if (ents.length === 1) out.entity = ents[0];
  else if (ents.length > 1) out.entities = ents;
  out.position = [round2(f.x), round2(f.y), round2(f.z)];
  out.color = parseColor(f.color);
  out.intensity = num(f.intensity, 30);
  out.distance = num(f.distance, 8);
  if (f.shadows) out.shadows = true;
  if (f.shadows && num(f.softness, 3) !== 3) out.softness = num(f.softness, 3);
  if (f.use_entity_color === false) out.use_entity_color = false;
  if (f.use_brightness === false) out.use_brightness = false;
  return out;
}

/* ---------------- camera views ---------------- */

const VIEW_LABELS = {
  name: "View name (button)",
  azimuth: "Camera rotation (°)",
  tilt: "Camera tilt (°)",
  zoom: "Zoom",
  x: "Target X (m)",
  y: "Target Y (m)",
  z: "Target Z (m)",
  duration: "Transition duration (s, 0 = default)",
};

const VIEW_HELPERS = {
  azimuth: "Easiest: set the camera in the preview and click Save current camera view",
  x: "Point in the model the camera looks at (model coordinates)",
};

const VIEW_SCHEMA = [
  { name: "name", selector: { text: {} } },
  {
    name: "",
    type: "grid",
    flatten: true,
    schema: [
      { name: "azimuth", selector: { number: { mode: "box", step: 1, unit_of_measurement: "°" } } },
      { name: "tilt", selector: { number: { min: 0, max: 90, step: 1, mode: "box", unit_of_measurement: "°" } } },
    ],
  },
  { name: "zoom", selector: { number: { min: 20, max: 3000, step: 10, mode: "slider", unit_of_measurement: "%" } } },
  {
    name: "",
    type: "grid",
    flatten: true,
    schema: [
      { name: "x", selector: coord },
      { name: "y", selector: coord },
      { name: "z", selector: coord },
    ],
  },
  {
    name: "duration",
    selector: { number: { min: 0, max: 10, step: 0.1, mode: "box", unit_of_measurement: "s" } },
  },
];

function viewToForm(v, info) {
  const t = Array.isArray(v.target) ? v.target : null;
  const c = hasBounds(info) ? centerOf(info) : [0, 0, 0];
  return {
    name: v.name || "",
    azimuth: num(v.azimuth, 30),
    tilt: num(v.tilt, 25),
    zoom: num(v.zoom, 100),
    x: num(t ? t[0] : undefined, c[0]),
    y: num(t ? t[1] : undefined, c[1]),
    z: num(t ? t[2] : undefined, c[2]),
    duration: num(v.duration, 0),
  };
}

function formToView(f, prev) {
  const out = {
    name: f.name || "",
    azimuth: Math.round(num(f.azimuth, 0) * 10) / 10,
    tilt: Math.round(num(f.tilt, 0) * 10) / 10,
    zoom: Math.round(num(f.zoom, 100)),
    target: [round2(f.x), round2(f.y), round2(f.z)],
  };
  if (prev && Array.isArray(prev.hide) && prev.hide.length) out.hide = prev.hide.slice();
  if (prev && Array.isArray(prev.fade) && prev.fade.length) out.fade = prev.fade.map((x) => ({ ...x }));
  if (num(f.duration, 0) > 0) out.duration = num(f.duration, 0);
  return out;
}

const EDITOR_CSS = `
  .lights h3 { margin: 24px 0 4px; font-size: 16px; font-weight: 500; }
  .lights p { margin: 0 0 12px; color: var(--secondary-text-color); font-size: 13px; }
  .lights details { border: 1px solid var(--divider-color); border-radius: 12px; margin: 8px 0; padding: 0 16px; }
  .lights summary { cursor: pointer; padding: 14px 0; font-weight: 500; }
  .lights .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 16px; }
  .lights button { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--primary-color);
    background: transparent; color: var(--primary-color); font: inherit; cursor: pointer; }
  .lights button.primary, .lights button.active { background: var(--primary-color);
    color: var(--text-primary-color, #fff); }
  .lights button.danger { border-color: var(--error-color); color: var(--error-color); }
  .lights .warn { color: var(--warning-color, #ff9800); font-size: 13px; margin: 8px 0; }
  .lights .mats { display: flex; flex-direction: column; gap: 2px; margin: 4px 0 12px; }
  .lights .mats label { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
  .lights .mats .sw { width: 18px; height: 18px; border-radius: 4px; border: 1px solid var(--divider-color); flex: none; }
  .lights .mats .nm { flex: 1; }
  .lights .mats .tag { font-size: 12px; color: var(--secondary-text-color); }
  .lights .cols { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 12px; }
  .lights .col { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0;
    border-bottom: 1px solid var(--divider-color); }
  .lights .col .nm { flex: 1 1 140px; min-width: 120px; }
  .lights .col input[type=color] { width: 40px; height: 28px; padding: 0; border: 1px solid var(--divider-color);
    border-radius: 6px; background: none; cursor: pointer; }
  .lights .col input[type=range] { flex: 1 1 120px; min-width: 100px; }
  .lights .col .pc { width: 40px; text-align: right; font-size: 13px; color: var(--secondary-text-color); }
  .lights .col button { padding: 4px 10px; }
  .lights .col.changed .nm { font-weight: 500; }
  .lights h4 { margin: 12px 0 4px; font-size: 14px; font-weight: 500; }
`;

const MAT_PREFIXES = ["wall_", "roof_", "window_", "glass_", "color_", "floor_", "door_"];
const ARRAY_KEYS = ["lights", "views", "hidden_materials", "material_colors"];

// JSON with sorted keys so key order does not affect equality
const stable = (v) =>
  JSON.stringify(v, (k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]))
      : x
  );

class DomViewerCardEditor extends HTMLElement {
  constructor() {
    super();
    this._onPicked = this._onPicked.bind(this);
    this._onCaptured = this._onCaptured.bind(this);
    this._onInfo = this._onInfo.bind(this);
    this._lights = [];
    this._views = [];
    this._hidden = [];
    this._colors = [];
    this._main = {};
    this._lightForms = [];
    this._viewForms = [];
    this._pickBtns = [];
    this._pickIdx = null;
    this._pickToken = null;
    this._capIdx = null;
    this._capToken = null;
  }

  connectedCallback() {
    window.addEventListener("glb-viewer-picked", this._onPicked);
    window.addEventListener("glb-viewer-captured", this._onCaptured);
    window.addEventListener("glb-viewer-info", this._onInfo);
  }

  disconnectedCallback() {
    window.removeEventListener("glb-viewer-picked", this._onPicked);
    window.removeEventListener("glb-viewer-captured", this._onCaptured);
    window.removeEventListener("glb-viewer-info", this._onInfo);
    this._cancelPick();
  }

  setConfig(config) {
    // a change we sent ourselves does not need to be loaded again
    // (HA may also return an older sent version, so several of the latest are remembered)
    if (this._emittedList && this._emittedList.includes(stable(config))) {
      this._config = config;
      return;
    }
    this._config = config;
    const { lights, views, hidden_materials, material_colors, ...rest } = config;
    const newColors = Array.isArray(material_colors) ? material_colors.map((c) => ({ ...c })) : [];
    const newLights = Array.isArray(lights) ? lights.map((l) => ({ ...l })) : [];
    const newViews = Array.isArray(views) ? views.map((v) => ({ ...v })) : [];
    const newHidden = Array.isArray(hidden_materials) ? hidden_materials.slice() : [];
    if (!this._form) {
      this._main = rest;
      this._lights = newLights;
      this._views = newViews;
      this._hidden = newHidden;
      this._colors = newColors;
      this._render();
      return;
    }
    // the editor already exists: only changed values are updated so the cursor in a field is not lost
    this._syncFromConfig(rest, newLights, newViews, newHidden, newColors);
  }

  _syncFromConfig(rest, lights, views, hidden, colors) {
    this._main = rest;
    const mainData = { ...DEFAULTS, ...rest };
    if (stable(mainData) !== stable(this._form.data)) this._form.data = mainData;

    if (lights.length !== this._lights.length) {
      this._lights = lights;
      this._renderLights();
    } else {
      this._lights = lights;
      this._lightForms.forEach((f, i) => {
        const d = lightToForm(lights[i]);
        if (stable(d) !== stable(f.data)) f.data = d;
      });
    }

    if (this._fadeTimer) views = this._views; // in-progress transparency changes are not overwritten
    const hideChanged = views.some(
      (v, i) =>
        !this._views[i] ||
        stable(v.hide || []) !== stable(this._views[i].hide || []) ||
        stable(v.fade || []) !== stable(this._views[i].fade || [])
    );
    if (views.length !== this._views.length || hideChanged) {
      this._views = views;
      this._renderViews();
    } else {
      this._views = views;
      this._viewForms.forEach((f, i) => {
        const d = viewToForm(views[i], this._info());
        if (stable(d) !== stable(f.data)) f.data = d;
      });
    }

    if (stable(hidden) !== stable(this._hidden)) {
      this._hidden = hidden;
      this._renderHidden();
    }
    if (!this._colorTimer && stable(colors) !== stable(this._colors)) {
      this._colors = colors;
      this._renderColors();
    }
    this._updateWarn();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    for (const f of this._lightForms) f.hass = hass;
    for (const f of this._viewForms) f.hass = hass;
  }

  _info() {
    return window.__glbViewerInfo ? window.__glbViewerInfo[this._main.model] : null;
  }

  /* ---------------- rendering ---------------- */

  _section(title, text) {
    const sec = document.createElement("div");
    sec.className = "lights";
    const h = document.createElement("h3");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = text;
    sec.append(h, p);
    return sec;
  }

  _render() {
    DomViewerCardEditor._renders = (DomViewerCardEditor._renders || 0) + 1;
    console.debug("[glb-viewer] editor render #" + DomViewerCardEditor._renders);
    this._cancelPick();
    this.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = EDITOR_CSS;
    this.appendChild(style);

    this._form = document.createElement("ha-form");
    this._form.computeLabel = (s) => LABELS[s.name] || s.title || s.name;
    this._form.computeHelper = (s) => HELPERS[s.name] || "";
    this._form.schema = SCHEMA;
    this._form.hass = this._hass;
    // the form shows default values, only those that differ are saved
    this._form.data = { ...DEFAULTS, ...this._main };
    this._form.addEventListener("value-changed", (ev) => this._mainChanged(ev));
    this.appendChild(this._form);

    // --- lights ---
    const lightsSec = this._section(
      "Lights",
      "Position is in meters in model coordinates. Use “Pick position” and click a spot in the model in the preview."
    );
    this._list = document.createElement("div");
    this._warn = document.createElement("div");
    this._warn.className = "warn";
    const addLight = document.createElement("button");
    addLight.className = "primary";
    addLight.textContent = "Add light";
    addLight.addEventListener("click", () => this._addLight());
    lightsSec.append(this._list, this._warn, addLight);
    this.appendChild(lightsSec);

    // --- which materials are shown in the lists (by name prefix) ---
    const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch (e) { /* nothing */ } };
    this._show = {};
    for (const pf of MAT_PREFIXES) this._show[pf] = lsGet("glb-viewer-show-" + pf) !== "0";
    this._show.other = lsGet("glb-viewer-show-other") === "1"; // other materials are hidden by default
    const bar = this._section(
      "Material list",
      "The lists (hidden surfaces, colors, views) show materials whose name starts with the selected prefix. Name materials in the model e.g. wall_livingroom, roof_house, window_kitchen."
    );
    const mkToggle = (text, pf) => {
      const lab = document.createElement("label");
      lab.className = "tgl";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this._show[pf];
      cb.addEventListener("change", () => {
        this._show[pf] = cb.checked;
        lsSet("glb-viewer-show-" + pf, cb.checked ? "1" : "0");
        this._renderHidden();
        this._renderColors();
        this._renderViews();
      });
      const tx = document.createElement("span");
      tx.textContent = " " + text;
      lab.append(cb, tx);
      lab.style.marginRight = "16px";
      lab.style.display = "inline-block";
      return lab;
    };
    for (const pf of MAT_PREFIXES) bar.appendChild(mkToggle(pf + "*", pf));
    bar.appendChild(mkToggle("other (no prefix)", "other"));
    this.appendChild(bar);

    // --- hidden surfaces ---
    this._hiddenSec = this._section(
      "Hidden surfaces",
      "Materials are read from the model file. Ticked ones are always hidden (e.g. the roof). To hide something only in a particular view, use the views below."
    );
    this._hiddenBox = document.createElement("div");
    this._hiddenSec.appendChild(this._hiddenBox);
    this.appendChild(this._hiddenSec);

    // --- material colors ---
    this._colorSec = this._section(
      "Material colors and transparency",
      "Every material has its own color and transparency. Changed ones are highlighted; the “Original” button restores the values from the file."
    );
    this._colorBox = document.createElement("div");
    this._colorSec.appendChild(this._colorBox);
    this.appendChild(this._colorSec);

    // --- views ---
    const viewsSec = this._section(
      "Camera views",
      "Every view has a name, a camera position and a list of hidden materials. It appears as a button on the card."
    );
    const home = document.createElement("div");
    home.className = "row";
    const homeBtn = document.createElement("button");
    homeBtn.textContent = "Show the default view";
    homeBtn.addEventListener("click", () => this._gotoView(null));
    home.appendChild(homeBtn);
    this._viewList = document.createElement("div");
    const addView = document.createElement("button");
    addView.className = "primary";
    addView.textContent = "Add view";
    addView.addEventListener("click", () => this._addView());
    viewsSec.append(home, this._viewList, addView);
    this.appendChild(viewsSec);

    this._renderLights();
    this._renderHidden();
    this._renderColors();
    this._renderViews();
  }

  // material list by the chosen prefixes (case-insensitive)
  _visibleMats(info) {
    const all = info && Array.isArray(info.materials) ? info.materials : [];
    const show = this._show || {};
    return all.filter((m) => {
      const n = String(m.name).toLowerCase();
      const pf = MAT_PREFIXES.find((p) => n.startsWith(p));
      return pf ? show[pf] !== false : !!show.other;
    });
  }

  _matLabel(m) {
    return m.name;
  }

  // color + transparency for every material from the file
  _renderColors() {
    this._colorBox.innerHTML = "";
    const info = this._info();
    const box = document.createElement("div");
    box.className = "cols";
    if (!info || !Array.isArray(info.materials) || !info.materials.length) {
      const p = document.createElement("p");
      p.textContent = "Materials appear after the model loads in the preview.";
      this._colorBox.appendChild(p);
      return;
    }
    const entry = (name) => this._colors.find((c) => c && String(c.name) === name);
    const setEntry = (name, patch) => {
      let e = entry(name);
      if (!e) {
        e = { name };
        this._colors.push(e);
      }
      Object.assign(e, patch);
      if (e.color === undefined && e.opacity === undefined) this._colors = this._colors.filter((c) => c !== e);
    };
    const emitSoon = () => {
      clearTimeout(this._colorTimer);
      this._colorTimer = setTimeout(() => {
        this._colorTimer = null;
        this._emit();
      }, 120);
    };
    for (const m of this._visibleMats(info)) {
      const e = entry(m.name) || {};
      const row = document.createElement("div");
      row.className = "col";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = this._matLabel(m) + (m.glass ? " (transparent)" : "");
      const color = document.createElement("input");
      color.type = "color";
      const hex6 = (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : null);
      color.value = hex6(e.color) || hex6(m.color) || "#999999";
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "1";
      const pc = document.createElement("span");
      pc.className = "pc";
      const reset = document.createElement("button");
      reset.textContent = "Original";
      const refresh = () => {
        const ent = entry(m.name);
        row.classList.toggle("changed", !!ent);
        reset.style.visibility = ent ? "visible" : "hidden";
      };
      const origOp = typeof m.opacity === "number" ? m.opacity : 1;
      const op = e.opacity !== undefined && e.opacity !== "" ? Number(e.opacity) : origOp;
      range.value = String(Math.round((isNaN(op) ? origOp : op) * 100));
      pc.textContent = range.value + " %";
      color.addEventListener("input", () => {
        setEntry(m.name, { color: color.value });
        refresh();
        emitSoon();
      });
      range.addEventListener("input", () => {
        pc.textContent = range.value + " %";
        setEntry(m.name, { opacity: Math.round(Number(range.value)) / 100 });
        refresh();
        emitSoon();
      });
      reset.addEventListener("click", () => {
        this._colors = this._colors.filter((c) => !(c && String(c.name) === m.name));
        color.value = hex6(m.color) || "#999999";
        range.value = String(Math.round(origOp * 100));
        pc.textContent = range.value + " %";
        refresh();
        this._emit();
      });
      row.append(nm, color, range, pc, reset);
      refresh();
      box.appendChild(row);
    }
    this._colorBox.appendChild(box);

    // settings for materials that are no longer in the loaded model (e.g. after renaming in SketchUp)
    const names = new Set(info.materials.map((m) => m.name));
    const orphans = this._colors.filter((c) => c && !names.has(String(c.name)));
    if (orphans.length) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = "Set, but not present in the model: " + orphans.map((c) => c.name).join(", ");
      const b = document.createElement("button");
      b.textContent = "Remove";
      b.style.marginLeft = "8px";
      b.addEventListener("click", () => {
        this._colors = this._colors.filter((c) => c && names.has(String(c.name)));
        this._renderColors();
        this._emit();
      });
      w.appendChild(b);
      this._colorBox.appendChild(w);
    }
  }

  // material picker with a color swatch; the list is read from the model file
  _matPicker(selected, onChange) {
    const box = document.createElement("div");
    box.className = "mats";
    const info = this._info();
    const allMats = info && Array.isArray(info.materials) ? info.materials : [];
    const mats = this._visibleMats(info).map((m) => ({ ...m }));
    const sel = new Set(selected || []);
    sel.forEach((n) => {
      if (!allMats.some((m) => m.name === n)) mats.push({ name: n, color: null, missing: true });
    });
    if (!mats.length) {
      box.textContent = "Materials appear after the model loads in the preview.";
      return box;
    }
    mats.forEach((m) => {
      const row = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = sel.has(m.name);
      cb.addEventListener("change", () => {
        if (cb.checked) sel.add(m.name);
        else sel.delete(m.name);
        // the selection is kept also for rows currently hidden by the toggles
        onChange([...sel]);
      });
      const sw = document.createElement("span");
      sw.className = "sw";
      if (m.color) sw.style.background = m.color;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = m.name;
      row.append(cb, sw, nm);
      if (m.glass || m.missing) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = m.missing ? "(not in the model)" : "(transparent)";
        row.appendChild(tag);
      }
      box.appendChild(row);
    });
    return box;
  }

  _renderHidden() {
    this._hiddenBox.innerHTML = "";
    this._hiddenBox.appendChild(
      this._matPicker(this._hidden, (names) => {
        this._hidden = names;
        this._emit();
      })
    );
  }

  _lightTitle(l, i) {
    const t = l.name || l.entity || (Array.isArray(l.entities) && l.entities[0]) || `Light ${i + 1}`;
    return l.disabled ? t + " (disabled)" : t;
  }

  _renderLights(openIdx) {
    const wasOpen = [...this._list.querySelectorAll("details")].map((d) => d.open);
    this._list.innerHTML = "";
    this._lightForms = [];
    this._pickBtns = [];

    this._lights.forEach((l, i) => {
      const det = document.createElement("details");
      det.open = openIdx === i || !!wasOpen[i];
      const sum = document.createElement("summary");
      sum.textContent = this._lightTitle(l, i);
      det.appendChild(sum);

      const form = document.createElement("ha-form");
      form.computeLabel = (s) => LIGHT_LABELS[s.name] || s.name;
      form.computeHelper = (s) => LIGHT_HELPERS[s.name] || "";
      form.schema = LIGHT_SCHEMA;
      form.hass = this._hass;
      form.data = lightToForm(l);
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        form.data = ev.detail.value;
        this._lights[i] = formToLight(ev.detail.value);
        sum.textContent = this._lightTitle(this._lights[i], i);
        this._emit();
      });
      det.appendChild(form);

      const row = document.createElement("div");
      row.className = "row";
      const pick = document.createElement("button");
      pick.textContent = "Pick position by clicking in the model";
      pick.addEventListener("click", () => this._togglePick(i));
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Remove light";
      del.addEventListener("click", () => {
        this._cancelPick();
        this._lights.splice(i, 1);
        this._renderLights();
        this._emit();
      });
      row.append(pick, del);
      det.appendChild(row);

      this._list.appendChild(det);
      this._lightForms.push(form);
      this._pickBtns.push(pick);
    });

    this._updateWarn();
  }

  _renderViews(openIdx) {
    const wasOpen = [...this._viewList.querySelectorAll("details")].map((d) => d.open);
    this._viewList.innerHTML = "";
    this._viewForms = [];
    const info = this._info();

    this._views.forEach((v, i) => {
      const det = document.createElement("details");
      det.open = openIdx === i || !!wasOpen[i];
      const sum = document.createElement("summary");
      sum.textContent = v.name || `View ${i + 1}`;
      det.appendChild(sum);

      const form = document.createElement("ha-form");
      form.computeLabel = (s) => VIEW_LABELS[s.name] || s.name;
      form.computeHelper = (s) => VIEW_HELPERS[s.name] || "";
      form.schema = VIEW_SCHEMA;
      form.hass = this._hass;
      form.data = viewToForm(v, info);
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        form.data = ev.detail.value;
        this._views[i] = formToView(ev.detail.value, this._views[i]);
        sum.textContent = this._views[i].name || `View ${i + 1}`;
        this._focusView(i);
        this._emit();
      });
      det.appendChild(form);

      const h4 = document.createElement("h4");
      h4.textContent = "Hide in this view";
      det.appendChild(h4);
      det.appendChild(
        this._matPicker(v.hide, (names) => {
          const cur = { ...this._views[i] };
          if (names.length) cur.hide = names;
          else delete cur.hide;
          this._views[i] = cur;
          this._focusView(i);
          this._emit();
        })
      );

      const h4b = document.createElement("h4");
      h4b.textContent = "Transparency in this view";
      det.appendChild(h4b);
      det.appendChild(this._fadeRows(i, info));

      const row = document.createElement("div");
      row.className = "row";
      const cap = document.createElement("button");
      cap.textContent = "Save current camera view";
      cap.addEventListener("click", () => this._capture(i));
      const go = document.createElement("button");
      go.textContent = "Go to view";
      go.addEventListener("click", () => this._gotoView(this._views[i].name));
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Remove view";
      del.addEventListener("click", () => {
        this._views.splice(i, 1);
        this._renderViews();
        this._emit();
      });
      row.append(cap, go, del);
      det.appendChild(row);

      this._viewList.appendChild(det);
      this._viewForms.push(form);
    });
  }

  _updateWarn() {
    if (!this._warn) return;
    const shadowCount = this._lights.filter((l) => l.shadows).length;
    this._warn.textContent =
      shadowCount > 3
        ? `Lights with shadows: ${shadowCount}. This may be slow on a tablet; at most 3 are recommended.`
        : "";
  }

  /* ---------------- changes ---------------- */

  _mainChanged(ev) {
    ev.stopPropagation();
    const value = ev.detail.value || {};
    this._form.data = value;
    const config = { type: this._main.type, model: value.model };
    for (const [key, val] of Object.entries(value)) {
      if (key === "type" || key === "model" || ARRAY_KEYS.includes(key)) continue;
      if (isEmpty(val)) continue;
      if (key in DEFAULTS && DEFAULTS[key] === val) continue;
      config[key] = val;
    }
    this._main = config;
    this._emit();
  }

  _emit() {
    const config = { ...this._main };
    if (this._lights.length) config.lights = this._lights.map((l) => ({ ...l }));
    if (this._views.length) config.views = this._views.map((v) => ({ ...v }));
    if (this._hidden.length) config.hidden_materials = this._hidden.slice();
    if (this._colors.length) config.material_colors = this._colors.map((c) => ({ ...c }));
    this._emitted = stable(config);
    this._emittedList = [...(this._emittedList || []).slice(-9), this._emitted];
    this._config = config;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true,
      })
    );
    this._updateWarn();
  }

  _addLight() {
    const info = this._info();
    const cx = hasBounds(info) ? centerOf(info)[0] : 0;
    const cz = hasBounds(info) ? centerOf(info)[2] : 0;
    this._lights.push({
      name: `Light ${this._lights.length + 1}`,
      position: [round2(cx), 2.2, round2(cz)],
      color: DEFAULT_LIGHT_COLOR.slice(),
      intensity: 30,
      distance: 8,
    });
    this._renderLights(this._lights.length - 1);
    this._emit();
  }

  _addView() {
    const info = this._info();
    const c = hasBounds(info) ? centerOf(info) : [0, 0, 0];
    this._views.push({
      name: `View ${this._views.length + 1}`,
      azimuth: 30,
      tilt: 60,
      zoom: 150,
      target: [round2(c[0]), round2(c[1]), round2(c[2])],
    });
    this._renderViews(this._views.length - 1);
    this._emit();
  }

  /* ---------------- events from the card ---------------- */

  _onInfo(ev) {
    const d = ev.detail || {};
    if (!this._main || d.model !== this._main.model || !this._hiddenBox) return;
    // info is sent on every (re)load of the model; redrawn only when the content actually changed
    const info = this._info();
    const sig = stable(info ? { min: info.min, max: info.max, m: info.materials } : null);
    if (sig === this._infoSig) return;
    this._infoSig = sig;
    this._renderHidden();
    this._renderColors();
    this._renderViews();
  }

  // material transparency for view i: slider 0-100 %, only values below 100 % are saved
  _fadeRows(i, info) {
    const box = document.createElement("div");
    box.className = "cols";
    const mats = this._visibleMats(info);
    if (!mats.length) {
      const p = document.createElement("p");
      p.textContent = "Materials appear after the model loads in the preview.";
      box.appendChild(p);
      return box;
    }
    const note = document.createElement("p");
    note.textContent = "Hidden surfaces (above) take precedence over transparency. 100 % = no change.";
    box.appendChild(note);
    const cur = (name) => (this._views[i].fade || []).find((x) => x && String(x.name) === name);
    for (const m of mats) {
      const e = cur(m.name);
      const row = document.createElement("div");
      row.className = "col";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = this._matLabel(m);
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "1";
      range.value = String(e ? Math.round(num(e.opacity, 1) * 100) : 100);
      const pc = document.createElement("span");
      pc.className = "pc";
      pc.textContent = range.value + " %";
      const mark = () => row.classList.toggle("changed", Number(range.value) < 100);
      mark();
      range.addEventListener("input", () => {
        pc.textContent = range.value + " %";
        mark();
        const v = { ...this._views[i] };
        const list = (v.fade || []).filter((x) => x && String(x.name) !== m.name);
        if (Number(range.value) < 100) list.push({ name: m.name, opacity: Number(range.value) / 100 });
        if (list.length) v.fade = list;
        else delete v.fade;
        this._views[i] = v;
        this._focusView(i);
        clearTimeout(this._fadeTimer);
        this._fadeTimer = setTimeout(() => {
          this._fadeTimer = null;
          this._emit();
        }, 120);
      });
      row.append(nm, range, pc);
      box.appendChild(row);
    }
    return box;
  }

  // after the view values change, the preview switches to this view (even if HA recreates the preview)
  _focusView(i) {
    const v = this._views[i];
    if (!v || !v.name) return;
    window.__glbViewerFocus = { model: this._main.model, name: v.name, t: Date.now(), seq: (window.__glbViewerFocusSeq = (window.__glbViewerFocusSeq || 0) + 1) };
  }

  _gotoView(name) {
    window.dispatchEvent(
      new CustomEvent("glb-viewer-goto", { detail: { model: this._main.model, name } })
    );
  }

  _capture(i) {
    this._capIdx = i;
    this._capToken = `cap-${Date.now()}-${i}`;
    window.dispatchEvent(
      new CustomEvent("glb-viewer-capture", {
        detail: { model: this._main.model, token: this._capToken },
      })
    );
  }

  _onCaptured(ev) {
    const d = ev.detail || {};
    if (!this._capToken || d.token !== this._capToken) return;
    const i = this._capIdx;
    this._capToken = null;
    if (!this._views[i] || !d.view) return;
    this._views[i] = { ...this._views[i], ...d.view };
    if (this._viewForms[i]) this._viewForms[i].data = viewToForm(this._views[i], this._info());
    this._emit();
  }

  /* ---------------- picking a light position ---------------- */

  _togglePick(i) {
    if (this._pickIdx === i) {
      this._cancelPick();
      return;
    }
    this._cancelPick();
    this._pickIdx = i;
    this._pickToken = `${Date.now()}-${i}`;
    const btn = this._pickBtns[i];
    if (btn) {
      btn.classList.add("active");
      btn.textContent = "Click the model in the preview (cancel)";
    }
    window.dispatchEvent(
      new CustomEvent("glb-viewer-pick", {
        detail: { model: this._main.model, token: this._pickToken },
      })
    );
  }

  _cancelPick() {
    if (this._pickToken) {
      window.dispatchEvent(new CustomEvent("glb-viewer-pick-cancel"));
    }
    this._finishPick();
  }

  _finishPick() {
    const btn = this._pickBtns ? this._pickBtns[this._pickIdx] : null;
    if (btn) {
      btn.classList.remove("active");
      btn.textContent = "Pick position by clicking in the model";
    }
    this._pickIdx = null;
    this._pickToken = null;
  }

  _onPicked(ev) {
    const d = ev.detail || {};
    if (!this._pickToken || d.token !== this._pickToken) return;
    const i = this._pickIdx;
    if (this._lights[i]) {
      this._lights[i] = { ...this._lights[i], position: d.point };
      if (this._lightForms[i]) this._lightForms[i].data = lightToForm(this._lights[i]);
    }
    this._finishPick();
    this._emit();
  }
}

customElements.define("dom-viewer-card", DomViewerCard);
customElements.define("dom-viewer-card-editor", DomViewerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "dom-viewer-card",
  name: "GLB viewer",
  description: "Interactive 3D model (GLB) with limited rotation and tilt",
  preview: false,
});

console.info(
  `%c GLB-VIEWER %c v${VERSION} `,
  "color:white;background:#03a9f4;font-weight:bold;",
  "color:#03a9f4;background:white;font-weight:bold;"
);
