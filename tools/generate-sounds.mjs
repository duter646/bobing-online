import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rate=24000,dir=join(dirname(fileURLToPath(import.meta.url)),"../apps/web/public/sounds");
mkdirSync(dir,{recursive:true});
let seed=0x5a17c0de;
const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1};
function wav(seconds,sample){
  const length=Math.ceil(seconds*rate),samples=new Float32Array(length);
  let peak=.01;
  for(let i=0;i<length;i++){samples[i]=sample(i/rate);peak=Math.max(peak,Math.abs(samples[i]))}
  const buffer=Buffer.alloc(44+length*2),gain=Math.min(1,.84/peak);
  buffer.write("RIFF",0);buffer.writeUInt32LE(36+length*2,4);buffer.write("WAVEfmt ",8);
  buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);
  buffer.writeUInt16LE(16,34);buffer.write("data",36);buffer.writeUInt32LE(length*2,40);
  for(let i=0;i<length;i++)buffer.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]*gain))*32767),44+i*2);
  return buffer;
}
function hit(t,power=1){
  if(t<0)return 0;
  const crack=noise()*Math.exp(-t*60)*.52;
  const ring=(Math.sin(t*2*Math.PI*940)*.5+Math.sin(t*2*Math.PI*1427)*.31+Math.sin(t*2*Math.PI*2114)*.19)*Math.exp(-t*25);
  return (crack+ring)*power;
}
let filtered=0;
writeFileSync(join(dir,"toss.wav"),wav(.43,t=>{
  filtered=filtered*.93+noise()*.07;
  const sweep=Math.sin(Math.min(1,t/.28)*Math.PI)*Math.exp(-t*2.5);
  return (noise()-filtered)*sweep*.12+hit(t-.055,.22)+hit(t-.15,.19)+hit(t-.235,.15);
}));
writeFileSync(join(dir,"impact.wav"),wav(.24,t=>hit(t)));
const notes=[523.25,659.25,783.99,1046.5];
writeFileSync(join(dir,"reward.wav"),wav(.96,t=>notes.reduce((sum,f,i)=>{
  const age=t-i*.115;if(age<0)return sum;
  const bell=Math.sin(2*Math.PI*f*age)+.34*Math.sin(2*Math.PI*f*2.013*age)+.12*Math.sin(2*Math.PI*f*3.92*age);
  return sum+bell*Math.exp(-age*5.5)*.23;
},0)));
