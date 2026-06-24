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
  classifyVolumeLabel,
  type CategoryKey,
  type SliceAxis,
  type VolumeData,
} from "./types";
import { parseNpy } from "./volumeLoader";

type MeshMode = "solid" | "wireframe" | "transparent" | "solidWire";
type SliceRenderMode = "pixels" | "cornerDots";

const DOT_SPACING = 4;
const DOT_RADIUS = 1.5;
const DOT_MARGIN = 3;
const DOT_BACKGROUND: [number, number, number] = [238, 242, 247];
const DOT_STAMP: Array<{ dx: number; dy: number; alpha: number }> = [];
for (let dy = -2; dy <= 2; dy += 1) {
  for (let dx = -2; dx <= 2; dx += 1) {
    const distance = Math.hypot(dx, dy);
    const alpha = clamp(DOT_RADIUS + 0.5 - distance, 0, 1);
    if (alpha > 0) {
      DOT_STAMP.push({ dx, dy, alpha });
    }
  }
}

interface SliceSample {
  grid: [number, number, number];
  worldIndex: [number, number, number];
  world: THREE.Vector3;
  label: number;
  category: CategoryKey | null;
}

type PipelineVolumeRole = "label" | "components" | "cases" | "insideFiltered" | "surfaceBoundary";

interface PipelineFolderSelection {
  directory: string;
  volumes: File[];
  mesh: File;
}

interface VolumeSlot {
  name: string;
  volume?: VolumeData;
  file?: File;
}

interface MeshItem {
  id: number;
  name: string;
  object: THREE.Object3D;
}

