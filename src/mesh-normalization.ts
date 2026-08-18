import * as THREE from "three";

const MIN_NORMALIZABLE_SIZE = 1e-12;

export function normalizeObjectToPreferredBounds(
  object: THREE.Object3D,
  preferredBounds: THREE.Box3 | null,
  fallbackBounds: THREE.Box3 | null,
): boolean {
  const targetBounds = preferredBounds && !preferredBounds.isEmpty()
    ? preferredBounds
    : fallbackBounds;
  return targetBounds ? normalizeObjectToBounds(object, targetBounds) : false;
}

export function normalizeObjectToBounds(
  object: THREE.Object3D,
  targetBounds: THREE.Box3,
): boolean {
  const sourceBounds = new THREE.Box3().setFromObject(object);
  if (sourceBounds.isEmpty() || targetBounds.isEmpty()) {
    return false;
  }

  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  const targetSize = targetBounds.getSize(new THREE.Vector3());
  const sourceLongestEdge = Math.max(sourceSize.x, sourceSize.y, sourceSize.z);
  const targetLongestEdge = Math.max(targetSize.x, targetSize.y, targetSize.z);
  if (
    !Number.isFinite(sourceLongestEdge)
    || !Number.isFinite(targetLongestEdge)
    || sourceLongestEdge <= MIN_NORMALIZABLE_SIZE
    || targetLongestEdge <= MIN_NORMALIZABLE_SIZE
  ) {
    return false;
  }

  object.scale.multiplyScalar(targetLongestEdge / sourceLongestEdge);
  object.updateMatrixWorld(true);

  const normalizedCenter = new THREE.Box3()
    .setFromObject(object)
    .getCenter(new THREE.Vector3());
  const targetCenter = targetBounds.getCenter(new THREE.Vector3());
  if (object.parent) {
    object.parent.updateWorldMatrix(true, false);
    const localTargetCenter = object.parent.worldToLocal(targetCenter);
    const localNormalizedCenter = object.parent.worldToLocal(normalizedCenter);
    object.position.add(localTargetCenter.sub(localNormalizedCenter));
  } else {
    object.position.add(targetCenter.sub(normalizedCenter));
  }
  object.updateMatrixWorld(true);
  return true;
}
