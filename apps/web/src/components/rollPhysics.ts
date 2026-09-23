import * as CANNON from "cannon-es";
import * as THREE from "three";
import type { DiceFace } from "@bobing/domain";

export const physicalFaceValues = [1, 6, 2, 5, 3, 4] as const;
export const faceNormals = [
  new CANNON.Vec3(1, 0, 0), new CANNON.Vec3(-1, 0, 0),
  new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(0, -1, 0),
  new CANNON.Vec3(0, 0, 1), new CANNON.Vec3(0, 0, -1),
];

export function topFaceIndex(quaternion: CANNON.Quaternion): number {
  let best = -Infinity, index = 0;
  faceNormals.forEach((normal, i) => {
    const y = quaternion.vmult(normal).y;
    if (y > best) { best = y; index = i; }
  });
  return index;
}

// A cube symmetry changes which printed face lands up without changing its collision geometry.
export function resultRotation(quaternion: CANNON.Quaternion, value: DiceFace): THREE.Quaternion {
  const desired = faceNormals[physicalFaceValues.indexOf(value)]!;
  const landed = faceNormals[topFaceIndex(quaternion)]!;
  return new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(desired.x, desired.y, desired.z),
    new THREE.Vector3(landed.x, landed.y, landed.z),
  );
}
