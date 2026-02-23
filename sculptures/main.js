"use strict";

const SCULPTURE_BASE_PATH = "https://github.oblokos.com/sculptures/";
const THEME_STORAGE_KEY = "sculpture-ui-theme";
const COPY_FEEDBACK_MS = 1200;
const FALLBACK_SIZE = { w: 1, h: 1 };

function getQueryParam(name, fallback = null) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name) ?? fallback;
}

function shortenText(value, max = 42) {
  if (!value) return "n/a";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}...`;
}

function formatLoadTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function createAlert(message, type) {
  const alert = document.createElement("div");
  alert.className = `alert alert-${type} mb-0`;
  alert.setAttribute("role", "alert");
  alert.textContent = message;
  return alert;
}

function showStatus(message, type = "danger") {
  const mount = document.querySelector("#status-alert");
  if (!mount) return;
  mount.replaceChildren(createAlert(message, type));
}

function clearStatus() {
  const mount = document.querySelector("#status-alert");
  if (mount) mount.innerHTML = "";
}

function setLoading(isVisible, label = "Loading...") {
  const loading = document.querySelector("#loading-indicator");
  if (!loading) return;
  loading.classList.toggle("d-none", !isVisible);
  const text = loading.querySelector("span");
  if (text) text.textContent = label;
}

function readTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch (_) {
    return "light";
  }
}

function writeTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (_) {
    // Ignore storage errors.
  }
}

function applyTheme(theme, scene) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", resolved);
  writeTheme(resolved);

  const themeButton = document.querySelector("#theme-toggle");
  if (themeButton) {
    themeButton.textContent = resolved === "dark" ? "Light" : "Dark";
    themeButton.setAttribute("aria-pressed", String(resolved === "dark"));
    themeButton.title = resolved === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }

  if (scene) {
    scene.background = new THREE.Color(resolved === "dark" ? 0x101a2c : 0xffffff);
  }
}

function updateStats(layers, baseUrl) {
  const statLayers = document.querySelector("#stat-layers");
  const statBase = document.querySelector("#stat-base-url");
  const statLoaded = document.querySelector("#stat-loaded-at");

  if (statLayers) statLayers.textContent = String((layers ?? []).length);
  if (statBase) {
    statBase.textContent = shortenText(baseUrl);
    statBase.title = baseUrl || "n/a";
  }
  if (statLoaded) {
    const now = new Date();
    statLoaded.textContent = formatLoadTime(now);
    statLoaded.title = now.toLocaleString();
  }
}

function updateVisibleCount(visible, total) {
  const badge = document.querySelector("#visible-count");
  if (!badge) return;
  badge.textContent = `${visible}/${total} visible`;
}

function applyViewMode() {
  const summary = document.querySelector("#summary");
  const toggle = document.querySelector("#view-mode-toggle");
  if (!summary || !toggle) return;
  summary.classList.toggle("compact-mode", !toggle.checked);
}

function applyLayerFilter() {
  const summary = document.querySelector("#summary");
  const input = document.querySelector("#layer-search");
  const empty = document.querySelector("#summary-empty");
  if (!summary || !input || !empty) return;

  const query = input.value.trim().toLowerCase();
  const items = summary.querySelectorAll(".layer-item");

  let visibleCount = 0;
  items.forEach((item) => {
    const layerId = (item.dataset.layerId || "").toLowerCase();
    const matches = layerId.includes(query);
    item.classList.toggle("d-none", !matches);
    if (matches) visibleCount += 1;
  });

  updateVisibleCount(visibleCount, items.length);

  if (items.length === 0) {
    empty.textContent = "No layers available.";
    empty.classList.remove("d-none");
    return;
  }

  if (visibleCount === 0) {
    empty.textContent = "No layers match your search.";
    empty.classList.remove("d-none");
    return;
  }

  empty.classList.add("d-none");
}

function addCard(layer, imgUrl) {
  const template = document.querySelector("#layer-card-template");
  if (!template) return null;

  const node = template.content.firstElementChild.cloneNode(true);
  const layerId = String(layer.id ?? "");

  node.dataset.layerId = layerId;

  const thumb = node.querySelector(".layer-thumb");
  thumb.src = imgUrl;
  thumb.alt = layerId;
  thumb.loading = "lazy";

  const title = node.querySelector(".layer-id");
  title.textContent = layerId;
  title.title = layerId;

  const copyBtn = node.querySelector(".copy-id-btn");
  copyBtn.setAttribute("data-layer-id", layerId);

  return node;
}

function renderSummary(layers, baseUrl) {
  const summary = document.querySelector("#summary");
  if (!summary) return;

  summary.innerHTML = "";

  for (const layer of layers ?? []) {
    const id = String(layer?.id ?? "");
    const card = addCard({ id }, `${baseUrl}${id}.png`);
    if (card) summary.appendChild(card);
  }

  applyViewMode();
  applyLayerFilter();
}

async function copyToClipboard(text) {
  if (!text) return false;

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.left = "-9999px";
  document.body.appendChild(helper);
  helper.focus();
  helper.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (_) {
    copied = false;
  }

  helper.remove();
  return copied;
}

const downloadLink = document.createElement("a");
downloadLink.style.display = "none";
document.body.appendChild(downloadLink);

function save(blob, filename) {
  downloadLink.href = URL.createObjectURL(blob);
  downloadLink.download = filename;
  downloadLink.click();
  setTimeout(() => URL.revokeObjectURL(downloadLink.href), 1000);
}

function saveString(text, filename) {
  save(new Blob([text], { type: "text/plain" }), filename);
}

function saveArrayBuffer(buffer, filename) {
  save(new Blob([buffer], { type: "application/octet-stream" }), filename);
}

function fitCameraToObject(camera, object3D, controls, offset = 1.2) {
  const box = new THREE.Box3().setFromObject(object3D);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  let cameraZ = Math.abs((maxDim / 2) / Math.tan(fov / 2));
  cameraZ *= offset;

  camera.position.set(center.x, center.y, center.z + cameraZ);
  camera.near = maxDim / 100;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();

  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
}

function centerObjectAtOrigin(object3D) {
  const box = new THREE.Box3().setFromObject(object3D);
  const center = new THREE.Vector3();
  box.getCenter(center);
  object3D.position.sub(center);
}

async function loadSculpture(name) {
  const url = `${SCULPTURE_BASE_PATH}${name}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  return await res.json();
}

