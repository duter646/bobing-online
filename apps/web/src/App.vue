<script setup lang="ts">
import { computed,defineAsyncComponent,nextTick,onBeforeUnmount,onMounted,reactive,ref,watch } from "vue";
import type { PrizeTier } from "@bobing/domain";
import type { ThrowProfile } from "@bobing/protocol";
const DiceBowl=defineAsyncComponent(()=>import("./components/DiceBowl.vue"));
import { createRoom as createRoomApi,createSession,getReport,getRoom,getStats,joinRoom as joinRoomApi,login,logout,register,startRoom as startRoomApi,updateSessionName } from "./api";
import { RealtimeRoom } from "./realtime";
import { GameAudio } from "./gameAudio";
import type { Member,Reaction,Report,Room,RoomEvent,Session,RollResolution,UserStats } from "./types";

const SESSION_KEY="bobing.session.v1",LAST_ROOM_KEY="bobing.lastRoom.v1";
const awardNames:Record<string,string>={OUTSIDE:"跳猴了",NOTHING:"未中奖",ONE_SHOW:"一秀",TWO_RAISES:"二举",FOUR_ADVANCES:"四进",THREE_REDS:"三红",STRAIGHT:"对堂",CHAMPION:"状元",FIVE_OF_KIND:"五子登科",FIVE_REDS:"五红",SIX_BLACK:"六勃黑",SIX_RED:"六勃红",CHAMPION_WITH_GOLDEN_FLOWERS:"状元插金花"};
const reactionOptions=[["CHEER","好彩头！","🎉"],["CLAP","鼓掌","👏"],["WOW","厉害","🤩"],["LUCK","接好运","🍀"],["LAUGH","哈哈","😄"]] as const;
const prizeOrder:PrizeTier[]=["CHAMPION","STRAIGHT","THREE_REDS","FOUR_ADVANCES","TWO_RAISES","ONE_SHOW"];
const tierNames:Record<PrizeTier,string>={CHAMPION:"状元",STRAIGHT:"对堂",THREE_REDS:"三红",FOUR_ADVANCES:"四进",TWO_RAISES:"二举",ONE_SHOW:"一秀"};

const saved=localStorage.getItem(SESSION_KEY);const session=ref<Session|null>(saved?JSON.parse(saved):null);
const room=ref<Room|null>(null),report=ref<Report|null>(null),latest=ref<RollResolution|null>(null);
const throwProfile=ref<ThrowProfile|null>(null),grabToken=ref(0),entryAttempted=ref(false);
const connected=ref(false),syncing=ref(false),busy=ref(false),rolling=ref(false),settingsOpen=ref(false),reportOpen=ref(false),menuOpen=ref(false);
const authOpen=ref(false),authMode=ref<"login"|"register">("login"),statsOpen=ref(false),stats=ref<UserStats|null>(null);
const authEmail=ref(""),authPassword=ref(""),authName=ref(""),authError=ref(""),expandedMemberId=ref<string|null>(null);
const reducedMotion=ref(localStorage.getItem("bobing.reducedMotion")==="1"),sound=ref(localStorage.getItem("bobing.sound")!=="0");
const gameAudio=new GameAudio(import.meta.env.BASE_URL);gameAudio.setEnabled(sound.value);
const displayName=ref(session.value?.account?.displayName??session.value?.displayName??""),roomCode=ref(new URLSearchParams(location.search).get("code")??""),maxPlayers=ref(8);
const message=ref(""),messageTone=ref<"error"|"success"|"info">("info"),reactions=ref<Reaction[]>([]);
const settingsDraft=reactive<{maxPlayers:number;prizes:Room["prizeConfig"]}>({maxPlayers:8,prizes:[]});
let realtime:RealtimeRoom|null=null,noticeTimer=0,refreshTimer=0,pollTimer=0;
let playedRollId="",rollFallbackTimer=0;
const drag=reactive({active:false,startX:0,startY:0,x:0,y:0,time:0,lastX:0,lastY:0,lastTime:0,velocityX:0,velocityY:0});