class MeshSliceViewer {
  private readonly canvas = getElement<HTMLCanvasElement>("viewerCanvas");
  private readonly sliceCanvas = getElement<HTMLCanvasElement>("sliceCanvas");
  private readonly sliceContext: CanvasRenderingContext2D;
  private readonly sliceTextureCanvas = document.createElement("canvas");
  private readonly sliceTextureContext: CanvasRenderingContext2D;
  private readonly sliceTexture = new THREE.CanvasTexture(this.sliceTextureCanvas);
  private readonly statusText = getElement<HTMLElement>("statusText");
  private readonly renderStats = getElement<HTMLElement>("renderStats");
  private readonly folderInput = getElement<HTMLInputElement>("folderInput");
  private readonly meshInput = getElement<HTMLInputElement>("meshInput");
  private readonly arraySelect = getElement<HTMLSelectElement>("arraySelect");
  private readonly arraySelectRow = getElement<HTMLElement>("arraySelectRow");
  private readonly sliceSlider = getElement<HTMLInputElement>("sliceSlider");
  private readonly sliceLabel = getElement<HTMLElement>("sliceLabel");
  private readonly sliceValue = getElement<HTMLOutputElement>("sliceValue");
  private readonly sliceRenderMode = getElement<HTMLSelectElement>("sliceRenderMode");
  private readonly meshModeSelect = getElement<HTMLSelectElement>("meshModeSelect");
  private readonly meshOpacity = getElement<HTMLInputElement>("meshOpacity");
  private readonly meshOpacityValue = getElement<HTMLOutputElement>("meshOpacityValue");
  private readonly meshList = getElement<HTMLElement>("meshList");
  private readonly legendList = getElement<HTMLElement>("legendList");
  private readonly inspectorList = getElement<HTMLElement>("inspectorList");

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  private readonly renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
  private readonly controls = new OrbitControls(this.camera, this.canvas);
  private readonly meshRoot = new THREE.Group();
  private readonly sliceRoot = new THREE.Group();
  private readonly meshClipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private readonly meshClippingPlanes = [this.meshClipPlane];
  private readonly slicePlaneMaterial = new THREE.MeshBasicMaterial({
    color: "#f97316",
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  private readonly slicePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    this.slicePlaneMaterial,
  );

  private volumeSlots: VolumeSlot[] = [];
  private activeVolume: VolumeData | null = null;
  private volumeLoadToken = 0;
  private currentMeshFiles: File[] = [];
  private meshItems: MeshItem[] = [];
  private nextMeshId = 1;
  private sliceAxis: SliceAxis = "z";
  private sliceIndex = 0;
  private slicePlaneHasTexture = false;
  private lastSliceRenderMode: SliceRenderMode = "pixels";
  private lastDotCanvasSize = "";

  constructor() {
    const sliceContext = this.sliceCanvas.getContext("2d", { alpha: false });
    if (!sliceContext) {
      throw new Error("Could not create a 2D canvas context.");
    }
    this.sliceContext = sliceContext;
    const sliceTextureContext = this.sliceTextureCanvas.getContext("2d", { alpha: true });
    if (!sliceTextureContext) {
      throw new Error("Could not create a texture canvas context.");
    }
    this.sliceTextureContext = sliceTextureContext;

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
    this.renderer.localClippingEnabled = true;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.sliceContext.imageSmoothingEnabled = false;
    this.sliceTexture.colorSpace = THREE.SRGBColorSpace;
    this.sliceTexture.magFilter = THREE.NearestFilter;
    this.sliceTexture.minFilter = THREE.NearestFilter;
    this.sliceTexture.generateMipmaps = false;
  }

  private bindEvents(): void {
    window.addEventListener("resize", () => this.resize());

    this.folderInput.addEventListener("change", () => void this.loadSelectedPipelineFolder());
    this.meshInput.addEventListener("change", () => void this.loadSelectedMeshFile());
    this.arraySelect.addEventListener("change", () => void this.selectVolume(Number(this.arraySelect.value)));
    this.sliceRenderMode.addEventListener("change", () => {
      this.setInspector();
      this.renderSlice();
    });

    this.sliceSlider.addEventListener("input", () => {
      this.setSliceIndex(Number(this.sliceSlider.value));
    });

    this.meshModeSelect.addEventListener("change", () => this.updateMeshDisplay());
    this.meshOpacity.addEventListener("input", () => this.updateMeshDisplay());

    getElement<HTMLButtonElement>("clearMeshButton").addEventListener("click", () => {
      this.clearGroup(this.meshRoot);
      this.currentMeshFiles = [];
      this.meshItems = [];
      this.renderMeshList();
      this.setStatus("Mesh cleared");
    });
    getElement<HTMLButtonElement>("resetCameraButton").addEventListener("click", () => this.resetCamera());

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

    this.sliceCanvas.addEventListener("pointermove", (event) => this.inspectSlicePointer(event));
    this.sliceCanvas.addEventListener("pointerleave", () => this.setInspector());
  }

  private async loadSelectedPipelineFolder(): Promise<void> {
    const files = Array.from(this.folderInput.files ?? []);
    if (files.length === 0) {
      return;
    }

    try {
      const selection = findPipelineFolderSelection(files);
      this.setStatus(`Loading folder ${selection.directory || "(selected folder)"}`);

      this.activeVolume = null;
      this.volumeLoadToken += 1;
      this.volumeSlots = selection.volumes.map((file) => ({
        name: file.name,
        file,
      }));
      this.populateArraySelect();

      const caseIndex = this.volumeSlots.findIndex((slot) => slot.name.toLowerCase().includes("cases"));
      this.arraySelect.value = String(caseIndex >= 0 ? caseIndex : 0);
      await this.loadMeshFiles([selection.mesh], { replace: true });
      await this.selectVolume(caseIndex >= 0 ? caseIndex : 0, true);
      this.setStatus(
        `Folder ${selection.directory || "(selected folder)"} loaded: ${selection.volumes.map((file) => file.name).join(", ")} and ${selection.mesh.name}`,
      );
    } catch (error) {
      this.setStatus(errorMessage(error));
    }
  }

  private populateArraySelect(): void {
    const selectedValue = this.arraySelect.value;
    this.arraySelect.replaceChildren();

    this.volumeSlots.forEach((slot, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = slot.volume
        ? `${slot.name} (${slot.volume.shape.join(" x ")})`
        : `${slot.name} (load on select)`;
      this.arraySelect.append(option);
    });

    if (this.volumeSlots.length > 0) {
      const selectedIndex = Number(selectedValue);
      this.arraySelect.value = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < this.volumeSlots.length
        ? selectedValue
        : "0";
    }

    this.arraySelectRow.classList.toggle("hidden", this.volumeSlots.length <= 1);
  }

  private async selectVolume(index: number, resetSlice = false): Promise<void> {
    const slot = this.volumeSlots[index];
    if (!slot) {
      return;
    }

    const token = ++this.volumeLoadToken;

    try {
      this.releaseDeferredVolumesExcept(index);

      if (!slot.volume) {
        if (!slot.file) {
          throw new Error(`Volume ${slot.name} is not available.`);
        }

        this.activeVolume = null;
        this.setStatus(`Loading ${slot.file.name}`);
        await yieldToBrowser();
        const volume = parseNpy(await slot.file.arrayBuffer(), slot.file.name);
        if (token !== this.volumeLoadToken) {
          return;
        }
        slot.volume = volume;
        slot.name = volume.name;
        await yieldToBrowser();
      }

      this.activeVolume = slot.volume;
      this.arraySelect.value = String(index);
      this.populateArraySelect();
      this.arraySelect.value = String(index);
      this.updateSliceControls(resetSlice);
      this.updateSlicePlane();
      this.renderSlice();
      const warnings = slot.volume.warnings.length ? ` ${slot.volume.warnings.join(" ")}` : "";
      this.setStatus(`Volume ${slot.volume.name}: ${slot.volume.shape.join(" x ")} ${slot.volume.dtype}.${warnings}`);
    } catch (error) {
      if (token === this.volumeLoadToken) {
        this.setStatus(errorMessage(error));
      }
    }
  }

  private releaseDeferredVolumesExcept(index: number): void {
    for (let slotIndex = 0; slotIndex < this.volumeSlots.length; slotIndex += 1) {
      if (slotIndex !== index && this.volumeSlots[slotIndex].file) {
        this.volumeSlots[slotIndex].volume = undefined;
      }
    }
  }

  private async loadSelectedMeshFile(): Promise<void> {
    const files = Array.from(this.meshInput.files ?? []);
    if (files.length === 0) {
      return;
    }

    try {
      await this.loadMeshFiles(files, { replace: false });
    } catch (error) {
      this.setStatus(errorMessage(error));
    } finally {
      this.meshInput.value = "";
    }
  }

  private async loadMeshFiles(files: File[], options: { replace: boolean; visibility?: boolean[] }): Promise<void> {
    const filesToLoad = [...files];
    const visibility = options.visibility ?? [];

    if (options.replace) {
      this.clearGroup(this.meshRoot);
      this.currentMeshFiles = [];
      this.meshItems = [];
      this.renderMeshList();
    }

    for (const [index, file] of filesToLoad.entries()) {
      this.setStatus(`Loading mesh ${file.name}`);
      const object = await this.parseMesh(file);
      this.currentMeshFiles.push(file);
      const root = this.addMeshObject(object, file.name, visibility[index] ?? true);
      this.meshItems.push({
        id: this.nextMeshId,
        name: file.name,
        object: root,
      });
      this.nextMeshId += 1;
      this.renderMeshList();
      await yieldToBrowser();
    }

    const loadedCount = filesToLoad.length;
    const totalCount = this.currentMeshFiles.length;
    const clippingNote = this.activeVolume ? "; clipped by current slice" : "";
    this.setStatus(
      loadedCount === totalCount
        ? `Loaded ${totalCount} mesh${totalCount === 1 ? "" : "es"}${clippingNote}`
        : `Added ${loadedCount} mesh${loadedCount === 1 ? "" : "es"} (${totalCount} total)${clippingNote}`,
    );
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

  private addMeshObject(object: THREE.Object3D, name: string, visible = true): THREE.Object3D {
    object.name = name;
    object.visible = visible;
    this.prepareMeshObject(object);
    this.meshRoot.add(object);
    this.updateMeshClipping();
    this.updateMeshDisplay();
    return object;
  }

  private renderMeshList(): void {
    this.meshList.replaceChildren();
    this.meshList.classList.toggle("hidden", this.meshItems.length === 0);

    if (this.meshItems.length === 0) {
      return;
    }

    const title = document.createElement("span");
    title.className = "mesh-list-title";
    title.textContent = "Meshes";

    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.textContent = "All";
    allButton.addEventListener("click", () => this.setAllMeshesVisible(true));

    const noneButton = document.createElement("button");
    noneButton.type = "button";
    noneButton.textContent = "None";
    noneButton.addEventListener("click", () => this.setAllMeshesVisible(false));

    this.meshList.append(title, allButton, noneButton);

    for (const item of this.meshItems) {
      const label = document.createElement("label");
      label.className = "mesh-toggle";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = item.object.visible;
      input.addEventListener("change", () => {
        item.object.visible = input.checked;
      });

      const name = document.createElement("span");
      name.textContent = item.name;
      name.title = item.name;

      label.append(input, name);
      this.meshList.append(label);
    }
  }

  private setAllMeshesVisible(visible: boolean): void {
    for (const item of this.meshItems) {
      item.object.visible = visible;
    }
    this.renderMeshList();
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
        clippingPlanes: this.meshClippingPlanes,
      });

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(child.geometry, 28),
        new THREE.LineBasicMaterial({
          color: "#202938",
          transparent: true,
          opacity: 0.74,
          depthTest: true,
          clippingPlanes: this.meshClippingPlanes,
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
          this.setMaterialClipping(material);
          material.needsUpdate = true;
        }
      }

      if (isLineSegments(child) && role === "wire") {
        child.visible = mode === "wireframe" || mode === "solidWire";
        const material = child.material;
        if (isLineMaterial(material)) {
          this.setMaterialClipping(material);
        }
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

    if (resetValue) {
      this.sliceIndex = Math.floor(max / 2);
    } else {
      this.sliceIndex = clamp(this.sliceIndex, 0, max);
    }

    this.sliceSlider.value = String(this.sliceIndex);
    this.sliceValue.value = String(this.sliceIndex);
  }

  private setSliceIndex(index: number): void {
    const max = this.activeVolume ? this.getWorldDims()[axisToIndex(this.sliceAxis)] - 1 : 0;
    this.sliceIndex = clamp(Math.round(index), 0, max);
    this.sliceSlider.value = String(this.sliceIndex);
    this.sliceValue.value = String(this.sliceIndex);
    this.updateSlicePlane();
    this.renderSlice();
  }

  private updateSlicePlane(): void {
    const dims = this.activeVolume ? this.getWorldDims() : [1, 1, 1] as [number, number, number];
    const position = indexToWorld(this.sliceIndex, dims[axisToIndex(this.sliceAxis)]);

    this.sliceRoot.position.set(0, 0, 0);
    this.sliceRoot.rotation.set(0, 0, 0);

    if (this.sliceAxis === "x") {
      this.sliceRoot.position.x = position;
      this.sliceRoot.rotation.y = -Math.PI / 2;
    } else if (this.sliceAxis === "y") {
      this.sliceRoot.position.y = position;
      this.sliceRoot.rotation.x = Math.PI / 2;
    } else {
      this.sliceRoot.position.z = position;
    }

    this.updateMeshClipping(position);
  }

  private updateMeshClipping(position = 0): void {
    if (!this.activeVolume) {
      this.meshRoot.traverse((child) => {
        if (isMesh(child) && isMeshMaterial(child.material)) {
          this.setMaterialClipping(child.material);
        } else if (isLineSegments(child) && isLineMaterial(child.material)) {
          this.setMaterialClipping(child.material);
        }
      });
      return;
    }

    if (this.sliceAxis === "x") {
      this.meshClipPlane.normal.set(-1, 0, 0);
    } else if (this.sliceAxis === "y") {
      this.meshClipPlane.normal.set(0, -1, 0);
    } else {
      this.meshClipPlane.normal.set(0, 0, -1);
    }
    this.meshClipPlane.constant = position;

    this.meshRoot.traverse((child) => {
      if (isMesh(child) && isMeshMaterial(child.material)) {
        this.setMaterialClipping(child.material);
      } else if (isLineSegments(child) && isLineMaterial(child.material)) {
        this.setMaterialClipping(child.material);
      }
    });
  }

  private setMaterialClipping(material: THREE.Material): void {
    const clippingPlanes = this.activeVolume ? this.meshClippingPlanes : null;
    if (material.clippingPlanes !== clippingPlanes) {
      material.clippingPlanes = clippingPlanes;
      material.needsUpdate = true;
    }
  }

  private renderSlice(): void {
    const volume = this.activeVolume;
    if (!volume) {
      this.clearSliceCanvas("Load a volume to see slice colors");
      this.renderStats.textContent = "No volume loaded";
      this.renderLegend(new Map());
      this.setSlicePlaneTextureEnabled(false);
      this.setInspector();
      return;
    }

    const started = performance.now();
    const dims = this.getWorldDims();
    const [width, height] = this.sliceAxis === "x"
      ? [dims[2], dims[1]]
      : this.sliceAxis === "y"
        ? [dims[0], dims[2]]
        : [dims[0], dims[1]];
    const counts = new Map<CategoryKey, number>();
    const renderMode = this.sliceRenderMode.value as SliceRenderMode;
    const cornerDotMode = renderMode === "cornerDots";
    const compactImage = this.sliceContext.createImageData(width, height);

    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const sample = this.sampleSlicePixel(px, py, height);
        const display = this.getSampleDisplay(sample);
        const [r, g, b] = display.color;
        const offset = (py * width + px) * 4;
        compactImage.data[offset] = r;
        compactImage.data[offset + 1] = g;
        compactImage.data[offset + 2] = b;
        compactImage.data[offset + 3] = 255;

        if (display.category) {
          counts.set(display.category, (counts.get(display.category) ?? 0) + 1);
        }
      }
    }

