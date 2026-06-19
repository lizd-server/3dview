import "./style.css";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  CATEGORIES,
  CATEGORY_ORDER,
  categoryDisplayName,
  type AxisOrder,
  type CategoryKey,
  type LabelSchema,
  type RenderMode,
  type RenderSettings,
  type SliceAxis,
  type VolumeData,
  type WorkerRenderResult,
  type WorkerResponse,
} from "./types";
import { loadVolumeFile } from "./volumeLoader";

type MeshMode = "solid" | "wireframe" | "transparent" | "solidWire";

interface CategoryControlState {
  visible: boolean;
  opacity: number;
}

interface VoxelMeshUserData {
  key: CategoryKey;
  positions: Float32Array;
  indices: Uint32Array;
  labels: Float64Array;
}

class VoxelMeshViewer {
  private readonly canvas = getElement<HTMLCanvasElement>("viewerCanvas");
  private readonly statusText = getElement<HTMLElement>("statusText");
  private readonly renderStats = getElement<HTMLElement>("renderStats");
  private readonly volumeInput = getElement<HTMLInputElement>("volumeInput");
  private readonly meshInput = getElement<HTMLInputElement>("meshInput");
  private readonly arraySelect = getElement<HTMLSelectElement>("arraySelect");
  private readonly arraySelectRow = getElement<HTMLElement>("arraySelectRow");
  private readonly schemaSelect = getElement<HTMLSelectElement>("schemaSelect");
  private readonly categoryControls = getElement<HTMLElement>("categoryControls");
  private readonly renderModeSelect = getElement<HTMLSelectElement>("renderModeSelect");
  private readonly sampleStep = getElement<HTMLInputElement>("sampleStep");
  private readonly maxVoxels = getElement<HTMLInputElement>("maxVoxels");
  private readonly autoSample = getElement<HTMLInputElement>("autoSample");
  private readonly sliceSlider = getElement<HTMLInputElement>("sliceSlider");
  private readonly sliceLabel = getElement<HTMLElement>("sliceLabel");
  private readonly sliceValue = getElement<HTMLOutputElement>("sliceValue");
  private readonly sliceThickness = getElement<HTMLInputElement>("sliceThickness");
  private readonly axisOrderSelect = getElement<HTMLSelectElement>("axisOrderSelect");
  private readonly flipX = getElement<HTMLInputElement>("flipX");
  private readonly flipY = getElement<HTMLInputElement>("flipY");
  private readonly flipZ = getElement<HTMLInputElement>("flipZ");
  private readonly meshModeSelect = getElement<HTMLSelectElement>("meshModeSelect");
  private readonly meshOpacity = getElement<HTMLInputElement>("meshOpacity");
  private readonly meshOpacityValue = getElement<HTMLOutputElement>("meshOpacityValue");
  private readonly normalizeMesh = getElement<HTMLInputElement>("normalizeMesh");
  private readonly inspectorList = getElement<HTMLElement>("inspectorList");

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  private readonly renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
  private readonly controls = new OrbitControls(this.camera, this.canvas);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly voxelRoot = new THREE.Group();
  private readonly meshRoot = new THREE.Group();
  private readonly hoverBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    }),
  );
  private readonly worker = new Worker(new URL("./volumeWorker.ts", import.meta.url), { type: "module" });
  private readonly categoryState: Record<CategoryKey, CategoryControlState> = createCategoryState();

  private volumes: VolumeData[] = [];
  private activeVolume: VolumeData | null = null;
  private sliceAxis: SliceAxis = "none";
  private requestId = 0;
  private renderTimer = 0;
  private lastCellSize: [number, number, number] = [1, 1, 1];

  constructor() {
    this.scene.background = new THREE.Color("#f4f6f8");
    this.scene.add(this.voxelRoot, this.meshRoot);
    this.hoverBox.visible = false;
    this.hoverBox.renderOrder = 1000;
    this.scene.add(this.hoverBox);

    this.addSceneGuides();
    this.addLighting();
    this.resetCamera();
    this.configureRenderer();
    this.createCategoryControls();
    this.bindEvents();
    this.updateSliceControls();
    this.updateMeshDisplay();
    this.resize();
    this.animate();
  }

  private addSceneGuides(): void {
    const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const helper = new THREE.Box3Helper(bounds, new THREE.Color("#344054"));
    const helperMaterial = helper.material as THREE.LineBasicMaterial;
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.32;
    this.scene.add(helper);

    const axes = new THREE.AxesHelper(1.25);
    axes.position.set(-1, -1, -1);
    this.scene.add(axes);

    const grid = new THREE.GridHelper(2, 8, "#8792a2", "#d4dae3");
    grid.position.y = -1;
    this.scene.add(grid);
  }

  private addLighting(): void {
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#d1d5db", 2.1));

    const keyLight = new THREE.DirectionalLight("#ffffff", 2.4);
    keyLight.position.set(3, 4, 5);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight("#d9f7ff", 0.8);
    fillLight.position.set(-4, 2, -3);
    this.scene.add(fillLight);
  }

  private configureRenderer(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
  }

  private bindEvents(): void {
    window.addEventListener("resize", () => this.resize());
    this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => this.handleWorkerMessage(event.data));

    this.volumeInput.addEventListener("change", () => void this.loadSelectedVolumeFile());
    this.meshInput.addEventListener("change", () => void this.loadSelectedMeshFile());
    this.arraySelect.addEventListener("change", () => this.selectVolume(Number(this.arraySelect.value)));
    this.schemaSelect.addEventListener("change", () => this.scheduleRender());
    this.renderModeSelect.addEventListener("change", () => this.scheduleRender());
    this.sampleStep.addEventListener("change", () => this.scheduleRender());
    this.maxVoxels.addEventListener("change", () => this.scheduleRender());
    this.autoSample.addEventListener("change", () => this.scheduleRender());
    this.sliceSlider.addEventListener("input", () => {
      this.sliceValue.value = this.sliceSlider.value;
      this.scheduleRender(40);
    });
    this.sliceThickness.addEventListener("change", () => this.scheduleRender());
    this.axisOrderSelect.addEventListener("change", () => {
      this.updateSliceControls(true);
      this.scheduleRender();
    });
    this.flipX.addEventListener("change", () => this.scheduleRender());
    this.flipY.addEventListener("change", () => this.scheduleRender());
    this.flipZ.addEventListener("change", () => this.scheduleRender());

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
    getElement<HTMLButtonElement>("refreshButton").addEventListener("click", () => this.scheduleRender(0));
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
      this.scheduleRender();
    });

    this.canvas.addEventListener("pointermove", (event) => this.inspectPointer(event));
    this.canvas.addEventListener("pointerleave", () => {
      this.hoverBox.visible = false;
      this.setInspector();
    });
  }

  private createCategoryControls(): void {
    this.categoryControls.replaceChildren();

    for (const key of CATEGORY_ORDER) {
      const definition = CATEGORIES[key];
      const row = document.createElement("div");
      row.className = "category-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.categoryState[key].visible;
      checkbox.addEventListener("change", () => {
        this.categoryState[key].visible = checkbox.checked;
        this.scheduleRender();
      });

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = definition.color;

      const label = document.createElement("span");
      label.className = "category-name";
      label.textContent = definition.label;

      const opacity = document.createElement("input");
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.01";
      opacity.value = String(this.categoryState[key].opacity);
      opacity.addEventListener("input", () => {
        this.categoryState[key].opacity = Number(opacity.value);
        this.updateVoxelMaterials();
      });

      row.append(checkbox, swatch, label, opacity);
      this.categoryControls.append(row);
    }
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
    this.updateSliceControls(true);
    const warnings = volume.warnings.length ? ` ${volume.warnings.join(" ")}` : "";
    this.setStatus(`Volume ${volume.name}: ${volume.shape.join(" x ")} ${volume.dtype}.${warnings}`);
    this.postVolumeToWorker(volume);
  }

  private postVolumeToWorker(volume: VolumeData): void {
    const requestId = this.nextRequestId();
    this.worker.postMessage({
      type: "load",
      requestId,
      volume: {
        name: volume.name,
        shape: volume.shape,
        data: volume.data,
        dtype: volume.dtype,
        fortranOrder: volume.fortranOrder,
      },
      settings: this.collectSettings(),
    });
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

  private scheduleRender(delay = 120): void {
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      if (!this.activeVolume) {
        return;
      }

      const requestId = this.nextRequestId();
      this.setStatus("Extracting voxels");
      this.worker.postMessage({
        type: "render",
        requestId,
        settings: this.collectSettings(),
      });
    }, delay);
  }

  private collectSettings(): RenderSettings {
    const visibleCategories = Object.fromEntries(
      CATEGORY_ORDER.map((key) => [key, this.categoryState[key].visible]),
    ) as Record<CategoryKey, boolean>;

    return {
      schema: this.schemaSelect.value as LabelSchema,
      renderMode: this.renderModeSelect.value as RenderMode,
      sampleStep: Number(this.sampleStep.value),
      autoSample: this.autoSample.checked,
      maxVoxels: Number(this.maxVoxels.value),
      sliceAxis: this.sliceAxis,
      sliceIndex: Number(this.sliceSlider.value),
      sliceThickness: Number(this.sliceThickness.value),
      axisOrder: this.axisOrderSelect.value as AxisOrder,
      flipX: this.flipX.checked,
      flipY: this.flipY.checked,
      flipZ: this.flipZ.checked,
      visibleCategories,
    };
  }

  private handleWorkerMessage(response: WorkerResponse): void {
    if (response.requestId !== this.requestId) {
      return;
    }

    if (response.type === "status") {
      this.setStatus(response.message);
      return;
    }

    if (response.type === "error") {
      this.setStatus(response.message);
      return;
    }

    this.applyVoxelResult(response);
  }

  private applyVoxelResult(result: WorkerRenderResult): void {
    this.clearGroup(this.voxelRoot);
    this.lastCellSize = result.cellSize;

    for (const group of result.groups) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshStandardMaterial({
        color: CATEGORIES[group.key].color,
        roughness: 0.72,
        metalness: 0,
        transparent: true,
        opacity: this.categoryState[group.key].opacity,
        depthWrite: this.categoryState[group.key].opacity >= 0.9,
        vertexColors: Boolean(group.colors),
      });
      const mesh = new THREE.InstancedMesh(geometry, material, group.count);
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3(
        result.cellSize[0] * 0.94,
        result.cellSize[1] * 0.94,
        result.cellSize[2] * 0.94,
      );

      for (let index = 0; index < group.count; index += 1) {
        matrix.compose(
          new THREE.Vector3(
            group.positions[index * 3],
            group.positions[index * 3 + 1],
            group.positions[index * 3 + 2],
          ),
          new THREE.Quaternion(),
          scale,
        );
        mesh.setMatrixAt(index, matrix);

        if (group.colors) {
          mesh.setColorAt(index, new THREE.Color(
            group.colors[index * 3],
            group.colors[index * 3 + 1],
            group.colors[index * 3 + 2],
          ));
        }
      }

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
      mesh.userData = {
        key: group.key,
        positions: group.positions,
        indices: group.indices,
        labels: group.labels,
      } satisfies VoxelMeshUserData;

      this.voxelRoot.add(mesh);
    }

    const { stats } = result;
    const capText = stats.capped ? " capped" : "";
    this.renderStats.textContent = `${stats.emitted.toLocaleString()} voxels${capText}, scanned ${stats.scanned.toLocaleString()}, step ${stats.step}, ${stats.elapsedMs.toFixed(0)} ms`;
    this.setStatus(`Rendered ${stats.emitted.toLocaleString()} voxels`);
    this.hoverBox.visible = false;
  }

  private updateVoxelMaterials(): void {
    for (const child of this.voxelRoot.children) {
      if (!isInstancedMesh(child)) {
        continue;
      }

      const key = (child.userData as VoxelMeshUserData).key;
      const material = child.material;
      if (isMeshMaterial(material)) {
        material.opacity = this.categoryState[key].opacity;
        material.transparent = material.opacity < 1;
        material.depthWrite = material.opacity >= 0.9;
        material.needsUpdate = true;
      }
    }
  }

  private updateSliceControls(resetValue = false): void {
    const axis = this.sliceAxis;
    const dims = this.activeVolume ? getWorldDims(this.activeVolume.shape, this.axisOrderSelect.value as AxisOrder) : [1, 1, 1];
    const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    const max = axis === "none" ? 0 : dims[axisIndex] - 1;

    this.sliceSlider.disabled = axis === "none" || !this.activeVolume;
    this.sliceSlider.max = String(max);
    this.sliceLabel.textContent = axis === "none" ? "Slice" : `${axis.toUpperCase()} slice`;

    if (axis === "none") {
      this.sliceSlider.value = "0";
      this.sliceValue.value = "-";
      return;
    }

    if (resetValue || Number(this.sliceSlider.value) > max) {
      this.sliceSlider.value = String(Math.floor(max / 2));
    }
    this.sliceValue.value = this.sliceSlider.value;
  }

  private inspectPointer(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const voxelHits = this.raycaster.intersectObjects(this.voxelRoot.children, false);
    const voxelHit = voxelHits.find((hit) => hit.instanceId !== undefined);
    if (voxelHit?.instanceId !== undefined && isInstancedMesh(voxelHit.object)) {
      this.inspectVoxel(voxelHit.object, voxelHit.instanceId);
      return;
    }

    const meshHits = this.raycaster
      .intersectObjects(this.meshRoot.children, true)
      .filter((hit) => hit.object.userData.viewerRole !== "wire");

    if (meshHits[0]) {
      const hit = meshHits[0];
      this.hoverBox.visible = false;
      this.setInspector({
        Target: "Mesh triangle",
        Grid: "-",
        World: formatVector(hit.point),
        Label: hit.faceIndex === undefined ? "-" : `face ${hit.faceIndex}`,
        Category: hit.object.name || "mesh",
      });
      return;
    }

    this.hoverBox.visible = false;
    this.setInspector();
  }

  private inspectVoxel(mesh: THREE.InstancedMesh, instanceId: number): void {
    const data = mesh.userData as VoxelMeshUserData;
    const p = instanceId * 3;
    const position = new THREE.Vector3(
      data.positions[p],
      data.positions[p + 1],
      data.positions[p + 2],
    );
    const grid = [
      data.indices[p],
      data.indices[p + 1],
      data.indices[p + 2],
    ];
    const label = data.labels[instanceId];
    const category = data.key;

    this.hoverBox.position.copy(position);
    this.hoverBox.scale.set(
      this.lastCellSize[0] * 1.08,
      this.lastCellSize[1] * 1.08,
      this.lastCellSize[2] * 1.08,
    );
    this.hoverBox.visible = true;

    const idText = category === "components"
      ? `component ${formatLabel(label)}`
      : isCaseCategory(category)
        ? `case ${formatLabel(label)}`
        : formatLabel(label);

    this.setInspector({
      Target: "Voxel",
      Grid: `[${grid.join(", ")}]`,
      World: formatVector(position),
      Label: idText,
      Category: categoryDisplayName(category),
    });
  }

  private setInspector(values?: Record<string, string>): void {
    const data = values ?? {
      Target: "-",
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

  private nextRequestId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private setStatus(message: string): void {
    this.statusText.textContent = message;
  }
}

function createCategoryState(): Record<CategoryKey, CategoryControlState> {
  return Object.fromEntries(
    CATEGORY_ORDER.map((key) => [
      key,
      {
        visible: CATEGORIES[key].defaultVisible,
        opacity: CATEGORIES[key].defaultOpacity,
      },
    ]),
  ) as Record<CategoryKey, CategoryControlState>;
}

function createDemoVolume(): VolumeData {
  const size = 56;
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
    name: "demo_semantic_volume",
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

function getWorldDims(
  [nx, ny, nz]: [number, number, number],
  axisOrder: AxisOrder,
): [number, number, number] {
  return axisOrder === "xyz" ? [nx, ny, nz] : [nz, ny, nx];
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

function isInstancedMesh(object: THREE.Object3D): object is THREE.InstancedMesh {
  return (object as THREE.InstancedMesh).isInstancedMesh === true;
}

function isLineSegments(object: THREE.Object3D): object is THREE.LineSegments {
  return (object as THREE.LineSegments).isLineSegments === true;
}

function isMeshMaterial(material: THREE.Material | THREE.Material[]): material is THREE.MeshStandardMaterial {
  return !Array.isArray(material) && "opacity" in material;
}

function isCaseCategory(category: CategoryKey): boolean {
  return category === "insideOnly" || category === "outsideOnly" || category === "bothSides" || category === "isolated";
}

function formatVector(vector: THREE.Vector3): string {
  return `[${vector.x.toFixed(4)}, ${vector.y.toFixed(4)}, ${vector.z.toFixed(4)}]`;
}

function formatLabel(label: number): string {
  return Number.isInteger(label) ? String(label) : label.toFixed(4);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

new VoxelMeshViewer();