const activeMembers=computed(()=>room.value?.members.filter(m=>m.status==="ACTIVE").sort((a,b)=>a.seatNo-b.seatNo)??[]);
const me=computed(()=>activeMembers.value.find(m=>m.displayName===session.value?.displayName));
const isHost=computed(()=>me.value?.id===room.value?.hostMemberId);
const current=computed(()=>activeMembers.value.find(m=>m.id===room.value?.game?.currentMemberId));
const myTurn=computed(()=>room.value?.state==="PLAYING"&&current.value?.id===me.value?.id);
const champion=computed(()=>activeMembers.value.find(m=>m.id===room.value?.game?.champion?.memberId));
const stateLabel=computed(()=>({LOBBY:"等待中",PLAYING:"进行中",PAUSED:"已暂停",FINISHED:"已结束",EXPIRED:"已过期"}[room.value?.state??"LOBBY"]));
const throwStrength=computed(()=>Math.min(1,Math.hypot(drag.velocityX,drag.velocityY)/1.35));
const dragOffset=computed(()=>({x:Math.max(-1,Math.min(1,(drag.x-drag.startX)/180)),y:Math.max(-1,Math.min(1,(drag.y-drag.startY)/180))}));
const activeCount=computed(()=>activeMembers.value.length);

function notify(text:string,tone:"error"|"success"|"info"="info"){message.value=text;messageTone.value=tone;clearTimeout(noticeTimer);noticeTimer=window.setTimeout(()=>message.value="",3200)}
function err(error:unknown){notify(error instanceof Error?error.message:"操作失败","error")}
function persistSession(next:Session){session.value=next;localStorage.setItem(SESSION_KEY,JSON.stringify(next))}
async function ensureSession(){const name=displayName.value.trim();if(!name)throw new Error("请先输入昵称");if(name.length>24)throw new Error("昵称最多 24 个字符");if(!session.value){persistSession(await createSession(name))}else if(session.value.displayName!==name){await updateSessionName(session.value.token,name);persistSession({...session.value,displayName:name})}return session.value!}
async function submitAuth(){if(busy.value)return;authError.value="";const email=authEmail.value.trim(),password=authPassword.value;if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){authError.value="请输入正确的邮箱地址";return}if(password.length<8||password.length>128){authError.value="密码长度应为 8～128 个字符";return}if(authMode.value==="register"&&(authName.value.trim().length<1||authName.value.trim().length>24)){authError.value="默认名字应为 1～24 个字符";return}busy.value=true;try{const next=authMode.value==="login"?await login(email,password):await register(email,password,authName.value);persistSession(next);displayName.value=next.account?.displayName??next.displayName;authOpen.value=false;notify(authMode.value==="login"?"登录成功":"注册成功","success")}catch(error){authError.value=error instanceof Error?error.message:"操作失败"}finally{busy.value=false}}
async function signOut(){if(session.value){try{await logout(session.value.token)}catch{}localStorage.removeItem(SESSION_KEY)}session.value=null;displayName.value="";menuOpen.value=false;notify("已退出登录")}
async function showStats(){if(!session.value?.account)return;statsOpen.value=true;try{stats.value=await getStats(session.value.token)}catch(e){err(e)}}
async function createGame(){if(busy.value)return;entryAttempted.value=true;busy.value=true;try{const s=await ensureSession();await enter(await createRoomApi(s.token,maxPlayers.value));notify("房间创建成功","success")}catch(e){err(e)}finally{busy.value=false}}
async function joinGame(){if(busy.value)return;entryAttempted.value=true;const code=roomCode.value.trim().toUpperCase();if(code.length!==6){notify("请输入 6 位房间码","error");return}busy.value=true;try{const s=await ensureSession();await enter(await joinRoomApi(s.token,code));notify("已加入房间","success")}catch(e){err(e)}finally{busy.value=false}}
async function enter(next:Room){room.value=next;report.value=null;localStorage.setItem(LAST_ROOM_KEY,next.id);history.replaceState(null,"",`?room=${encodeURIComponent(next.id)}`);connect();void refresh()}
function connect(){realtime?.close();clearInterval(pollTimer);if(!room.value||!session.value)return;syncing.value=true;realtime=new RealtimeRoom(session.value.token,room.value.id,onRealtime,v=>connected.value=v);realtime.subscribe(Number(localStorage.getItem(`bobing.seq.${room.value.id}`)??0)).then(async sync=>{if(sync.mode==="snapshot")room.value=sync.snapshot;else if(sync.events.length)await refresh();localStorage.setItem(`bobing.seq.${room.value!.id}`,String(sync.mode==="snapshot"?sync.snapshot.sequence:sync.sequence));syncing.value=false;pollTimer=window.setInterval(refresh,4000)}).catch(e=>{syncing.value=false;err(e)})}
function finishRollAnimation(){if(!rolling.value)return;rolling.value=false;clearTimeout(rollFallbackTimer);const result=latest.value;if(!result)return;if(result.award.primary!=="NOTHING"&&result.award.primary!=="OUTSIDE")gameAudio.play("reward");const who=activeMembers.value.find(member=>member.id===result.memberId)?.displayName??"玩家";notify(`${who} · ${awardNames[result.award.primary]}`,result.award.primary==="NOTHING"?"info":"success")}
function onDiceImpact(strength:number){if(!sound.value)return;gameAudio.play("impact",strength);if(navigator.vibrate)navigator.vibrate(Math.min(25,Math.round(8+strength*12)))}
async function animateRoll(result:RollResolution){if(result.rollId===playedRollId)return;playedRollId=result.rollId;latest.value=result;throwProfile.value=result.throwProfile;rolling.value=false;clearTimeout(rollFallbackTimer);await nextTick();rolling.value=true;rollFallbackTimer=window.setTimeout(finishRollAnimation,10000)}
function onRealtime(type:string,event:RoomEvent){if(!room.value)return;localStorage.setItem(`bobing.seq.${room.value.id}`,String(event.sequence));if(type==="reaction:received"){const p=event.payload as {memberId:string;reaction:string};const option=reactionOptions.find(x=>x[0]===p.reaction);const item={id:event.eventId,memberId:p.memberId,value:option?.[2]??"🎉"};reactions.value.push(item);setTimeout(()=>reactions.value=reactions.value.filter(x=>x.id!==item.id),2200);return}if(type==="game:roll-resolved")void animateRoll(event.payload as RollResolution);clearTimeout(refreshTimer);refreshTimer=window.setTimeout(refresh,80)}
async function refresh(){if(!room.value||!session.value)return;try{const [nextRoom,nextReport]=await Promise.all([getRoom(session.value.token,room.value.id),getReport(session.value.token,room.value.id)]);room.value=nextRoom;report.value=nextReport}catch(e){err(e)}}
async function start(){if(!room.value||!session.value)return;busy.value=true;try{room.value=await startRoomApi(session.value.token,room.value);notify("开博！","success")}catch(e){err(e)}finally{busy.value=false}}
function openSettings(){if(!room.value)return;settingsDraft.maxPlayers=room.value.maxPlayers;settingsDraft.prizes=room.value.prizeConfig.map(prize=>({...prize}));settingsOpen.value=true}
async function saveSettings(){if(!room.value||!realtime)return;busy.value=true;try{const draftRoom:Room={...room.value,maxPlayers:settingsDraft.maxPlayers,prizeConfig:settingsDraft.prizes.map(prize=>({...prize}))};await realtime.settings(draftRoom);settingsOpen.value=false;await refresh();notify("房间设置已保存","success")}catch(e){err(e)}finally{busy.value=false}}
async function control(type:"room:pause"|"room:resume"|"room:skip-turn"|"game:finish"|"room:leave"){if(!room.value||!realtime)return;try{await realtime.control(type,room.value.version);if(type==="room:leave"){leaveLocal();return}await refresh()}catch(e){err(e)}}
async function transfer(member:Member){if(!room.value||!realtime)return;try{await realtime.transfer(member.id,room.value.version);menuOpen.value=false;await refresh();notify(`已将房主移交给 ${member.displayName}`,"success")}catch(e){err(e)}}
function leaveLocal(){realtime?.close();clearInterval(pollTimer);realtime=null;room.value=null;latest.value=null;localStorage.removeItem(LAST_ROOM_KEY);history.replaceState(null,"","/")}
async function showReport(){if(!room.value||!session.value)return;reportOpen.value=true;try{report.value=await getReport(session.value.token,room.value.id)}catch(e){err(e)}}
async function copyInvite(){if(!room.value)return;const url=`${location.origin}${location.pathname}?code=${room.value.code}`;try{await navigator.clipboard.writeText(url);notify("邀请链接已复制","success")}catch{notify(`房间码：${room.value.code}`)}}
function pointerDown(e:PointerEvent){if((e.target as HTMLElement).closest("button")||!myTurn.value||busy.value)return;const now=performance.now();drag.active=true;drag.startX=drag.x=drag.lastX=e.clientX;drag.startY=drag.y=drag.lastY=e.clientY;drag.time=drag.lastTime=now;drag.velocityX=drag.velocityY=0;grabToken.value+=1;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)}
function pointerMove(e:PointerEvent){if(!drag.active)return;const now=performance.now(),dt=Math.max(8,now-drag.lastTime);drag.velocityX=drag.velocityX*.35+(e.clientX-drag.lastX)/dt*.65;drag.velocityY=drag.velocityY*.35+(e.clientY-drag.lastY)/dt*.65;drag.x=drag.lastX=e.clientX;drag.y=drag.lastY=e.clientY;drag.lastTime=now}
async function pointerUp(e:PointerEvent){if(!drag.active||!room.value||!realtime)return;drag.active=false;const elapsed=Math.max(1,performance.now()-drag.time),totalX=drag.x-drag.startX,totalY=drag.y-drag.startY,recent=performance.now()-drag.lastTime<90;let vx=recent?drag.velocityX:totalX/elapsed,vy=recent?drag.velocityY:totalY/elapsed;let speed=Math.hypot(vx,vy);if(speed<.08){vx=0;vy=-.2;speed=.2}const target=e.currentTarget as HTMLElement,rect=target.getBoundingClientRect();const profile:ThrowProfile={start:{x:Math.max(-1,Math.min(1,(drag.startX-rect.left)/rect.width*2-1)),y:Math.max(-1,Math.min(1,(drag.startY-rect.top)/rect.height*2-1))},direction:{x:vx/speed,y:vy/speed},strength:Math.max(.12,Math.min(1,speed/1.35)),holdDurationMs:Math.min(10000,Math.round(elapsed))};throwProfile.value=profile;gameAudio.play("toss");busy.value=true;try{const event=await realtime.roll(profile,room.value.version);await animateRoll(event.payload);await refresh();}catch(error){rolling.value=false;err(error)}finally{busy.value=false}}
async function react(value:(typeof reactionOptions)[number][0]){try{await realtime?.react(value)}catch(e){err(e)}}
function toggleReduced(){reducedMotion.value=!reducedMotion.value;localStorage.setItem("bobing.reducedMotion",reducedMotion.value?"1":"0")}
function toggleSound(){sound.value=!sound.value;gameAudio.setEnabled(sound.value);localStorage.setItem("bobing.sound",sound.value?"1":"0");if(sound.value)gameAudio.play("toss")}
function avatar(name:string){return name.slice(0,1).toUpperCase()}
function prizeName(tier:string){return room.value?.prizeConfig.find(x=>x.tier===tier)?.displayName??tier}
function isMoneyPrize(name:string){return /^\d+(?:\.\d{1,2})?$/.test(name.trim())}
function prizeDisplay(tier:string){const name=prizeName(tier);return isMoneyPrize(name)?`¥${name}`:name}
function summarizePrizes(prizes:Record<string,number>,empty:string){let items=0,money=0;for(const [tier,count] of Object.entries(prizes)){const name=prizeName(tier).trim();if(isMoneyPrize(name))money+=Number(name)*count;else items+=count}const parts=[];if(items)parts.push(`${items} 份奖品`);if(money)parts.push(`¥${new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2}).format(money)}`);return parts.length?parts.join(" · "):empty}
function memberReward(memberId:string){const player=report.value?.players.find(item=>item.memberId===memberId);return player?`已获 ${summarizePrizes(player.prizes,"0 份奖品")}`:"尚未获奖"}
function memberPrizeDetails(memberId:string){const prizes=report.value?.players.find(item=>item.memberId===memberId)?.prizes??{};return Object.entries(prizes).filter(([tier,count])=>count>0&&!isMoneyPrize(prizeName(tier))).map(([tier,count])=>({tier,name:prizeName(tier),count}))}
function togglePrizeDetails(memberId:string){expandedMemberId.value=expandedMemberId.value===memberId?null:memberId}
function rewardSummary(player:Report["players"][number]){return summarizePrizes(player.prizes,"未获得奖品")}
function durationText(ms:number){const minutes=Math.round(ms/60000);return minutes<60?`${minutes} 分钟`:`${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟`}