    if (cornerDotMode) {
      const textureWidth = Math.max(1, (width - 1) * DOT_SPACING + 1);
      const textureHeight = Math.max(1, (height - 1) * DOT_SPACING + 1);
      const textureImage = this.sliceTextureContext.createImageData(textureWidth, textureHeight);

      for (let py = 0; py < height; py += 1) {
        for (let px = 0; px < width; px += 1) {
          const compactOffset = (py * width + px) * 4;
          const r = compactImage.data[compactOffset];
          const g = compactImage.data[compactOffset + 1];
          const b = compactImage.data[compactOffset + 2];
          const centerX = px * DOT_SPACING;
          const centerY = py * DOT_SPACING;

          for (const { dx, dy, alpha } of DOT_STAMP) {
            const x = centerX + dx;
            const y = centerY + dy;
            if (x < 0 || y < 0 || x >= textureWidth || y >= textureHeight) {
              continue;
            }

            const offset = (y * textureWidth + x) * 4;
            textureImage.data[offset] = r;
            textureImage.data[offset + 1] = g;
            textureImage.data[offset + 2] = b;
            textureImage.data[offset + 3] = Math.round(255 * alpha);
          }
        }
      }

      this.sliceTextureCanvas.width = textureWidth;
      this.sliceTextureCanvas.height = textureHeight;
      this.sliceTextureContext.imageSmoothingEnabled = true;
      this.sliceTextureContext.putImageData(textureImage, 0, 0);
      this.sliceTexture.magFilter = THREE.LinearFilter;
      this.sliceTexture.minFilter = THREE.LinearFilter;
    } else {
      this.sliceTextureCanvas.width = width;
      this.sliceTextureCanvas.height = height;
      this.sliceTextureContext.imageSmoothingEnabled = false;
      this.sliceTextureContext.putImageData(compactImage, 0, 0);
      this.sliceTexture.magFilter = THREE.NearestFilter;
      this.sliceTexture.minFilter = THREE.NearestFilter;
    }

