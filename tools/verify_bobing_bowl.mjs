// Inspect the exported files with the same Three.js loader used by the web app.
// Node has no browser image decoder: validate embedded PNGs separately with Pillow.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as THREE from '../apps/web/node_modules/three/build/three.module.js';
import { GLTFLoader } from '../apps/web/node_modules/three/examples/jsm/loaders/GLTFLoader.js';

globalThis.self = globalThis;
globalThis.createImageBitmap = async (blob) => {
  const bytes = new DataView(await blob.arrayBuffer());
  assert.equal(bytes.getUint32(0), 0x89504e47);
  return { width: bytes.getUint32(16), height: bytes.getUint32(20), close() {} };
};
const directory = new URL('../apps/web/public/models/bobing-bowl/', import.meta.url);
const results = [];
for (const kind of ['visual', 'collision']) {
  const bytes = readFileSync(new URL(`bowl-${kind}.glb`, directory));
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  let triangles = 0;
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    triangles += object.geometry.index.count / 3;
    assert.equal(object.material.side, THREE.FrontSide);
    if (kind === 'visual') {
      assert.equal(object.material.map.image.width, 2048);
      assert.equal(object.material.metalnessMap.image.width, 2048);
      assert.equal(object.material.clearcoat, .85);
    }
  });
  assert.equal(triangles, kind === 'visual' ? 27264 : 2496);
  const samples = [];
  for (const radius of [0, .025, .055, .09, .12, .145, .165]) {
    const hits = new THREE.Raycaster(new THREE.Vector3(radius,.3,0), new THREE.Vector3(0,-1,0)).intersectObject(gltf.scene,true);
    assert.ok(hits.length, `Hole at ${radius}`);
    assert.ok(hits[0].point.y >= .023 && hits[0].point.y < .125, 'Cavity capped or floor missing');
    samples.push({ radius, height: hits[0].point.y });
  }
  results.push({ kind, triangles, loader: 'Three.js GLTFLoader', cavityRaycasts: samples, embeddedTextureHeadersChecked: kind === 'visual' });
}
writeFileSync(fileURLToPath(new URL('loader-check.json', directory)), JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
