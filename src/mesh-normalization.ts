import * as THREE from "three";

const MIN_NORMALIZABLE_SIZE = 1e-12;

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
  object.position.add(targetCenter.sub(normalizedCenter));
  object.updateMatrixWorld(true);
  return true;
}