async function main() {
  const canvas = document.querySelector("#c");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  applyTheme(readTheme(), scene);

  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 1000);
  camera.position.set(1, 1, 3);

  const controls = new THREE.OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.update();

  const sculptureKey = getQueryParam("sculpture", "ORINOCO_PORTAL");
  const sculptureBadge = document.querySelector("#sculpt-key-badge");
  if (sculptureBadge) sculptureBadge.textContent = `sculpture: ${sculptureKey}`;

  clearStatus();
  setLoading(true, "Loading sculpture data...");

  const sculpture = await loadSculpture(sculptureKey);
  const layers = sculpture.layers ?? [];
  const base = sculpture.image_base_url ?? "https://github.oblokos.com/art/";

  document.querySelector("#sculpt-name").textContent = sculpture.name ?? sculptureKey;

  const loc = document.querySelector("#sculpt-location");
  if (sculpture.location_url) {
    loc.href = sculpture.location_url;
    loc.textContent = "Open in Spatial";
    loc.classList.remove("disabled");
    loc.setAttribute("aria-disabled", "false");
  } else {
    loc.removeAttribute("href");
    loc.textContent = "Open in Spatial";
    loc.classList.add("disabled");
    loc.setAttribute("aria-disabled", "true");
  }

  renderSummary(layers, base);
  updateStats(layers, base);

  const group = new THREE.Group();
  scene.add(group);

  const loader = new THREE.TextureLoader();
  const matCache = new Map();
  let pendingTextures = 0;
  let textureWarningShown = false;

  const textureReadyCallbacks = new Map();

  function getPlaneSizeFromTexture(texture) {
    const image = texture?.image;
    const width = Number(image?.naturalWidth ?? image?.videoWidth ?? image?.width ?? 0);
    const height = Number(image?.naturalHeight ?? image?.videoHeight ?? image?.height ?? 0);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ...FALLBACK_SIZE };
    }

    const maxDimension = Math.max(width, height);
    return { w: width / maxDimension, h: height / maxDimension };
  }

  function applyRealSize(front, back, texture) {
    const size = getPlaneSizeFromTexture(texture);

    front.geometry.dispose();
    back.geometry.dispose();

    front.geometry = new THREE.PlaneBufferGeometry(size.w, size.h);
    back.geometry = new THREE.PlaneBufferGeometry(size.w, size.h);
  }

  function updateTextureLoading() {
    if (pendingTextures > 0) {
      setLoading(true, `Loading layers (${pendingTextures})...`);
      return;
    }
    setLoading(false);
  }

  function getMaterial(id, onTextureReady) {
    if (matCache.has(id)) {
      const cached = matCache.get(id);
      if (typeof onTextureReady === "function") {
        const callbacks = textureReadyCallbacks.get(id);
        if (callbacks) {
          callbacks.push(onTextureReady);
        } else {
          onTextureReady(cached.map);
        }
      }
      return cached;
    }

    const readyCallbacks = [];
    if (typeof onTextureReady === "function") readyCallbacks.push(onTextureReady);
    textureReadyCallbacks.set(id, readyCallbacks);

    pendingTextures += 1;
    updateTextureLoading();

    const tex = loader.load(
      `${base}${id}.png`,
      () => {
        pendingTextures = Math.max(0, pendingTextures - 1);
        updateTextureLoading();

        const callbacks = textureReadyCallbacks.get(id) ?? [];
        for (const callback of callbacks) {
          try {
            callback(tex);
          } catch (_) {
            // Ignore callback errors for size updates.
          }
        }
        textureReadyCallbacks.delete(id);

        requestRenderIfNotRequested();
      },
      undefined,
      () => {
        pendingTextures = Math.max(0, pendingTextures - 1);
        updateTextureLoading();

        if (!textureWarningShown) {
          showStatus("Some layer textures failed to load.", "warning");
          textureWarningShown = true;
        }

        textureReadyCallbacks.delete(id);
        requestRenderIfNotRequested();
      }
    );

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide
    });
    matCache.set(id, mat);
    return mat;
  }

  function makePlane(layer) {
    if (layer.role === "sample") {
      return;
    }

    const geo = new THREE.PlaneBufferGeometry(FALLBACK_SIZE.w, FALLBACK_SIZE.h);
    let front;
    let back;

    const mat = getMaterial(layer.id, (texture) => {
      if (!front || !back) return;
      applyRealSize(front, back, texture);
      centerObjectAtOrigin(group);
      fitCameraToObject(camera, group, controls, 1.35);
      requestRenderIfNotRequested();
    });

    front = new THREE.Mesh(geo, mat);
    back = new THREE.Mesh(geo, mat);
    back.rotation.y = Math.PI;
    back.scale.x = -1;

    const p = layer.position ?? { x: 0, y: 0, z: 0 };
    const r = layer.rotation ?? { x: 0, y: 0, z: 0 };
    const s = layer.scale ?? { x: 1, y: 1, z: 1 };

    front.position.set(p.x, p.y, p.z);
    front.rotation.set(r.x, r.y, r.z);
    front.scale.set(s.x, s.y, s.z);

    back.position.copy(front.position);
    back.rotation.copy(front.rotation);
    back.rotateY(Math.PI);
    back.scale.copy(front.scale);

    group.add(front);
    group.add(back);
  }

  for (const layer of layers) makePlane(layer);

  centerObjectAtOrigin(group);
  fitCameraToObject(camera, group, controls, 1.35);

  document.querySelector("#download").addEventListener("click", (e) => {
    e.preventDefault();
      // (opcional pero recomendado)
    scene.updateMatrixWorld(true);

    // 1) Sanitizar geometrías antes de exportar (ver sección 3)
    sanitizeForGLTF(scene);
    const filenameBase = (sculpture.name ?? sculptureKey).replace(/\s+/g, "_");
    const exporter = new THREE.GLTFExporter();
    const options = {
      trs: true,
      onlyVisible: true,
      truncateDrawRange: true,
      binary: false,
      embedImages: true,
      maxTextureSize: 1024
    };

    exporter.parse(
      scene,
      (gltfOrArrayBuffer) => {
        if (gltfOrArrayBuffer instanceof ArrayBuffer) {
          saveArrayBuffer(gltfOrArrayBuffer, `${filenameBase}.glb`);
          return;
        }

        const output = JSON.stringify(gltfOrArrayBuffer, null, 2);
        saveString(output, `${filenameBase}.gltf`);
      },
      (err) => console.log("Export error:", err),
      options
    );
  });

  function resizeRendererToDisplaySize() {
    const width = canvas.clientWidth | 0;
    const height = canvas.clientHeight | 0;
    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) renderer.setSize(width, height, false);
    return needResize;
  }

  let renderRequested = false;

  function render() {
    renderRequested = false;
    if (resizeRendererToDisplaySize()) {
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
  }

  function requestRenderIfNotRequested() {
    if (!renderRequested) {
      renderRequested = true;
      requestAnimationFrame(render);
    }
  }

  const layerSearch = document.querySelector("#layer-search");
  if (layerSearch) layerSearch.addEventListener("input", applyLayerFilter);

  const viewModeToggle = document.querySelector("#view-mode-toggle");
  if (viewModeToggle) {
    viewModeToggle.addEventListener("change", () => {
      applyViewMode();
      applyLayerFilter();
    });
  }

  const summary = document.querySelector("#summary");
  if (summary) {
    summary.addEventListener("click", async (event) => {
      const button = event.target.closest(".copy-id-btn");
      if (!button) return;

      const layerId =
        button.getAttribute("data-layer-id") ||
        button.closest(".layer-item")?.dataset.layerId ||
        "";

      const original = button.textContent;
      let ok = false;
      try {
        ok = await copyToClipboard(layerId);
      } catch (_) {
        ok = false;
      }

      button.textContent = ok ? "Copied" : "Failed";
      setTimeout(() => {
        button.textContent = original;
      }, COPY_FEEDBACK_MS);
    });
  }

  const themeToggle = document.querySelector("#theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next, scene);
      requestRenderIfNotRequested();
    });
  }

  controls.addEventListener("change", requestRenderIfNotRequested);
  window.addEventListener("resize", requestRenderIfNotRequested);

  render();
  updateTextureLoading();
}

main().catch((e) => {
  console.error(e);
  setLoading(false);
  showStatus(e.message || "Unexpected error while loading sculpture.", "danger");
});

function sanitizeForGLTF(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;

    const g = o.geometry;
    if (!g.isBufferGeometry) return;

    const n = g.getAttribute("normal");

    // Si no hay normales o no tienen .clone() (caso del error)
    if (!n || typeof n.clone !== "function") {
      g.deleteAttribute("normal");
      g.computeVertexNormals();
      g.normalizeNormals?.(); // existe en algunas versiones
      return;
    }

    // Si tenés el warning de "normalized normal attribute..."
    // podés forzar una normalización segura:
    try {
      g.normalizeNormals?.();
    } catch (_) {
      // si no existe el método, lo ignorás
    }
  });
}