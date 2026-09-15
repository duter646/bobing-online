import type { AwardCode,ChampionRank,DiceFace,OutsideRule,PrizeTier } from "@bobing/domain";
import type { ProtocolError,ThrowProfile } from "@bobing/protocol";
export type RoomState="LOBBY"|"PLAYING"|"PAUSED"|"FINISHED"|"EXPIRED";
export interface Member{id:string;sessionId:string;displayName:string;seatNo:number;role:"HOST"|"PLAYER";status:"ACTIVE"|"LEFT";online:boolean}
export interface PrizeConfig{tier:PrizeTier;displayName:string;quantity:number}
export interface PrizePool{tier:PrizeTier;initial:number;remaining:number}
export interface Game{id:string;status:"PLAYING"|"PAUSED"|"FINISHED";currentMemberId:string;roundNo:number;turnNo:number;prizes:PrizePool[];champion?:{rollId:string;memberId:string;rank:ChampionRank};ending?:{triggeredAtTurnNo:number;finishAfterRoundNo:number}}
export interface Room{id:string;code:string;state:RoomState;version:number;sequence:number;hostMemberId:string;rulePresetId:"xiamen-traditional-v1";maxPlayers:number;outsideRule:OutsideRule;prizeConfig:PrizeConfig[];members:Member[];game?:Game;createdAt:string;reportToken?:string}
export interface RollResolution{rollId:string;memberId:string;outcome:"DICE"|"OUTSIDE";dice:DiceFace[]|null;outsideProbabilityBasisPoints:number;visualSeed:string;throwProfile:ThrowProfile;award:{primary:AwardCode;secondary:AwardCode[];normalizedDice:DiceFace[];championRank?:ChampionRank};claims:Array<{tier:PrizeTier;quantity:1}>;nextMemberId:string;gameFinished:boolean}
export interface RoomEvent<T=unknown>{protocolVersion:1;eventId:string;roomId:string;sequence:number;roomVersion:number;occurredAt:string;payload:T}
export interface StoredRoomEvent{type:string;event:RoomEvent}
export type RoomSync={mode:"snapshot";snapshot:Room}|{mode:"events";events:StoredRoomEvent[];roomVersion:number;sequence:number};
export type Ack<T>={ok:true;commandId:string;data:T}|{ok:false;commandId:string;error:ProtocolError};
export interface Session{sessionId:string;token:string;displayName:string;expiresAt:string}
export interface PlayerReport{memberId:string;displayName:string;seatNo:number;totalRolls:number;awards:Record<string,number>;prizes:Record<string,number>}
export interface Report{roomId:string;code:string;state:RoomState;createdAt:string;champion:Game["champion"]|null;prizes:PrizePool[];totalRolls:number;players:PlayerReport[]}
export interface Reaction{id:string;memberId:string;value:string}
