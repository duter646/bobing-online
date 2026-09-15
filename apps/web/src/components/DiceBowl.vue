<script setup lang="ts">
import { onBeforeUnmount,onMounted,ref,watch } from "vue";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import type { DiceFace } from "@bobing/domain";

const props=defineProps<{dice:DiceFace[]|null;rolling:boolean;reducedMotion:boolean}>();
const root=ref<HTMLDivElement>();let renderer:THREE.WebGLRenderer|undefined;let frame=0;let world:CANNON.World;let meshes:THREE.Mesh[]=[];let bodies:CANNON.Body[]=[];let stopTimer=0;

function faceTexture(value:number){
  const canvas=document.createElement("canvas");canvas.width=128;canvas.height=128;const ctx=canvas.getContext("2d")!;
  ctx.fillStyle="#fffaf0";ctx.fillRect(0,0,128,128);ctx.fillStyle=value===4?"#b91c1c":"#25211f";
  const spots:Record<number,Array<[number,number]>>={1:[[64,64]],2:[[34,34],[94,94]],3:[[34,34],[64,64],[94,94]],4:[[34,34],[94,34],[34,94],[94,94]],5:[[34,34],[94,34],[64,64],[34,94],[94,94]],6:[[34,28],[34,64],[34,100],[94,28],[94,64],[94,100]]};
  for(const [x,y] of spots[value]??[]){ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill()}
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
function settle(){
  const values=props.dice??[1,2,3,4,5,6];bodies.forEach((body,i)=>{body.velocity.setZero();body.angularVelocity.setZero();body.position.set((i%3-1)*1.05,0.48,(Math.floor(i/3)-.5)*1.05);body.quaternion.setFromEuler(0,0,0)});
  meshes.forEach((mesh,i)=>{const mat=mesh.material as THREE.MeshStandardMaterial[];mat[2]!.map=faceTexture(values[i]??1);mat[2]!.needsUpdate=true});
}
function toss(){
  if(props.reducedMotion){settle();return}clearTimeout(stopTimer);bodies.forEach((body,i)=>{body.position.set((i%3-1)*.42,2.7+i*.08,(Math.floor(i/3)-.5)*.45);body.velocity.set((Math.random()-.5)*4,-1,(Math.random()-.5)*4);body.angularVelocity.set(Math.random()*11,Math.random()*11,Math.random()*11)});
  stopTimer=window.setTimeout(settle,1700);
}
onMounted(()=>{
  const scene=new THREE.Scene();scene.background=new THREE.Color("#511519");
  const camera=new THREE.PerspectiveCamera(38,1,.1,100);camera.position.set(0,7.8,7.2);camera.lookAt(0,0,0);
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));renderer.shadowMap.enabled=true;root.value!.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xfff3d6,0x3d090c,2.2));const light=new THREE.DirectionalLight(0xffe6b0,3);light.position.set(-3,7,4);light.castShadow=true;scene.add(light);
  const table=new THREE.Mesh(new THREE.CylinderGeometry(5.5,5.5,.32,64),new THREE.MeshStandardMaterial({color:0x771d22,roughness:.78}));table.position.y=-.28;table.receiveShadow=true;scene.add(table);
  const bowl=new THREE.Mesh(new THREE.CylinderGeometry(3.55,3.0,.55,64,1,true),new THREE.MeshStandardMaterial({color:0xf1d29c,roughness:.28,side:THREE.DoubleSide}));bowl.position.y=.05;bowl.receiveShadow=true;scene.add(bowl);
  world=new CANNON.World({gravity:new CANNON.Vec3(0,-18,0)});const ground=new CANNON.Body({mass:0,shape:new CANNON.Plane()});ground.quaternion.setFromEuler(-Math.PI/2,0,0);world.addBody(ground);
  const geo=new THREE.BoxGeometry(.82,.82,.82);for(let i=0;i<6;i++){const materials=[1,6,2,5,3,4].map(n=>new THREE.MeshStandardMaterial({map:faceTexture(n),roughness:.3}));const mesh=new THREE.Mesh(geo,materials);mesh.castShadow=true;scene.add(mesh);meshes.push(mesh);const body=new CANNON.Body({mass:1,shape:new CANNON.Box(new CANNON.Vec3(.41,.41,.41)),linearDamping:.18,angularDamping:.2});world.addBody(body);bodies.push(body)}
  const resize=()=>{const w=root.value!.clientWidth,h=root.value!.clientHeight;renderer!.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()};new ResizeObserver(resize).observe(root.value!);resize();let last=performance.now();
  const loop=(now:number)=>{frame=requestAnimationFrame(loop);world.step(1/60,Math.min((now-last)/1000,.05),2);last=now;bodies.forEach((b,i)=>{meshes[i]!.position.copy(b.position as unknown as THREE.Vector3);meshes[i]!.quaternion.copy(b.quaternion as unknown as THREE.Quaternion)});renderer!.render(scene,camera)};loop(last);settle();
});
watch(()=>props.rolling,v=>{if(v)toss()});
watch(()=>props.dice,()=>{if(!props.rolling)settle()},{deep:true});
onBeforeUnmount(()=>{cancelAnimationFrame(frame);clearTimeout(stopTimer);renderer?.dispose()});
</script>
<template><div ref="root" class="dice-bowl" role="img" :aria-label="dice ? `骰子结果：${dice.join('、')}` : '等待投掷'"></div></template>