    let shouldCenterDotCanvas = false;
    if (cornerDotMode) {
      const canvasWidth = DOT_MARGIN * 2 + Math.max(0, width - 1) * DOT_SPACING + 1;
      const canvasHeight = DOT_MARGIN * 2 + Math.max(0, height - 1) * DOT_SPACING + 1;
      const image = this.sliceContext.createImageData(canvasWidth, canvasHeight);
      const dotCanvasSize = `${canvasWidth}x${canvasHeight}`;
      shouldCenterDotCanvas = this.lastSliceRenderMode !== renderMode || this.lastDotCanvasSize !== dotCanvasSize;
      this.lastDotCanvasSize = dotCanvasSize;

      for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = DOT_BACKGROUND[0];
        image.data[offset + 1] = DOT_BACKGROUND[1];
        image.data[offset + 2] = DOT_BACKGROUND[2];
        image.data[offset + 3] = 255;
      }

      for (let py = 0; py < height; py += 1) {
        for (let px = 0; px < width; px += 1) {
          const compactOffset = (py * width + px) * 4;
          const r = compactImage.data[compactOffset];
          const g = compactImage.data[compactOffset + 1];
          const b = compactImage.data[compactOffset + 2];
          const centerX = DOT_MARGIN + px * DOT_SPACING;
          const centerY = DOT_MARGIN + py * DOT_SPACING;

          for (const { dx, dy, alpha } of DOT_STAMP) {
            const x = centerX + dx;
            const y = centerY + dy;
            const offset = (y * canvasWidth + x) * 4;
            const inverseAlpha = 1 - alpha;
            image.data[offset] = Math.round(r * alpha + DOT_BACKGROUND[0] * inverseAlpha);
            image.data[offset + 1] = Math.round(g * alpha + DOT_BACKGROUND[1] * inverseAlpha);
            image.data[offset + 2] = Math.round(b * alpha + DOT_BACKGROUND[2] * inverseAlpha);
            image.data[offset + 3] = 255;
          }
        }
      }

