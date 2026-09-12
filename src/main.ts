import "./style.css";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  type SliceAxis,
  type VxzColorMode,
  type VxzJobResponse,
  type VxzMetadata,
} from "./types";
import {
  automaticContinuousRange,
  categoricalColorForValue,
  continuousColorForValue,
  fieldValueKey,
  formatFieldValue,
  grayscaleColorForAmount,
  isNoDataValue,
  labelDefinitionForValue,
  type DenseField,
  type ContinuousStyle,
  type FieldMetadataPatch,
  type FieldValue,
  type LabelSchema,
  type SourceAxisOrder,
} from "./field-model";
import {
  mergeFieldMetadataPatches,
  parseFieldManifest,
  resolveFieldDefinition,
  type ParsedFieldManifest,
} from "./field-metadata";
import {
  InMemoryFieldProvider,
  type FieldProvider,
  type FieldSlice,
} from "./field-provider";
import {
  computeTransformedSlicePlaneFrame,
  formatIndexToWorldText,
  logicalDomainLimits,
  parseIndexToWorldText,
  slicePixelToLogicalIndex,
  transformIndexToWorld,
  worldDomainCorners,
} from "./grid-field";
import {
  createLabelFilterState,
  isLabelHighlighted,
  isLabelVisible,
  isolateLabel,
  labelMatchesQuery,
  lockLabelHighlight,
  setLabelHidden,
  setLabelQuery,
  type LabelFilterState,
} from "./label-filter";
import {
  applicablePipelineVisualization,
  classifyPipelineValue,
  inferPipelinePreset,
  pipelineCategoryDisplayName,
  pipelineColorForValue,
  type PipelineCategoryKey,
  type PipelineVisualization,
} from "./pipeline-presets";
import { normalizeObjectToPreferredBounds } from "./mesh-normalization";
import { parseNpy } from "./volumeLoader";
import {
  projectVxzDualVertexToSlice,
  vxzDualOverlayScale,
} from "./vxz-dual-slice-projection";
import {
  VXZ_QEF_RANKS,
  vxzQefRankColor,
  vxzQefRankDeficient,
  vxzQefRankDescription,
} from "./vxz-qef-rank";
import { vxzDataUrl } from "./vxz-data-url";
import {
  activeSliceIndex,
  clearPinnedPoint,
  createViewerState,
  pinGridPoint,
  reconcileViewerState,
  setActiveAxis,
  setSliceIndex as updateViewerSliceIndex,
  type ViewerState,
} from "./viewer-state";

type MeshMode = "solid" | "wireframe" | "transparent" | "solidWire";
type SliceRenderMode = "pixels" | "cornerDots";
type FieldSettingKind =
  | "semantic"
  | "categoricalPreset"
  | "association"
  | "axisOrder"
  | "coordinates"
  | "continuousRange"
  | "continuousIsovalue"
  | "continuousPalette";

interface ElectronVxzOpenRequest {
  requestId: string;
  sourceName: string;
}

declare global {
  interface Window {
    voxelMeshViewer?: {
      onOpenVxzRequest(callback: (payload: ElectronVxzOpenRequest) => void): void;
      openVxzFile(requestId: string, resolution: number | null): Promise<VxzJobResponse>;
      getVxzResolution(): Promise<number | null>;
      setVxzResolution(resolution: number | null): Promise<void>;
      readyForOpenFiles(): void;
    };
  }
}

const DOT_SPACING = 4;
const DOT_RADIUS = 1.5;
const DOT_MARGIN = 3;
const DOT_BACKGROUND: [number, number, number] = [238, 242, 247];
const NO_DATA_COLOR: [number, number, number] = [148, 163, 184];
const URL_PARAMS = new URLSearchParams(window.location.search);
const IS_ELECTRON_APP = URL_PARAMS.has("electron");
const REMOTE_API_BASE = URL_PARAMS.get("apiBase") ?? "http://127.0.0.1:5175/api/remote";
const VXZ_API_BASE = (() => {
  const value = new URL(REMOTE_API_BASE, window.location.href);
  value.pathname = value.pathname.replace(/\/api\/remote\/?$/, "/api/vxz");
  value.search = "";
  value.hash = "";
  return value.toString().replace(/\/$/, "");
})();
const DEFAULT_REMOTE_HOST = "hl_gpu_2";
const REMOTE_DEFAULT_PATH = "/mnt/bn/vai3d-hl-1/Users/lizd/work/floodfill/output";
const REMOTE_LAST_HOST_STORAGE_KEY = "voxel-mesh-viewer:last-remote-host";
const REMOTE_LAST_PATH_STORAGE_KEY = "voxel-mesh-viewer:last-remote-path";
const REMOTE_CACHE_DB_NAME = "voxel-mesh-viewer-cache";
const REMOTE_CACHE_STORE = "remote-files";
const REMOTE_CACHE_META_STORE = "remote-file-meta";
const DOT_STAMP: Array<{ dx: number; dy: number; alpha: number }> = [];
const VXZ_VOXEL_HEADER_BYTES = 16;
const VXZ_SLICE_HEADER_BYTES = 24;
const VXZ_MESH_HEADER_BYTES = 16;
const VXZ_WORKER_FORMAT_VERSION = 3;
const VXZ_VOXEL_RECORD_BYTES = 12;
const VXZ_DUAL_MARKER_COLOR = "#ff2d55";
const VIRIDIS_PALETTE = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"] as const;
const LIGHTWEIGHT_WIREFRAME_FACE_THRESHOLD = 250_000;
const VXZ_FALLBACK_CASES: Array<{
  color: [number, number, number];
  cssColor: string;
  label: string;
}> = [
  { color: [37, 99, 235], cssColor: "#2563eb", label: "0 · Interior (3D unconstrained)" },
  { color: [16, 185, 129], cssColor: "#10b981", label: "1 · Voxel face (2D optimum)" },
  { color: [245, 158, 11], cssColor: "#f59e0b", label: "2 · Voxel edge (1D optimum)" },
  { color: [225, 29, 72], cssColor: "#e11d48", label: "3 · Voxel corner" },
];

if (IS_ELECTRON_APP) {
  document.documentElement.classList.add("electron-app");
}

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
  world: THREE.Vector3;
  value: FieldValue;
  category: PipelineCategoryKey | null;
}

interface FileLoadProgress {
  loaded: number;
  total: number | null;
}

type ProgressCallback = (progress: FileLoadProgress) => void;

interface SourceFile {
  name: string;
  webkitRelativePath?: string;
  arrayBuffer(onProgress?: ProgressCallback, signal?: AbortSignal): Promise<ArrayBuffer>;
  text(onProgress?: ProgressCallback, signal?: AbortSignal): Promise<string>;
}

interface PipelineFolderSelection {
  directory: string;
  volumes: SourceFile[];
  meshes: SourceFile[];
  manifests: SourceFile[];
}

interface VolumeSlot {
  name: string;
  volume?: DenseField;
  provider?: FieldProvider;
  userOverrides?: FieldMetadataPatch;
  labelFilter?: LabelFilterState;
  file?: SourceFile;
}

interface MeshItem {
  id: number;
  name: string;
  object: THREE.Object3D;
}

interface VxzSliceRecord {
  coords: [number, number, number];
  dual: [number, number, number];
  intersected: number;
  ovoxelType: number;
  qefRank: number;
}

interface VxzPreviewRecords {
  coords: Uint16Array;
  dual: Uint8Array;
  intersected: Uint8Array;
  ovoxelType: Uint8Array;
  qefRank: Uint8Array;
}

interface LoadTask {
  row: HTMLElement;
  bar: HTMLElement;
  text: HTMLElement;
}

interface RemoteFileDownloadEntry {
  promise?: Promise<ArrayBuffer>;
  subscribers: Set<ProgressCallback>;
  loaded: number;
  total: number | null;
}

interface CachedRemoteFileRecord {
  path: string;
  buffer: ArrayBuffer;
  size: number | null;
  mtimeMs: number | null;
  savedAt: number;
}

interface CachedRemoteFileMeta {
  path: string;
  byteLength: number;
  size: number | null;
  mtimeMs: number | null;
  savedAt: number;
}

interface RemoteCacheStats {
  fileCount: number;
  trackedBytes: number;
  originUsage: number | null;
  quota: number | null;
  oldestSavedAt: number | null;
}

interface RemoteCacheClearResult {
  deletedCount: number;
  deletedBytes: number;
}

interface RemoteEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number | null;
  mtimeMs: number | null;
}

interface RemoteListResponse {
  host: string;
  path: string;
  parent: string;
  entries: RemoteEntry[];
}

