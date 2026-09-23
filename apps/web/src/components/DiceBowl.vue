<script setup lang="ts">
import { onBeforeUnmount,onMounted,ref,watch } from "vue";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { DiceFace } from "@bobing/domain";
import type { ThrowProfile } from "@bobing/protocol";
import { physicalFaceValues, faceNormals, resultRotation } from "./rollPhysics";

const props=defineProps<{dice:DiceFace[]|null;outcome:"DICE"|"OUTSIDE"|null;rolling:boolean;reducedMotion:boolean;grabToken:number;throwProfile:ThrowProfile|null;dragOffset:{x:number;y:number}}>();
const emit=defineEmits<{settled:[];impact:[strength:number]}>();
const root=ref<HTMLDivElement>();
let renderer:THREE.WebGLRenderer|undefined,frame=0,world:CANNON.World,observer:ResizeObserver|undefined;
let bowlVisual:THREE.Object3D|undefined,environmentMap:THREE.Texture|undefined,disposed=false;
const BOWL_SCALE=20,BOWL_Y=-.32,MODEL_BASE=`${import.meta.env.BASE_URL}models/bobing-bowl/`;
const collisionBodies:CANNON.Body[]=[];
let pendingCollisionProfile:Array<[number,number]>|null=null;
const meshes:THREE.Mesh[]=[];const bodies:CANNON.Body[]=[];const textures=new Map<number,THREE.CanvasTexture>();
let lifting=false,liftStarted=0,motionActive=false,rollStarted=0,outsideBody:CANNON.Body|null=null;
let simulationPending=false,simulationId=0,playbackFrames:Float32Array|null=null,playbackCount=0;
let playbackRotations:THREE.Quaternion[]=[];
let impactFrames:Array<{frame:number;strength:number}>=[],nextImpact=0;
let clearImpactListeners=()=>{};
let previewPoses:Array<{position:CANNON.Vec3;quaternion:CANNON.Quaternion}>=[];
let liftFrom:Array<{x:number;y:number;z:number}>=[];
function faceTexture(value:number){
  const cached=textures.get(value);if(cached)return cached;
  const canvas=document.createElement("canvas");canvas.width=128;canvas.height=128;const ctx=canvas.getContext("2d")!;
  ctx.fillStyle="#fffdf7";ctx.fillRect(0,0,128,128);ctx.fillStyle=value===4?"#b91c1c":"#282220";
  const spots:Record<number,Array<[number,number]>>={1:[[64,64]],2:[[34,34],[94,94]],3:[[34,34],[64,64],[94,94]],4:[[34,34],[94,34],[34,94],[94,94]],5:[[34,34],[94,34],[64,64],[34,94],[94,94]],6:[[34,28],[34,64],[34,100],[94,28],[94,64],[94,100]]};
  for(const [x,y] of spots[value]??[]){ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill()}
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;textures.set(value,texture);return texture;
}
function targetOrientation(body:CANNON.Body,value:DiceFace){
  const current=new THREE.Quaternion(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w);
  const normal=faceNormals[physicalFaceValues.indexOf(value)]!;
  const worldNormal=new THREE.Vector3(normal.x,normal.y,normal.z).applyQuaternion(current).normalize();
  return new THREE.Quaternion().setFromUnitVectors(worldNormal,new THREE.Vector3(0,1,0)).multiply(current).normalize();
}
function recordFrame(frames:number[]){
  for(const body of bodies)frames.push(body.position.x,body.position.y,body.position.z,body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w);
}
function beginSimulation(){
  const id=++simulationId,frames:number[]=[];
  let steps=0,stableSteps=0;
  impactFrames=[];nextImpact=0;clearImpactListeners();
  const lastImpactStep=Array(6).fill(-30) as number[];
  const listeners=bodies.map((body,i)=>{
    const listener=(event:{contact?:{getImpactVelocityAlongNormal:()=>number}})=>{
      const speed=Math.abs(event.contact?.getImpactVelocityAlongNormal()??0);
      if(speed<4||steps-lastImpactStep[i]!<8)return;
      lastImpactStep[i]=steps;
      impactFrames.push({frame:Math.floor(steps/2)+1,strength:Math.min(1.5,speed/8)});
    };
    body.addEventListener("collide",listener);
    return {body,listener};
  });
  const cleanup=()=>{for(const {body,listener} of listeners)body.removeEventListener("collide",listener)};
  clearImpactListeners=cleanup;
  previewPoses=bodies.map(body=>({position:body.position.clone(),quaternion:body.quaternion.clone()}));
  simulationPending=true;recordFrame(frames);
  const chunk=()=>{
    if(disposed||id!==simulationId){cleanup();return}
    for(let batch=0;batch<48&&steps<840;batch++,steps++){
      world.step(1/120);
      containNormalDice();
      if(steps>250){
        const t=Math.min(1,(steps-250)/450);
        for(const body of bodies){body.linearDamping=.055+t*.24;body.angularDamping=.045+t*.26}
      }
      if(steps%2===1)recordFrame(frames);
      const stable=steps>210&&bodies.every(body=>body.velocity.lengthSquared()<.035&&body.angularVelocity.lengthSquared()<.1&&body.position.y<(body===outsideBody?.55:2.4));
      stableSteps=stable?stableSteps+1:0;
      if(stableSteps>=30)break;
    }
    if(steps<840&&stableSteps<30){setTimeout(chunk,0);return}
    cleanup();recordFrame(frames);
    playbackFrames=new Float32Array(frames);playbackCount=frames.length/42;
    playbackRotations=bodies.map((body,i)=>props.dice?.[i]?resultRotation(body.quaternion,props.dice[i]!):new THREE.Quaternion());
    simulationPending=false;rollStarted=performance.now();
  };
  setTimeout(chunk,0);
}
function playTrajectory(now:number){
  if(!playbackFrames)return;
  const cursor=Math.min(playbackCount-1,Math.max(0,(now-rollStarted)*.06));
  while(nextImpact<impactFrames.length&&impactFrames[nextImpact]!.frame<=cursor){emit("impact",impactFrames[nextImpact]!.strength);nextImpact++}
  const first=Math.floor(cursor),last=Math.min(first+1,playbackCount-1),blend=cursor-first;
  for(let i=0;i<bodies.length;i++){
    const a=(first*6+i)*7,b=(last*6+i)*7,frames=playbackFrames,body=bodies[i]!;
    body.position.set(
      frames[a]!+(frames[b]!-frames[a]!)*blend,
      frames[a+1]!+(frames[b+1]!-frames[a+1]!)*blend,
      frames[a+2]!+(frames[b+2]!-frames[a+2]!)*blend
    );
    const q=new THREE.Quaternion(frames[a+3],frames[a+4],frames[a+5],frames[a+6]);
    q.slerp(new THREE.Quaternion(frames[b+3],frames[b+4],frames[b+5],frames[b+6]),blend);
    q.multiply(playbackRotations[i]!);
    body.quaternion.set(q.x,q.y,q.z,q.w);
  }
  if(cursor>=playbackCount-1)completeRoll();
}
function containNormalDice(){
  if(!motionActive||lifting)return;
  const centerLimit=3.18;
  for(const body of bodies){if(body===outsideBody)continue;const radius=Math.hypot(body.position.x,body.position.z);if(radius<=centerLimit)continue;const nx=body.position.x/radius,nz=body.position.z/radius;body.position.x=nx*centerLimit;body.position.z=nz*centerLimit;const outward=body.velocity.x*nx+body.velocity.z*nz;if(outward>0){body.velocity.x-=outward*1.65*nx;body.velocity.z-=outward*1.65*nz}body.wakeUp()}
}
function completeRoll(){
  if(!motionActive)return;
  motionActive=false;lifting=false;simulationPending=false;playbackFrames=null;
  for(const body of bodies){
    body.velocity.setZero();body.angularVelocity.setZero();
    body.type=CANNON.Body.STATIC;body.updateMassProperties();
  }
  if(pendingCollisionProfile){replaceBowlCollision(pendingCollisionProfile);pendingCollisionProfile=null}
  emit("settled");
}
function grab(){
  simulationId++;clearImpactListeners();simulationPending=false;playbackFrames=null;motionActive=false;outsideBody=null;lifting=true;liftStarted=performance.now();
  liftFrom=bodies.map(body=>({x:body.position.x,y:body.position.y,z:body.position.z}));
  bodies.forEach(body=>{body.type=CANNON.Body.KINEMATIC;body.updateMassProperties();body.velocity.setZero();body.angularVelocity.setZero()});
}
function toss(){
  simulationId++;clearImpactListeners();lifting=false;motionActive=true;outsideBody=null;playbackFrames=null;
  const profile=props.throwProfile??{start:{x:0,y:0},direction:{x:0,y:-1},strength:.45,holdDurationMs:300};
  const length=Math.hypot(profile.direction.x,profile.direction.y);const direction=length>.15?{x:profile.direction.x/length,y:profile.direction.y/length}:{x:0,y:-1};
  const speed=1.4+profile.strength*4.8;
  bodies.forEach((body,i)=>{
    const jumped=props.outcome==="OUTSIDE"&&i===0;if(jumped)outsideBody=body;
    body.type=CANNON.Body.DYNAMIC;body.collisionFilterMask=jumped?7:6;body.angularFactor.set(1,1,1);body.mass=1;body.linearDamping=.055;body.angularDamping=.045;body.updateMassProperties();body.wakeUp();
    body.position.set((i%3-1)*.82+props.dragOffset.x*.42,3.1+Math.floor(i/3)*.12,(Math.floor(i/3)-.5)*.84+props.dragOffset.y*.3);
    if(jumped){body.position.x-=direction.x*.45;body.position.z-=direction.y*.45;body.velocity.set(direction.x*8.6,7,direction.y*8.6);body.angularVelocity.set(18,15,17)}
    else{const insideIndex=props.outcome==="OUTSIDE"?i-1:i,insideCount=props.outcome==="OUTSIDE"?5:6,angle=Math.atan2(direction.y,direction.x)+(insideIndex-(insideCount-1)/2)*.62,dx=Math.cos(angle),dz=Math.sin(angle),dieSpeed=speed*(.88+(i%3)*.06);body.velocity.set(dx*dieSpeed,-1.2,dz*dieSpeed);body.angularVelocity.set(8+profile.strength*12+i*.45,9-dx*2.4,8-dz*2.4)}
  });
  if(props.reducedMotion){
    bodies.forEach((body,i)=>{const value=props.dice?.[i];if(value){const target=targetOrientation(body,value);body.quaternion.set(target.x,target.y,target.z,target.w)}});
    let insideIndex=0;
    bodies.forEach(body=>{
      if(body===outsideBody)body.position.set(direction.x*4.25,.03,direction.y*4.25);
      else{const insideCount=props.outcome==="OUTSIDE"?5:6,angle=insideIndex*Math.PI*2/insideCount+.25,radius=1.55;body.position.set(Math.cos(angle)*radius,.6,Math.sin(angle)*radius);insideIndex++}
    });
    completeRoll();
    return;
  }
  beginSimulation();
}
function initialLayout(){
  bodies.forEach((body,i)=>{const angle=i*Math.PI/3+.25,radius=1.55;body.position.set(Math.cos(angle)*radius,.6,Math.sin(angle)*radius);body.quaternion.setFromEuler(0,angle,0);body.type=CANNON.Body.STATIC;body.updateMassProperties()});
}
const fallbackCollisionProfile:Array<[number,number]>=[[.9,.17],[1.45,.22],[1.9,.33],[2.3,.55],[2.65,.87],[2.95,1.27],[3.22,1.77],[3.42,2.14]];
function innerProfileFromModel(model:THREE.Object3D):Array<[number,number]>{
  const rings=new Map<number,{radius:number;height:number;count:number}>();
  model.updateMatrixWorld(true);
  model.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return;
    const positions=object.geometry.getAttribute("position"),normals=object.geometry.getAttribute("normal");
    if(!positions||!normals)return;
    for(let i=0;i<positions.count;i++){
      const point=new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld);
      const normal=new THREE.Vector3().fromBufferAttribute(normals,i).transformDirection(object.matrixWorld);
      const radius=Math.hypot(point.x,point.z)*BOWL_SCALE;
      const radialNormal=radius>.01?(normal.x*point.x+normal.z*point.z)/Math.hypot(point.x,point.z):0;
      if(radius<.9||radius>3.44||normal.y<.08||radialNormal>.12)continue;
      const key=Math.round(radius*100),ring=rings.get(key)??{radius:0,height:0,count:0};
      ring.radius+=radius;ring.height+=point.y*BOWL_SCALE+BOWL_Y;ring.count++;rings.set(key,ring);
    }
  });
  const profile=[...rings.values()].map(ring=>[ring.radius/ring.count,ring.height/ring.count] as [number,number]).sort((a,b)=>a[0]-b[0]);
  if(profile.length<5)throw new Error("Collision GLB has no usable inner wall profile");
  return [[.9,.17] as [number,number],...profile];
}
function replaceBowlCollision(profile:Array<[number,number]>,material?:CANNON.Material){
  const bowlMaterial=material??collisionBodies[0]?.material;
  if(!bowlMaterial)return;
  for(const body of collisionBodies)world.removeBody(body);
  collisionBodies.length=0;
  const segments=32,halfThickness=.075;
  for(let band=0;band<profile.length-1;band++){
    const [innerRadius,innerY]=profile[band]!,[outerRadius,outerY]=profile[band+1]!;
    const radialLength=outerRadius-innerRadius;
    if(radialLength<.025)continue;
    const slope=Math.atan2(outerY-innerY,radialLength),midRadius=(innerRadius+outerRadius)/2;
    const halfTangent=outerRadius*Math.tan(Math.PI/segments)*1.08;
    const shape=new CANNON.Box(new CANNON.Vec3(Math.hypot(radialLength,outerY-innerY)/2+.025,halfThickness,halfTangent));
    for(let i=0;i<segments;i++){
      const angle=i*Math.PI*2/segments,yaw=new CANNON.Quaternion(),tilt=new CANNON.Quaternion(),rotation=new CANNON.Quaternion();
      yaw.setFromAxisAngle(new CANNON.Vec3(0,1,0),-angle);
      tilt.setFromAxisAngle(new CANNON.Vec3(0,0,1),slope);
      yaw.mult(tilt,rotation);
      const centerRadius=midRadius+Math.sin(slope)*halfThickness,centerY=(innerY+outerY)/2-Math.cos(slope)*halfThickness;
      const strip=new CANNON.Body({mass:0,material:bowlMaterial,shape,collisionFilterGroup:2,collisionFilterMask:4});
      strip.position.set(Math.cos(angle)*centerRadius,centerY,Math.sin(angle)*centerRadius);
      strip.quaternion.copy(rotation);world.addBody(strip);collisionBodies.push(strip);
    }
  }
  const wallSegments=48,wallRadius=3.52,wallShape=new CANNON.Box(new CANNON.Vec3(.16,1.14,.25));
  for(let i=0;i<wallSegments;i++){
    const angle=i*Math.PI*2/wallSegments;
    const wall=new CANNON.Body({mass:0,material:bowlMaterial,shape:wallShape,collisionFilterGroup:2,collisionFilterMask:4});
    wall.position.set(Math.cos(angle)*wallRadius,1.14,Math.sin(angle)*wallRadius);
    wall.quaternion.setFromEuler(0,-angle,0);
    world.addBody(wall);collisionBodies.push(wall);
  }
}
function loadBowlModels(scene:THREE.Scene,fallback:THREE.Object3D,rim:THREE.Object3D){
  const loader=new GLTFLoader();
  void loader.loadAsync(`${MODEL_BASE}bowl-visual.glb`).then(gltf=>{
    if(disposed)return;
    bowlVisual=gltf.scene;bowlVisual.scale.setScalar(BOWL_SCALE);bowlVisual.position.y=BOWL_Y;
    bowlVisual.traverse(object=>{if(object instanceof THREE.Mesh){object.castShadow=true;object.receiveShadow=true}});
    scene.add(bowlVisual);scene.remove(fallback,rim);
  }).catch(error=>console.error("Bowl visual GLB failed to load",error));
  void loader.loadAsync(`${MODEL_BASE}bowl-collision.glb`).then(gltf=>{
    if(disposed)return;
    const profile=innerProfileFromModel(gltf.scene);
    if(motionActive)pendingCollisionProfile=profile;
    else replaceBowlCollision(profile);
  }).catch(error=>console.error("Bowl collision GLB failed to load; using matching fallback collision",error));
}
onMounted(()=>{
  const scene=new THREE.Scene();scene.background=new THREE.Color("#511519");
  const camera=new THREE.PerspectiveCamera(37,1,.1,100);camera.position.set(0,9.5,8.5);camera.lookAt(0,.85,0);
  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});renderer.setPixelRatio(Math.min(devicePixelRatio,1.45));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.78;root.value!.appendChild(renderer.domElement);
  const pmrem=new THREE.PMREMGenerator(renderer);environmentMap=pmrem.fromScene(new RoomEnvironment(),.04).texture;scene.environment=environmentMap;scene.environmentIntensity=.65;pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xfff3dc,0x260609,1.55));const light=new THREE.DirectionalLight(0xffdfb1,2.25);light.position.set(-4,8,5);light.castShadow=true;light.shadow.mapSize.set(1024,1024);scene.add(light);
  const table=new THREE.Mesh(new THREE.CylinderGeometry(5.5,5.5,.32,64),new THREE.MeshStandardMaterial({color:0x71191e,roughness:.72}));table.position.y=-.48;table.receiveShadow=true;scene.add(table);
  const profile=[[0,.16],[1.16,.18],[2.36,.6],[3.42,2.14],[3.6,2.28],[3.55,2.0],[2.66,.46],[1.48,-.14],[1.34,-.32],[0,-.12]].map(([x,y])=>new THREE.Vector2(x!,y!));
  const bowlMesh=new THREE.Mesh(new THREE.LatheGeometry(profile,96),new THREE.MeshPhysicalMaterial({color:0x9b2026,roughness:.2,metalness:.02,clearcoat:.8,clearcoatRoughness:.16,side:THREE.DoubleSide}));bowlMesh.receiveShadow=true;bowlMesh.castShadow=true;scene.add(bowlMesh);
  const rim=new THREE.Mesh(new THREE.TorusGeometry(3.58,.1,16,96),new THREE.MeshPhysicalMaterial({color:0xd95a4f,roughness:.18,clearcoat:1}));rim.rotation.x=Math.PI/2;rim.position.y=2.28;scene.add(rim);
  loadBowlModels(scene,bowlMesh,rim);
  world=new CANNON.World({gravity:new CANNON.Vec3(0,-26,0),allowSleep:true});(world.solver as CANNON.GSSolver).iterations=24;world.addEventListener("postStep",containNormalDice);
  const diceMaterial=new CANNON.Material("dice"),bowlMaterial=new CANNON.Material("bowl");
  world.addContactMaterial(new CANNON.ContactMaterial(diceMaterial,diceMaterial,{friction:.42,restitution:.55,contactEquationStiffness:1e8,contactEquationRelaxation:3}));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMaterial,bowlMaterial,{friction:.55,restitution:.62,contactEquationStiffness:1e8,contactEquationRelaxation:3}));
  const ground=new CANNON.Body({mass:0,material:bowlMaterial,shape:new CANNON.Plane(),collisionFilterGroup:1,collisionFilterMask:4});ground.quaternion.setFromEuler(-Math.PI/2,0,0);ground.position.y=-.32;world.addBody(ground);
  const bowlFloor=new CANNON.Body({mass:0,material:bowlMaterial,shape:new CANNON.Box(new CANNON.Vec3(1.1,.05,1.1)),collisionFilterGroup:2,collisionFilterMask:4});bowlFloor.position.y=.11;world.addBody(bowlFloor);replaceBowlCollision(fallbackCollisionProfile,bowlMaterial);
  const geometry=new THREE.BoxGeometry(.68,.68,.68,2,2,2);for(let i=0;i<6;i++){const materials=physicalFaceValues.map(n=>new THREE.MeshStandardMaterial({map:faceTexture(n),roughness:.24}));const mesh=new THREE.Mesh(geometry,materials);mesh.castShadow=true;mesh.receiveShadow=true;scene.add(mesh);meshes.push(mesh);const body=new CANNON.Body({mass:1,material:diceMaterial,shape:new CANNON.Box(new CANNON.Vec3(.34,.34,.34)),linearDamping:.055,angularDamping:.045,allowSleep:true,sleepSpeedLimit:.18,sleepTimeLimit:.45,collisionFilterGroup:4,collisionFilterMask:7});world.addBody(body);bodies.push(body)}
  const resize=()=>{const w=root.value!.clientWidth,h=root.value!.clientHeight;renderer!.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()};observer=new ResizeObserver(resize);observer.observe(root.value!);resize();let last=performance.now();
  const loop=(now:number)=>{
    frame=requestAnimationFrame(loop);
    if(lifting){const t=Math.min(1,(now-liftStarted)/180),ease=1-(1-t)**3;bodies.forEach((body,i)=>{const from=liftFrom[i]!;const tx=(i%3-1)*.82+props.dragOffset.x*.42,tz=(Math.floor(i/3)-.5)*.84+props.dragOffset.y*.3;body.position.set(from.x+(tx-from.x)*ease,from.y+(3.1+Math.floor(i/3)*.12-from.y)*ease,from.z+(tz-from.z)*ease)})}
    if(motionActive&&!simulationPending&&playbackFrames)playTrajectory(now);
    bodies.forEach((body,i)=>{
      const pose=simulationPending?previewPoses[i]:body;
      meshes[i]!.position.set(pose!.position.x,pose!.position.y,pose!.position.z);
      meshes[i]!.quaternion.set(pose!.quaternion.x,pose!.quaternion.y,pose!.quaternion.z,pose!.quaternion.w);
    });
    last=now;
    renderer!.render(scene,camera);
  };
  loop(last);initialLayout();
});
watch(()=>props.grabToken,()=>grab());
watch(()=>props.rolling,(value,old)=>{if(value&&!old)toss()});
onBeforeUnmount(()=>{disposed=true;simulationId++;clearImpactListeners();cancelAnimationFrame(frame);observer?.disconnect();textures.forEach(texture=>texture.dispose());environmentMap?.dispose();bowlVisual?.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(material=>material.dispose())}});renderer?.dispose()});
</script>
<template><div ref="root" class="dice-bowl" role="img" :aria-label="dice ? `骰子结果：${dice.join('、')}` : '等待投掷'"></div></template>
