import { describe, expect, it } from "vitest";
import * as CANNON from "cannon-es";
import * as THREE from "three";
import { faceNormals, physicalFaceValues, resultRotation } from "./rollPhysics";

describe("resultRotation", () => {
  it("maps the final face without changing the cube collision shape", () => {
    const orientations = [
      new CANNON.Quaternion(),
      ...Array.from({ length: 12 }, (_, i) => {
        const q = new CANNON.Quaternion();
        q.setFromEuler(i * .37, i * .71, i * .19);
        return q;
      }),
    ];
    for (const physical of orientations) for (const value of physicalFaceValues) {
      const correction = resultRotation(physical, value);
      const corrected = new THREE.Quaternion(physical.x, physical.y, physical.z, physical.w).multiply(correction);
      const normal = faceNormals[physicalFaceValues.indexOf(value)]!;
      const target = new THREE.Vector3(normal.x, normal.y, normal.z).applyQuaternion(corrected);
      const highest = Math.max(...faceNormals.map(face =>
        new THREE.Vector3(face.x, face.y, face.z).applyQuaternion(corrected).y));
      expect(target.y).toBeCloseTo(highest, 5);
      for (const axis of [new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1)]) {
        const rotated = axis.applyQuaternion(correction);
        expect(Math.max(Math.abs(rotated.x),Math.abs(rotated.y),Math.abs(rotated.z))).toBeCloseTo(1,5);
      }
    }
  });
});