class MeshSliceViewer {
  private readonly canvas = getElement<HTMLCanvasElement>("viewerCanvas");
  private readonly sliceCanvas = getElement<HTMLCanvasElement>("sliceCanvas");
  private readonly vxzDualOverlay = getElement<HTMLCanvasElement>("vxzDualOverlay");
  private readonly workspace = getElement<HTMLElement>("workspace");
  private readonly slicePane = document.querySelector<HTMLElement>(".slice-pane");
  private readonly sliceContext: CanvasRenderingContext2D;
  private readonly vxzDualOverlayContext: CanvasRenderingContext2D;
  private readonly sliceTextureCanvas = document.createElement("canvas");
  private readonly sliceTextureContext: CanvasRenderingContext2D;
  private readonly sliceTexture = new THREE.CanvasTexture(this.sliceTextureCanvas);
  private readonly statusText = getElement<HTMLElement>("statusText");
  private readonly renderStats = getElement<HTMLElement>("renderStats");
  private readonly folderInput = getElement<HTMLInputElement>("folderInput");
  private readonly fieldInput = getElement<HTMLInputElement>("fieldInput");
  private readonly meshInput = getElement<HTMLInputElement>("meshInput");
  private readonly vxzInput = getElement<HTMLInputElement>("vxzInput");
  private readonly vxzResolution = getElement<HTMLInputElement>("vxzResolution");
  private readonly topbar = document.querySelector<HTMLElement>(".topbar");
  private readonly remotePanel = document.querySelector<HTMLDetailsElement>(".remote-panel");
  private readonly remoteBrowser = getElement<HTMLElement>("remoteBrowser");
  private readonly floatingPanels = Array.from(document.querySelectorAll<HTMLDetailsElement>(".remote-panel, .options-panel"));
  private readonly remoteHostInput = getElement<HTMLInputElement>("remoteHostInput");
  private readonly remotePathInput = getElement<HTMLInputElement>("remotePathInput");
  private readonly remoteStatus = getElement<HTMLElement>("remoteStatus");
  private readonly remoteList = getElement<HTMLElement>("remoteList");
  private readonly remoteCacheUsage = getElement<HTMLElement>("remoteCacheUsage");
  private readonly remoteCacheDetails = getElement<HTMLElement>("remoteCacheDetails");
  private readonly loadProgress = getElement<HTMLElement>("loadProgress");
  private readonly arraySelect = getElement<HTMLSelectElement>("arraySelect");
  private readonly arraySelectRow = getElement<HTMLElement>("arraySelectRow");
  private readonly sliceSlider = getElement<HTMLInputElement>("sliceSlider");
  private readonly sliceLabel = getElement<HTMLElement>("sliceLabel");
  private readonly sliceValue = getElement<HTMLInputElement>("sliceValue");
  private readonly sliceRenderMode = getElement<HTMLSelectElement>("sliceRenderMode");
  private readonly meshModeSelect = getElement<HTMLSelectElement>("meshModeSelect");
  private readonly meshOpacity = getElement<HTMLInputElement>("meshOpacity");
  private readonly meshOpacityValue = getElement<HTMLOutputElement>("meshOpacityValue");
  private readonly normalizeImportedMesh = getElement<HTMLInputElement>("normalizeImportedMesh");
  private readonly sliceOpacity = getElement<HTMLInputElement>("sliceOpacity");
  private readonly sliceOpacityValue = getElement<HTMLOutputElement>("sliceOpacityValue");
  private readonly meshList = getElement<HTMLElement>("meshList");
  private readonly vxzOptions = getElement<HTMLElement>("vxzOptions");
  private readonly vxzMeshVisible = getElement<HTMLInputElement>("vxzMeshVisible");
  private readonly vxzVoxelsVisible = getElement<HTMLInputElement>("vxzVoxelsVisible");
  private readonly vxzDualVerticesVisible = getElement<HTMLInputElement>("vxzDualVerticesVisible");
  private readonly vxzColorMode = getElement<HTMLSelectElement>("vxzColorMode");
  private readonly vxzFallbackColorOption = getElement<HTMLOptionElement>("vxzFallbackColorOption");
  private readonly vxzQefRankColorOption = getElement<HTMLOptionElement>("vxzQefRankColorOption");
  private readonly vxzPointSize = getElement<HTMLInputElement>("vxzPointSize");
  private readonly vxzPointSizeValue = getElement<HTMLOutputElement>("vxzPointSizeValue");
  private readonly legendList = getElement<HTMLElement>("legendList");
  private readonly labelTools = getElement<HTMLElement>("labelTools");
  private readonly labelSearch = getElement<HTMLInputElement>("labelSearch");
  private readonly showAllLabels = getElement<HTMLButtonElement>("showAllLabels");
  private readonly inspectorList = getElement<HTMLElement>("inspectorList");
  private readonly fieldOptions = getElement<HTMLElement>("fieldOptions");
  private readonly fieldMetadataSummary = getElement<HTMLElement>("fieldMetadataSummary");
  private readonly fieldSemantic = getElement<HTMLSelectElement>("fieldSemantic");
  private readonly categoricalPreset = getElement<HTMLSelectElement>("categoricalPreset");
  private readonly categoricalPresetControl = getElement<HTMLElement>("categoricalPresetControl");
  private readonly fieldAssociation = getElement<HTMLSelectElement>("fieldAssociation");
  private readonly fieldAxisOrder = getElement<HTMLSelectElement>("fieldAxisOrder");
  private readonly fieldCoordinates = getElement<HTMLSelectElement>("fieldCoordinates");
  private readonly fieldMatrixControl = getElement<HTMLElement>("fieldMatrixControl");
  private readonly fieldIndexToWorld = getElement<HTMLTextAreaElement>("fieldIndexToWorld");
  private readonly continuousOptions = getElement<HTMLElement>("continuousOptions");
  private readonly continuousColorMap = getElement<HTMLSelectElement>("continuousColorMap");
  private readonly continuousRangeMin = getElement<HTMLInputElement>("continuousRangeMin");
  private readonly continuousRangeMax = getElement<HTMLInputElement>("continuousRangeMax");
  private readonly continuousIsovalue = getElement<HTMLInputElement>("continuousIsovalue");
  private readonly continuousContours = getElement<HTMLInputElement>("continuousContours");
  private readonly clearSelectedPoint = getElement<HTMLButtonElement>("clearSelectedPoint");

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  private readonly renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
  private readonly controls = new OrbitControls(this.camera, this.canvas);
  private readonly meshRoot = new THREE.Group();
  private readonly voxelRoot = new THREE.Group();
  private readonly sliceRoot = new THREE.Group();
  private readonly guideRoot = new THREE.Group();
  private readonly selectionMarker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 18, 12),
    new THREE.MeshBasicMaterial({ color: "#111827", depthTest: false }),
  );
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
  private activeVolume: DenseField | null = null;
  private activeProvider: FieldProvider | null = null;
  private activeFieldSlice: FieldSlice | null = null;
  private fieldManifest: ParsedFieldManifest | undefined;
  private fieldManifestWarnings: string[] = [];
  private fieldSliceAbort: AbortController | null = null;
  private fieldSliceToken = 0;
  private inspectorRequestToken = 0;
  private readonly autoRanges = new WeakMap<DenseField, [number, number]>();
  private sourceLoadToken = 0;
  private volumeLoadToken = 0;
  private nextLoadTaskId = 1;
  private readonly loadTasks = new Map<number, LoadTask>();
  private currentMeshFiles: SourceFile[] = [];
  private meshItems: MeshItem[] = [];
  private nextMeshId = 1;
  private vxzJobId: string | null = null;
  private vxzMetadata: VxzMetadata | null = null;
  private vxzMeshObject: THREE.Object3D | null = null;
  private vxzVoxelObject: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private vxzDualSliceObject: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private vxzPreviewRecords: VxzPreviewRecords | null = null;
  private vxzSliceRecords = new Map<number, VxzSliceRecord>();
  private vxzLoadAbort: AbortController | null = null;
  private vxzSliceAbort: AbortController | null = null;
  private vxzLoadToken = 0;
  private vxzSliceToken = 0;
  private remoteHost = DEFAULT_REMOTE_HOST;
  private remotePath = "";
  private remoteParent = "";
  private remoteEntries: RemoteEntry[] = [];
  private remoteListToken = 0;
  private viewerState: ViewerState = createViewerState([1, 1, 1]);
  private slicePlaneHasTexture = false;
  private lastSliceRenderMode: SliceRenderMode = "pixels";
  private lastDotCanvasSize = "";

  constructor() {
    const sliceContext = this.sliceCanvas.getContext("2d", { alpha: false });
    if (!sliceContext) {
      throw new Error("Could not create a 2D canvas context.");
    }
    this.sliceContext = sliceContext;
    const vxzDualOverlayContext = this.vxzDualOverlay.getContext("2d", { alpha: true });
    if (!vxzDualOverlayContext) {
      throw new Error("Could not create the VXZ dual vertex overlay context.");
    }
    this.vxzDualOverlayContext = vxzDualOverlayContext;
    const sliceTextureContext = this.sliceTextureCanvas.getContext("2d", { alpha: true });
    if (!sliceTextureContext) {
      throw new Error("Could not create a texture canvas context.");
    }
    this.sliceTextureContext = sliceTextureContext;

    this.scene.background = new THREE.Color("#f3f6fa");
    this.scene.add(this.guideRoot, this.meshRoot, this.voxelRoot, this.sliceRoot, this.selectionMarker);
    this.selectionMarker.name = "selected-field-point";
    this.selectionMarker.visible = false;
    this.selectionMarker.renderOrder = 40;
    document.body.append(this.remoteBrowser);
    this.remoteBrowser.classList.add("hidden");

    this.addSceneGuides();
    this.addSlicePlane();
    this.addLighting();
    this.resetCamera();
    this.configureRenderer();
    this.bindEvents();
    void this.initializeElectronFileBridge();
    void this.initializeRemoteBrowser();
    this.updateSliceControls(true);
    this.updateSlicePlane();
    this.updateMeshDisplay();
    this.updateSlicePlaneOpacity();
    this.renderSlice();
    this.resize();
    this.animate();
  }

  private addSceneGuides(): void {
    this.rebuildSceneGuides();
  }

  private rebuildSceneGuides(): void {
    this.clearGroup(this.guideRoot);
    if (this.activeVolume) {
      this.addTransformedFieldGuides(this.activeVolume);
      return;
    }
    const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const helper = new THREE.Box3Helper(bounds, new THREE.Color("#334155"));
    const helperMaterial = helper.material as THREE.LineBasicMaterial;
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.34;
    this.guideRoot.add(helper);

    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1e-6);
    const axes = new THREE.AxesHelper(span * 0.24);
    axes.position.copy(bounds.min);
    this.guideRoot.add(axes);

    const grid = new THREE.GridHelper(span, 8, "#8fa0b4", "#d6dde8");
    grid.position.set(
      (bounds.min.x + bounds.max.x) / 2,
      bounds.min.y,
      (bounds.min.z + bounds.max.z) / 2,
    );
    this.guideRoot.add(grid);
  }

  private addTransformedFieldGuides(field: DenseField): void {
    const definition = field.definition;
    const { min, max } = logicalDomainLimits(definition.logicalShape, definition.association);
    const corners = worldDomainCorners(
      definition.logicalShape,
      definition.association,
      definition.indexToWorld,
    ).map(vectorFromWorldPoint);
    const edgePairs = [
      [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
      [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
    ] as const;
    const edgePositions: number[] = [];
    for (const [start, end] of edgePairs) {
      edgePositions.push(...corners[start].toArray(), ...corners[end].toArray());
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
    const edges = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({ color: "#334155", transparent: true, opacity: 0.52 }),
    );
    this.guideRoot.add(edges);

    const transform = (point: [number, number, number]): THREE.Vector3 => (
      vectorFromWorldPoint(transformIndexToWorld(point, definition.indexToWorld))
    );
    const gridPositions: number[] = [];
    for (let step = 0; step <= 8; step += 1) {
      const amount = step / 8;
      const x = THREE.MathUtils.lerp(min[0], max[0], amount);
      const z = THREE.MathUtils.lerp(min[2], max[2], amount);
      gridPositions.push(
        ...transform([min[0], min[1], z]).toArray(),
        ...transform([max[0], min[1], z]).toArray(),
        ...transform([x, min[1], min[2]]).toArray(),
        ...transform([x, min[1], max[2]]).toArray(),
      );
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(gridPositions, 3));
    this.guideRoot.add(new THREE.LineSegments(
      gridGeometry,
      new THREE.LineBasicMaterial({ color: "#aeb9c7", transparent: true, opacity: 0.5 }),
    ));

    const origin = transform([min[0], min[1], min[2]]);
    const axisPositions: number[] = [];
    const axisColors: number[] = [];
    const colors = [new THREE.Color("#ef4444"), new THREE.Color("#22c55e"), new THREE.Color("#3b82f6")];
    for (let axis = 0; axis < 3; axis += 1) {
      const endpointIndex: [number, number, number] = [min[0], min[1], min[2]];
      endpointIndex[axis] = max[axis];
      const endpoint = transform(endpointIndex);
      if (endpoint.distanceToSquared(origin) <= Number.EPSILON) {
        continue;
      }
      axisPositions.push(...origin.toArray(), ...endpoint.toArray());
      const color = colors[axis];
      axisColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    if (axisPositions.length > 0) {
      const axisGeometry = new THREE.BufferGeometry();
      axisGeometry.setAttribute("position", new THREE.Float32BufferAttribute(axisPositions, 3));
      axisGeometry.setAttribute("color", new THREE.Float32BufferAttribute(axisColors, 3));
      this.guideRoot.add(new THREE.LineSegments(
        axisGeometry,
        new THREE.LineBasicMaterial({ vertexColors: true }),
      ));
    }
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
    window.addEventListener("resize", () => {
      this.resize();
      this.positionVxzDualOverlay();
      this.updateRemoteBrowserPosition();
    });
    document.addEventListener("pointerdown", (event) => this.closeFloatingPanelsForPointer(event), true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.closeFloatingPanels();
      }
    });

    this.folderInput.addEventListener("change", () => void this.loadSelectedPipelineFolder());
    this.fieldInput.addEventListener("change", () => void this.loadSelectedFields());
    this.meshInput.addEventListener("change", () => void this.loadSelectedMeshFile());
    this.vxzInput.addEventListener("change", () => void this.loadSelectedVxz());
    window.voxelMeshViewer?.onOpenVxzRequest((request) => {
      void this.openAssociatedVxz(request).catch((error) => {
        if (!isAbortError(error)) {
          this.setStatus(errorMessage(error));
        }
      });
    });
    this.vxzResolution.addEventListener("change", () => {
      void this.persistVxzResolution().catch((error) => this.setStatus(errorMessage(error)));
    });
    this.remotePanel?.addEventListener("toggle", () => this.updateRemoteBrowserPosition());
    getElement<HTMLButtonElement>("remoteGoButton").addEventListener("click", () => {
      void this.loadRemotePath(this.remotePathInput.value.trim());
    });
    getElement<HTMLButtonElement>("remoteRefreshButton").addEventListener("click", () => {
      void this.loadRemotePath(this.remotePath || this.remotePathInput.value.trim());
    });
    getElement<HTMLButtonElement>("remoteUpButton").addEventListener("click", () => {
      if (this.remoteParent) {
        void this.loadRemotePath(this.remoteParent);
      }
    });
    getElement<HTMLButtonElement>("remoteLoadButton").addEventListener("click", () => {
      void this.loadCurrentRemoteFolder();
    });
    getElement<HTMLButtonElement>("remoteDownloadButton").addEventListener("click", () => {
      void this.downloadCurrentRemoteFolder();
    });
    getElement<HTMLButtonElement>("remoteCacheRefreshButton").addEventListener("click", () => {
      void this.refreshRemoteCacheStats();
    });
    getElement<HTMLButtonElement>("remoteCacheClear1hButton").addEventListener("click", () => {
      void this.clearRemoteCacheOlderThan(60 * 60 * 1000);
    });
    getElement<HTMLButtonElement>("remoteCacheClear1dButton").addEventListener("click", () => {
      void this.clearRemoteCacheOlderThan(24 * 60 * 60 * 1000);
    });
    getElement<HTMLButtonElement>("remoteCacheClear7dButton").addEventListener("click", () => {
      void this.clearRemoteCacheOlderThan(7 * 24 * 60 * 60 * 1000);
    });
    this.remotePathInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        void this.loadRemotePath(this.remotePathInput.value.trim());
      }
    });
    this.remoteHostInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        void this.loadRemotePath(this.remotePathInput.value.trim() || this.remotePath);
      }
    });
    this.arraySelect.addEventListener("change", () => void this.selectVolume(Number(this.arraySelect.value)));
    this.fieldSemantic.addEventListener("change", () => this.applyFieldSettings("semantic"));
    this.categoricalPreset.addEventListener("change", () => this.applyFieldSettings("categoricalPreset"));
    this.fieldAssociation.addEventListener("change", () => this.applyFieldSettings("association"));
    this.fieldAxisOrder.addEventListener("change", () => this.applyFieldSettings("axisOrder"));
    this.fieldCoordinates.addEventListener("change", () => this.applyFieldSettings("coordinates"));
    this.fieldIndexToWorld.addEventListener("change", () => this.applyFieldSettings("coordinates"));
    this.continuousColorMap.addEventListener("change", () => this.applyFieldSettings("continuousPalette"));
    this.continuousRangeMin.addEventListener("change", () => this.applyFieldSettings("continuousRange"));
    this.continuousRangeMax.addEventListener("change", () => this.applyFieldSettings("continuousRange"));
    this.continuousIsovalue.addEventListener("change", () => this.applyFieldSettings("continuousIsovalue"));
    this.continuousContours.addEventListener("change", () => this.renderSlice());
    this.sliceRenderMode.addEventListener("change", () => {
      this.setInspector();
      this.updateSlicePlane();
      this.renderSlice();
    });
    this.labelSearch.addEventListener("input", () => {
      const slot = this.activeVolumeSlot();
      if (!slot) {
        return;
      }
      slot.labelFilter = setLabelQuery(slot.labelFilter ?? createLabelFilterState(), this.labelSearch.value);
      this.renderSlice();
    });
    this.showAllLabels.addEventListener("click", () => {
      const slot = this.activeVolumeSlot();
      if (!slot) {
        return;
      }
      slot.labelFilter = createLabelFilterState();
      this.labelSearch.value = "";
      this.renderSlice();
    });

    this.sliceSlider.addEventListener("input", () => {
      this.setSliceIndex(Number(this.sliceSlider.value));
    });
    this.sliceValue.addEventListener("input", () => {
      if (this.sliceValue.value === "") {
        return;
      }

      const index = Number(this.sliceValue.value);
      if (Number.isFinite(index)) {
        this.setSliceIndex(index);
      }
    });
    this.sliceValue.addEventListener("change", () => this.commitSliceInput());
    this.sliceValue.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.commitSliceInput();
        this.sliceValue.blur();
      } else if (event.key === "Escape") {
        this.sliceValue.value = this.hasSliceSource() ? String(this.sliceIndex) : "";
        this.sliceValue.blur();
      }
    });

    this.meshModeSelect.addEventListener("change", () => this.updateMeshDisplay());
    this.meshOpacity.addEventListener("input", () => this.updateMeshDisplay());
    this.sliceOpacity.addEventListener("input", () => this.updateSlicePlaneOpacity());
    this.vxzMeshVisible.addEventListener("change", () => {
      if (this.vxzMeshObject) {
        this.vxzMeshObject.visible = this.vxzMeshVisible.checked;
        this.updateMeshDisplay();
        this.renderMeshList();
      }
    });
    this.vxzVoxelsVisible.addEventListener("change", () => {
      this.voxelRoot.visible = this.vxzVoxelsVisible.checked;
    });
    this.vxzDualVerticesVisible.addEventListener("change", () => {
      if (this.vxzDualVerticesVisible.checked) {
        this.renderSlice();
      } else {
        this.clearVxzDualVertices();
      }
    });
    this.vxzColorMode.addEventListener("change", () => {
      this.updateVxzVoxelColors();
      this.renderSlice();
    });
    this.vxzPointSize.addEventListener("input", () => this.updateVxzPointSize());

    getElement<HTMLButtonElement>("clearMeshButton").addEventListener("click", () => {
      this.clearGroup(this.meshRoot);
      this.currentMeshFiles = [];
      this.meshItems = [];
      this.vxzMeshObject = null;
      this.vxzMeshVisible.checked = false;
      this.renderMeshList();
      this.setStatus("Mesh cleared");
    });
    getElement<HTMLButtonElement>("resetCameraButton").addEventListener("click", () => this.resetCamera());

    getElement<HTMLElement>("sliceAxisGroup").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const button = target.closest<HTMLButtonElement>("button[data-axis]");
      if (!button || button.parentElement?.id !== "sliceAxisGroup") {
        return;
      }

      const axis = button.dataset.axis as SliceAxis | undefined;
      if (!axis || axis === this.sliceAxis) {
        return;
      }

      this.viewerState = setActiveAxis(this.viewerState, axis);
      const buttons = Array.from(button.parentElement.querySelectorAll<HTMLButtonElement>("button"));
      for (const button of buttons) {
        button.classList.toggle("active", button.dataset.axis === axis);
      }
      this.updateSliceControls(false);
      this.updateSlicePlane();
      this.renderSlice();
    });

    this.sliceCanvas.addEventListener("pointermove", (event) => this.inspectSlicePointer(event));
    this.sliceCanvas.addEventListener("click", (event) => this.pinSlicePointer(event));
    this.sliceCanvas.addEventListener("pointerleave", () => this.showPinnedInspectorOrClear());
    this.clearSelectedPoint.addEventListener("click", () => this.clearPinnedFieldPoint());
  }

  private async loadSelectedPipelineFolder(): Promise<void> {
    const files = Array.from(this.folderInput.files ?? []) as SourceFile[];
    if (files.length === 0) {
      return;
    }

    try {
      await this.loadPipelineFolder(files);
    } catch (error) {
      if (!isAbortError(error)) {
        this.setStatus(errorMessage(error));
      }
    }
  }

  private async loadSelectedFields(): Promise<void> {
    const files = Array.from(this.fieldInput.files ?? []) as SourceFile[];
    if (files.length === 0) {
      return;
    }

    try {
      await this.loadPipelineFolder(files, "selected fields", { replaceMeshes: false });
    } catch (error) {
      if (!isAbortError(error)) {
        this.setStatus(errorMessage(error));
      }
    } finally {
      this.fieldInput.value = "";
    }
  }

  private claimSourceLoad(): number {
    this.sourceLoadToken += 1;
    this.volumeLoadToken += 1;
    return this.sourceLoadToken;
  }

  private async loadPipelineFolder(
    files: SourceFile[],
    folderLabel?: string,
    options: { replaceMeshes?: boolean; sourceToken?: number } = {},
  ): Promise<boolean> {
    const sourceToken = options.sourceToken ?? this.claimSourceLoad();
    if (sourceToken !== this.sourceLoadToken) {
      return false;
    }
    const replaceMeshes = options.replaceMeshes ?? true;
    this.clearVxzSource();
    this.volumeSlots = [];
    this.fieldManifest = undefined;
    this.fieldManifestWarnings = [];
    this.populateArraySelect();
    this.arraySelect.disabled = true;
    this.arraySelectRow.classList.add("hidden");
    this.showNoSourceState();
    if (replaceMeshes) {
      this.clearGroup(this.meshRoot);
      this.currentMeshFiles = [];
      this.meshItems = [];
      this.renderMeshList();
    }
    const selection = findPipelineFolderSelection(files);
    const displayFolder = folderLabel || selection.directory || "(selected folder)";
    const statusFolder = compactFolderLabel(displayFolder);
    this.setStatus(`Loading ${statusFolder}`);

    const fieldManifest = await loadFieldManifests(selection.manifests);
    if (sourceToken !== this.sourceLoadToken) {
      return false;
    }
    this.fieldManifest = fieldManifest;
    this.fieldManifestWarnings = this.fieldManifest?.warnings ?? [];
    this.volumeSlots = selection.volumes.map((file) => ({
      name: file.name,
      file,
    }));
    this.populateArraySelect();

    const caseIndex = this.volumeSlots.findIndex((slot) => slot.name.toLowerCase().includes("cases"));
    this.arraySelect.value = String(caseIndex >= 0 ? caseIndex : 0);
    const fieldLoaded = await this.selectVolume(caseIndex >= 0 ? caseIndex : 0, true);
    if (sourceToken === this.sourceLoadToken) {
      this.arraySelect.disabled = false;
    }
    if (!fieldLoaded || sourceToken !== this.sourceLoadToken) {
      return false;
    }
    if (selection.meshes.length > 0) {
      await this.loadMeshFiles(selection.meshes, { replace: false, sourceToken });
    }
    if (sourceToken !== this.sourceLoadToken) {
      return false;
    }
    const meshText = selection.meshes.length > 0
      ? `${replaceMeshes ? " and " : " and added "}${selection.meshes.length} mesh${selection.meshes.length === 1 ? "" : "es"}`
      : replaceMeshes
        ? " and no mesh"
        : this.meshItems.length > 0
          ? " with the current mesh overlay"
          : "";
    const metadataWarnings = this.fieldManifestWarnings.length
      ? ` Metadata: ${this.fieldManifestWarnings.join(" ")}`
      : "";
    this.setStatus(
      `Loaded ${statusFolder}: ${selection.volumes.length} field${selection.volumes.length === 1 ? "" : "s"}${meshText}.${metadataWarnings}`,
    );
    return true;
  }

  private async initializeRemoteBrowser(): Promise<void> {
    const initialHost = window.localStorage.getItem(REMOTE_LAST_HOST_STORAGE_KEY) || DEFAULT_REMOTE_HOST;
    const initialPath = window.localStorage.getItem(REMOTE_LAST_PATH_STORAGE_KEY) || REMOTE_DEFAULT_PATH;
    this.remoteHost = initialHost;
    this.remoteHostInput.value = initialHost;
    this.remotePathInput.value = initialPath;
    void this.refreshRemoteCacheStats();
    try {
      await this.loadRemotePath(initialPath);
    } catch (error) {
      this.setRemoteStatus(errorMessage(error));
      this.renderRemoteList([]);
    }
  }

  private async loadRemotePath(path: string): Promise<void> {
    if (!path) {
      this.setRemoteStatus("Enter a remote path");
      return;
    }

    const host = this.currentRemoteHost();
    const token = ++this.remoteListToken;
    this.setRemoteStatus(`Listing ${host}:${path}`);

    try {
      const response = await fetchRemoteJson<RemoteListResponse>("list", host, { path });
      if (token !== this.remoteListToken) {
        return;
      }

      this.remoteHost = response.host;
      this.remotePath = response.path;
      this.remoteParent = response.parent;
      this.remoteEntries = response.entries;
      this.remoteHostInput.value = response.host;
      this.remotePathInput.value = response.path;
      this.rememberRemoteHost(response.host);
      this.rememberRemotePath(response.path);
      this.renderRemoteList(response.entries);
      this.setRemoteStatus(`${response.entries.length} item${response.entries.length === 1 ? "" : "s"}`);
    } catch (error) {
      if (token === this.remoteListToken) {
        this.setRemoteStatus(errorMessage(error));
      }
    }
  }

  private async loadCurrentRemoteFolder(): Promise<void> {
    if (!this.remotePath) {
      this.setRemoteStatus("Remote directory is not loaded");
      return;
    }

    await this.loadRemoteFolderPath(this.remotePath);
  }

  private async loadRemoteFolderPath(path: string): Promise<void> {
    if (!path) {
      this.setRemoteStatus("Remote directory is not loaded");
      return;
    }

    const sourceToken = this.claimSourceLoad();
    this.setRemoteStatus(`Loading folder ${path}`);

    try {
      const host = this.currentRemoteHost();
      const response =
        path === this.remotePath && host === this.remoteHost
          ? { host: this.remoteHost, path: this.remotePath, parent: this.remoteParent, entries: this.remoteEntries }
          : await fetchRemoteJson<RemoteListResponse>("list", host, { path });

      if (sourceToken !== this.sourceLoadToken) {
        return;
      }

      this.remoteHost = response.host;
      this.remotePath = response.path;
      this.remoteParent = response.parent;
      this.remoteEntries = response.entries;
      this.remoteHostInput.value = response.host;
      this.remotePathInput.value = response.path;
      this.rememberRemoteHost(response.host);
      this.rememberRemotePath(response.path);
      this.renderRemoteList(response.entries);

      const files = this.remoteSourceFiles(response.entries, response.path, response.host);

      const loaded = await this.loadPipelineFolder(files, `${response.host}:${response.path}`, { sourceToken });
      if (sourceToken !== this.sourceLoadToken) {
        return;
      }
      this.setRemoteStatus(
        loaded
          ? `Loaded ${response.host}:${response.path}`
          : this.statusText.textContent || `Could not load ${response.host}:${response.path}`,
      );
    } catch (error) {
      if (sourceToken === this.sourceLoadToken && !isAbortError(error)) {
        this.setStatus(errorMessage(error));
        this.setRemoteStatus(errorMessage(error));
      }
    }
  }

  private async downloadCurrentRemoteFolder(): Promise<void> {
    if (!this.remotePath) {
      this.setRemoteStatus("Remote directory is not loaded");
      return;
    }

    await this.downloadRemoteFolderPath(this.remotePath);
  }

  private async downloadRemoteFolderPath(path: string): Promise<void> {
    if (!path) {
      this.setRemoteStatus("Remote directory is not loaded");
      return;
    }

    this.setRemoteStatus(`Preparing download for ${path}`);

    try {
      const host = this.currentRemoteHost();
      const response =
        path === this.remotePath && host === this.remoteHost
          ? { host: this.remoteHost, path: this.remotePath, parent: this.remoteParent, entries: this.remoteEntries }
          : await fetchRemoteJson<RemoteListResponse>("list", host, { path });

      const selection = findPipelineFolderSelection(this.remoteSourceFiles(response.entries, response.path, response.host));
      const files = [...selection.volumes, ...selection.meshes, ...selection.manifests];
      const folderLabel = compactFolderLabel(`${response.host}:${response.path}`);
      let succeeded = 0;
      let failed = 0;

      this.setStatus(`Downloading ${files.length} file${files.length === 1 ? "" : "s"} from ${folderLabel}`);
      this.setRemoteStatus(`Downloading ${files.length} file${files.length === 1 ? "" : "s"} from ${response.host}:${response.path}`);

      await Promise.all(files.map(async (file) => {
        let loadTaskId: number | null = this.beginFileLoad(`Downloading ${file.name}`);
        try {
          await file.arrayBuffer((progress) => {
            if (loadTaskId !== null) {
              this.setLoadProgress(loadTaskId, `Downloading ${file.name}`, progress);
            }
          });
          succeeded += 1;
          this.finishLoadProgress(loadTaskId, `Cached ${file.name}`);
          loadTaskId = null;
        } catch (error) {
          failed += 1;
          if (loadTaskId !== null) {
            this.failLoadProgress(loadTaskId, `${file.name}: ${errorMessage(error)}`);
            loadTaskId = null;
          }
        } finally {
          if (loadTaskId !== null) {
            this.removeLoadProgress(loadTaskId);
          }
        }
      }));

      const message = failed === 0
        ? `Cached ${succeeded} file${succeeded === 1 ? "" : "s"} from ${folderLabel}`
        : `Cached ${succeeded} file${succeeded === 1 ? "" : "s"} from ${folderLabel}; ${failed} failed`;
      this.setStatus(message);
      this.setRemoteStatus(message);
      void this.refreshRemoteCacheStats();
    } catch (error) {
      if (!isAbortError(error)) {
        this.setStatus(errorMessage(error));
        this.setRemoteStatus(errorMessage(error));
      }
    }
  }

  private remoteSourceFiles(entries: RemoteEntry[], directoryPath: string, host = this.remoteHost): SourceFile[] {
    return entries
      .filter((entry) => entry.type === "file")
      .map((entry) => new RemoteFileHandle(host, entry.name, entry.path, directoryPath, entry.size, entry.mtimeMs));
  }

  private renderRemoteList(entries: RemoteEntry[]): void {
    this.remoteList.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "remote-entry";
      empty.textContent = "No entries";
      this.remoteList.append(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = `remote-entry ${entry.type}`;

      if (entry.type === "directory") {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = entry.name;
        button.title = entry.path;
        button.addEventListener("click", () => void this.loadRemotePath(entry.path));
        row.append(button);
      } else {
        const name = document.createElement("span");
        name.className = "remote-entry-name";
        name.textContent = entry.name;
        name.title = entry.path;
        row.append(name);
      }

      const kind = document.createElement("span");
      kind.className = "remote-entry-kind";
      kind.textContent = entry.type === "directory" ? "dir" : "file";

      const size = document.createElement("span");
      size.className = "remote-entry-size";
      size.textContent = entry.type === "file" && entry.size !== null ? formatBytes(entry.size) : "";

      if (entry.type === "directory") {
        const loadButton = document.createElement("button");
        loadButton.type = "button";
        loadButton.className = "remote-entry-action";
        loadButton.textContent = "Load";
        loadButton.title = `Load ${entry.path}`;
        loadButton.addEventListener("click", () => void this.loadRemoteFolderPath(entry.path));

        const actions = document.createElement("div");
        actions.className = "remote-entry-actions";
        actions.append(loadButton);
        row.append(kind, size, actions);
      } else if (isMeshFileName(entry.name)) {
        const addButton = document.createElement("button");
        addButton.type = "button";
        addButton.className = "remote-entry-action";
        addButton.textContent = "Add";
        addButton.title = `Add mesh ${entry.path}`;
        addButton.addEventListener("click", () => void this.loadRemoteMesh(entry));
        const actions = document.createElement("div");
        actions.className = "remote-entry-actions";
        actions.append(addButton);
        row.append(kind, size, actions);
      } else {
        row.append(kind, size);
      }
      this.remoteList.append(row);
    }
  }

  private async loadRemoteMesh(entry: RemoteEntry): Promise<void> {
    if (entry.type !== "file" || !isMeshFileName(entry.name)) {
      return;
    }

    try {
      const directoryPath = directoryName(entry.path);
      await this.loadMeshFiles(
        [new RemoteFileHandle(this.currentRemoteHost(), entry.name, entry.path, directoryPath, entry.size, entry.mtimeMs)],
        { replace: false, normalizeToCurrentSize: this.normalizeImportedMesh.checked },
      );
      this.setRemoteStatus(`Added mesh ${entry.name}`);
    } catch (error) {
      if (!isAbortError(error)) {
        this.setStatus(errorMessage(error));
        this.setRemoteStatus(errorMessage(error));
      }
    }
  }

  private setRemoteStatus(message: string): void {
    this.remoteStatus.textContent = message;
    this.remoteStatus.title = message;
  }

  private currentRemoteHost(): string {
    return this.remoteHostInput.value.trim() || DEFAULT_REMOTE_HOST;
  }

  private rememberRemoteHost(host: string): void {
    window.localStorage.setItem(REMOTE_LAST_HOST_STORAGE_KEY, host);
  }

  private async refreshRemoteCacheStats(): Promise<void> {
    this.remoteCacheUsage.textContent = "Checking...";
    this.remoteCacheDetails.textContent = "Reading local browser storage...";

    try {
      const stats = await remoteCacheStats();
      const shownBytes = stats.originUsage ?? stats.trackedBytes;
      const primary = shownBytes > 0 ? `${formatBytes(shownBytes)} used` : "No cached files";
      const quotaText = stats.quota !== null ? ` / ${formatBytes(stats.quota)} quota` : "";
      const fileText = `${stats.fileCount} cached file${stats.fileCount === 1 ? "" : "s"}`;
      const trackedText = stats.trackedBytes > 0 ? `, ${formatBytes(stats.trackedBytes)} tracked` : "";
      const storageText = stats.originUsage !== null
        ? `browser storage ${formatBytes(stats.originUsage)}${quotaText}`
        : "browser storage unavailable";
      const oldestText = stats.oldestSavedAt !== null
        ? `oldest ${formatCacheAge(Date.now() - stats.oldestSavedAt)} ago`
        : "empty";
      const detail = `${fileText}${trackedText}; ${storageText}; ${oldestText}`;

      this.remoteCacheUsage.textContent = primary;
      this.remoteCacheUsage.title = detail;
      this.remoteCacheDetails.textContent = detail;
      this.remoteCacheDetails.title = detail;
    } catch (error) {
      const message = errorMessage(error);
      this.remoteCacheUsage.textContent = "Cache unavailable";
      this.remoteCacheDetails.textContent = message;
      this.remoteCacheDetails.title = message;
    }
  }

  private async clearRemoteCacheOlderThan(ageMs: number): Promise<void> {
    const label = formatCacheAge(ageMs);
    this.remoteCacheUsage.textContent = `Clearing > ${label}...`;
    this.remoteCacheDetails.textContent = "Scanning cached remote files...";

    try {
      const result = await clearCachedRemoteFilesOlderThan(Date.now() - ageMs);
      const message = result.deletedCount === 0
        ? `No cached files older than ${label}`
        : `Cleared ${result.deletedCount} cached file${result.deletedCount === 1 ? "" : "s"} (${formatBytes(result.deletedBytes)}) older than ${label}`;
      this.setStatus(message);
      this.setRemoteStatus(message);
      await this.refreshRemoteCacheStats();
    } catch (error) {
      const message = errorMessage(error);
      this.remoteCacheUsage.textContent = "Clear failed";
      this.remoteCacheDetails.textContent = message;
      this.remoteCacheDetails.title = message;
      this.setRemoteStatus(message);
    }
  }

  private rememberRemotePath(path: string): void {
    try {
      window.localStorage.setItem(REMOTE_LAST_PATH_STORAGE_KEY, path);
    } catch {
      // localStorage can be unavailable in restrictive browser modes.
    }
  }

  private beginFileLoad(label: string): number {
    const id = this.nextLoadTaskId;
    this.nextLoadTaskId += 1;

    const row = document.createElement("div");
    row.className = "load-progress-row indeterminate";

    const track = document.createElement("div");
    track.className = "load-progress-track";

    const bar = document.createElement("div");
    bar.className = "load-progress-bar";

    const text = document.createElement("span");
    text.className = "load-progress-text";
    text.textContent = label;
    text.title = label;

    track.append(bar);
    row.append(track, text);
    this.loadProgress.append(row);
    this.loadTasks.set(id, { row, bar, text });
    this.loadProgress.classList.remove("hidden");
    return id;
  }

  private setLoadProgress(taskId: number, label: string, progress?: FileLoadProgress): void {
    const task = this.loadTasks.get(taskId);
    if (!task) {
      return;
    }

    task.row.classList.remove("done", "error");
    if (progress?.total && progress.total > 0) {
      const percent = clamp((progress.loaded / progress.total) * 100, 0, 100);
      task.row.classList.remove("indeterminate");
      task.bar.style.width = `${percent.toFixed(1)}%`;
      task.text.textContent = `${percent.toFixed(0)}% · ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)} · ${label}`;
      task.text.title = task.text.textContent;
      return;
    }

    task.row.classList.add("indeterminate");
    task.bar.style.width = "42%";
    task.text.textContent = progress ? `${formatBytes(progress.loaded)} · ${label}` : label;
    task.text.title = task.text.textContent;
  }

  private finishLoadProgress(taskId: number, label?: string): void {
    const task = this.loadTasks.get(taskId);
    if (!task) {
      return;
    }

    task.row.classList.remove("indeterminate", "error");
    task.row.classList.add("done");
    task.bar.style.width = "100%";
    if (label) {
      task.text.textContent = label;
      task.text.title = label;
    }
    window.setTimeout(() => this.removeLoadProgress(taskId), 1400);
  }

  private failLoadProgress(taskId: number, message: string): void {
    const task = this.loadTasks.get(taskId);
    if (!task) {
      return;
    }

    task.row.classList.remove("indeterminate", "done");
    task.row.classList.add("error");
    task.bar.style.width = "100%";
    task.text.textContent = message;
    task.text.title = message;
    window.setTimeout(() => this.removeLoadProgress(taskId), 3500);
  }

  private removeLoadProgress(taskId: number): void {
    const task = this.loadTasks.get(taskId);
    if (!task) {
      return;
    }

    task.row.remove();
    this.loadTasks.delete(taskId);
    this.loadProgress.classList.toggle("hidden", this.loadTasks.size === 0);
  }

  private populateArraySelect(): void {
    const selectedValue = this.arraySelect.value;
    this.arraySelect.replaceChildren();

    this.volumeSlots.forEach((slot, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = slot.volume
        ? `${slot.name} (${slot.volume.definition.logicalShape.join(" x ")})`
        : `${slot.name} (load/cache on select)`;
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

  private async selectVolume(index: number, resetSlice = false): Promise<boolean> {
    const slot = this.volumeSlots[index];
    if (!slot) {
      return false;
    }

    const token = ++this.volumeLoadToken;
    let loadTaskId: number | null = null;
    const assertCurrentVolumeLoad = (): void => {
      if (token !== this.volumeLoadToken) {
        throw new DOMException("Superseded field load", "AbortError");
      }
    };

    try {
      this.releaseDeferredVolumesExcept(index);

      if (!slot.volume) {
        if (!slot.file) {
          throw new Error(`Field ${slot.name} is not available.`);
        }

        this.showNoSourceState(true);
        loadTaskId = this.beginFileLoad(`Loading ${slot.file.name}`);
        this.setStatus(`Loading ${slot.file.name}`);
        await yieldToBrowser();
        assertCurrentVolumeLoad();
        const buffer = await slot.file.arrayBuffer((progress) => {
          if (loadTaskId !== null && token === this.volumeLoadToken) {
            this.setLoadProgress(loadTaskId, `Downloading ${slot.file?.name ?? slot.name}`, progress);
          }
        });
        assertCurrentVolumeLoad();
        this.setLoadProgress(loadTaskId, `Parsing ${slot.file.name}`, {
          loaded: buffer.byteLength,
          total: buffer.byteLength,
        });
        await yieldToBrowser();
        assertCurrentVolumeLoad();
        const array = parseNpy(buffer, slot.file.name);
        const preset = inferPipelinePreset(slot.file.name);
        const definition = resolveFieldDefinition(array, {
          preset,
          manifest: this.fieldManifest,
          userOverrides: slot.userOverrides,
        });
        const volume: DenseField = { array, definition };
        slot.volume = volume;
        slot.provider = new InMemoryFieldProvider(volume);
        slot.labelFilter ??= initialLabelFilterState(definition.labels);
        slot.name = array.name;
        this.populateArraySelect();
        this.finishLoadProgress(loadTaskId, `Loaded ${array.name}`);
        loadTaskId = null;
        await yieldToBrowser();
      }

      if (token !== this.volumeLoadToken) {
        return false;
      }

      this.activeVolume = slot.volume;
      slot.labelFilter ??= initialLabelFilterState(slot.volume.definition.labels);
      this.activeProvider = slot.provider ?? new InMemoryFieldProvider(slot.volume);
      slot.provider = this.activeProvider;
      this.activeFieldSlice = null;
      this.arraySelect.value = String(index);
      this.populateArraySelect();
      this.arraySelect.value = String(index);
      this.updateSliceControls(resetSlice);
      this.updateFieldOptions();
      this.rebuildSceneGuides();
      this.updateSlicePlane();
      this.updateSelectionMarker();
      this.renderSlice();
      this.showPinnedInspectorOrClear();
      if (resetSlice) {
        this.resetCamera();
      }
      const warnings = [...slot.volume.array.warnings, ...this.fieldManifestWarnings];
      const warningText = warnings.length ? ` ${warnings.join(" ")}` : "";
      this.setStatus(
        `Field ${slot.volume.definition.name}: ${slot.volume.definition.logicalShape.join(" x ")} `
        + `${slot.volume.array.dtype}, ${slot.volume.definition.semantic}.${warningText}`,
      );
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        return false;
      }

      if (loadTaskId !== null) {
        this.failLoadProgress(loadTaskId, errorMessage(error));
        loadTaskId = null;
      }

      if (token === this.volumeLoadToken) {
        const metadataWarnings = this.fieldManifestWarnings.length
          ? ` Metadata: ${this.fieldManifestWarnings.join(" ")}`
          : "";
        this.setStatus(`${errorMessage(error)}${metadataWarnings}`);
      }
      return false;
    } finally {
      if (loadTaskId !== null) {
        this.removeLoadProgress(loadTaskId);
      }
    }
  }

  private releaseDeferredVolumesExcept(index: number): void {
    for (let slotIndex = 0; slotIndex < this.volumeSlots.length; slotIndex += 1) {
      if (slotIndex !== index && this.volumeSlots[slotIndex].file) {
        this.volumeSlots[slotIndex].volume = undefined;
        this.volumeSlots[slotIndex].provider = undefined;
      }
    }
  }

  private activeVolumeSlot(): VolumeSlot | undefined {
    const index = Number(this.arraySelect.value);
    return Number.isInteger(index) ? this.volumeSlots[index] : undefined;
  }

  private updateFieldOptions(): void {
    const field = this.activeVolume;
    if (!field) {
      this.fieldOptions.classList.add("hidden");
      this.labelTools.classList.add("hidden");
      return;
    }

    const definition = field.definition;
    this.fieldOptions.classList.remove("hidden");
    this.fieldSemantic.value = definition.semantic;
    this.categoricalPreset.value = definition.categoricalPreset;
    this.fieldAssociation.value = definition.association;
    this.fieldAxisOrder.value = definition.sourceAxisOrder.join("");
    this.fieldCoordinates.value = definition.coordinatePreset === "normalized"
      ? "normalized"
      : definition.coordinatePreset === "index"
        ? "index"
        : "custom";
    this.fieldMatrixControl.classList.toggle("hidden", this.fieldCoordinates.value !== "custom");
    this.fieldIndexToWorld.value = formatIndexToWorldText(definition.indexToWorld);
    this.categoricalPresetControl.classList.toggle("hidden", definition.semantic !== "categorical");
    this.continuousOptions.classList.toggle("hidden", definition.semantic !== "continuous");
    this.labelTools.classList.toggle("hidden", definition.semantic !== "categorical");
    this.labelSearch.value = this.activeVolumeSlot()?.labelFilter?.query ?? "";

    if (definition.semantic === "continuous") {
      const range = definition.continuousStyle.range;
      this.continuousRangeMin.value = range ? String(range[0]) : "";
      this.continuousRangeMax.value = range ? String(range[1]) : "";
      this.continuousIsovalue.value = String(definition.continuousStyle.isovalue ?? definition.continuousStyle.center ?? 0);
      this.continuousColorMap.value = definition.stylePreset === "scalarField"
        ? "sdf"
        : ["sdf", "diverging", "viridis", "grayscale"].includes(definition.stylePreset ?? "")
          ? definition.stylePreset!
          : "diverging";
    }

    const coordinateText = definition.coordinatePreset === "normalized"
      ? `normalized ${definition.association} coordinates`
      : definition.coordinatePreset === "index"
        ? "index coordinates"
        : "custom index-to-world transform";
    const semanticSource = definition.semanticSource === "dtype" ? "dtype suggestion" : definition.semanticSource;
    const coordinateSource = definition.coordinateSource === "index" ? "default" : definition.coordinateSource;
    const labelCount = Object.keys(definition.labels).length;
    this.fieldMetadataSummary.textContent = [
      `${capitalize(definition.semantic)} (${semanticSource})`,
      definition.logicalShape.join(" × "),
      `${definition.sourceAxisOrder.join("").toUpperCase()} source axes`,
      `${definition.association} samples`,
      `${coordinateText} (${coordinateSource})`,
      definition.semantic === "categorical" && labelCount > 0 ? `${labelCount} named labels` : "exact values",
      definition.validity.noDataValues?.length
        ? `${definition.validity.noDataValues.length} no-data value${definition.validity.noDataValues.length === 1 ? "" : "s"}`
        : "",
      definition.sparseDefault !== undefined ? `sparse default ${definition.sparseDefault}` : "",
    ].filter(Boolean).join(" · ");
  }

  private applyFieldSettings(kind: FieldSettingKind): void {
    const field = this.activeVolume;
    const slotIndex = Number(this.arraySelect.value);
    const slot = this.volumeSlots[slotIndex];
    if (!field || !slot) {
      return;
    }

    const overrides: FieldMetadataPatch = { ...slot.userOverrides };
    if (kind === "semantic") {
      overrides.semantic = this.fieldSemantic.value === "continuous" ? "continuous" : "categorical";
    } else if (kind === "categoricalPreset") {
      overrides.categoricalPreset = this.categoricalPreset.value === "instances" ? "instances" : "semantic";
    } else if (kind === "association") {
      overrides.association = this.fieldAssociation.value === "cell" ? "cell" : "point";
    } else if (kind === "axisOrder") {
      overrides.sourceAxisOrder = this.fieldAxisOrder.value.split("") as unknown as SourceAxisOrder;
    } else if (kind === "coordinates") {
      if (this.fieldCoordinates.value === "index") {
        overrides.coordinatePreset = "index";
        delete overrides.indexToWorld;
      } else if (this.fieldCoordinates.value === "normalized") {
        overrides.coordinatePreset = "normalized";
        delete overrides.indexToWorld;
      } else {
        try {
          overrides.indexToWorld = parseIndexToWorldText(this.fieldIndexToWorld.value);
          delete overrides.coordinatePreset;
        } catch (error) {
          this.setStatus(errorMessage(error));
          return;
        }
      }
    } else if (kind === "continuousRange") {
      const minimum = optionalFiniteNumber(this.continuousRangeMin.value);
      const maximum = optionalFiniteNumber(this.continuousRangeMax.value);
      if ((minimum === null) !== (maximum === null)) {
        this.setStatus("Enter both range limits, or clear both fields to use the field's default display range.");
        return;
      }
      if (minimum !== null && maximum !== null && minimum >= maximum) {
        this.setStatus("Continuous range minimum must be smaller than the maximum.");
        return;
      }
      overrides.continuousStyle = {
        ...overrides.continuousStyle,
        range: minimum !== null && maximum !== null ? [minimum, maximum] as const : null,
      };
    } else if (kind === "continuousIsovalue") {
      const isovalue = optionalFiniteNumber(this.continuousIsovalue.value);
      if (isovalue === null) {
        this.setStatus("Enter a finite isovalue.");
        return;
      }
      overrides.continuousStyle = {
        ...overrides.continuousStyle,
        isovalue,
      };
    } else {
      overrides.continuousStyle = {
        ...overrides.continuousStyle,
        ...continuousPalette(this.continuousColorMap.value),
      };
      overrides.stylePreset = this.continuousColorMap.value;
    }

    slot.userOverrides = overrides;
    const preset = inferPipelinePreset(field.array.name);
    const definition = resolveFieldDefinition(field.array, {
      preset,
      manifest: this.fieldManifest,
      userOverrides: overrides,
    });
    const updated: DenseField = { array: field.array, definition };
    slot.volume = updated;
    slot.provider = new InMemoryFieldProvider(updated);
    if (kind === "semantic" || kind === "categoricalPreset") {
      slot.labelFilter = initialLabelFilterState(definition.labels);
    }
    this.activeVolume = updated;
    this.activeProvider = slot.provider;
    this.activeFieldSlice = null;
    this.viewerState = reconcileViewerState(this.viewerState, definition.logicalShape);
    this.updateFieldOptions();
    this.rebuildSceneGuides();
    this.updateSliceControls(false);
    this.updateSlicePlane();
    this.updateSelectionMarker();
    if (kind === "association" || kind === "axisOrder" || kind === "coordinates") {
      this.resetCamera();
    }
    this.renderSlice();
    this.showPinnedInspectorOrClear();
  }

  private async loadSelectedVxz(): Promise<void> {
    const file = this.vxzInput.files?.[0];
    if (!file) {
      return;
    }

    try {
      await this.loadVxz(file);
    } catch (error) {
      if (!isAbortError(error)) {
        this.setStatus(errorMessage(error));
      }
    } finally {
      this.vxzInput.value = "";
    }
  }

  private async loadVxz(file: File): Promise<void> {
    const requestedResolution = this.requestedVxzResolution();
    await this.loadVxzSource(file.name, `Uploading VXZ ${file.name}`, async (signal) => {
      const openResponse = await fetch(
        `${VXZ_API_BASE}/open?name=${encodeURIComponent(file.name)}`
        + (requestedResolution === null ? "" : `&resolution=${requestedResolution}`),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
          signal,
        },
      );
      if (!openResponse.ok) {
        throw new Error(await responseError(openResponse));
      }
      return await openResponse.json() as VxzJobResponse;
    });
  }

  private async loadOpenedVxz(
    sourceName: string,
    job: VxzJobResponse,
    sourceToken?: number,
  ): Promise<void> {
    await this.loadVxzSource(sourceName, `Opening VXZ ${sourceName}`, async () => job, sourceToken);
  }

  private async openAssociatedVxz(request: ElectronVxzOpenRequest): Promise<void> {
    const sourceToken = this.claimSourceLoad();
    const bridge = window.voxelMeshViewer;
    if (!bridge) {
      throw new Error("Electron VXZ bridge is unavailable");
    }
    const resolution = this.requestedVxzResolution();
    await this.persistVxzResolution();
    if (sourceToken !== this.sourceLoadToken) {
      throw new DOMException("Superseded VXZ load", "AbortError");
    }
    this.setStatus(`Opening VXZ ${request.sourceName}`);
    const job = await bridge.openVxzFile(request.requestId, resolution);
    if (sourceToken !== this.sourceLoadToken) {
      throw new DOMException("Superseded VXZ load", "AbortError");
    }
    await this.loadOpenedVxz(request.sourceName, job, sourceToken);
  }

  private async initializeElectronFileBridge(): Promise<void> {
    const bridge = window.voxelMeshViewer;
    if (!bridge) {
      return;
    }
    try {
      const resolution = await bridge.getVxzResolution();
      if (resolution !== null) {
        this.vxzResolution.value = String(resolution);
      }
    } catch (error) {
      this.setStatus(`Could not restore VXZ resolution: ${errorMessage(error)}`);
    } finally {
      bridge.readyForOpenFiles();
    }
  }

  private async persistVxzResolution(): Promise<void> {
    const bridge = window.voxelMeshViewer;
    if (!bridge) {
      return;
    }
    await bridge.setVxzResolution(this.requestedVxzResolution());
  }

  private async loadVxzSource(
    sourceName: string,
    initialMessage: string,
    openJob: (signal: AbortSignal) => Promise<VxzJobResponse>,
    requestedSourceToken?: number,
  ): Promise<void> {
    const sourceToken = requestedSourceToken ?? this.claimSourceLoad();
    if (sourceToken !== this.sourceLoadToken) {
      throw new DOMException("Superseded VXZ load", "AbortError");
    }
    this.clearVxzSource();
    this.volumeSlots = [];
    this.fieldManifest = undefined;
    this.fieldManifestWarnings = [];
    this.fieldOptions.classList.add("hidden");
    this.labelTools.classList.add("hidden");
    this.arraySelectRow.classList.add("hidden");
    this.showNoSourceState();
    const token = ++this.vxzLoadToken;
    const controller = new AbortController();
    this.vxzLoadAbort = controller;
    let loadTaskId: number | null = this.beginFileLoad(initialMessage);
    this.setStatus(initialMessage);

    try {
      let job = await openJob(controller.signal);
      if (sourceToken !== this.sourceLoadToken) {
        throw new DOMException("Superseded VXZ load", "AbortError");
      }
      this.assertVxzJob(job);

      while (job.status === "processing") {
        if (token !== this.vxzLoadToken || sourceToken !== this.sourceLoadToken) {
          throw new DOMException("Superseded VXZ load", "AbortError");
        }
        const progress = Number.isFinite(job.progress) ? clamp(job.progress, 0, 1) : 0;
        if (loadTaskId !== null) {
          this.setLoadProgress(loadTaskId, job.message || "Decoding VXZ", {
            loaded: Math.round(progress * 1000),
            total: 1000,
          });
        }
        this.setStatus(job.message || "Decoding VXZ");
        await delay(500);
        const statusResponse = await fetch(
          `${VXZ_API_BASE}/status?id=${encodeURIComponent(job.id)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!statusResponse.ok) {
          throw new Error(await responseError(statusResponse));
        }
        job = await statusResponse.json() as VxzJobResponse;
        this.assertVxzJob(job);
      }

      if (job.status === "failed" || !job.metadata) {
        throw new Error(job.error || job.message || "VXZ decode failed");
      }
      if (token !== this.vxzLoadToken || sourceToken !== this.sourceLoadToken) {
        throw new DOMException("Superseded VXZ load", "AbortError");
      }

      this.vxzJobId = job.id;
      this.vxzMetadata = job.metadata;
      this.vxzFallbackColorOption.disabled = !job.metadata.hasOvoxelType;
      this.vxzQefRankColorOption.disabled = !job.metadata.hasQefRank;
      if (
        (this.vxzFallbackColorOption.disabled && this.vxzColorMode.value === "fallback")
        || (this.vxzQefRankColorOption.disabled && this.vxzColorMode.value === "rank")
      ) {
        this.vxzColorMode.value = "occupancy";
      }
      this.vxzSliceRecords.clear();
      this.vxzOptions.classList.remove("hidden");
      this.vxzMeshVisible.checked = true;
      this.vxzVoxelsVisible.checked = false;
      this.voxelRoot.visible = false;
      this.sliceRenderMode.value = "pixels";
      this.sliceRenderMode.disabled = true;

      if (loadTaskId !== null) {
        this.setLoadProgress(loadTaskId, "Loading voxel preview", { loaded: 0, total: 2 });
      }
      const voxelResponse = await fetch(
        vxzDataUrl(
          VXZ_API_BASE,
          job.id,
          "voxels",
          job.metadata.formatVersion,
          job.metadata.cacheVersion,
        ),
        { signal: controller.signal },
      );
      if (!voxelResponse.ok) {
        throw new Error(await responseError(voxelResponse));
      }
      const voxelBuffer = await voxelResponse.arrayBuffer();
      if (token !== this.vxzLoadToken || sourceToken !== this.sourceLoadToken) {
        throw new DOMException("Superseded VXZ load", "AbortError");
      }
      this.loadVxzVoxelPreview(voxelBuffer);

      this.updateSliceControls(true);
      this.updateSlicePlane();
      this.renderSlice();
      if (loadTaskId !== null) {
        this.setLoadProgress(loadTaskId, "Loading mesh preview", { loaded: 1, total: 2 });
      }
      const meshResponse = await fetch(
        vxzDataUrl(
          VXZ_API_BASE,
          job.id,
          "mesh",
          job.metadata.formatVersion,
          job.metadata.cacheVersion,
        ),
        { signal: controller.signal },
      );
      if (!meshResponse.ok) {
        throw new Error(await responseError(meshResponse));
      }
      const meshBuffer = await meshResponse.arrayBuffer();
      if (token !== this.vxzLoadToken || sourceToken !== this.sourceLoadToken) {
        throw new DOMException("Superseded VXZ load", "AbortError");
      }
      this.loadDecodedVxzMesh(meshBuffer, sourceName);
      this.frameVxzMesh();
      this.updateVxzPointSize();
      this.updateMeshDisplay();

      if (loadTaskId !== null) {
        this.finishLoadProgress(loadTaskId, `Loaded VXZ ${sourceName}`);
        loadTaskId = null;
      }
      const metadata = this.vxzMetadata;
      this.setStatus(
        `Loaded ${sourceName}: r=${metadata.resolution}, ${metadata.voxelCount.toLocaleString()} voxels, `
        + `${metadata.faceCount.toLocaleString()} exact faces; `
        + `decoded mesh viewport LOD ${metadata.previewFaceCount.toLocaleString()} faces`,
      );
    } catch (error) {
      if (loadTaskId !== null) {
        this.failLoadProgress(loadTaskId, errorMessage(error));
        loadTaskId = null;
      }
      throw error;
    } finally {
      if (this.vxzLoadAbort === controller) {
        this.vxzLoadAbort = null;
      }
      if (loadTaskId !== null) {
        this.removeLoadProgress(loadTaskId);
      }
    }
  }

  private assertVxzJob(job: VxzJobResponse): void {
    if (!job || typeof job.id !== "string" || !["processing", "ready", "failed"].includes(job.status)) {
      throw new Error("VXZ backend returned an invalid job response");
    }
  }

  private requestedVxzResolution(): number | null {
    const value = this.vxzResolution.value.trim();
    if (!value) {
      return null;
    }
    const resolution = Number(value);
    if (!Number.isInteger(resolution) || resolution <= 0) {
      throw new Error("VXZ resolution must be a positive integer or left blank for Auto");
    }
    return resolution;
  }

  private loadVxzVoxelPreview(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    assertBinaryMagic(view, "VXVP", VXZ_VOXEL_HEADER_BYTES);
    const version = view.getUint32(4, true);
    const count = view.getUint32(8, true);
    const resolution = view.getUint32(12, true);
    if (
      version !== VXZ_WORKER_FORMAT_VERSION
      || !this.vxzMetadata
      || resolution !== this.vxzMetadata.resolution
    ) {
      throw new Error("Unsupported or inconsistent VXZ voxel preview");
    }
    if (buffer.byteLength !== VXZ_VOXEL_HEADER_BYTES + count * VXZ_VOXEL_RECORD_BYTES) {
      throw new Error("VXZ voxel preview byte length is inconsistent");
    }

    const coords = new Uint16Array(count * 3);
    const dual = new Uint8Array(count * 3);
    const intersected = new Uint8Array(count);
    const ovoxelType = new Uint8Array(count);
    const qefRank = new Uint8Array(count);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let record = 0; record < count; record += 1) {
      const offset = VXZ_VOXEL_HEADER_BYTES + record * VXZ_VOXEL_RECORD_BYTES;
      for (let axis = 0; axis < 3; axis += 1) {
        const coord = view.getUint16(offset + axis * 2, true);
        const dualValue = view.getUint8(offset + 6 + axis);
        coords[record * 3 + axis] = coord;
        dual[record * 3 + axis] = dualValue;
        positions[record * 3 + axis] = (coord + 0.5) / resolution - 0.5;
      }
      intersected[record] = view.getUint8(offset + 9);
      ovoxelType[record] = view.getUint8(offset + 10);
      qefRank[record] = view.getUint8(offset + 11);
    }
    this.vxzPreviewRecords = { coords, dual, intersected, ovoxelType, qefRank };

    this.clearGroup(this.voxelRoot);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.PointsMaterial({
      size: Number(this.vxzPointSize.value),
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: true,
      clippingPlanes: this.meshClippingPlanes,
    });
    const points = new THREE.Points(geometry, material);
    points.name = "VXZ active voxels";
    points.frustumCulled = true;
    this.voxelRoot.add(points);
    this.vxzVoxelObject = points;
    this.updateVxzVoxelColors();
  }

  private loadDecodedVxzMesh(buffer: ArrayBuffer, sourceName: string): void {
    const view = new DataView(buffer);
    assertBinaryMagic(view, "VXMP", VXZ_MESH_HEADER_BYTES);
    const version = view.getUint32(4, true);
    const vertexCount = view.getUint32(8, true);
    const indexCount = view.getUint32(12, true);
    const indexOffset = VXZ_MESH_HEADER_BYTES + vertexCount * 3 * 4;
    if (
      version !== VXZ_WORKER_FORMAT_VERSION
      || indexCount % 3 !== 0
      || buffer.byteLength !== indexOffset + indexCount * 4
    ) {
      throw new Error("VXZ decoded mesh byte length is inconsistent");
    }
    const positions = new Float32Array(buffer, VXZ_MESH_HEADER_BYTES, vertexCount * 3);
    const indices = new Uint32Array(buffer, indexOffset, indexCount);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry);
    mesh.userData.preferLightweightWireframe = true;
    mesh.userData.preferFlatShading = true;
    const meshName = `${sourceName} decoded mesh (viewport LOD)`;
    const root = this.addMeshObject(mesh, meshName, this.vxzMeshVisible.checked);
    this.vxzMeshObject = root;
    this.meshItems.push({
      id: this.nextMeshId,
      name: meshName,
      object: root,
    });
    this.nextMeshId += 1;
    this.renderMeshList();
  }

  private updateVxzVoxelColors(): void {
    const records = this.vxzPreviewRecords;
    const colorAttribute = this.vxzVoxelObject?.geometry.getAttribute("color");
    if (!records || !(colorAttribute instanceof THREE.BufferAttribute)) {
      return;
    }
    const colors = colorAttribute.array as Float32Array;
    const mode = this.vxzColorMode.value as VxzColorMode;
    for (let record = 0; record < records.intersected.length; record += 1) {
      const offset = record * 3;
      const [r, g, b] = vxzRecordColor(
        records.intersected[record],
        [records.dual[offset], records.dual[offset + 1], records.dual[offset + 2]],
        records.ovoxelType[record],
        records.qefRank[record],
        mode,
      );
      colors[offset] = r / 255;
      colors[offset + 1] = g / 255;
      colors[offset + 2] = b / 255;
    }
    colorAttribute.needsUpdate = true;
  }

  private updateVxzPointSize(): void {
    const size = Number(this.vxzPointSize.value);
    this.vxzPointSizeValue.value = size.toFixed(1);
    if (this.vxzVoxelObject) {
      this.vxzVoxelObject.material.size = size;
      this.vxzVoxelObject.material.needsUpdate = true;
    }
  }

  private renderVxzDualVertices(
    pixelPositions: Float32Array,
    planePositions: Float32Array,
    resolution: number,
  ): void {
    const overlayScale = vxzDualOverlayScale(resolution);
    this.vxzDualOverlay.width = resolution * overlayScale;
    this.vxzDualOverlay.height = resolution * overlayScale;
    this.vxzDualOverlay.style.width = `${resolution}px`;
    this.vxzDualOverlay.style.height = `${resolution}px`;

    const context = this.vxzDualOverlayContext;
    context.setTransform(overlayScale, 0, 0, overlayScale, 0, 0);
    context.clearRect(0, 0, resolution, resolution);
    context.fillStyle = "rgba(15, 23, 42, 0.92)";
    context.beginPath();
    for (let offset = 0; offset < pixelPositions.length; offset += 2) {
      const x = pixelPositions[offset];
      const y = pixelPositions[offset + 1];
      context.moveTo(x + 1.5, y);
      context.arc(x, y, 1.5, 0, Math.PI * 2);
    }
    context.fill();
    context.fillStyle = VXZ_DUAL_MARKER_COLOR;
    context.beginPath();
    for (let offset = 0; offset < pixelPositions.length; offset += 2) {
      const x = pixelPositions[offset];
      const y = pixelPositions[offset + 1];
      context.moveTo(x + 0.72, y);
      context.arc(x, y, 0.72, 0, Math.PI * 2);
    }
    context.fill();

    this.disposeVxzDualSliceObject();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(planePositions, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.PointsMaterial({
      color: VXZ_DUAL_MARKER_COLOR,
      size: 3.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.96,
      depthTest: false,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.name = "VXZ slice dual vertices";
    points.renderOrder = 30;
    points.frustumCulled = false;
    this.sliceRoot.add(points);
    this.vxzDualSliceObject = points;
    this.updateVxzDualVisibility();
    requestAnimationFrame(() => this.positionVxzDualOverlay());
  }

  private positionVxzDualOverlay(): void {
    if (!this.vxzMetadata || this.vxzDualOverlay.width <= 1) {
      return;
    }
    this.vxzDualOverlay.style.left = `${this.sliceCanvas.offsetLeft + this.sliceCanvas.clientLeft}px`;
    this.vxzDualOverlay.style.top = `${this.sliceCanvas.offsetTop + this.sliceCanvas.clientTop}px`;
  }

  private updateVxzDualVisibility(): void {
    const visible = Boolean(this.vxzMetadata) && this.vxzDualVerticesVisible.checked;
    this.vxzDualOverlay.classList.toggle("visible", visible && this.vxzDualOverlay.width > 1);
    if (this.vxzDualSliceObject) {
      this.vxzDualSliceObject.visible = visible;
    }
  }

  private disposeVxzDualSliceObject(): void {
    if (!this.vxzDualSliceObject) {
      return;
    }
    this.sliceRoot.remove(this.vxzDualSliceObject);
    this.vxzDualSliceObject.geometry.dispose();
    this.vxzDualSliceObject.material.dispose();
    this.vxzDualSliceObject = null;
  }

  private clearVxzDualVertices(): void {
    this.disposeVxzDualSliceObject();
    this.vxzDualOverlay.width = 1;
    this.vxzDualOverlay.height = 1;
    this.vxzDualOverlay.style.removeProperty("width");
    this.vxzDualOverlay.style.removeProperty("height");
    this.vxzDualOverlay.style.removeProperty("left");
    this.vxzDualOverlay.style.removeProperty("top");
    this.vxzDualOverlay.classList.remove("visible");
  }

  private clearVxzSource(): void {
    this.vxzLoadToken += 1;
    this.vxzSliceToken += 1;
    this.vxzLoadAbort?.abort();
    this.vxzLoadAbort = null;
    this.vxzSliceAbort?.abort();
    this.vxzSliceAbort = null;
    this.vxzJobId = null;
    this.vxzMetadata = null;
    this.vxzPreviewRecords = null;
    this.vxzFallbackColorOption.disabled = true;
    this.vxzQefRankColorOption.disabled = true;
    this.vxzSliceRecords.clear();
    this.clearVxzDualVertices();
    this.clearGroup(this.voxelRoot);
    this.vxzVoxelObject = null;
    if (this.vxzMeshObject) {
      const object = this.vxzMeshObject;
      this.meshRoot.remove(object);
      disposeObject(object);
      this.meshItems = this.meshItems.filter((item) => item.object !== object);
      this.vxzMeshObject = null;
      this.renderMeshList();
    }
    this.vxzOptions.classList.add("hidden");
    this.sliceRenderMode.disabled = false;
  }

  private async loadSelectedMeshFile(): Promise<void> {
    const files = Array.from(this.meshInput.files ?? []) as SourceFile[];
    if (files.length === 0) {
      return;
    }

    try {
      await this.loadMeshFiles(files, {
        replace: false,
        normalizeToCurrentSize: this.normalizeImportedMesh.checked,
      });
    } catch (error) {
      if (!isAbortError(error)) {
        this.setStatus(errorMessage(error));
      }
    } finally {
      this.meshInput.value = "";
    }
  }

  private async loadMeshFiles(
    files: SourceFile[],
    options: {
      replace: boolean;
      visibility?: boolean[];
      normalizeToCurrentSize?: boolean;
      sourceToken?: number;
    },
  ): Promise<void> {
    const filesToLoad = [...files];
    const visibility = options.visibility ?? [];
    const preferredNormalizationBounds = options.normalizeToCurrentSize
      ? this.vxzMeshBounds()
      : null;
    const fallbackNormalizationBounds = options.normalizeToCurrentSize
      ? this.currentMeshBounds()
      : null;
    const normalizationTargetLabel = preferredNormalizationBounds ? "VXZ size" : "current size";
    let normalizedCount = 0;

    const assertCurrentSource = (): void => {
      if (options.sourceToken !== undefined && options.sourceToken !== this.sourceLoadToken) {
        throw new DOMException("Superseded field-folder load", "AbortError");
      }
    };
    assertCurrentSource();

    if (options.replace) {
      this.clearGroup(this.meshRoot);
      this.currentMeshFiles = [];
      this.meshItems = [];
      this.renderMeshList();
    }

    for (const [index, file] of filesToLoad.entries()) {
      assertCurrentSource();
      let loadTaskId: number | null = this.beginFileLoad(`Loading mesh ${file.name}`);
      this.setStatus(`Loading mesh ${file.name}`);
      let object: THREE.Object3D;
      try {
        object = await this.parseMesh(file, (progress) => {
          if (loadTaskId !== null) {
            this.setLoadProgress(loadTaskId, `Downloading mesh ${file.name}`, progress);
          }
        });
        try {
          assertCurrentSource();
        } catch (error) {
          disposeObject(object);
          throw error;
        }
        if (loadTaskId !== null) {
          this.finishLoadProgress(loadTaskId, `Loaded mesh ${file.name}`);
          loadTaskId = null;
        }
      } catch (error) {
        if (loadTaskId !== null) {
          this.failLoadProgress(loadTaskId, errorMessage(error));
          loadTaskId = null;
        }
        throw error;
      } finally {
        if (loadTaskId !== null) {
          this.removeLoadProgress(loadTaskId);
        }
      }
      if (normalizeObjectToPreferredBounds(
        object,
        preferredNormalizationBounds,
        fallbackNormalizationBounds,
      )) {
        normalizedCount += 1;
      }
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
      assertCurrentSource();
    }

    const loadedCount = filesToLoad.length;
    const totalCount = this.currentMeshFiles.length;
    const clippingNote = this.activeVolume ? "; clipped by current slice" : "";
    const normalizationNote = options.normalizeToCurrentSize
      ? normalizedCount === loadedCount
        ? `; normalized to ${normalizationTargetLabel}`
        : normalizedCount > 0
          ? `; ${normalizedCount}/${loadedCount} normalized to ${normalizationTargetLabel}`
          : preferredNormalizationBounds || fallbackNormalizationBounds
            ? `; normalization skipped, invalid mesh or ${normalizationTargetLabel} bounds`
            : "; current size unavailable, kept source size"
      : "";
    assertCurrentSource();
    this.setStatus(
      loadedCount === totalCount
        ? `Loaded ${totalCount} mesh${totalCount === 1 ? "" : "es"}${normalizationNote}${clippingNote}`
        : `Added ${loadedCount} mesh${loadedCount === 1 ? "" : "es"} (${totalCount} total)${normalizationNote}${clippingNote}`,
    );
  }

  private currentMeshBounds(): THREE.Box3 | null {
    this.meshRoot.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(this.meshRoot);
    return bounds.isEmpty() ? null : bounds;
  }

  private vxzMeshBounds(): THREE.Box3 | null {
    const metadata = this.vxzMetadata;
    if (!metadata) {
      return null;
    }
    const bounds = new THREE.Box3(
      new THREE.Vector3(...metadata.boundsMin),
      new THREE.Vector3(...metadata.boundsMax),
    );
    return bounds.isEmpty() ? null : bounds;
  }

  private async parseMesh(file: SourceFile, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<THREE.Object3D> {
    const extension = file.name.split(".").pop()?.toLowerCase();

    if (extension === "obj") {
      return new OBJLoader().parse(await file.text(onProgress, signal));
    }

    if (extension === "ply") {
      const geometry = new PLYLoader().parse(await file.arrayBuffer(onProgress, signal));
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry);
    }

    if (extension === "stl") {
      const geometry = new STLLoader().parse(await file.arrayBuffer(onProgress, signal));
      geometry.computeVertexNormals();
      return new THREE.Mesh(geometry);
    }

    throw new Error("Unsupported mesh format. Use .ply, .obj, or .stl.");
  }

  private addMeshObject(object: THREE.Object3D, name: string, visible = true): THREE.Object3D {
    const root = new THREE.Group();
    root.name = name;
    root.visible = visible;
    object.name ||= name;
    root.add(object);
    this.prepareMeshObject(root);
    this.meshRoot.add(root);
    this.updateMeshClipping();
    this.updateMeshDisplay();
    return root;
  }

  private renderMeshList(): void {
    this.meshList.replaceChildren();
    this.meshList.classList.toggle("hidden", this.meshItems.length === 0);
    requestAnimationFrame(() => this.resize());

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
      input.checked = item.object === this.vxzMeshObject
        ? this.vxzMeshVisible.checked
        : item.object.visible;
      input.addEventListener("change", () => {
        if (item.object === this.vxzMeshObject) {
          this.vxzMeshVisible.checked = input.checked;
          item.object.visible = input.checked;
          this.updateMeshDisplay();
        } else {
          item.object.visible = input.checked;
        }
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
      if (item.object === this.vxzMeshObject) {
        this.vxzMeshVisible.checked = visible;
      }
    }
    this.updateMeshDisplay();
    this.renderMeshList();
  }

  private prepareMeshObject(object: THREE.Object3D): void {
    const solidMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>[] = [];
    object.traverse((child) => {
      if (isMesh(child)) {
        solidMeshes.push(child);
      }
    });

    for (const child of solidMeshes) {
      const useFlatShading = child.userData.preferFlatShading === true;

      if (!useFlatShading && !child.geometry.attributes.normal) {
        child.geometry.computeVertexNormals();
      }

      child.userData.viewerRole = "solid";
      child.material = new THREE.MeshStandardMaterial({
        color: useFlatShading ? "#94a3b8" : "#d9dde7",
        roughness: useFlatShading ? 0.82 : 0.65,
        metalness: useFlatShading ? 0 : 0.04,
        flatShading: useFlatShading,
        transparent: true,
        opacity: Number(this.meshOpacity.value),
        side: THREE.DoubleSide,
        clippingPlanes: this.meshClippingPlanes,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });

      const faceCount = Math.floor((child.geometry.index?.count
        ?? child.geometry.getAttribute("position").count) / 3);
      if (child.userData.preferLightweightWireframe
        || faceCount >= LIGHTWEIGHT_WIREFRAME_FACE_THRESHOLD) {
        const wireframe = new THREE.Mesh(
          child.geometry,
          new THREE.MeshBasicMaterial({
            color: "#202938",
            wireframe: true,
            transparent: true,
            opacity: 0.46,
            depthTest: true,
            clippingPlanes: this.meshClippingPlanes,
          }),
        );
        wireframe.name = "wireframe-overlay";
        wireframe.userData.viewerRole = "wire";
        wireframe.renderOrder = 1;
        child.add(wireframe);
      } else {
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
      }
    }
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
        // Keep the object traversable in wireframe mode so its wire overlay,
        // which shares the decoded geometry, remains renderable.
        child.visible = true;
        const material = child.material;
        if (isMeshMaterial(material)) {
          material.visible = mode !== "wireframe";
          material.opacity = opacity;
          material.transparent = opacity < 1 || mode === "transparent";
          material.depthWrite = opacity >= 0.92 && mode !== "transparent";
          this.setMaterialClipping(material);
          material.needsUpdate = true;
        }
      }

      if ((isLineSegments(child) || isMesh(child)) && role === "wire") {
        child.visible = mode === "wireframe" || mode === "solidWire";
        const material = child.material;
        if (isMeshMaterial(material)) {
          material.opacity = mode === "wireframe" ? 0.76 : 0.46;
          material.transparent = true;
          material.depthWrite = false;
          this.setMaterialClipping(material);
          material.needsUpdate = true;
        } else if (isLineMaterial(material)) {
          this.setMaterialClipping(material);
        }
      }
    });
  }

  private updateSlicePlaneOpacity(): void {
    const requestedOpacity = clamp(Number(this.sliceOpacity.value), 0, 1);
    const opacity = this.slicePlaneHasTexture ? requestedOpacity : Math.min(requestedOpacity, 0.22);
    this.slicePlaneMaterial.opacity = opacity;
    this.sliceOpacityValue.value = requestedOpacity.toFixed(2);
    this.slicePlaneMaterial.needsUpdate = true;
  }

  private showNoSourceState(preserveViewerState = false): void {
    const previousViewerState = preserveViewerState ? this.viewerState : null;
    this.activeVolume = null;
    this.activeProvider = null;
    this.activeFieldSlice = null;
    this.fieldSliceAbort?.abort();
    this.fieldSliceAbort = null;
    this.fieldSliceToken += 1;
    this.fieldOptions.classList.add("hidden");
    this.labelTools.classList.add("hidden");
    this.selectionMarker.visible = false;
    this.clearSelectedPoint.classList.add("hidden");
    this.updateSliceControls(false);
    this.rebuildSceneGuides();
    this.updateSlicePlane();
    this.renderSlice();
    if (previousViewerState) {
      this.viewerState = previousViewerState;
    }
  }

  private updateSliceControls(resetValue = false): void {
    const hasSource = this.hasSliceSource();
    const dims = hasSource ? this.getWorldDims() : [1, 1, 1] as [number, number, number];
    this.viewerState = resetValue
      ? createViewerState(dims, this.sliceAxis)
      : reconcileViewerState(this.viewerState, dims);
    const axisIndex = axisToIndex(this.sliceAxis);
    const max = dims[axisIndex] - 1;

    this.sliceSlider.disabled = !hasSource;
    this.sliceSlider.max = String(max);
    this.sliceValue.disabled = !hasSource;
    this.sliceValue.max = String(max);
    this.sliceLabel.textContent = `${this.sliceAxis.toUpperCase()} slice`;

    if (!hasSource) {
      this.sliceSlider.value = "0";
      this.sliceValue.value = "";
      this.sliceValue.placeholder = "No slice";
      this.clearSelectedPoint.classList.add("hidden");
      this.viewerState = createViewerState([1, 1, 1], this.sliceAxis);
      return;
    }

    this.sliceValue.placeholder = "";

    this.sliceSlider.value = String(this.sliceIndex);
    this.sliceValue.value = String(this.sliceIndex);
    this.clearSelectedPoint.classList.toggle("hidden", this.viewerState.pinnedGridPoint === null || !this.activeVolume);
  }

  private setSliceIndex(index: number): void {
    const dims = this.hasSliceSource() ? this.getWorldDims() : [1, 1, 1] as [number, number, number];
    this.viewerState = updateViewerSliceIndex(this.viewerState, this.sliceAxis, index, dims);
    this.sliceSlider.value = String(this.sliceIndex);
    this.sliceValue.value = String(this.sliceIndex);
    this.updateSlicePlane();
    this.updateSelectionMarker();
    this.renderSlice();
    this.showPinnedInspectorOrClear();
  }

  private get sliceAxis(): SliceAxis {
    return this.viewerState.activeAxis;
  }

  private get sliceIndex(): number {
    return activeSliceIndex(this.viewerState);
  }

  private commitSliceInput(): void {
    if (!this.hasSliceSource() || this.sliceValue.value === "") {
      this.sliceValue.value = this.hasSliceSource() ? String(this.sliceIndex) : "";
      return;
    }

    const index = Number(this.sliceValue.value);
    if (Number.isFinite(index)) {
      this.setSliceIndex(index);
    } else {
      this.sliceValue.value = String(this.sliceIndex);
    }
  }

  private updateSlicePlane(): void {
    if (this.activeVolume && !this.vxzMetadata) {
      const definition = this.activeVolume.definition;
      const displayAssociation = definition.association === "cell"
        && (this.sliceRenderMode.value as SliceRenderMode) === "cornerDots"
        ? "point"
        : definition.association;
      const frame = computeTransformedSlicePlaneFrame(
        definition.logicalShape,
        displayAssociation,
        definition.indexToWorld,
        this.sliceAxis,
        this.sliceIndex,
      );
      const center = vectorFromWorldPoint(frame.center);
      const basisU = vectorFromWorldPoint(frame.basisU);
      const basisV = vectorFromWorldPoint(frame.basisV);
      const normal = vectorFromWorldPoint(frame.normal);

      this.sliceRoot.matrixAutoUpdate = false;
      this.sliceRoot.matrix.set(
        basisU.x, basisV.x, normal.x, center.x,
        basisU.y, basisV.y, normal.y, center.y,
        basisU.z, basisV.z, normal.z, center.z,
        0, 0, 0, 1,
      );
      this.sliceRoot.matrixWorldNeedsUpdate = true;
      this.meshClipPlane.setFromNormalAndCoplanarPoint(normal, center);
      this.refreshMeshClipping();
      return;
    }

    const dims = this.hasSliceSource() ? this.getWorldDims() : [1, 1, 1] as [number, number, number];
    const position = this.activeIndexToWorld(
      this.sliceIndex,
      dims[axisToIndex(this.sliceAxis)],
    );

    this.sliceRoot.matrixAutoUpdate = true;
    this.sliceRoot.position.set(0, 0, 0);
    this.sliceRoot.rotation.set(0, 0, 0);
    const extentScale = this.vxzMetadata ? 0.5 : 1;
    this.sliceRoot.scale.set(extentScale, extentScale, extentScale);

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
    if (!this.hasSliceSource()) {
      this.refreshMeshClipping();
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

    this.refreshMeshClipping();
  }

  private refreshMeshClipping(): void {
    this.meshRoot.traverse((child) => {
      if (isMesh(child) && isMeshMaterial(child.material)) {
        this.setMaterialClipping(child.material);
      } else if (isLineSegments(child) && isLineMaterial(child.material)) {
        this.setMaterialClipping(child.material);
      }
    });
  }

  private setMaterialClipping(material: THREE.Material): void {
    const clippingPlanes = this.hasSliceSource() ? this.meshClippingPlanes : null;
    if (material.clippingPlanes !== clippingPlanes) {
      material.clippingPlanes = clippingPlanes;
      material.needsUpdate = true;
    }
  }

  private renderSlice(): void {
    if (this.vxzMetadata && this.vxzJobId) {
      void this.renderVxzSlice();
      return;
    }
    void this.renderFieldSlice();
  }

  private async renderFieldSlice(): Promise<void> {
    const volume = this.activeVolume;
    const provider = this.activeProvider;
    if (!volume || !provider) {
      this.labelTools.classList.add("hidden");
      this.clearSliceCanvas("Load a field to inspect exact slices");
      this.workspace.classList.add("single-pane");
      this.slicePane?.classList.add("empty-state");
      this.renderStats.textContent = "No field loaded";
      this.renderLegend(new Map());
      this.setSlicePlaneTextureEnabled(false);
      this.setInspector();
      return;
    }

    const token = ++this.fieldSliceToken;
    this.fieldSliceAbort?.abort();
    const started = performance.now();
    let fieldSlice = this.activeFieldSlice;
    if (!fieldSlice || fieldSlice.axis !== this.sliceAxis || fieldSlice.index !== this.sliceIndex) {
      const controller = new AbortController();
      this.fieldSliceAbort = controller;
      try {
        fieldSlice = await provider.readSlice(
          { axis: this.sliceAxis, index: this.sliceIndex },
          controller.signal,
        );
      } catch (error) {
        if (!isAbortError(error) && token === this.fieldSliceToken) {
          this.renderStats.textContent = `Field slice error: ${errorMessage(error)}`;
        }
        return;
      } finally {
        if (this.fieldSliceAbort === controller) {
          this.fieldSliceAbort = null;
        }
      }
    }
    if (token !== this.fieldSliceToken || provider !== this.activeProvider) {
      return;
    }
    this.activeFieldSlice = fieldSlice;

    this.sliceCanvas.classList.remove("vxz-grid-mode");
    this.sliceCanvas.parentElement?.classList.remove("vxz-grid-mode");
    const [width, height] = fieldSlice.shape;
    const labelCounts = new Map<string, { value: FieldValue; count: number }>();
    let noDataCount = 0;
    const renderMode = this.sliceRenderMode.value as SliceRenderMode;
    const cornerDotMode = renderMode === "cornerDots";
    const compactImage = this.sliceContext.createImageData(width, height);
    const sampleVisibility = new Uint8Array(width * height);

    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const sample = this.sampleSlicePixel(px, py, height);
        const display = this.getSampleDisplay(sample);
        sampleVisibility[py * width + px] = display.visible ? 1 : 0;
        const [r, g, b] = display.color;
        const offset = (py * width + px) * 4;
        compactImage.data[offset] = r;
        compactImage.data[offset + 1] = g;
        compactImage.data[offset + 2] = b;
        compactImage.data[offset + 3] = 255;

        if (isNoDataValue(sample.value, volume.definition.validity)) {
          noDataCount += 1;
        } else if (volume.definition.semantic === "categorical") {
          const key = fieldValueKey(sample.value);
          const current = labelCounts.get(key);
          labelCounts.set(key, { value: sample.value, count: (current?.count ?? 0) + 1 });
        }
      }
    }

    this.sliceCanvas.classList.remove("empty-state");
    this.sliceCanvas.parentElement?.classList.remove("empty-state");
    this.workspace.classList.remove("single-pane");
    this.slicePane?.classList.remove("empty-state");

    if (cornerDotMode) {
      const textureWidth = Math.max(1, (width - 1) * DOT_SPACING + 1);
      const textureHeight = Math.max(1, (height - 1) * DOT_SPACING + 1);
      const textureImage = this.sliceTextureContext.createImageData(textureWidth, textureHeight);

      for (let py = 0; py < height; py += 1) {
        for (let px = 0; px < width; px += 1) {
          if (sampleVisibility[py * width + px] === 0) {
            continue;
          }
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
      const textureImage = this.sliceTextureContext.createImageData(width, height);
      textureImage.data.set(compactImage.data);
      for (let sampleIndex = 0; sampleIndex < sampleVisibility.length; sampleIndex += 1) {
        if (sampleVisibility[sampleIndex] === 0) {
          textureImage.data[sampleIndex * 4 + 3] = 0;
        }
      }
      this.sliceTextureContext.putImageData(textureImage, 0, 0);
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
      this.drawContinuousContours(cornerDotMode);
      this.drawPinnedCrosshair(cornerDotMode);
      this.renderStats.textContent = `${this.sliceAxis.toUpperCase()}=${this.sliceIndex}, ${width} x ${height} points, ${canvasWidth} x ${canvasHeight}${noDataCount ? `, ${noDataCount.toLocaleString()} no data` : ""}, ${(performance.now() - started).toFixed(1)} ms`;
    } else {
      this.sliceCanvas.width = width;
      this.sliceCanvas.height = height;
      this.sliceContext.imageSmoothingEnabled = false;
      this.sliceContext.putImageData(compactImage, 0, 0);
      this.drawContinuousContours(cornerDotMode);
      this.drawPinnedCrosshair(cornerDotMode);
      this.renderStats.textContent = `${this.sliceAxis.toUpperCase()}=${this.sliceIndex}, ${width} x ${height}${noDataCount ? `, ${noDataCount.toLocaleString()} no data` : ""}, ${(performance.now() - started).toFixed(1)} ms`;
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
    this.updateSlicePlaneOpacity();
    this.sliceTexture.needsUpdate = true;
    this.renderLegend(labelCounts, noDataCount);
  }

  private async renderVxzSlice(): Promise<void> {
    const metadata = this.vxzMetadata;
    const jobId = this.vxzJobId;
    if (!metadata || !jobId) {
      return;
    }
    this.clearVxzDualVertices();
    const token = ++this.vxzSliceToken;
    this.vxzSliceAbort?.abort();
    this.vxzSliceRecords.clear();
    this.setSlicePlaneTextureEnabled(false);
    this.clearSliceCanvas(`Loading exact ${this.sliceAxis.toUpperCase()}=${this.sliceIndex} VXZ slice`);
    this.workspace.classList.remove("single-pane");
    this.renderStats.textContent = `Loading ${this.sliceAxis.toUpperCase()}=${this.sliceIndex}`;
    this.legendList.replaceChildren();
    this.setInspector();
    const controller = new AbortController();
    this.vxzSliceAbort = controller;
    const started = performance.now();
    const resolution = metadata.resolution;

    try {
      const response = await fetch(
        `${VXZ_API_BASE}/slice?id=${encodeURIComponent(jobId)}&axis=${this.sliceAxis}&index=${this.sliceIndex}`,
        { signal: controller.signal, cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      const buffer = await response.arrayBuffer();
      if (token !== this.vxzSliceToken) {
        return;
      }
      const view = new DataView(buffer);
      assertBinaryMagic(view, "VXSL", VXZ_SLICE_HEADER_BYTES);
      const version = view.getUint32(4, true);
      const count = view.getUint32(8, true);
      const payloadResolution = view.getUint32(12, true);
      const axisIndex = view.getUint32(16, true);
      const sliceIndex = view.getUint32(20, true);
      if (
        version !== VXZ_WORKER_FORMAT_VERSION
        || payloadResolution !== resolution
        || axisIndex !== axisToIndex(this.sliceAxis)
        || sliceIndex !== this.sliceIndex
        || buffer.byteLength !== VXZ_SLICE_HEADER_BYTES + count * VXZ_VOXEL_RECORD_BYTES
      ) {
        throw new Error("VXZ slice payload is inconsistent with the requested grid slice");
      }

      const image = this.sliceContext.createImageData(resolution, resolution);
      const textureImage = this.sliceTextureContext.createImageData(resolution, resolution);
      for (let offset = 0; offset < image.data.length; offset += 4) {
        image.data[offset] = 244;
        image.data[offset + 1] = 247;
        image.data[offset + 2] = 250;
        image.data[offset + 3] = 255;
      }
      const colorMode = this.vxzColorMode.value as VxzColorMode;
      const fallbackCounts = [0, 0, 0, 0];
      const qefRankCounts = [0, 0, 0, 0];
      const showDualVertices = this.vxzDualVerticesVisible.checked;
      const dualPixelPositions = showDualVertices ? new Float32Array(count * 2) : null;
      const dualPlanePositions = showDualVertices ? new Float32Array(count * 3) : null;
      for (let recordIndex = 0; recordIndex < count; recordIndex += 1) {
        const offset = VXZ_SLICE_HEADER_BYTES + recordIndex * VXZ_VOXEL_RECORD_BYTES;
        const record: VxzSliceRecord = {
          coords: [
            view.getUint16(offset, true),
            view.getUint16(offset + 2, true),
            view.getUint16(offset + 4, true),
          ],
          dual: [
            view.getUint8(offset + 6),
            view.getUint8(offset + 7),
            view.getUint8(offset + 8),
          ],
          intersected: view.getUint8(offset + 9),
          ovoxelType: view.getUint8(offset + 10),
          qefRank: view.getUint8(offset + 11),
        };
        const [px, py] = gridToVxzSlicePixel(this.sliceAxis, record.coords, resolution);
        if (px < 0 || py < 0 || px >= resolution || py >= resolution) {
          throw new Error(`VXZ slice record is outside the r=${resolution} grid`);
        }
        const pixelOffset = (py * resolution + px) * 4;
        const [r, g, b] = vxzRecordColor(
          record.intersected,
          record.dual,
          record.ovoxelType,
          record.qefRank,
          colorMode,
        );
        if (record.ovoxelType >= 0 && record.ovoxelType < fallbackCounts.length) {
          fallbackCounts[record.ovoxelType] += 1;
        }
        if (record.qefRank >= 0 && record.qefRank < qefRankCounts.length) {
          qefRankCounts[record.qefRank] += 1;
        }
        image.data[pixelOffset] = r;
        image.data[pixelOffset + 1] = g;
        image.data[pixelOffset + 2] = b;
        image.data[pixelOffset + 3] = 255;
        textureImage.data[pixelOffset] = r;
        textureImage.data[pixelOffset + 1] = g;
        textureImage.data[pixelOffset + 2] = b;
        textureImage.data[pixelOffset + 3] = 235;
        this.vxzSliceRecords.set(py * resolution + px, record);

        if (dualPixelPositions && dualPlanePositions) {
          const projection = projectVxzDualVertexToSlice(
            this.sliceAxis,
            record.coords,
            record.dual,
            resolution,
          );
          dualPixelPositions[recordIndex * 2] = projection.pixel[0];
          dualPixelPositions[recordIndex * 2 + 1] = projection.pixel[1];
          dualPlanePositions[recordIndex * 3] = projection.plane[0];
          dualPlanePositions[recordIndex * 3 + 1] = projection.plane[1];
          dualPlanePositions[recordIndex * 3 + 2] = 0;
        }
      }

      this.sliceCanvas.width = resolution;
      this.sliceCanvas.height = resolution;
      this.sliceContext.imageSmoothingEnabled = false;
      this.sliceContext.putImageData(image, 0, 0);
      this.sliceTextureCanvas.width = resolution;
      this.sliceTextureCanvas.height = resolution;
      this.sliceTextureContext.imageSmoothingEnabled = false;
      this.sliceTextureContext.putImageData(textureImage, 0, 0);
      this.sliceTexture.magFilter = THREE.NearestFilter;
      this.sliceTexture.minFilter = THREE.NearestFilter;
      this.sliceTexture.generateMipmaps = false;
      this.sliceTexture.needsUpdate = true;
      if (dualPixelPositions && dualPlanePositions && this.vxzDualVerticesVisible.checked) {
        this.renderVxzDualVertices(dualPixelPositions, dualPlanePositions, resolution);
      }
      this.sliceCanvas.classList.remove("empty-state", "corner-dot-mode");
      this.sliceCanvas.parentElement?.classList.remove("empty-state", "corner-dot-mode");
      this.sliceCanvas.classList.add("vxz-grid-mode");
      this.sliceCanvas.parentElement?.classList.add("vxz-grid-mode");
      this.workspace.classList.remove("single-pane");
      this.slicePane?.classList.remove("empty-state");
      const shell = this.sliceCanvas.parentElement;
      if (shell) {
        requestAnimationFrame(() => {
          shell.scrollLeft = Math.max(0, (this.sliceCanvas.clientWidth - shell.clientWidth) / 2);
          shell.scrollTop = Math.max(0, (this.sliceCanvas.clientHeight - shell.clientHeight) / 2);
        });
      }
      this.setSlicePlaneTextureEnabled(true);
      this.updateSlicePlaneOpacity();
      this.renderStats.textContent = `${this.sliceAxis.toUpperCase()}=${this.sliceIndex}, ${resolution} × ${resolution} exact cells, native 1 px = 1 grid cell, ${count.toLocaleString()} active, ${(performance.now() - started).toFixed(1)} ms`;
      this.renderVxzLegend(count, fallbackCounts, qefRankCounts);
      this.setInspector();
    } catch (error) {
      if (!isAbortError(error) && token === this.vxzSliceToken) {
        this.renderStats.textContent = `VXZ slice error: ${errorMessage(error)}`;
        this.clearSliceCanvas("Exact VXZ slice unavailable");
        this.workspace.classList.remove("single-pane");
      }
    } finally {
      if (this.vxzSliceAbort === controller) {
        this.vxzSliceAbort = null;
      }
    }
  }

  private renderVxzLegend(
    activeCount: number,
    fallbackCounts: number[],
    qefRankCounts: number[],
  ): void {
    this.legendList.replaceChildren();
    const items: Array<{ color: string; label: string; value: string }> = [
      { color: "#f4f7fa", label: "Inactive cell", value: (this.vxzMetadata!.resolution ** 2 - activeCount).toLocaleString() },
    ];
    if (this.vxzColorMode.value === "fallback" && this.vxzMetadata?.hasOvoxelType) {
      for (const [fallbackCase, definition] of VXZ_FALLBACK_CASES.entries()) {
        items.push({
          color: definition.cssColor,
          label: definition.label,
          value: (fallbackCounts[fallbackCase] ?? 0).toLocaleString(),
        });
      }
    } else if (this.vxzColorMode.value === "rank" && this.vxzMetadata?.hasQefRank) {
      for (const definition of VXZ_QEF_RANKS) {
        items.push({
          color: definition.color,
          label: definition.label,
          value: (qefRankCounts[definition.rank] ?? 0).toLocaleString(),
        });
      }
    } else {
      items.push({ color: "#1696c8", label: "Active O-Voxel cell", value: activeCount.toLocaleString() });
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "legend-row";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = item.color;
      const label = document.createElement("span");
      label.textContent = item.label;
      const value = document.createElement("strong");
      value.textContent = item.value;
      row.append(swatch, label, value);
      this.legendList.append(row);
    }
  }

  private clearSliceCanvas(message: string): void {
    const width = 420;
    const height = 260;
    this.sliceCanvas.width = width;
    this.sliceCanvas.height = height;
    this.sliceContext.fillStyle = "#f5f7fa";
    this.sliceContext.fillRect(0, 0, width, height);
    this.sliceContext.strokeStyle = "#d6dee9";
    this.sliceContext.lineWidth = 2;
    this.sliceContext.strokeRect(0.5, 0.5, width - 1, height - 1);
    this.sliceContext.fillStyle = "#7b8797";
    this.sliceContext.font = "15px system-ui, sans-serif";
    this.sliceContext.textAlign = "center";
    this.sliceContext.textBaseline = "middle";
    this.sliceContext.fillText(message, width / 2, height / 2);
    this.sliceCanvas.classList.remove("corner-dot-mode");
    this.sliceCanvas.parentElement?.classList.remove("corner-dot-mode");
    this.sliceCanvas.classList.remove("vxz-grid-mode");
    this.sliceCanvas.parentElement?.classList.remove("vxz-grid-mode");
    this.sliceCanvas.classList.add("empty-state");
    this.sliceCanvas.parentElement?.classList.add("empty-state");
  }

  private setSlicePlaneTextureEnabled(enabled: boolean): void {
    if (this.slicePlaneHasTexture === enabled) {
      return;
    }

    this.slicePlaneHasTexture = enabled;
    this.slicePlaneMaterial.map = enabled ? this.sliceTexture : null;
    this.slicePlaneMaterial.color.set(enabled ? "#ffffff" : "#f97316");
    this.updateSlicePlaneOpacity();
  }

  private renderLegend(
    labelCounts: Map<string, { value: FieldValue; count: number }>,
    noDataCount = 0,
  ): void {
    this.legendList.replaceChildren();
    const field = this.activeVolume;
    if (!field) {
      return;
    }

    if (field.definition.semantic === "continuous") {
      const [minimum, maximum] = this.continuousRange(field);
      const isovalue = field.definition.continuousStyle.isovalue
        ?? field.definition.continuousStyle.center
        ?? (minimum + maximum) / 2;
      this.appendLegendRow(this.continuousCssColor(minimum), "Range minimum", formatCompactNumber(minimum));
      this.appendLegendRow(this.continuousCssColor(isovalue), "Isovalue", formatCompactNumber(isovalue));
      this.appendLegendRow(this.continuousCssColor(maximum), "Range maximum", formatCompactNumber(maximum));
      if (noDataCount > 0) {
        this.appendLegendRow(rgbToCss(NO_DATA_COLOR), "No data · current slice", noDataCount.toLocaleString());
      }
      const note = document.createElement("span");
      note.className = "legend-empty";
      note.textContent = field.definition.continuousStyle.range
        ? "Exact values · current slice"
        : field.array.data.length > 1_000_000
          ? "Exact slice · automatic display range sampled from field"
          : "Exact slice · automatic display range scanned from field";
      this.legendList.append(note);
      return;
    }

    const filter = this.activeVolumeSlot()?.labelFilter ?? createLabelFilterState();
    if (noDataCount > 0) {
      this.appendLegendRow(rgbToCss(NO_DATA_COLOR), "No data · current slice", noDataCount.toLocaleString());
    }
    const schemaOrder = new Map(Object.keys(field.definition.labels).map((key, index) => [key, index]));
    const visibleLabels = Array.from(labelCounts.values()).sort((left, right) => {
      if (field.definition.categoricalPreset === "instances") {
        return right.count - left.count || fieldValueKey(left.value).localeCompare(fieldValueKey(right.value));
      }
      const leftOrder = schemaOrder.get(fieldValueKey(left.value)) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = schemaOrder.get(fieldValueKey(right.value)) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || fieldValueKey(left.value).localeCompare(fieldValueKey(right.value));
    });
    const matchingLabels = visibleLabels.filter((entry) => {
      const key = fieldValueKey(entry.value);
      return labelMatchesQuery(filter.query, key, labelDefinitionForValue(entry.value, field.definition.labels));
    });
    if (matchingLabels.length === 0) {
      const empty = document.createElement("span");
      empty.className = "legend-empty";
      empty.textContent = filter.query ? "No labels match this search on the current slice" : "No valid labels on this slice";
      this.legendList.append(empty);
      return;
    }

    const limit = 100;
    for (const entry of matchingLabels.slice(0, limit)) {
      const schema = labelDefinitionForValue(entry.value, field.definition.labels);
      const id = formatFieldValue(entry.value);
      const label = schema?.name
        ? `${schema.name} · ${id}`
        : field.definition.categoricalPreset === "instances" ? `Instance ${id}` : `Label ${id}`;
      this.appendLabelLegendRow(entry.value, label, entry.count, filter);
    }
    if (matchingLabels.length > limit) {
      const more = document.createElement("span");
      more.className = "legend-empty";
      more.textContent = `${(matchingLabels.length - limit).toLocaleString()} more matching labels on this slice`;
      this.legendList.append(more);
    }
  }

  private appendLabelLegendRow(
    value: FieldValue,
    text: string,
    countValue: number,
    state: LabelFilterState,
  ): void {
    const slot = this.activeVolumeSlot();
    if (!slot) {
      return;
    }
    const key = fieldValueKey(value);
    const visible = isLabelVisible(state, key);
    const isolated = state.isolatedLabelKey === key;
    const highlighted = isLabelHighlighted(state, key);
    const row = document.createElement("div");
    row.className = "legend-row";
    row.classList.toggle("label-hidden", !visible);
    row.classList.toggle("label-locked", highlighted);
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = this.categoricalCssColor(value);
    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = text;
    label.title = text;
    const count = document.createElement("strong");
    count.textContent = countValue.toLocaleString();
    const actions = document.createElement("span");
    actions.className = "legend-actions";
    const visibility = document.createElement("button");
    visibility.type = "button";
    visibility.textContent = visible ? "Hide" : "Show";
    visibility.title = `${visibility.textContent} ${text}`;
    visibility.addEventListener("click", () => {
      let current = slot.labelFilter ?? createLabelFilterState();
      if (current.isolatedLabelKey !== null) {
        current = isolateLabel(current, null);
      }
      slot.labelFilter = setLabelHidden(current, key, visible);
      this.renderSlice();
    });
    const isolate = document.createElement("button");
    isolate.type = "button";
    isolate.textContent = isolated ? "All" : "Only";
    isolate.title = isolated ? "Show all labels" : `Isolate ${text}`;
    isolate.addEventListener("click", () => {
      const current = slot.labelFilter ?? createLabelFilterState();
      slot.labelFilter = isolateLabel(current, isolated ? null : key);
      this.renderSlice();
    });
    const lock = document.createElement("button");
    lock.type = "button";
    lock.textContent = highlighted ? "Unlock" : "Lock";
    lock.title = highlighted ? "Clear locked highlight" : `Lock highlight on ${text}`;
    lock.addEventListener("click", () => {
      const current = slot.labelFilter ?? createLabelFilterState();
      slot.labelFilter = lockLabelHighlight(current, highlighted ? null : key);
      this.renderSlice();
    });
    actions.append(visibility, isolate, lock);
    row.append(swatch, label, count, actions);
    this.legendList.append(row);
  }

  private appendLegendRow(color: string, text: string, value: string): void {
    const row = document.createElement("div");
    row.className = "legend-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = text;
    label.title = text;
    const count = document.createElement("strong");
    count.textContent = value;
    row.append(swatch, label, count);
    this.legendList.append(row);
  }

  private sampleSlicePixel(px: number, py: number, height: number): SliceSample {
    const volume = this.activeVolume;
    const fieldSlice = this.activeFieldSlice;
    if (!volume || !fieldSlice) {
      return {
        grid: [0, 0, 0],
        world: new THREE.Vector3(),
        value: Number.NaN,
        category: null,
      };
    }

    const grid = slicePixelToLogicalIndex(
      volume.definition.logicalShape,
      this.sliceAxis,
      this.sliceIndex,
      px,
      py,
    );
    const offset = (height - 1 - py) * fieldSlice.shape[0] + px;
    const value = fieldSlice.values[offset];
    const world = vectorFromWorldPoint(transformIndexToWorld(grid, volume.definition.indexToWorld));
    const { category } = this.getSampleDisplay({ grid, world, value, category: null });
    return { grid, world, value, category };
  }

  private getSampleDisplay(sample: SliceSample): {
    category: PipelineCategoryKey | null;
    color: [number, number, number];
    visible: boolean;
  } {
    const volume = this.activeVolume;
    if (!volume) {
      return { category: null, color: [127, 127, 127], visible: false };
    }

    if (isNoDataValue(sample.value, volume.definition.validity)) {
      return { category: null, color: NO_DATA_COLOR, visible: true };
    }
    if (volume.definition.semantic === "continuous") {
      return { category: null, color: cssColorToRgb(this.continuousCssColor(sample.value)), visible: true };
    }
    const presetId = this.activePipelineVisualization(volume);
    const category = presetId ? classifyPipelineValue(sample.value, presetId) : null;
    const schema = labelDefinitionForValue(sample.value, volume.definition.labels);
    const filter = this.activeVolumeSlot()?.labelFilter ?? createLabelFilterState();
    const key = fieldValueKey(sample.value);
    if (!isLabelVisible(filter, key)) {
      return { category, color: DOT_BACKGROUND, visible: false };
    }
    const schemaColor = schema?.color;
    let color = schemaColor
      ? cssColorToRgb(schemaColor)
      : presetId
        ? pipelineColorForValue(sample.value, presetId)
        : cssColorToRgb(categoricalColorForValue(sample.value, volume.definition.labels));
    if (filter.lockedHighlightKey !== null && !isLabelHighlighted(filter, key)) {
      color = mixRgb(color, DOT_BACKGROUND, 0.78);
    }
    return {
      category,
      color,
      visible: true,
    };
  }

  private categoricalCssColor(value: FieldValue): string {
    const field = this.activeVolume;
    if (!field) {
      return "#7f7f7f";
    }
    if (isNoDataValue(value, field.definition.validity)) {
      return rgbToCss(NO_DATA_COLOR);
    }
    const schemaColor = labelDefinitionForValue(value, field.definition.labels)?.color;
    if (schemaColor) {
      return schemaColor;
    }
    const presetId = this.activePipelineVisualization(field);
    if (presetId) {
      return rgbToCss(pipelineColorForValue(value, presetId));
    }
    return categoricalColorForValue(value, field.definition.labels);
  }

  private activePipelineVisualization(field: DenseField): PipelineVisualization | undefined {
    return applicablePipelineVisualization(
      field.array.name,
      field.definition.semantic,
      field.definition.categoricalPreset,
    );
  }

  private continuousRange(field: DenseField): [number, number] {
    const configured = field.definition.continuousStyle.range;
    if (configured && configured[0] < configured[1]) {
      return [configured[0], configured[1]];
    }
    const cached = this.autoRanges.get(field);
    if (cached) {
      return cached;
    }
    const range = automaticContinuousRange(field.array.data, field.definition.validity);
    this.autoRanges.set(field, range);
    return range;
  }

  private continuousCssColor(value: FieldValue): string {
    const field = this.activeVolume;
    if (!field) {
      return "#7f7f7f";
    }
    if (isNoDataValue(value, field.definition.validity)) {
      return rgbToCss(NO_DATA_COLOR);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return field.definition.continuousStyle.outOfRangeColor ?? "#000000";
    }
    const range = this.continuousRange(field);
    const palette = field.definition.stylePreset ?? this.continuousColorMap.value;
    if (palette === "viridis") {
      return interpolatePalette(VIRIDIS_PALETTE, normalizeRange(numeric, range));
    }
    if (palette === "grayscale") {
      return grayscaleColorForAmount(normalizeRange(numeric, range));
    }
    return continuousColorForValue(numeric, {
      ...field.definition.continuousStyle,
      range,
    });
  }

  private getWorldDims(): [number, number, number] {
    if (this.vxzMetadata) {
      const resolution = this.vxzMetadata.resolution;
      return [resolution, resolution, resolution];
    }
    if (!this.activeVolume) {
      return [1, 1, 1];
    }

    return [...this.activeVolume.definition.logicalShape];
  }

  private hasSliceSource(): boolean {
    return this.activeVolume !== null || this.vxzMetadata !== null;
  }

  private activeIndexToWorld(index: number, dimension: number): number {
    if (this.vxzMetadata) {
      return -0.5 + (index + 0.5) / this.vxzMetadata.resolution;
    }
    return indexToWorld(index, dimension);
  }

  private drawPinnedCrosshair(cornerDotMode: boolean): void {
    const point = this.viewerState.pinnedGridPoint;
    const fieldSlice = this.activeFieldSlice;
    if (!point || !fieldSlice || point[axisToIndex(this.sliceAxis)] !== this.sliceIndex) {
      return;
    }
    const [px, py] = gridToFieldSlicePixel(this.sliceAxis, point, fieldSlice.shape[1]);
    const x = cornerDotMode ? DOT_MARGIN + px * DOT_SPACING : px + 0.5;
    const y = cornerDotMode ? DOT_MARGIN + py * DOT_SPACING : py + 0.5;
    const context = this.sliceContext;
    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.96)";
    context.lineWidth = cornerDotMode ? 1.5 : 1;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(this.sliceCanvas.width, y);
    context.moveTo(x, 0);
    context.lineTo(x, this.sliceCanvas.height);
    context.stroke();
    context.strokeStyle = "rgba(17, 24, 39, 0.96)";
    context.strokeRect(x - 2.5, y - 2.5, 5, 5);
    context.restore();
  }

  private drawContinuousContours(cornerDotMode: boolean): void {
    const field = this.activeVolume;
    const slice = this.activeFieldSlice;
    if (
      !field
      || !slice
      || field.definition.semantic !== "continuous"
      || !this.continuousContours.checked
    ) {
      return;
    }
    const [width, height] = slice.shape;
    const level = field.definition.continuousStyle.isovalue
      ?? field.definition.continuousStyle.center
      ?? 0;
    const position = (x: number, y: number): [number, number] => cornerDotMode
      ? [DOT_MARGIN + x * DOT_SPACING, DOT_MARGIN + y * DOT_SPACING]
      : [x + 0.5, y + 0.5];
    const valueAt = (x: number, y: number): number => {
      const value = slice.values[(height - 1 - y) * width + x];
      return isNoDataValue(value, field.definition.validity) ? Number.NaN : Number(value);
    };
    const context = this.sliceContext;
    context.save();
    context.strokeStyle = "rgba(17, 24, 39, 0.92)";
    context.lineWidth = cornerDotMode ? 1.2 : 0.75;
    context.beginPath();
    for (let y = 0; y < height - 1; y += 1) {
      for (let x = 0; x < width - 1; x += 1) {
        const corners = [valueAt(x, y), valueAt(x + 1, y), valueAt(x + 1, y + 1), valueAt(x, y + 1)];
        if (corners.some((value) => !Number.isFinite(value))) {
          continue;
        }
        const points: Array<[number, number]> = [];
        const edges: Array<[number, number, [number, number], [number, number]]> = [
          [0, 1, [x, y], [x + 1, y]],
          [1, 2, [x + 1, y], [x + 1, y + 1]],
          [2, 3, [x + 1, y + 1], [x, y + 1]],
          [3, 0, [x, y + 1], [x, y]],
        ];
        for (const [startIndex, endIndex, start, end] of edges) {
          const startValue = corners[startIndex];
          const endValue = corners[endIndex];
          if ((startValue < level && endValue < level) || (startValue > level && endValue > level) || startValue === endValue) {
            continue;
          }
          const t = clamp((level - startValue) / (endValue - startValue), 0, 1);
          points.push(position(
            start[0] + (end[0] - start[0]) * t,
            start[1] + (end[1] - start[1]) * t,
          ));
        }
        for (let pointIndex = 0; pointIndex + 1 < points.length; pointIndex += 2) {
          context.moveTo(points[pointIndex][0], points[pointIndex][1]);
          context.lineTo(points[pointIndex + 1][0], points[pointIndex + 1][1]);
        }
      }
    }
    context.stroke();
    context.restore();
  }

  private updateSelectionMarker(): void {
    const field = this.activeVolume;
    const point = this.viewerState.pinnedGridPoint;
    if (!field || !point || this.vxzMetadata) {
      this.selectionMarker.visible = false;
      return;
    }
    this.selectionMarker.position.copy(
      vectorFromWorldPoint(transformIndexToWorld(point, field.definition.indexToWorld)),
    );
    const size = this.fieldWorldBounds(field).getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1) * 0.012;
    this.selectionMarker.scale.setScalar(radius);
    this.selectionMarker.visible = true;
  }

  private inspectSlicePointer(event: PointerEvent): void {
    if (this.vxzMetadata) {
      this.inspectVxzSlicePointer(event);
      return;
    }
    const sample = this.sliceSampleFromPointer(event);
    if (sample) {
      this.setInspectorForSample(sample);
    } else {
      this.showPinnedInspectorOrClear();
    }
  }

  private sliceSampleFromPointer(event: PointerEvent): SliceSample | null {
    if (
      !this.activeVolume
      || !this.activeFieldSlice
      || this.activeFieldSlice.axis !== this.sliceAxis
      || this.activeFieldSlice.index !== this.sliceIndex
      || this.sliceCanvas.width === 0
      || this.sliceCanvas.height === 0
    ) {
      return null;
    }
    const rect = this.sliceCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const canvasX = (event.clientX - rect.left) / rect.width * this.sliceCanvas.width;
    const canvasY = (event.clientY - rect.top) / rect.height * this.sliceCanvas.height;
    const [gridWidth, gridHeight] = this.activeFieldSlice.shape;
    let px: number;
    let py: number;
    if ((this.sliceRenderMode.value as SliceRenderMode) === "cornerDots") {
      px = Math.round((canvasX - DOT_MARGIN) / DOT_SPACING);
      py = Math.round((canvasY - DOT_MARGIN) / DOT_SPACING);
      const centerX = DOT_MARGIN + px * DOT_SPACING;
      const centerY = DOT_MARGIN + py * DOT_SPACING;
      if (Math.hypot(canvasX - centerX, canvasY - centerY) > DOT_RADIUS + 0.75) {
        return null;
      }
    } else {
      px = Math.floor(canvasX);
      py = Math.floor(canvasY);
    }
    if (px < 0 || py < 0 || px >= gridWidth || py >= gridHeight) {
      return null;
    }
    return this.sampleSlicePixel(px, py, gridHeight);
  }

  private setInspectorForSample(sample: SliceSample): void {
    const field = this.activeVolume;
    if (!field) {
      this.setInspector();
      return;
    }
    const common: Record<string, string> = {
      Field: field.definition.name,
      Grid: `[${sample.grid.join(", ")}]`,
      World: `[${sample.world.x.toFixed(6)}, ${sample.world.y.toFixed(6)}, ${sample.world.z.toFixed(6)}]`,
      Fidelity: "exact",
    };
    if (field.definition.valueDescription) {
      common.Meaning = field.definition.valueDescription;
    }
    const valueKey = fieldValueKey(sample.value);
    const noData = isNoDataValue(sample.value, field.definition.validity);
    if (field.definition.validity.noDataValues) {
      common.Validity = noData ? "no data" : "valid";
    }
    if (field.definition.validity.description) {
      common["Validity note"] = field.definition.validity.description;
    }
    if (field.definition.sparseDefault !== undefined) {
      common.Storage = field.definition.sparseDefault === valueKey
        ? "equals sparse default"
        : "differs from sparse default";
    }
    if (field.definition.semantic === "continuous") {
      const numeric = Number(sample.value);
      const isovalue = field.definition.continuousStyle.isovalue
        ?? field.definition.continuousStyle.center
        ?? 0;
      this.setInspector({
        ...common,
        Value: formatFieldValue(sample.value),
        "Isovalue relation": !noData && Number.isFinite(numeric)
          ? numeric < isovalue ? "below" : numeric > isovalue ? "above" : "equal"
          : "-",
      });
      return;
    }
    const schema = labelDefinitionForValue(sample.value, field.definition.labels);
    this.setInspector({
      ...common,
      "Label ID": formatFieldValue(sample.value),
      Name: schema?.name ?? "-",
      Group: schema?.group ?? "-",
      Role: schema?.background ? "background" : "label",
      Category: sample.category ? pipelineCategoryDisplayName(sample.category) : "-",
    });
  }

  private pinSlicePointer(event: PointerEvent): void {
    if (this.vxzMetadata || !this.activeVolume) {
      return;
    }
    const sample = this.sliceSampleFromPointer(event);
    if (!sample) {
      return;
    }
    this.viewerState = pinGridPoint(this.viewerState, sample.grid, this.activeVolume.definition.logicalShape);
    this.clearSelectedPoint.classList.remove("hidden");
    this.updateSliceControls(false);
    this.updateSlicePlane();
    this.updateSelectionMarker();
    this.renderSlice();
    this.setInspectorForSample(sample);
  }

  private clearPinnedFieldPoint(): void {
    this.viewerState = clearPinnedPoint(this.viewerState);
    this.selectionMarker.visible = false;
    this.clearSelectedPoint.classList.add("hidden");
    this.renderSlice();
    this.setInspector();
  }

  private showPinnedInspectorOrClear(): void {
    const point = this.viewerState.pinnedGridPoint;
    const provider = this.activeProvider;
    if (!point || !provider || this.vxzMetadata) {
      this.setInspector();
      return;
    }
    const requestToken = ++this.inspectorRequestToken;
    void provider.readPoint(point).then((result) => {
      if (
        requestToken !== this.inspectorRequestToken
        ||
        provider !== this.activeProvider
        || (this.viewerState.pinnedGridPoint !== point && !sameGridPoint(this.viewerState.pinnedGridPoint, point))
      ) {
        return;
      }
      const activeVolume = this.activeVolume;
      const presetId = activeVolume ? this.activePipelineVisualization(activeVolume) : undefined;
      const category = presetId && activeVolume && !isNoDataValue(result.value, activeVolume.definition.validity)
        ? classifyPipelineValue(result.value, presetId)
        : null;
      this.setInspectorForSample({
        grid: result.index,
        world: vectorFromWorldPoint(result.world),
        value: result.value,
        category,
      });
    }).catch(() => {
      if (
        requestToken === this.inspectorRequestToken
        && provider === this.activeProvider
        && (this.viewerState.pinnedGridPoint === point || sameGridPoint(this.viewerState.pinnedGridPoint, point))
      ) {
        this.setInspector();
      }
    });
  }

  private inspectVxzSlicePointer(event: PointerEvent): void {
    const metadata = this.vxzMetadata;
    if (!metadata || this.sliceCanvas.width !== metadata.resolution || this.sliceCanvas.height !== metadata.resolution) {
      this.setInspector();
      return;
    }
    const rect = this.sliceCanvas.getBoundingClientRect();
    const px = clamp(
      Math.floor((event.clientX - rect.left) / rect.width * metadata.resolution),
      0,
      metadata.resolution - 1,
    );
    const py = clamp(
      Math.floor((event.clientY - rect.top) / rect.height * metadata.resolution),
      0,
      metadata.resolution - 1,
    );
    const grid = vxzSlicePixelToGrid(
      this.sliceAxis,
      this.sliceIndex,
      px,
      py,
      metadata.resolution,
    );
    const record = this.vxzSliceRecords.get(py * metadata.resolution + px);
    const world = grid.map((value) => -0.5 + (value + 0.5) / metadata.resolution);
    const dualProjection = record
      ? projectVxzDualVertexToSlice(this.sliceAxis, record.coords, record.dual, metadata.resolution)
      : null;
    const rankDeficient = record ? vxzQefRankDeficient(record.qefRank) : null;
    this.setInspector({
      Pixel: `[${px}, ${py}]`,
      Grid: `[${grid.join(", ")}]`,
      World: `[${world.map((value) => value.toFixed(6)).join(", ")}]`,
      Active: record ? "yes" : "no",
      "Dual uint8": record ? `[${record.dual.join(", ")}]` : "-",
      "Dual slice pixel": dualProjection
        ? `[${dualProjection.pixel.map((value) => value.toFixed(3)).join(", ")}]`
        : "-",
      Intersections: record ? vxzIntersectionDescription(record.intersected) : "-",
      "Fallback case": record ? vxzFallbackDescription(record.ovoxelType) : "-",
      "QEF rank": record ? vxzQefRankDescription(record.qefRank) : "-",
      "Rank deficient": rankDeficient === null ? "-" : rankDeficient ? "yes" : "no",
    });
  }

  private setInspector(values?: Record<string, string>): void {
    this.inspectorRequestToken += 1;
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
    let bounds = this.activeVolume
      ? this.fieldWorldBounds(this.activeVolume)
      : this.vxzMetadata
        ? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5))
        : new THREE.Box3().setFromObject(this.meshRoot);
    if (this.activeVolume) {
      const displayedSliceBounds = new THREE.Box3().setFromObject(this.sliceRoot);
      if (!displayedSliceBounds.isEmpty()) {
        bounds.union(displayedSliceBounds);
      }
    }
    if (bounds.isEmpty()) {
      bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.01);
    const direction = new THREE.Vector3(2.05, 1.62, 1.9).normalize();
    const distance = Math.max(radius * 2.35, 0.1);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(radius / 1000, 0.0001);
    this.camera.far = Math.max(radius * 100, 80);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  private fieldWorldBounds(field: DenseField): THREE.Box3 {
    const bounds = new THREE.Box3();
    for (const corner of worldDomainCorners(
      field.definition.logicalShape,
      field.definition.association,
      field.definition.indexToWorld,
    )) {
      bounds.expandByPoint(vectorFromWorldPoint(corner));
    }
    return bounds;
  }

  private frameVxzMesh(): void {
    const metadata = this.vxzMetadata;
    if (!metadata) {
      return;
    }
    const bounds = new THREE.Box3(
      new THREE.Vector3(...metadata.boundsMin),
      new THREE.Vector3(...metadata.boundsMax),
    );
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.01);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = radius / Math.sin(verticalFov / 2) * 1.08;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.001, distance / 1000);
    this.camera.far = Math.max(80, distance + radius * 12);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    this.camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height, false);
    this.controls.update();
  }

  private updateRemoteBrowserPosition(): void {
    const isOpen = Boolean(this.remotePanel?.open);
    this.remoteBrowser.classList.toggle("hidden", !isOpen);
    if (!isOpen) {
      return;
    }

    const summaryRect = this.remotePanel?.querySelector("summary")?.getBoundingClientRect();
    const topbarRect = this.topbar?.getBoundingClientRect();
    const panelTop = Math.ceil((summaryRect?.bottom ?? topbarRect?.bottom ?? 78) + 8);
    const panelRight = Math.max(12, window.innerWidth - (summaryRect?.right ?? window.innerWidth - 16));
    this.remoteBrowser.style.setProperty("--remote-panel-top", `${panelTop}px`);
    this.remoteBrowser.style.setProperty("--remote-panel-right", `${panelRight}px`);
  }

  private closeFloatingPanelsForPointer(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    for (const panel of this.floatingPanels) {
      const isRemoteBrowserTarget = panel === this.remotePanel && this.remoteBrowser.contains(target);
      if (panel.open && !panel.contains(target) && !isRemoteBrowserTarget) {
        panel.open = false;
      }
    }
  }

  private closeFloatingPanels(): void {
    for (const panel of this.floatingPanels) {
      panel.open = false;
    }
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
    this.statusText.title = message;
  }
}

interface PipelineFolderCandidate {
  directory: string;
  prefix: string;
  label?: SourceFile;
  components?: SourceFile;
  cases?: SourceFile;
  insideFiltered?: SourceFile;
  surfaceBoundary?: SourceFile;
}

const remoteFileDownloads = new Map<string, RemoteFileDownloadEntry>();
let remoteCacheDbPromise: Promise<IDBDatabase> | null = null;

class RemoteFileHandle implements SourceFile {
  readonly webkitRelativePath: string;
  private readonly cacheKey: string;

  constructor(
    private readonly remoteHost: string,
    readonly name: string,
    private readonly remotePath: string,
    directoryPath: string,
    private readonly size: number | null,
    private readonly mtimeMs: number | null,
  ) {
    this.webkitRelativePath = `${baseName(directoryPath)}/${name}`;
    this.cacheKey = `${remoteHost}\u0000${remotePath}`;
  }

  async arrayBuffer(onProgress?: ProgressCallback, signal?: AbortSignal): Promise<ArrayBuffer> {
    const cached = await readCachedRemoteFile(this.cacheKey, this.size, this.mtimeMs);
    if (cached) {
      onProgress?.({
        loaded: cached.byteLength,
        total: cached.byteLength,
      });
      return cached;
    }

    let entry = remoteFileDownloads.get(this.cacheKey);
    if (entry?.promise) {
      if (onProgress) {
        entry.subscribers.add(onProgress);
        onProgress({ loaded: entry.loaded, total: entry.total });
      }

      try {
        return await entry.promise;
      } finally {
        if (onProgress) {
          entry.subscribers.delete(onProgress);
        }
      }
    }

    entry = {
      subscribers: new Set(),
      loaded: 0,
      total: this.size,
    };
    if (onProgress) {
      entry.subscribers.add(onProgress);
    }
    remoteFileDownloads.set(this.cacheKey, entry);

    entry.promise = this.downloadArrayBuffer(entry, signal)
      .then(async (buffer) => {
        if (this.size !== null && buffer.byteLength !== this.size) {
          throw new Error(
            `Remote file ${this.name} ended at ${formatBytes(buffer.byteLength)}; expected ${formatBytes(this.size)}.`,
          );
        }
        entry.promise = undefined;
        entry.loaded = buffer.byteLength;
        entry.total = entry.total ?? buffer.byteLength;
        notifyRemoteFileDownloadProgress(entry);
        await writeCachedRemoteFile(this.cacheKey, buffer, this.size, this.mtimeMs);
        return buffer;
      })
      .finally(() => {
        remoteFileDownloads.delete(this.cacheKey);
      });

    try {
      return await entry.promise;
    } finally {
      if (onProgress) {
        entry.subscribers.delete(onProgress);
      }
    }
  }

  private async downloadArrayBuffer(entry: RemoteFileDownloadEntry, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(remoteUrl("file", this.remoteHost, { path: this.remotePath }), { signal });
    if (!response.ok) {
      throw new Error(await response.text());
    }

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      entry.loaded = buffer.byteLength;
      entry.total = entry.total ?? buffer.byteLength;
      notifyRemoteFileDownloadProgress(entry);
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const result = await reader.read();
      if (result.done) {
        break;
      }

      chunks.push(result.value);
      loaded += result.value.byteLength;
      entry.loaded = loaded;
      notifyRemoteFileDownloadProgress(entry);
    }

    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }

  async text(onProgress?: ProgressCallback, signal?: AbortSignal): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer(onProgress, signal));
  }
}

function notifyRemoteFileDownloadProgress(entry: RemoteFileDownloadEntry): void {
  for (const subscriber of entry.subscribers) {
    subscriber({ loaded: entry.loaded, total: entry.total });
  }
}

function openRemoteCacheDb(): Promise<IDBDatabase> {
  if (remoteCacheDbPromise) {
    return remoteCacheDbPromise;
  }

  remoteCacheDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(REMOTE_CACHE_DB_NAME, 2);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REMOTE_CACHE_STORE)) {
        db.createObjectStore(REMOTE_CACHE_STORE, { keyPath: "path" });
      }
      if (!db.objectStoreNames.contains(REMOTE_CACHE_META_STORE)) {
        db.createObjectStore(REMOTE_CACHE_META_STORE, { keyPath: "path" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onblocked = () => console.warn("Remote cache database upgrade is blocked by another open tab.");
    request.onerror = () => {
      remoteCacheDbPromise = null;
      reject(request.error ?? new Error("Could not open remote cache database."));
    };
  });

  return remoteCacheDbPromise;
}

async function readCachedRemoteFile(
  path: string,
  size: number | null,
  mtimeMs: number | null,
): Promise<ArrayBuffer | null> {
  if (!("indexedDB" in window)) {
    return null;
  }

  try {
    const record = await idbGet<CachedRemoteFileRecord>(REMOTE_CACHE_STORE, path);
    if (!record) {
      return null;
    }

    if (
      (size !== null && record.size !== size)
      || (size !== null && record.buffer.byteLength !== size)
      || (record.size !== null && record.buffer.byteLength !== record.size)
      || (mtimeMs !== null && record.mtimeMs !== mtimeMs)
    ) {
      await Promise.all([
        idbDelete(REMOTE_CACHE_STORE, path),
        idbDelete(REMOTE_CACHE_META_STORE, path),
      ]);
      return null;
    }

    void writeCachedRemoteFileMeta(path, record.buffer.byteLength, record.size, record.mtimeMs, record.savedAt);
    return record.buffer;
  } catch (error) {
    console.warn(`Could not read cached remote file ${path}:`, error);
    return null;
  }
}

async function writeCachedRemoteFile(
  path: string,
  buffer: ArrayBuffer,
  size: number | null,
  mtimeMs: number | null,
): Promise<void> {
  if (!("indexedDB" in window)) {
    return;
  }

  try {
    const savedAt = Date.now();
    await idbPut<CachedRemoteFileRecord>(REMOTE_CACHE_STORE, {
      path,
      buffer,
      size,
      mtimeMs,
      savedAt,
    });
    await writeCachedRemoteFileMeta(path, buffer.byteLength, size, mtimeMs, savedAt);
  } catch (error) {
    console.warn(`Could not cache remote file ${path}:`, error);
  }
}

async function writeCachedRemoteFileMeta(
  path: string,
  byteLength: number,
  size: number | null,
  mtimeMs: number | null,
  savedAt: number,
): Promise<void> {
  try {
    await idbPut<CachedRemoteFileMeta>(REMOTE_CACHE_META_STORE, {
      path,
      byteLength,
      size,
      mtimeMs,
      savedAt,
    });
  } catch (error) {
    console.warn(`Could not write remote cache metadata for ${path}:`, error);
  }
}

async function remoteCacheStats(): Promise<RemoteCacheStats> {
  let fileCount = 0;
  let trackedBytes = 0;
  let oldestSavedAt: number | null = null;

  if ("indexedDB" in window) {
    try {
      const db = await openRemoteCacheDb();
      await new Promise<void>((resolve, reject) => {
        const request = db.transaction(REMOTE_CACHE_META_STORE, "readonly")
          .objectStore(REMOTE_CACHE_META_STORE)
          .openCursor();

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }

          const record = cursor.value as CachedRemoteFileMeta;
          fileCount += 1;
          if (Number.isFinite(record.byteLength) && record.byteLength > 0) {
            trackedBytes += record.byteLength;
          }
          if (Number.isFinite(record.savedAt)) {
            oldestSavedAt = oldestSavedAt === null ? record.savedAt : Math.min(oldestSavedAt, record.savedAt);
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error("Could not read remote cache metadata."));
      });

      if (fileCount === 0) {
        fileCount = await idbCount(REMOTE_CACHE_STORE);
      }
    } catch (error) {
      console.warn("Could not measure remote cache metadata:", error);
    }
  }

  let originUsage: number | null = null;
  let quota: number | null = null;
  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      originUsage = typeof estimate.usage === "number" ? estimate.usage : null;
      quota = typeof estimate.quota === "number" ? estimate.quota : null;
    } catch (error) {
      console.warn("Could not estimate browser storage:", error);
    }
  }

  return { fileCount, trackedBytes, originUsage, quota, oldestSavedAt };
}

async function clearCachedRemoteFilesOlderThan(cutoffMs: number): Promise<RemoteCacheClearResult> {
  if (!("indexedDB" in window)) {
    return { deletedCount: 0, deletedBytes: 0 };
  }

  const metaCount = await idbCount(REMOTE_CACHE_META_STORE);
  const result = await clearCachedRemoteFilesFromMeta(cutoffMs);

  if (metaCount === 0) {
    const legacyResult = await clearLegacyCachedRemoteFiles(cutoffMs);
    return {
      deletedCount: result.deletedCount + legacyResult.deletedCount,
      deletedBytes: result.deletedBytes + legacyResult.deletedBytes,
    };
  }

  return result;
}

async function clearCachedRemoteFilesFromMeta(cutoffMs: number): Promise<RemoteCacheClearResult> {
  const db = await openRemoteCacheDb();
  let deletedCount = 0;
  let deletedBytes = 0;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([REMOTE_CACHE_STORE, REMOTE_CACHE_META_STORE], "readwrite");
    const files = transaction.objectStore(REMOTE_CACHE_STORE);
    const metadata = transaction.objectStore(REMOTE_CACHE_META_STORE);
    const request = metadata.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }

      const record = cursor.value as CachedRemoteFileMeta;
      if (record.savedAt <= cutoffMs) {
        deletedCount += 1;
        deletedBytes += Number.isFinite(record.byteLength) ? record.byteLength : 0;
        files.delete(record.path);
        cursor.delete();
      }
      cursor.continue();
    };

    transaction.oncomplete = () => resolve({ deletedCount, deletedBytes });
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear remote cache."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Remote cache clear was aborted."));
  });
}

async function clearLegacyCachedRemoteFiles(cutoffMs: number): Promise<RemoteCacheClearResult> {
  const db = await openRemoteCacheDb();
  let deletedCount = 0;
  let deletedBytes = 0;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([REMOTE_CACHE_STORE, REMOTE_CACHE_META_STORE], "readwrite");
    const files = transaction.objectStore(REMOTE_CACHE_STORE);
    const metadata = transaction.objectStore(REMOTE_CACHE_META_STORE);
    const request = files.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }

      const record = cursor.value as CachedRemoteFileRecord;
      if (record.savedAt <= cutoffMs) {
        deletedCount += 1;
        deletedBytes += record.buffer?.byteLength ?? record.size ?? 0;
        metadata.delete(record.path);
        cursor.delete();
      }
      cursor.continue();
    };

    transaction.oncomplete = () => resolve({ deletedCount, deletedBytes });
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear legacy remote cache."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Legacy remote cache clear was aborted."));
  });
}

async function idbGet<T>(storeName: string, path: string): Promise<T | null> {
  const db = await openRemoteCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(path);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read remote cache record."));
  });
}

async function idbPut<T>(storeName: string, record: T): Promise<void> {
  const db = await openRemoteCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readwrite").objectStore(storeName).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not write remote cache record."));
  });
}

async function idbDelete(storeName: string, path: string): Promise<void> {
  const db = await openRemoteCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readwrite").objectStore(storeName).delete(path);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not delete remote cache record."));
  });
}

async function idbCount(storeName: string): Promise<number> {
  const db = await openRemoteCacheDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not count remote cache records."));
  });
}

function findPipelineFolderSelection(files: SourceFile[]): PipelineFolderSelection {
  const candidates = new Map<string, PipelineFolderCandidate>();
  const meshesByDirectory = new Map<string, SourceFile[]>();
  const volumesByDirectory = new Map<string, Array<{ order: number; file: SourceFile }>>();
  const npyNamesByDirectory = new Map<string, string[]>();
  const manifestsByDirectory = new Map<string, SourceFile[]>();

  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop() ?? path;
    const directory = parts.join("/");
    const lowerName = name.toLowerCase();

    if (["fields.json", "field_metadata.json", "npy_fields.json", "npy_labels.json"].includes(lowerName)) {
      const manifests = manifestsByDirectory.get(directory) ?? [];
      manifests.push(file);
      manifestsByDirectory.set(directory, manifests);
      continue;
    }

    if (lowerName.endsWith(".npy")) {
      const names = npyNamesByDirectory.get(directory) ?? [];
      names.push(name);
      npyNamesByDirectory.set(directory, names);
    }

    if (isMeshFileName(lowerName)) {
      addDirectoryMesh(meshesByDirectory, directory, file);
      continue;
    }

    if (!lowerName.endsWith(".npy")) {
      continue;
    }

    const preset = inferPipelinePreset(name);
    addDirectoryVolume(volumesByDirectory, directory, preset?.order ?? genericNpyFileOrder(name), file);
    if (!preset?.group) {
      continue;
    }
    const { prefix, role } = preset.group;
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
  const completeCandidates = available.filter((candidate) => candidate.label && candidate.components && candidate.cases);
  let selected: PipelineFolderCandidate | null = null;

  if (completeCandidates.length > 0) {
    selected = completeCandidates.sort((a, b) => candidateRank(b, meshesByDirectory) - candidateRank(a, meshesByDirectory))[0];
  } else if (available.length > 0) {
    selected = available.sort((a, b) => candidateRank(b, meshesByDirectory) - candidateRank(a, meshesByDirectory))[0];
  }

  let directory = selected?.directory ?? "";
  if (!selected) {
    const volumeDirectories = Array.from(volumesByDirectory.keys());
    if (volumeDirectories.length === 0) {
      throw new Error(
        "No 3D NumPy .npy fields were found in the selected folder.",
      );
    }
    directory = volumeDirectories.sort((a, b) => directoryRank(b, meshesByDirectory, volumesByDirectory) - directoryRank(a, meshesByDirectory, volumesByDirectory) || a.localeCompare(b))[0];
  }

  const volumes = (volumesByDirectory.get(directory) ?? [])
    .sort((a, b) => a.order - b.order || a.file.name.localeCompare(b.file.name))
    .map((item) => item.file);

  if (volumes.length === 0) {
    const found = (npyNamesByDirectory.get(directory) ?? []).sort((a, b) => a.localeCompare(b));
    throw new Error(`No loadable 3D NumPy fields were found in ${directory || "(selected folder)"}. Found .npy: ${found.join(", ") || "none"}.`);
  }

  return {
    directory,
    volumes,
    meshes: sortPipelineMeshes(meshesByDirectory.get(directory) ?? []),
    manifests: [...(manifestsByDirectory.get(directory) ?? [])]
      .sort((left, right) => manifestOrder(left.name) - manifestOrder(right.name) || left.name.localeCompare(right.name)),
  };
}

function genericNpyFileOrder(name: string): number {
  const step = /^(\d+)_/.exec(baseFileName(name));
  return step ? Number(step[1]) : 10_000;
}

async function loadFieldManifests(files: SourceFile[]): Promise<ParsedFieldManifest | undefined> {
  if (files.length === 0) {
    return undefined;
  }
  const combined: ParsedFieldManifest = {
    sourceName: files.map((file) => file.name).join(", "),
    format: "unknown",
    defaults: {},
    fields: new Map(),
    warnings: [],
  };
  for (const file of files) {
    try {
      const parsed = parseFieldManifest(await file.text(), file.name);
      combined.format = parsed.format === "fields" ? "fields" : combined.format === "fields" ? "fields" : parsed.format;
      combined.defaults = mergeFieldMetadataPatches(combined.defaults, parsed.defaults);
      for (const [name, patch] of parsed.fields) {
        combined.fields.set(name, mergeFieldMetadataPatches(combined.fields.get(name), patch));
      }
      combined.warnings.push(...parsed.warnings);
    } catch (error) {
      combined.warnings.push(`${file.name}: ${errorMessage(error)}`);
    }
  }
  return combined;
}

function manifestOrder(name: string): number {
  return baseFileName(name).toLowerCase() === "npy_labels.json" ? 0 : 1;
}

function baseFileName(name: string): string {
  return name.split("/").pop() ?? name;
}

function addDirectoryMesh(meshesByDirectory: Map<string, SourceFile[]>, directory: string, file: SourceFile): void {
  const meshes = meshesByDirectory.get(directory) ?? [];
  meshes.push(file);
  meshesByDirectory.set(directory, meshes);
}

function sortPipelineMeshes(meshes: SourceFile[]): SourceFile[] {
  return [...meshes].sort((a, b) => meshOrder(a.name) - meshOrder(b.name) || a.name.localeCompare(b.name));
}

function meshOrder(name: string): number {
  const lowerName = name.toLowerCase();
  if (lowerName === "voxel_input_mesh.ply") {
    return 0;
  }
  if (lowerName === "mesh.ply") {
    return 1;
  }
  return 2;
}

function addDirectoryVolume(
  volumesByDirectory: Map<string, Array<{ order: number; file: SourceFile }>>,
  directory: string,
  order: number,
  file: SourceFile,
): void {
  const volumes = volumesByDirectory.get(directory) ?? [];
  volumes.push({ order, file });
  volumesByDirectory.set(directory, volumes);
}

function directoryRank(
  directory: string,
  meshesByDirectory: Map<string, SourceFile[]>,
  volumesByDirectory: Map<string, Array<{ order: number; file: SourceFile }>>,
): number {
  const volumes = volumesByDirectory.get(directory) ?? [];
  const nonScalarCount = volumes.filter((item) => inferPipelinePreset(item.file.name)?.id !== "scalarField").length;
  return ((meshesByDirectory.get(directory)?.length ?? 0) > 0 ? 10000 : 0) + nonScalarCount * 100 + volumes.length;
}

function candidateRank(candidate: PipelineFolderCandidate, meshesByDirectory: Map<string, SourceFile[]>): number {
  const prefix = Number(candidate.prefix);
  return (
    ((meshesByDirectory.get(candidate.directory)?.length ?? 0) > 0 ? 1000 : 0)
    + (candidate.label ? 100 : 0)
    + (candidate.components ? 90 : 0)
    + (candidate.cases ? 90 : 0)
    + (candidate.insideFiltered ? 40 : 0)
    + (candidate.surfaceBoundary ? 40 : 0)
    + (Number.isFinite(prefix) ? prefix : 0)
  );
}

async function fetchRemoteJson<T>(action: string, host: string, params: Record<string, string> = {}): Promise<T> {
  const response = await fetch(remoteUrl(action, host, params));
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function remoteUrl(action: string, host: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ host, ...params });
  return `${REMOTE_API_BASE}/${action}?${search.toString()}`;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? "remote";
}

function directoryName(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/";
}

function isMeshFileName(name: string): boolean {
  return /\.(ply|obj|stl)$/i.test(name);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function compactFolderLabel(label: string): string {
  if (label === "(selected folder)") {
    return label;
  }

  const separatorIndex = label.indexOf(":");
  if (separatorIndex >= 0) {
    const host = label.slice(0, separatorIndex);
    const folder = baseName(label.slice(separatorIndex + 1));
    return `${host}:${folder}`;
  }

  return baseName(label);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return unitIndex === 0 ? `${value} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatCacheAge(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0m";
  }

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ms < hour) {
    return `${Math.max(1, Math.round(ms / minute))}m`;
  }
  if (ms < day) {
    return `${Math.max(1, Math.round(ms / hour))}h`;
  }
  return `${Math.max(1, Math.round(ms / day))}d`;
}

function indexToWorld(index: number, dimension: number): number {
  if (dimension <= 1) {
    return 0;
  }
  return -1 + index * 2 / (dimension - 1);
}

function continuousPalette(name: string): ContinuousStyle {
  if (name === "sdf") {
    return {
      scale: "sqrt",
      negativeColor: "#0d33f2",
      centerColor: "#ffffff",
      positiveColor: "#e60d0d",
      outOfRangeColor: "#000000",
    };
  }
  return {
    scale: "linear",
    negativeColor: "#2563eb",
    centerColor: "#f8fafc",
    positiveColor: "#dc2626",
  };
}

function normalizeRange(value: number, range: readonly [number, number]): number {
  return range[1] > range[0] ? clamp((value - range[0]) / (range[1] - range[0]), 0, 1) : 0.5;
}

function interpolatePalette(palette: readonly string[], amount: number): string {
  const position = clamp(amount, 0, 1) * (palette.length - 1);
  const start = Math.min(palette.length - 1, Math.floor(position));
  const end = Math.min(palette.length - 1, start + 1);
  const color = new THREE.Color(palette[start]).lerp(new THREE.Color(palette[end]), position - start);
  return `#${color.getHexString()}`;
}

function cssColorToRgb(color: string): [number, number, number] {
  const parsed = new THREE.Color(color).convertLinearToSRGB();
  return [
    Math.round(parsed.r * 255),
    Math.round(parsed.g * 255),
    Math.round(parsed.b * 255),
  ];
}

function rgbToCss(color: readonly [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function mixRgb(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  amount: number,
): [number, number, number] {
  const t = clamp(amount, 0, 1);
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

function initialLabelFilterState(labels: LabelSchema): LabelFilterState {
  let state = createLabelFilterState();
  for (const [key, definition] of Object.entries(labels)) {
    if (definition.hidden) {
      state = setLabelHidden(state, key, true);
    }
  }
  return state;
}

function vectorFromWorldPoint(point: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(point[0], point[1], point[2]);
}

function optionalFiniteNumber(value: string): number | null {
  if (!value.trim()) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatCompactNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : Number(value.toPrecision(6)).toString();
}

function capitalize(value: string): string {
  return value.length ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function sameGridPoint(
  left: readonly [number, number, number] | null,
  right: readonly [number, number, number] | null,
): boolean {
  return left !== null && right !== null && left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function gridToFieldSlicePixel(
  axis: SliceAxis,
  point: readonly [number, number, number],
  height: number,
): [number, number] {
  if (axis === "x") {
    return [point[2], height - 1 - point[1]];
  }
  if (axis === "y") {
    return [point[0], height - 1 - point[2]];
  }
  return [point[0], height - 1 - point[1]];
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

function gridToVxzSlicePixel(
  axis: SliceAxis,
  coords: [number, number, number],
  resolution: number,
): [number, number] {
  const [x, y, z] = coords;
  if (axis === "x") {
    return [z, resolution - 1 - y];
  }
  if (axis === "y") {
    return [x, resolution - 1 - z];
  }
  return [x, resolution - 1 - y];
}

function vxzSlicePixelToGrid(
  axis: SliceAxis,
  index: number,
  px: number,
  py: number,
  resolution: number,
): [number, number, number] {
  const inverted = resolution - 1 - py;
  if (axis === "x") {
    return [index, inverted, px];
  }
  if (axis === "y") {
    return [px, index, inverted];
  }
  return [px, inverted, index];
}

function vxzRecordColor(
  intersected: number,
  dual: [number, number, number],
  ovoxelType: number,
  qefRank: number,
  mode: VxzColorMode,
): [number, number, number] {
  if (mode === "fallback") {
    return VXZ_FALLBACK_CASES[ovoxelType]?.color ?? [100, 116, 139];
  }
  if (mode === "rank") {
    return [...vxzQefRankColor(qefRank)];
  }
  if (mode === "dual") {
    return dual;
  }
  if (mode === "edges") {
    if ((intersected & 0x07) === 0) {
      return [92, 105, 122];
    }
    return [0, 1, 2].map((axis) => {
      const present = (intersected & (1 << axis)) !== 0;
      const positive = (intersected & (1 << (axis + 3))) !== 0;
      return present ? positive ? 255 : 145 : 28;
    }) as [number, number, number];
  }
  return [22, 150, 200];
}

function vxzFallbackDescription(ovoxelType: number): string {
  return VXZ_FALLBACK_CASES[ovoxelType]?.label ?? "unavailable";
}

function vxzIntersectionDescription(intersected: number): string {
  const labels: string[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    if ((intersected & (1 << axis)) === 0) {
      continue;
    }
    const sign = (intersected & (1 << (axis + 3))) !== 0 ? "+" : "−";
    labels.push(`${["X", "Y", "Z"][axis]}${sign}`);
  }
  return labels.length ? labels.join(", ") : "none";
}

function assertBinaryMagic(view: DataView, expected: string, minimumBytes: number): void {
  if (view.byteLength < minimumBytes) {
    throw new Error(`${expected} payload is truncated`);
  }
  const actual = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (actual !== expected) {
    throw new Error(`Expected ${expected} payload, got ${actual}`);
  }
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  return text.trim() || `${response.status} ${response.statusText}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (isMesh(child) || isLineSegments(child) || isPoints(child)) {
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

function isPoints(object: THREE.Object3D): object is THREE.Points<THREE.BufferGeometry, THREE.Material | THREE.Material[]> {
  return (object as THREE.Points).isPoints === true;
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