      this.sliceCanvas.width = canvasWidth;
      this.sliceCanvas.height = canvasHeight;
      this.sliceContext.imageSmoothingEnabled = true;
      this.sliceContext.putImageData(image, 0, 0);
      this.renderStats.textContent = `${this.sliceAxis.toUpperCase()}=${this.sliceIndex}, ${width} x ${height} points, ${canvasWidth} x ${canvasHeight}, ${(performance.now() - started).toFixed(1)} ms`;
    } else {
      this.sliceCanvas.width = width;
      this.sliceCanvas.height = height;
      this.sliceContext.imageSmoothingEnabled = false;
      this.sliceContext.putImageData(compactImage, 0, 0);
      this.renderStats.textContent = `${this.sliceAxis.toUpperCase()}=${this.sliceIndex}, ${width} x ${height}, ${(performance.now() - started).toFixed(1)} ms`;
    }

    this.sliceCanvas.classList.toggle("corner-dot-mode", cornerDotMode);
    this.sliceCanvas.parentElement?.classList.toggle("corner-dot-mode", cornerDotMode);
    if (cornerDotMode && shouldCenterDotCanvas) {
      const shell = this.sliceCanvas.parentElement;
      requestAnimationFrame(() => {
        if (!shell) {
          return;
        }
        shell.scrollLeft = Math.max(0, (this.sliceCanvas.clientWidth - shell.clientWidth) / 2);
        shell.scrollTop = Math.max(0, (this.sliceCanvas.clientHeight - shell.clientHeight) / 2);
      });
    }
    this.lastSliceRenderMode = renderMode;
    this.setSlicePlaneTextureEnabled(true);
    this.slicePlaneMaterial.opacity = cornerDotMode ? 1 : 0.82;
    this.slicePlaneMaterial.needsUpdate = true;
    this.sliceTexture.needsUpdate = true;
    this.renderLegend(counts);
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
    this.sliceCanvas.classList.remove("corner-dot-mode");
    this.sliceCanvas.parentElement?.classList.remove("corner-dot-mode");
  }

  private setSlicePlaneTextureEnabled(enabled: boolean): void {
    if (this.slicePlaneHasTexture === enabled) {
      return;
    }

    this.slicePlaneHasTexture = enabled;
    this.slicePlaneMaterial.map = enabled ? this.sliceTexture : null;
    this.slicePlaneMaterial.color.set(enabled ? "#ffffff" : "#f97316");
    this.slicePlaneMaterial.opacity = enabled ? 0.82 : 0.22;
    this.slicePlaneMaterial.needsUpdate = true;
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

    const grid = worldIndex;
    const [nx, ny, nz] = volume.shape;
    const offset = volume.fortranOrder
      ? grid[0] + nx * (grid[1] + ny * grid[2])
      : grid[2] + nz * (grid[1] + ny * grid[0]);
    const label = Number(volume.data[offset]);
    const { category } = this.getSampleDisplay({ grid, worldIndex, world: new THREE.Vector3(), label, category: null });
    const world = new THREE.Vector3(
      indexToWorld(worldIndex[0], dims[0]),
      indexToWorld(worldIndex[1], dims[1]),
      indexToWorld(worldIndex[2], dims[2]),
    );

    return { grid, worldIndex, world, label, category };
  }

  private getSampleDisplay(sample: SliceSample): {
    category: CategoryKey | null;
    color: [number, number, number];
  } {
    const volume = this.activeVolume;
    if (!volume) {
      return { category: null, color: [127, 127, 127] };
    }

    const category = classifyVolumeLabel(sample.label, volume.visualization);
    return {
      category,
      color: colorForLabel(sample.label, category, volume.visualization),
    };
  }

  private getWorldDims(): [number, number, number] {
    if (!this.activeVolume) {
      return [1, 1, 1];
    }

    const [nx, ny, nz] = this.activeVolume.shape;
    return [nx, ny, nz];
  }

  private inspectSlicePointer(event: PointerEvent): void {
    if (!this.activeVolume || this.sliceCanvas.width === 0 || this.sliceCanvas.height === 0) {
      this.setInspector();
      return;
    }

    const rect = this.sliceCanvas.getBoundingClientRect();
    const canvasX = (event.clientX - rect.left) / rect.width * this.sliceCanvas.width;
    const canvasY = (event.clientY - rect.top) / rect.height * this.sliceCanvas.height;
    let sample: SliceSample;

    if ((this.sliceRenderMode.value as SliceRenderMode) === "cornerDots") {
      const dims = this.getWorldDims();
      const [gridWidth, gridHeight] = this.sliceAxis === "x"
        ? [dims[2], dims[1]]
        : this.sliceAxis === "y"
          ? [dims[0], dims[2]]
          : [dims[0], dims[1]];
      const px = Math.round((canvasX - DOT_MARGIN) / DOT_SPACING);
      const py = Math.round((canvasY - DOT_MARGIN) / DOT_SPACING);

      if (px < 0 || py < 0 || px >= gridWidth || py >= gridHeight) {
        this.setInspector();
        return;
      }

      const centerX = DOT_MARGIN + px * DOT_SPACING;
      const centerY = DOT_MARGIN + py * DOT_SPACING;
      if (Math.hypot(canvasX - centerX, canvasY - centerY) > DOT_RADIUS + 0.75) {
        this.setInspector();
        return;
      }

      sample = this.sampleSlicePixel(px, py, gridHeight);
    } else {
      const px = clamp(Math.floor(canvasX), 0, this.sliceCanvas.width - 1);
      const py = clamp(Math.floor(canvasY), 0, this.sliceCanvas.height - 1);
      sample = this.sampleSlicePixel(px, py, this.sliceCanvas.height);
    }

    const label = Number.isInteger(sample.label) ? String(sample.label) : sample.label.toFixed(4);
    const labelText = this.activeVolume.visualization === "finalCclComponents" && sample.label > 3
      ? `component ${Number.isInteger(sample.label - 3) ? String(sample.label - 3) : (sample.label - 3).toFixed(4)}`
      : this.activeVolume.visualization === "finalCclCases" && sample.category
        ? `${label} ${categoryDisplayName(sample.category)}`
        : label;
    const values: Record<string, string> = {
      Grid: `[${sample.grid.join(", ")}]`,
      World: `[${sample.world.x.toFixed(4)}, ${sample.world.y.toFixed(4)}, ${sample.world.z.toFixed(4)}]`,
      Label: labelText,
      Category: sample.category ? categoryDisplayName(sample.category) : "-",
    };

    this.setInspector(values);
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

interface PipelineFolderCandidate {
  directory: string;
  prefix: string;
  label?: File;
  components?: File;
  cases?: File;
  insideFiltered?: File;
  surfaceBoundary?: File;
}

function findPipelineFolderSelection(files: File[]): PipelineFolderSelection {
  const candidates = new Map<string, PipelineFolderCandidate>();
  const meshes = new Map<string, File>();
  const initialLabels = new Map<string, File>();

  for (const file of files) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop() ?? path;
    const directory = parts.join("/");
    const lowerName = name.toLowerCase();

    if (lowerName === "voxel_input_mesh.ply") {
      meshes.set(directory, file);
      continue;
    }

    if (lowerName === "000_initial_ccl_labels.npy") {
      initialLabels.set(directory, file);
      continue;
    }

    const parsed = parsePipelineNpyFileName(name);
    if (!parsed) {
      continue;
    }

    const { prefix, role } = parsed;
    const key = `${directory}\u0000${prefix}`;
    const candidate = candidates.get(key) ?? { directory, prefix };
    if (role === "components") {
      candidate.components = file;
    } else if (role === "cases") {
      candidate.cases = file;
    } else if (role === "insideFiltered") {
      candidate.insideFiltered = file;
    } else if (role === "surfaceBoundary") {
      candidate.surfaceBoundary = file;
    } else {
      candidate.label = file;
    }
    candidates.set(key, candidate);
  }

  const available = Array.from(candidates.values());

  if (available.length === 0) {
    throw new Error(
      "No pipeline debug .npy files were found. Expected files generated by --save-debug-volumes, such as NNN_final_ccl_labels.npy, NNN_final_ccl_components.npy, and NNN_final_ccl_cases.npy.",
    );
  }

  const completeCandidates = available.filter((candidate) => candidate.label && candidate.components && candidate.cases);
  if (completeCandidates.length === 0) {
    const first = available[0];
    const missing: string[] = [];
    if (!first.label) {
      missing.push(`${first.prefix}_final_ccl_labels.npy`);
    }
    if (!first.components) {
      missing.push(`${first.prefix}_final_ccl_components.npy`);
    }
    if (!first.cases) {
      missing.push(`${first.prefix}_final_ccl_cases.npy`);
    }
    throw new Error(
      `Missing required final CCL volumes in ${first.directory || "(selected folder)"} for prefix ${first.prefix}: ${missing.join(", ")}.`,
    );
  }

  const completeWithMesh = completeCandidates.filter((candidate) => meshes.has(candidate.directory));
  if (completeWithMesh.length === 0) {
    throw new Error("Found the required final CCL .npy files, but voxel_input_mesh.ply was not found in the same folder.");
  }

  if (completeWithMesh.length > 1) {
    throw new Error("Multiple pipeline output candidates were selected. Select one output folder containing a single final CCL prefix.");
  }

  const selected = completeWithMesh[0];
  const mesh = meshes.get(selected.directory);
  if (!mesh) {
    throw new Error(`Found ${selected.prefix}*.npy in ${selected.directory || "(selected folder)"}, but the mesh could not be opened.`);
  }

  return {
    directory: selected.directory,
    volumes: [initialLabels.get(selected.directory), selected.label, selected.components, selected.cases, selected.insideFiltered, selected.surfaceBoundary]
      .filter((file): file is File => Boolean(file)),
    mesh,
  };
}

