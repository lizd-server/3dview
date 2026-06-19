import "./style.css";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  CATEGORIES,
  CATEGORY_ORDER,
  CASE_OVERLAY_OFFSET,
  COMPONENT_OVERLAY_OFFSET,
  categoryDisplayName,
  classifyLabel,
  type AxisOrder,
  type CategoryKey,
  type LabelSchema,
  type SliceAxis,
  type VolumeData,
} from "./types";
import { loadVolumeFile } from "./volumeLoader";

type MeshMode = "solid" | "wireframe" | "transparent" | "solidWire";

interface SliceSample {
  grid: [number, number, number];
  worldIndex: [number, number, number];
  world: THREE.Vector3;
  label: number;
  category: CategoryKey | null;
}

class MeshSliceViewer {
  private readonly canvas = getElement<HTMLCanvasElement>("viewerCanvas");
  private readonly sliceCanvas = getElement<HTMLCanvasElement>("sliceCanvas");
  private readonly sliceContext = mustGetContext(this.sliceCanvas);
  private readonly statusText = getElement<HTMLElement>("statusText");
  private readonly renderStats = getElement<HTMLElement>("renderStats");
  private readonly volumeInput = getElement<HTMLInputElement>("volumeInput");
  private readonly meshInput = getElement<HTMLInputElement>("meshInput");
  private readonly arraySelect = getElement<HTMLSelectElement>("arraySelect");
  private readonly arraySelectRow = getElement<HTMLElement>("arraySelectRow");
  private readonly schemaSelect = getElement<HTMLSelectElement>("schemaSelect");
  private readonly sliceSlider = getElement<HTMLInputElement>("sliceSlider");
  private readonly sliceLabel = getElement<HTMLElement>("sliceLabel");
  private readonly sliceValue = getElement<HTMLOutputElement>("sliceValue");
  private readonly axisOrderSelect = getElement<HTMLSelectElement>("axisOrderSelect");
  private readonly flipX = getElement<HTMLInputElement>("flipX");
  private readonly flipY = getElement<HTMLInputElement>("flipY");
  private readonly flipZ = getElement<HTMLInputElement>("flipZ");
  private readonly meshModeSelect = getElement<HTMLSelectElement>("meshModeSelect");
  private readonly meshOpacity = getElement<HTMLInputElement>("meshOpacity");
  private readonly meshOpacityValue = getElement<HTMLOutputElement>("meshOpacityValue");
  private readonly normalizeMesh = getElement<HTMLInputElement>("normalizeMesh");
  private readonly legendList = getElement<HTMLElement>("legendList");
  private readonly inspectorList = getElement<HTMLElement>("inspectorList");

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  private readonly renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
  private readonly controls = new OrbitControls(this.camera, this.canvas);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly meshRoot = new THREE.Group();
  private readonly sliceRoot = new THREE.Group();
  private readonly slicePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      color: "#f97316",
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );

  private volumes: VolumeData[] = [];
  private activeVolume: VolumeData | null = null;
  private sliceAxis: SliceAxis = "z";
  private sliceIndex = 0;
  private draggingSlice = false;
  private dragStartPointer = new THREE.Vector2();
  private dragStartIndex = 0;

  constructor() {
    this.scene.background = new THREE.Color("#f3f6fa");
    this.scene.add(this.meshRoot, this.sliceRoot);

    this.addSceneGuides();
    this.addSlicePlane();
    this.addLighting();
    this.resetCamera();
    this.configureRenderer();
    this.bindEvents();
    this.updateSliceControls(true);
    this.updateSlicePlane();
    this.updateMeshDisplay();
    this.renderSlice();
    this.resize();
    this.animate();
  }

  private addSceneGuides(): void {
    const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const helper = new THREE.Box3Helper(bounds, new THREE.Color("#334155"));
    const helperMaterial = helper.material as THREE.LineBasicMaterial;
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.34;
    this.scene.add(helper);

    const axes = new THREE.AxesHelper(1.25);
    axes.position.set(-1, -1, -1);
    this.scene.add(axes);

    const grid = new THREE.GridHelper(2, 8, "#8fa0b4", "#d6dde8");
    grid.position.y = -1;
    this.scene.add(grid);
  }

  private addSlicePlane(): void {
    this.slicePlane.name = "slice-plane";
    this.slicePlane.renderOrder = 20;
    this.sliceRoot.add(this.slicePlane);

    const edgeGeometry = new THREE.EdgesGeometry(this.slicePlane.geometry);
    const edges = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({
        color: "#ea580c",
        transparent: true,
        opacity: 0.98,
        depthTest: true,
      }),
    );
    edges.name = "slice-plane-edge";
    this.sliceRoot.add(edges);
  }

  private addLighting(): void {
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#d1d5db", 2.1));

    const keyLight = new THREE.DirectionalLight("#ffffff", 2.5);
    keyLight.position.set(3, 4, 5);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight("#d9f7ff", 0.75);
    fillLight.position.set(-4, 2, -3);
    this.scene.add(fillLight);
  }

  private configureRenderer(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.sliceContext.imageSmoothingEnabled = false;
  }

  private bindEvents(): void {
    window.addEventListener("resize", () => this.resize());

    this.volumeInput.addEventListener("change", () => void this.loadSelectedVolumeFile());
    this.meshInput.addEventListener("change", () => void this.loadSelectedMeshFile());
    this.arraySelect.addEventListener("change", () => this.selectVolume(Number(this.arraySelect.value)));
    this.schemaSelect.addEventListener("change", () => this.renderSlice());

    this.sliceSlider.addEventListener("input", () => {
      this.setSliceIndex(Number(this.sliceSlider.value));
    });
    this.axisOrderSelect.addEventListener("change", () => {
      this.updateSliceControls(true);
      this.updateSlicePlane();
      this.renderSlice();
    });
    this.flipX.addEventListener("change", () => {
      this.setInspector();
      this.renderSlice();
    });
    this.flipY.addEventListener("change", () => {
      this.setInspector();
      this.renderSlice();
    });
    this.flipZ.addEventListener("change", () => {
      this.setInspector();
      this.renderSlice();
    });

    this.meshModeSelect.addEventListener("change", () => this.updateMeshDisplay());
    this.meshOpacity.addEventListener("input", () => this.updateMeshDisplay());
    this.normalizeMesh.addEventListener("change", () => {
      if (this.meshInput.files?.[0]) {
        void this.loadSelectedMeshFile();
      }
    });

    getElement<HTMLButtonElement>("clearMeshButton").addEventListener("click", () => {
      this.clearGroup(this.meshRoot);
      this.setStatus("Mesh cleared");
    });
    getElement<HTMLButtonElement>("resetCameraButton").addEventListener("click", () => this.resetCamera());
    getElement<HTMLButtonElement>("demoButton").addEventListener("click", () => this.loadDemo());

    getElement<HTMLElement>("sliceAxisGroup").addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const axis = target.dataset.axis as SliceAxis | undefined;
      if (!axis) {
        return;
      }

      this.sliceAxis = axis;
      const buttons = target.parentElement
        ? Array.from(target.parentElement.querySelectorAll<HTMLButtonElement>("button"))
        : [];
      for (const button of buttons) {
        button.classList.toggle("active", button === target);
      }
      this.updateSliceControls(true);
      this.updateSlicePlane();
      this.renderSlice();
    });

    this.canvas.addEventListener("pointerdown", (event) => this.startSliceDrag(event));
    this.canvas.addEventListener("pointermove", (event) => this.moveSliceDrag(event));
    this.canvas.addEventListener("pointerup", () => this.endSliceDrag());
    this.canvas.addEventListener("pointercancel", () => this.endSliceDrag());
    this.canvas.addEventListener("wheel", (event) => this.stepSliceFromWheel(event), { passive: false });
    this.sliceCanvas.addEventListener("pointermove", (event) => this.inspectSlicePointer(event));
    this.sliceCanvas.addEventListener("pointerleave", () => this.setInspector());
  }

  private async loadSelectedVolumeFile(): Promise<void> {
    const file = this.volumeInput.files?.[0];
    if (!file) {
      return;
    }

    try {
      this.setStatus(`Loading ${file.name}`);
      this.volumes = await loadVolumeFile(file);
      this.populateArraySelect();
      this.selectVolume(0);
    } catch (error) {
      this.setStatus(errorMessage(error));
    }
  }

  private populateArraySelect(): void {
    this.arraySelect.replaceChildren();

    this.volumes.forEach((volume, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${volume.name} (${volume.shape.join(" x ")})`;
      this.arraySelect.append(option);
    });

    this.arraySelectRow.classList.toggle("hidden", this.volumes.length <= 1);
  }

  private selectVolume(index: number): void {
    const volume = this.volumes[index];
    if (!volume) {
      return;
    }

    this.activeVolume = volume;
    this.schemaSelect.value = inferSchemaForVolume(volume);
    this.updateSliceControls(true);
    this.updateSlicePlane();
    this.renderSlice();
    const warnings = volume.warnings.length ? ` ${volume.warnings.join(" ")}` : "";
    this.setStatus(`Volume ${volume.name}: ${volume.shape.join(" x ")} ${volume.dtype}.${warnings}`);
  }

  private async loadSelectedMeshFile(): Promise<void> {
    const file = this.meshInput.files?.[0];
    if (!file) {
      return;
    }

    try {
      this.setStatus(`Loading mesh ${file.name}`);
      const object = await this.parseMesh(file);
      this.setMeshObject(object, file.name);
      this.setStatus(`Mesh ${file.name} loaded`);
    } catch (error) {
      this.setStatus(errorMessage(error));
    }
  }

  private async parseMesh(file: File): Promise<THREE.Object3D> {
    const extension = file.name.split(".").pop()?.toLowerCase();

    if (extension === "obj") {
      return new OBJLoader().parse(await file.text());
    }

    if (extension === "ply") {
      const geometry = new PLYLoader().parse(await file.arrayBuffer());
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry);
    }

    if (extension === "stl") {
      const geometry = new STLLoader().parse(await file.arrayBuffer());
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry);
    }

    throw new Error("Unsupported mesh format. Use .ply, .obj, or .stl.");
  }

  private setMeshObject(object: THREE.Object3D, name: string): void {
    this.clearGroup(this.meshRoot);
    const root = this.normalizeMesh.checked ? normalizeIntoUnitBox(object) : object;
    root.name = name;
    this.prepareMeshObject(root);
    this.meshRoot.add(root);
    this.updateMeshDisplay();
  }

  private prepareMeshObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      if (!isMesh(child)) {
        return;
      }

      if (!child.geometry.attributes.normal) {
        child.geometry.computeVertexNormals();
      }

      child.userData.viewerRole = "solid";
      child.material = new THREE.MeshStandardMaterial({
        color: "#d9dde7",
        roughness: 0.65,
        metalness: 0.04,
        transparent: true,
        opacity: Number(this.meshOpacity.value),
        side: THREE.DoubleSide,
      });

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(child.geometry, 28),
        new THREE.LineBasicMaterial({
          color: "#202938",
          transparent: true,
          opacity: 0.74,
          depthTest: true,
        }),
      );
      edges.name = "wireframe-overlay";
      edges.userData.viewerRole = "wire";
      child.add(edges);
    });
  }

  private updateMeshDisplay(): void {
    const mode = this.meshModeSelect.value as MeshMode;
    let opacity = Number(this.meshOpacity.value);

    if (mode === "transparent") {
      opacity = Math.min(opacity, 0.5);
    }

    this.meshOpacityValue.value = opacity.toFixed(2);

    this.meshRoot.traverse((child) => {
      const role = child.userData.viewerRole;

      if (isMesh(child) && role === "solid") {
        child.visible = mode !== "wireframe";
        const material = child.material;
        if (isMeshMaterial(material)) {
          material.opacity = opacity;
          material.transparent = opacity < 1 || mode === "transparent";
          material.depthWrite = opacity >= 0.92 && mode !== "transparent";
          material.needsUpdate = true;
        }
      }

      if (isLineSegments(child) && role === "wire") {
        child.visible = mode === "wireframe" || mode === "solidWire";
      }
    });
  }

  private updateSliceControls(resetValue = false): void {
    const dims = this.activeVolume ? this.getWorldDims() : [1, 1, 1] as [number, number, number];
    const axisIndex = axisToIndex(this.sliceAxis);
    const max = dims[axisIndex] - 1;

    this.sliceSlider.disabled = !this.activeVolume;
    this.sliceSlider.max = String(max);
    this.sliceLabel.textContent = `${this.sliceAxis.toUpperCase()} slice`;

    if (!this.activeVolume) {
      this.sliceSlider.value = "0";
      this.sliceValue.value = "-";
      this.sliceIndex = 0;
      return;
    }

    if (resetValue || this.sliceIndex > max) {
      this.sliceIndex = Math.floor(max / 2);
      this.sliceSlider.value = String(this.sliceIndex);
    }

    this.sliceValue.value = String(this.sliceIndex);
  }

  private setSliceIndex(index: number): void {
    const max = this.getSliceMax();
    this.sliceIndex = clamp(Math.round(index), 0, max);
    this.sliceSlider.value = String(this.sliceIndex);
    this.sliceValue.value = String(this.sliceIndex);
    this.updateSlicePlane();
    this.renderSlice();
  }

  private getSliceMax(): number {
    if (!this.activeVolume) {
      return 0;
    }

    const dims = this.getWorldDims();
    return dims[axisToIndex(this.sliceAxis)] - 1;
  }

  private updateSlicePlane(): void {
    const dims = this.activeVolume ? this.getWorldDims() : [1, 1, 1] as [number, number, number];
    const position = indexToWorld(this.sliceIndex, dims[axisToIndex(this.sliceAxis)]);

    this.sliceRoot.position.set(0, 0, 0);
    this.sliceRoot.rotation.set(0, 0, 0);

    if (this.sliceAxis === "x") {
      this.sliceRoot.position.x = position;
      this.sliceRoot.rotation.y = Math.PI / 2;
    } else if (this.sliceAxis === "y") {
      this.sliceRoot.position.y = position;
      this.sliceRoot.rotation.x = Math.PI / 2;
    } else {
      this.sliceRoot.position.z = position;
    }
  }

  private renderSlice(): void {
    const volume = this.activeVolume;
    if (!volume) {
      this.clearSliceCanvas("Load a volume to see slice colors");
      this.renderStats.textContent = "No volume loaded";
      this.renderLegend(new Map());
      this.setInspector();
      return;
    }

    const started = performance.now();
    const schema = this.schemaSelect.value as LabelSchema;
    const dims = this.getWorldDims();
    const [width, height] = this.getSliceSize(dims);
    const image = this.sliceContext.createImageData(width, height);
    const counts = new Map<CategoryKey, number>();

    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const sample = this.sampleSlicePixel(px, py, height);
        const category = classifyDisplayLabel(sample.label, schema, volume.visualization ?? "raw");
        const [r, g, b] = colorForLabel(sample.label, category);
        const offset = (py * width + px) * 4;
        image.data[offset] = r;
        image.data[offset + 1] = g;
        image.data[offset + 2] = b;
        image.data[offset + 3] = 255;

        if (category) {
          counts.set(category, (counts.get(category) ?? 0) + 1);
        }
      }
    }

    this.sliceCanvas.width = width;
    this.sliceCanvas.height = height;
    this.sliceContext.imageSmoothingEnabled = false;
    this.sliceContext.putImageData(image, 0, 0);
    this.renderLegend(counts);

    const elapsed = performance.now() - started;
    this.renderStats.textContent = `${this.sliceAxis.toUpperCase()}=${this.sliceIndex}, ${width} x ${height}, ${elapsed.toFixed(1)} ms`;
  }

  private clearSliceCanvas(message: string): void {
    const width = 640;
    const height = 640;
    this.sliceCanvas.width = width;
    this.sliceCanvas.height = height;
    this.sliceContext.fillStyle = "#eef2f7";
    this.sliceContext.fillRect(0, 0, width, height);
    this.sliceContext.fillStyle = "#64748b";
    this.sliceContext.font = "16px system-ui, sans-serif";
    this.sliceContext.textAlign = "center";
    this.sliceContext.fillText(message, width / 2, height / 2);
  }

  private renderLegend(counts: Map<CategoryKey, number>): void {
    this.legendList.replaceChildren();
    const visibleKeys = CATEGORY_ORDER.filter((key) => (counts.get(key) ?? 0) > 0);

    if (visibleKeys.length === 0) {
      const empty = document.createElement("span");
      empty.className = "legend-empty";
      empty.textContent = "No labels on this slice";
      this.legendList.append(empty);
      return;
    }

    for (const key of visibleKeys) {
      const definition = CATEGORIES[key];
      if (!definition.visibleInLegend) {
        continue;
      }

      const row = document.createElement("div");
      row.className = "legend-row";

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = definition.color;

      const label = document.createElement("span");
      label.textContent = definition.label;

      const count = document.createElement("strong");
      count.textContent = (counts.get(key) ?? 0).toLocaleString();

      row.append(swatch, label, count);
      this.legendList.append(row);
    }
  }

  private sampleSlicePixel(px: number, py: number, height: number): SliceSample {
    const volume = this.activeVolume;
    if (!volume) {
      return {
        grid: [0, 0, 0],
        worldIndex: [0, 0, 0],
        world: new THREE.Vector3(),
        label: Number.NaN,
        category: null,
      };
    }

    const dims = this.getWorldDims();
    const u = px;
    const v = height - 1 - py;
    let worldIndex: [number, number, number];

    if (this.sliceAxis === "x") {
      worldIndex = [this.sliceIndex, v, u];
    } else if (this.sliceAxis === "y") {
      worldIndex = [u, this.sliceIndex, v];
    } else {
      worldIndex = [u, v, this.sliceIndex];
    }

    const grid = this.worldIndexToGrid(worldIndex);
    const label = this.getVolumeValue(grid[0], grid[1], grid[2]);
    const category = classifyDisplayLabel(
      label,
      this.schemaSelect.value as LabelSchema,
      volume.visualization ?? "raw",
    );
    const world = new THREE.Vector3(
      indexToWorld(worldIndex[0], dims[0]),
      indexToWorld(worldIndex[1], dims[1]),
      indexToWorld(worldIndex[2], dims[2]),
    );

    return { grid, worldIndex, world, label, category };
  }

  private getSliceSize(dims: [number, number, number]): [number, number] {
    if (this.sliceAxis === "x") {
      return [dims[2], dims[1]];
    }
    if (this.sliceAxis === "y") {
      return [dims[0], dims[2]];
    }
    return [dims[0], dims[1]];
  }

  private getWorldDims(): [number, number, number] {
    if (!this.activeVolume) {
      return [1, 1, 1];
    }

    const [nx, ny, nz] = this.activeVolume.shape;
    return this.axisOrderSelect.value === "xyz" ? [nx, ny, nz] : [nz, ny, nx];
  }

  private worldIndexToGrid(worldIndex: [number, number, number]): [number, number, number] {
    const dims = this.getWorldDims();
    let [x, y, z] = worldIndex;

    if (this.flipX.checked) {
      x = dims[0] - 1 - x;
    }
    if (this.flipY.checked) {
      y = dims[1] - 1 - y;
    }
    if (this.flipZ.checked) {
      z = dims[2] - 1 - z;
    }

    if ((this.axisOrderSelect.value as AxisOrder) === "xyz") {
      return [x, y, z];
    }

    return [z, y, x];
  }

  private getVolumeValue(i: number, j: number, k: number): number {
    const volume = this.activeVolume;
    if (!volume) {
      return Number.NaN;
    }

    const [nx, ny, nz] = volume.shape;
    const offset = volume.fortranOrder
      ? i + nx * (j + ny * k)
      : k + nz * (j + ny * i);
    return Number(volume.data[offset]);
  }

  private startSliceDrag(event: PointerEvent): void {
    if (!this.activeVolume) {
      return;
    }

    this.setPointerFromEvent(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.slicePlane, true);
    if (hits.length === 0) {
      return;
    }

    this.draggingSlice = true;
    this.dragStartPointer.set(event.clientX, event.clientY);
    this.dragStartIndex = this.sliceIndex;
    this.controls.enabled = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add("dragging");
  }

  private moveSliceDrag(event: PointerEvent): void {
    if (!this.draggingSlice) {
      return;
    }

    const dx = event.clientX - this.dragStartPointer.x;
    const dy = this.dragStartPointer.y - event.clientY;
    const delta = this.sliceAxis === "x" ? dx : dy;
    const max = this.getSliceMax();
    const sensitivity = Math.max(4, Math.min(12, 360 / Math.max(1, max + 1)));
    this.setSliceIndex(this.dragStartIndex + Math.round(delta / sensitivity));
  }

  private endSliceDrag(): void {
    if (!this.draggingSlice) {
      return;
    }

    this.draggingSlice = false;
    this.controls.enabled = true;
    this.canvas.classList.remove("dragging");
  }

  private stepSliceFromWheel(event: WheelEvent): void {
    if (!this.activeVolume) {
      return;
    }

    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    this.setSliceIndex(this.sliceIndex + direction);
  }

  private inspectSlicePointer(event: PointerEvent): void {
    if (!this.activeVolume || this.sliceCanvas.width === 0 || this.sliceCanvas.height === 0) {
      this.setInspector();
      return;
    }

    const rect = this.sliceCanvas.getBoundingClientRect();
    const px = clamp(Math.floor((event.clientX - rect.left) / rect.width * this.sliceCanvas.width), 0, this.sliceCanvas.width - 1);
    const py = clamp(Math.floor((event.clientY - rect.top) / rect.height * this.sliceCanvas.height), 0, this.sliceCanvas.height - 1);
    const sample = this.sampleSlicePixel(px, py, this.sliceCanvas.height);

    this.setInspector({
      Grid: `[${sample.grid.join(", ")}]`,
      World: formatVector(sample.world),
      Label: formatDisplayLabel(sample.label, this.activeVolume.visualization ?? "raw"),
      Category: sample.category ? categoryDisplayName(sample.category) : "-",
    });
  }

  private setPointerFromEvent(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private setInspector(values?: Record<string, string>): void {
    const data = values ?? {
      Grid: "-",
      World: "-",
      Label: "-",
      Category: "-",
    };

    this.inspectorList.replaceChildren();
    for (const [term, description] of Object.entries(data)) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = description;
      this.inspectorList.append(dt, dd);
    }
  }

  private loadDemo(): void {
    const volume = createDemoVolume();
    this.volumes = [volume];
    this.populateArraySelect();
    this.arraySelect.value = "0";
    this.schemaSelect.value = "semantic";
    this.selectVolume(0);

    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.62, 64, 32));
    sphere.name = "demo-sphere";
    this.normalizeMesh.checked = false;
    this.setMeshObject(sphere, "demo sphere");
    this.setStatus("Demo volume and mesh loaded");
  }

  private resetCamera(): void {
    this.camera.position.set(2.65, 2.15, 2.45);
    this.camera.near = 0.01;
    this.camera.far = 80;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    this.camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height, false);
  }

  private animate(): void {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      disposeObject(child);
    }
  }

  private setStatus(message: string): void {
    this.statusText.textContent = message;
  }
}

function createDemoVolume(): VolumeData {
  const size = 96;
  const data = new Uint8Array(size * size * size);
  const cell = 2 / size;
  const radius = 0.62;
  const bandWidth = 0.16;

  for (let i = 0; i < size; i += 1) {
    const x = -1 + (i + 0.5) * cell;
    for (let j = 0; j < size; j += 1) {
      const y = -1 + (j + 0.5) * cell;
      for (let k = 0; k < size; k += 1) {
        const z = -1 + (k + 0.5) * cell;
        const distance = Math.hypot(x, y, z);
        const offset = k + size * (j + size * i);

        if (Math.abs(distance - radius) < cell * 0.85) {
          data[offset] = 4;
        } else if (Math.abs(distance - radius) < bandWidth && x > -0.18) {
          data[offset] = 3;
        } else if (distance < radius) {
          data[offset] = 2;
        } else {
          data[offset] = 1;
        }
      }
    }
  }

  return {
    name: "demo_pipeline_labels",
    shape: [size, size, size],
    sourceShape: [size, size, size],
    data,
    dtype: "|u1",
    fortranOrder: false,
    warnings: [],
  };
}

function normalizeIntoUnitBox(object: THREE.Object3D): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);

  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    return object;
  }

  const wrapper = new THREE.Group();
  object.position.sub(center);
  wrapper.scale.setScalar(2 / maxDimension);
  wrapper.add(object);
  return wrapper;
}

function classifyDisplayLabel(
  label: number,
  schema: LabelSchema,
  visualization: VolumeData["visualization"],
): CategoryKey | null {
  if (!Number.isFinite(label)) {
    return null;
  }

  if (visualization === "caseOverlay") {
    if (label >= CASE_OVERLAY_OFFSET) {
      return caseIdToCategory(label - CASE_OVERLAY_OFFSET);
    }
    return classifyLabel(label, "semantic");
  }

  if (visualization === "componentOverlay") {
    if (label >= COMPONENT_OVERLAY_OFFSET) {
      return "components";
    }
    return classifyLabel(label, "semantic");
  }

  return classifyLabel(label, schema);
}

function colorForLabel(label: number, category: CategoryKey | null): [number, number, number] {
  if (category === "components") {
    const componentId = label >= CASE_OVERLAY_OFFSET
      ? label - CASE_OVERLAY_OFFSET
      : label >= COMPONENT_OVERLAY_OFFSET
        ? label - COMPONENT_OVERLAY_OFFSET
        : label;
    return componentColor(componentId);
  }

  if (!category) {
    return [127, 127, 127];
  }

  return hexToRgb(CATEGORIES[category].color);
}

function caseIdToCategory(caseId: number): CategoryKey {
  switch (Math.trunc(caseId)) {
    case 1:
      return "insideOnly";
    case 2:
      return "outsideOnly";
    case 3:
      return "bothSides";
    case 4:
      return "isolated";
    default:
      return "components";
  }
}

function inferSchemaForVolume(volume: VolumeData): LabelSchema {
  if (volume.visualization === "caseOverlay") {
    return "cases";
  }
  if (volume.visualization === "componentOverlay") {
    return "components";
  }
  if (volume.visualization === "pipelineLabels") {
    return "semantic";
  }

  const lowerName = volume.name.toLowerCase();
  if (lowerName.includes("case")) {
    return "cases";
  }
  if (lowerName.includes("component") || lowerName.includes("ccl")) {
    return "components";
  }
  return "semantic";
}

function componentColor(label: number): [number, number, number] {
  const seed = Math.abs(Math.trunc(label));
  const hue = ((seed * 137.508) % 360) / 360;
  const [r, g, b] = hslToRgb(hue, schemaSaturation(label), 0.57);
  return [
    Math.round(r * 255),
    Math.round(g * 255),
    Math.round(b * 255),
  ];
}

function schemaSaturation(label: number): number {
  return Number.isFinite(label) ? 0.68 : 0;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    return [l, l, l];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, h + 1 / 3),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1 / 3),
  ];
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) {
    value += 1;
  }
  if (value > 1) {
    value -= 1;
  }
  if (value < 1 / 6) {
    return p + (q - p) * 6 * value;
  }
  if (value < 1 / 2) {
    return q;
  }
  if (value < 2 / 3) {
    return p + (q - p) * (2 / 3 - value) * 6;
  }
  return p;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function indexToWorld(index: number, dimension: number): number {
  return -1 + (index + 0.5) * 2 / Math.max(1, dimension);
}

function axisToIndex(axis: SliceAxis): 0 | 1 | 2 {
  if (axis === "x") {
    return 0;
  }
  if (axis === "y") {
    return 1;
  }
  return 2;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (isMesh(child) || isLineSegments(child)) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose());
      } else {
        material.dispose();
      }
    }
  });
}

function isMesh(object: THREE.Object3D): object is THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]> {
  return (object as THREE.Mesh).isMesh === true;
}

function isLineSegments(object: THREE.Object3D): object is THREE.LineSegments {
  return (object as THREE.LineSegments).isLineSegments === true;
}

function isMeshMaterial(material: THREE.Material | THREE.Material[]): material is THREE.MeshStandardMaterial {
  return !Array.isArray(material) && "opacity" in material;
}

function formatVector(vector: THREE.Vector3): string {
  return `[${vector.x.toFixed(4)}, ${vector.y.toFixed(4)}, ${vector.z.toFixed(4)}]`;
}

function formatLabel(label: number): string {
  return Number.isInteger(label) ? String(label) : label.toFixed(4);
}

function formatDisplayLabel(label: number, visualization: VolumeData["visualization"]): string {
  if (visualization === "caseOverlay" && label >= CASE_OVERLAY_OFFSET) {
    return `case ${formatLabel(label - CASE_OVERLAY_OFFSET)}`;
  }
  if (visualization === "componentOverlay" && label >= COMPONENT_OVERLAY_OFFSET) {
    return `component ${formatLabel(label - COMPONENT_OVERLAY_OFFSET)}`;
  }
  return formatLabel(label);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mustGetContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Could not create a 2D canvas context.");
  }
  return context;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

new MeshSliceViewer();
