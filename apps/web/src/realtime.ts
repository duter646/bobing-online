import { io, type Socket } from "socket.io-client";
import type { ThrowProfile } from "@bobing/protocol";
import type { Ack, Room, RoomEvent, RoomSync, RollResolution } from "./types";

const endpoint=(import.meta.env.VITE_SOCKET_URL as string|undefined)??undefined;
const id=()=>globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class RealtimeRoom {
  private socket:Socket;
  constructor(private token:string,private roomId:string,private onEvent:(type:string,event:RoomEvent)=>void,private onConnection:(connected:boolean)=>void){
    this.socket=io(endpoint,{auth:{token},transports:["websocket","polling"],reconnection:true});
    this.socket.on("connect",()=>this.onConnection(true));
    this.socket.on("disconnect",()=>this.onConnection(false));
    for(const type of ["room:snapshot","room:member-joined","room:member-updated","room:settings-updated","room:state-changed","room:host-transferred","game:turn-changed","game:roll-resolved","game:champion-changed","game:finished","reaction:received","system:error"]){
      this.socket.on(type,(event:RoomEvent)=>this.onEvent(type,event));
    }
  }
  private envelope(payload:unknown,version?:number){return{protocolVersion:1 as const,commandId:id(),roomId:this.roomId,...(version===undefined?{}:{expectedRoomVersion:version}),payload}}
  async subscribe(lastSequence:number):Promise<RoomSync>{return this.emit("room:subscribe",this.envelope({lastSequence}))}
  async roll(profile:ThrowProfile,version:number):Promise<RoomEvent<RollResolution>>{return this.emit("game:roll",this.envelope({throwProfile:profile},version))}
  async settings(room:Room):Promise<RoomEvent<Room>>{return this.emit("room:update-settings",this.envelope({maxPlayers:room.maxPlayers,prizes:room.prizeConfig.map(({tier,displayName,quantity})=>({tier,displayName,quantity}))},room.version))}
  async control(type:"room:pause"|"room:resume"|"room:skip-turn"|"game:finish"|"room:leave",version:number):Promise<RoomEvent<Room>>{return this.emit(type,this.envelope({},version))}
  async transfer(memberId:string,version:number):Promise<RoomEvent<Room>>{return this.emit("room:transfer-host",this.envelope({memberId},version))}
  async react(reaction:"CHEER"|"CLAP"|"WOW"|"LUCK"|"LAUGH"):Promise<RoomEvent>{return this.emit("reaction:send",this.envelope({reaction}))}
  close(){this.socket.close()}
  private emit<T>(type:string,payload:unknown):Promise<T>{return new Promise((resolve,reject)=>{this.socket.timeout(10000).emit(type,payload,(timeout:Error|null,ack:Ack<T>)=>{if(timeout)return reject(new Error("网络响应超时，请重试"));if(!ack?.ok)return reject(new Error(ack?.error?.message??"操作失败"));resolve(ack.data)})})}
}