onMounted(async()=>{gameAudio.preload();const params=new URLSearchParams(location.search),roomId=params.get("room")??localStorage.getItem(LAST_ROOM_KEY);if(roomId&&session.value){try{room.value=await getRoom(session.value.token,roomId);connect()}catch{localStorage.removeItem(LAST_ROOM_KEY)}}});
watch(()=>room.value?.state,state=>{if(state==="FINISHED")showReport()});
onBeforeUnmount(()=>{realtime?.close();clearInterval(pollTimer);clearTimeout(noticeTimer);clearTimeout(refreshTimer);clearTimeout(rollFallbackTimer)});
</script>

<template>
  <main v-if="!room" class="landing">
    <header class="brand"><span class="brand-seal">博</span><span>BOBING ONLINE</span></header>
    <section class="hero">
      <div class="hero-copy"><p class="eyebrow">博饼在线</p><h1>一起，<em>博个好彩。</em></h1><p class="lead">输入昵称和房间码，即刻入席。</p></div>
      <form class="entry-card" @submit.prevent>
        <div class="account-row"><span v-if="session?.account">{{session.account.displayName}} · 已登录</span><span v-else>游客模式</span><span><button v-if="session?.account" type="button" @click="showStats">统计</button><button v-if="session?.account" type="button" @click="signOut">退出</button><button type="button" @click="authOpen=true">{{session?.account?"切换":"邮箱登录 / 注册"}}</button></span></div>
        <h2>入席</h2><p>无需注册，填写后即可加入</p>
        <label>你的昵称<input v-model="displayName" maxlength="24" placeholder="例如：阿明" autocomplete="nickname"></label>
        <label>房间码<input v-model="roomCode" maxlength="6" class="code-input" placeholder="6 位房间码" @input="roomCode=roomCode.toUpperCase()"></label>
        <p v-if="message" class="form-error" :class="messageTone" role="alert">{{message}}</p>
        <button class="primary wide" type="button" :disabled="busy" @click="joinGame">{{busy?"正在入席…":"加入房间"}}</button>
        <div class="divider"><span>或</span></div>
        <div class="create-line"><label>人数上限<select v-model="maxPlayers"><option v-for="n in 11" :key="n+1" :value="n+1">{{n+1}} 人</option></select></label><button type="button" class="secondary" :disabled="busy" @click="createGame">创建新房间</button></div>
        <small>继续即表示同意仅将昵称用于本次游戏</small>
      </form>
    </section>
    <footer>闽南人的中秋仪式感 · 结果由服务端公平生成</footer>
  </main>

  <main v-else class="room-page">
    <header class="room-header">
      <button class="logo-button" @click="menuOpen=!menuOpen"><span class="brand-seal small">博</span></button>
      <div><span class="room-label">房间</span><button class="room-code" @click="copyInvite">{{room.code}} <span>复制邀请</span></button></div>
      <div class="connection" :class="{offline:!connected}"><i></i>{{connected?"实时在线":"正在重连"}}</div>
      <button class="icon-button" aria-label="菜单" @click="menuOpen=!menuOpen">•••</button>
    </header>

    <div v-if="menuOpen" class="popover menu">
      <button @click="toggleSound">{{sound?"🔊 音效与震动已开":"🔇 音效与震动已关"}}</button><button @click="toggleReduced">{{reducedMotion?"▶ 播放动画":"⏩ 减少动画"}}</button>
      <button @click="showReport">📜 查看战报</button><button v-if="session?.account" @click="showStats">📊 我的统计</button><button class="danger-text" @click="control('room:leave')">离开房间</button>
    </div>

    <section class="game-layout">
      <aside class="side-panel players-panel">
        <div class="panel-title"><h2>同桌玩家</h2><span>{{activeCount}} / {{room.maxPlayers}}</span></div>
        <ul class="players"><li v-for="member in activeMembers" :key="member.id" :class="{current:member.id===current?.id,self:member.id===me?.id}">
          <div class="avatar">{{avatar(member.displayName)}}<i :class="{online:member.online}"></i></div>
          <div class="player-name"><strong>{{member.displayName}}</strong><span>{{member.id===me?.id?"你":`${member.seatNo} 号位`}}</span><small class="player-reward">{{memberReward(member.id)}}</small></div>
          <span v-if="member.role==='HOST'" class="host-badge">房主</span><span v-if="member.id===current?.id&&room.state!=='LOBBY'" class="turn-badge">轮到</span>
          <button v-if="memberPrizeDetails(member.id).length" class="reward-detail-toggle" type="button" @pointerdown.stop @click.stop="togglePrizeDetails(member.id)">{{expandedMemberId===member.id?"收起":"明细"}}</button>
          <button v-if="isHost&&member.id!==me?.id&&room.state==='LOBBY'" class="mini-action" @click="transfer(member)">移交</button>
          <div v-if="expandedMemberId===member.id&&memberPrizeDetails(member.id).length" class="player-prize-detail"><span v-for="item in memberPrizeDetails(member.id)" :key="item.tier"><b>{{item.name}}</b><em>× {{item.count}}</em></span></div>
        </li></ul>
        <button class="invite" @click="copyInvite">＋ 邀请亲友</button>
      </aside>

      <section class="table-stage" :class="{grabbable:myTurn&&!busy,grabbing:drag.active}" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="drag.active=false">
        <div class="round-pill" v-if="room.game">第 {{room.game.roundNo}} 轮 · 第 {{room.game.turnNo+1}} 博</div>
        <div class="stage-copy">
          <template v-if="room.state==='LOBBY'"><p>人齐之后</p><h2>由房主开博</h2></template>
          <template v-else-if="room.state==='PAUSED'"><p>稍歇片刻</p><h2>对局已暂停</h2></template>
          <template v-else-if="room.state==='FINISHED'"><p>今夜好彩</p><h2>本局已圆满结束</h2></template>
          <template v-else><p>{{myTurn?"好彩头就在手中":`等待 ${current?.displayName??'玩家'}`}}</p><h2>{{myTurn?"轮到你博了":"请见证这一博"}}</h2></template>
        </div>
        <div class="bowl-wrap">
          <DiceBowl :dice="latest?.dice??null" :outcome="latest?.outcome??null" :rolling="rolling" @settled="finishRollAnimation" @impact="onDiceImpact" :reduced-motion="reducedMotion" :grab-token="grabToken" :throw-profile="throwProfile??latest?.throwProfile??null" :drag-offset="dragOffset"/>
          <div v-for="item in reactions" :key="item.id" class="flying-reaction">{{item.value}}<small>{{activeMembers.find(x=>x.id===item.memberId)?.displayName}}</small></div>
          <div v-if="latest&&!rolling" class="result-ribbon" :class="{muted:latest.award.primary==='NOTHING'}"><span>{{latest.outcome==="OUTSIDE"?"骰子出碗":latest.dice?.join(" · ")}}</span><strong>{{awardNames[latest.award.primary]}}</strong><small v-if="latest.claims.length">获得 {{latest.claims.map(x=>prizeDisplay(x.tier)).join("、")}}</small></div>
        </div>
        <div v-if="room.state==='LOBBY'" class="lobby-action"><p>{{activeCount<2?"至少还需要 1 位玩家":"人已到齐，可以开始"}}</p><button v-if="isHost" class="primary" :disabled="busy||activeCount<2" @click="start">开 始 博 饼</button><span v-else>等待房主开始</span></div>
        <div v-else-if="room.state==='PLAYING'" class="table-gesture-status">
          <div v-if="myTurn" class="throw-guide"><i :style="{transform:`scaleX(${Math.max(.08,throwStrength)})`}"></i><strong>{{drag.active?"松手投掷":"按住向上拖，松手投掷"}}</strong><small>力度过大会增加“跳猴”概率</small></div>
          <div v-else class="waiting-guide"><span class="pulse"></span><strong>等待 {{current?.displayName}} 投掷</strong></div>
        </div>
        <div v-else-if="room.state==='PAUSED'" class="lobby-action"><button v-if="isHost" class="primary" @click="control('room:resume')">继续对局</button><span v-else>等待房主继续</span></div>
        <button v-else class="primary" @click="showReport">查看本局战报</button>
        <div class="reactions"><button v-for="item in reactionOptions" :key="item[0]" :title="item[1]" @click="react(item[0])">{{item[2]}}</button></div>
      </section>

      <aside class="side-panel prizes-panel">
        <div class="panel-title"><h2>会饼奖池</h2><button v-if="isHost&&room.state==='LOBBY'" @click="openSettings">设置</button></div>
        <ul class="prizes"><li v-for="tier in prizeOrder" :key="tier" :class="{empty:(room.game?.prizes.find(x=>x.tier===tier)?.remaining??room.prizeConfig.find(x=>x.tier===tier)?.quantity)===0}">
          <span class="prize-medal">{{tier==="CHAMPION"?"冠":tier==="STRAIGHT"?"堂":tier==="THREE_REDS"?"红":tier==="FOUR_ADVANCES"?"进":tier==="TWO_RAISES"?"举":"秀"}}</span>
          <div><strong>{{prizeDisplay(tier)}}</strong><small>{{tier==="CHAMPION"?"全场最高者":"本档奖品"}}</small></div>
          <b>{{room.game?.prizes.find(x=>x.tier===tier)?.remaining??room.prizeConfig.find(x=>x.tier===tier)?.quantity}}<small> 份</small></b>
        </li></ul>
        <div v-if="champion" class="champion-card"><span>👑 当前状元</span><strong>{{champion.displayName}}</strong></div>
        <div v-if="isHost&&room.state!=='LOBBY'&&room.state!=='FINISHED'" class="host-controls">
          <button v-if="room.state==='PLAYING'" @click="control('room:pause')">暂停</button><button v-if="room.state==='PAUSED'" @click="control('room:resume')">继续</button><button @click="control('room:skip-turn')">跳过当前</button><button class="danger-text" @click="control('game:finish')">结束对局</button>
        </div>
      </aside>
    </section>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen=false"><section class="modal settings-modal"><button class="modal-close" @click="settingsOpen=false">×</button><p class="eyebrow">房主设置</p><h2>会饼与席位</h2><label>玩家上限<select v-model="settingsDraft.maxPlayers"><option v-for="n in 11" :value="n+1" :disabled="n+1<activeCount">{{n+1}} 人</option></select></label><div class="setting-prizes"><div class="setting-prize-head"><span>奖项</span><span>奖品</span><span>数量</span></div><label v-for="p in settingsDraft.prizes" :key="p.tier"><span class="tier-title">{{tierNames[p.tier]}}</span><input v-model="p.displayName" maxlength="40" :aria-label="`${tierNames[p.tier]}奖品`"><input v-model.number="p.quantity" type="number" min="0" max="999" :aria-label="`${tierNames[p.tier]}数量`"></label></div><p class="hint">奖品填写纯数字时视为金额并累计；游戏开始后设置锁定，奖品总数至少为 1。</p><button class="primary wide" :disabled="busy" @click="saveSettings">保存设置</button></section></div>

    <div v-if="reportOpen" class="modal-backdrop" @click.self="reportOpen=false"><section class="modal report-modal"><button class="modal-close" @click="reportOpen=false">×</button><p class="eyebrow">房间 {{room.code}}</p><h2>本局战报</h2><div v-if="!report" class="loading">正在整理好彩…</div><template v-else><div class="report-hero"><span>共博 {{report.totalRolls}} 次</span><strong>{{champion?.displayName??"本局暂无状元"}}</strong><small>{{champion?"问鼎本局状元":"期待下次好彩"}}</small></div><ol class="report-list"><li v-for="player in [...report.players].sort((a,b)=>b.totalRolls-a.totalRolls)" :key="player.memberId"><span>{{player.seatNo}}</span><div><strong>{{player.displayName}}</strong><small>{{rewardSummary(player)}}</small></div><b>{{player.totalRolls}} 博</b></li></ol></template></section></div>
    <div v-if="syncing" class="sync-mask"><span></span>正在同步房间</div>
    <Transition name="toast"><div v-if="message" class="toast" :class="messageTone">{{message}}</div></Transition>
  </main>

  <div v-if="authOpen" class="modal-backdrop" @click.self="authOpen=false"><section class="modal auth-modal"><button class="modal-close" @click="authOpen=false">×</button><p class="eyebrow">可选账户</p><h2>{{authMode==="login"?"邮箱登录":"注册账户"}}</h2><p class="hint">不登录也可以继续使用游客模式。</p><div class="auth-tabs"><button type="button" :class="{active:authMode==='login'}" @click="authMode='login';authError=''">登录</button><button type="button" :class="{active:authMode==='register'}" @click="authMode='register';authError=''">注册</button></div><label v-if="authMode==='register'">默认名字<input v-model="authName" maxlength="24" autocomplete="name"><small>1～24 个可见字符</small></label><label>邮箱<input v-model="authEmail" type="email" maxlength="254" autocomplete="email"><small>例如 name@example.com</small></label><label>密码<input v-model="authPassword" type="password" minlength="8" maxlength="128" :autocomplete="authMode==='login'?'current-password':'new-password'"><small>8～128 个字符</small></label><p v-if="authError" class="auth-error" role="alert">{{authError}}</p><button class="primary wide" :disabled="busy" @click="submitAuth">{{busy?"请稍候…":authMode==="login"?"登录":"注册并登录"}}</button></section></div>

  <div v-if="statsOpen" class="modal-backdrop" @click.self="statsOpen=false"><section class="modal stats-modal"><button class="modal-close" @click="statsOpen=false">×</button><p class="eyebrow">个人记录</p><h2>我的博饼统计</h2><div v-if="!stats" class="loading">正在统计…</div><template v-else><div class="stats-grid"><div><strong>{{stats.gamesPlayed}}</strong><span>参与对局</span></div><div><strong>{{stats.totalRolls}}</strong><span>投掷次数</span></div><div><strong>{{stats.completedGames}}</strong><span>完成对局</span></div><div><strong>{{durationText(stats.playDurationMs)}}</strong><span>累计时长</span></div></div><h3>奖项频率</h3><ul class="stats-list"><li v-for="item in stats.awards" :key="item.award"><span>{{awardNames[item.award]??item.award}}</span><b>{{item.count}} 次 · {{(item.frequency*100).toFixed(1)}}%</b></li></ul><h3>获得奖品</h3><p class="hint">{{Object.keys(stats.prizes).length?Object.entries(stats.prizes).map(([tier,count])=>`${prizeName(tier)}×${count}`).join(' · '):'暂无奖品记录'}}</p></template></section></div>
</template>