function parsePipelineNpyFileName(name: string): { prefix: string; role: PipelineVolumeRole } | null {
  const finalMatch = /^(\d{3})_final_ccl_(labels|components|cases)\.npy$/i.exec(name);
  if (finalMatch) {
    const roleBySuffix: Record<string, PipelineVolumeRole> = {
      labels: "label",
      components: "components",
      cases: "cases",
    };
    return {
      prefix: finalMatch[1],
      role: roleBySuffix[finalMatch[2].toLowerCase()],
    };
  }

  const auditMatch = /^(\d{3})_inside_filtered_labels\.npy$/i.exec(name);
  if (auditMatch) {
    const auditStep = Number(auditMatch[1]);
    if (!Number.isInteger(auditStep) || auditStep <= 0) {
      return null;
    }
    return {
      prefix: String(auditStep - 1).padStart(3, "0"),
      role: "insideFiltered",
    };
  }

  const surfaceBoundaryMatch = /^(\d{3})_surface_boundary_classification\.npy$/i.exec(name);
  if (surfaceBoundaryMatch) {
    const surfaceBoundaryStep = Number(surfaceBoundaryMatch[1]);
    if (!Number.isInteger(surfaceBoundaryStep) || surfaceBoundaryStep <= 2) {
      return null;
    }
    return {
      prefix: String(surfaceBoundaryStep - 2).padStart(3, "0"),
      role: "surfaceBoundary",
    };
  }

  return null;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function colorForLabel(
  label: number,
  category: CategoryKey | null,
  visualization: VolumeData["visualization"],
): [number, number, number] {
  if (category === "components") {
    const componentId = visualization === "finalCclComponents" ? Math.max(0, label - 3) : label;
    return componentColor(componentId);
  }

  if (!category) {
    return [127, 127, 127];
  }

  const hex = CATEGORIES[category].color.replace("#", "");
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function componentColor(label: number): [number, number, number] {
  const seed = Math.abs(Math.trunc(label));
  const hue = ((seed * 137.508) % 360) / 360;
  const [r, g, b] = hslToRgb(hue, 0.68, 0.57);
  return [
    Math.round(r * 255),
    Math.round(g * 255),
    Math.round(b * 255),
  ];
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

function indexToWorld(index: number, dimension: number): number {
  if (dimension <= 1) {
    return 0;
  }
  return -1 + index * 2 / (dimension - 1);
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

function isLineMaterial(material: THREE.Material | THREE.Material[]): material is THREE.LineBasicMaterial {
  return !Array.isArray(material);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

new MeshSliceViewer();
