import type { Report,Room,Session } from "./types";
const base=(import.meta.env.VITE_API_BASE as string|undefined)??"";
async function request<T>(path:string,init:RequestInit={},token?:string):Promise<T>{const response=await fetch(`${base}${path}`,{...init,headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{}),...init.headers}});const body=await response.json().catch(()=>({})) as {error?:{message?:string}};if(!response.ok)throw new Error(body.error?.message??"请求失败，请稍后重试");return body as T}
export async function createSession(displayName:string):Promise<Session>{const data=await request<Omit<Session,"displayName">>("/api/sessions",{method:"POST",body:JSON.stringify({displayName})});return{...data,displayName}}
export const createRoom=(token:string,maxPlayers:number)=>request<Room>("/api/rooms",{method:"POST",body:JSON.stringify({maxPlayers})},token);
export const joinRoom=(token:string,code:string)=>request<Room>("/api/rooms/join",{method:"POST",body:JSON.stringify({code})},token);
export const getRoom=(token:string,id:string)=>request<Room>(`/api/rooms/${id}`,{},token);
export const startRoom=(token:string,room:Room)=>request<Room>(`/api/rooms/${room.id}/start`,{method:"POST",body:JSON.stringify({expectedRoomVersion:room.version})},token);
export const getReport=(token:string,id:string)=>request<Report>(`/api/rooms/${id}/report`,{},token);
