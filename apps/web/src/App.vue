<script setup lang="ts">
import { computed,defineAsyncComponent,onBeforeUnmount,onMounted,reactive,ref,watch } from "vue";
import type { PrizeTier } from "@bobing/domain";
import type { ThrowProfile } from "@bobing/protocol";
const DiceBowl=defineAsyncComponent(()=>import("./components/DiceBowl.vue"));
import { createRoom as createRoomApi,createSession,getReport,getRoom,joinRoom as joinRoomApi,startRoom as startRoomApi } from "./api";
import { RealtimeRoom } from "./realtime";
import type { Member,Reaction,Report,Room,RoomEvent,Session,RollResolution } from "./types";

const SESSION_KEY="bobing.session.v1",LAST_ROOM_KEY="bobing.lastRoom.v1";
const awardNames:Record<string,string>={OUTSIDE:"跳猴了",NOTHING:"未中奖",ONE_SHOW:"一秀",TWO_RAISES:"二举",FOUR_ADVANCES:"四进",THREE_REDS:"三红",STRAIGHT:"对堂",CHAMPION:"状元",FIVE_OF_KIND:"五子登科",FIVE_REDS:"五红",SIX_BLACK:"六勃黑",SIX_RED:"六勃红",CHAMPION_WITH_GOLDEN_FLOWERS:"状元插金花"};
const reactionOptions=[["CHEER","好彩头！","🎉"],["CLAP","鼓掌","👏"],["WOW","厉害","🤩"],["LUCK","接好运","🍀"],["LAUGH","哈哈","😄"]] as const;
const prizeOrder:PrizeTier[]=["CHAMPION","STRAIGHT","THREE_REDS","FOUR_ADVANCES","TWO_RAISES","ONE_SHOW"];

const saved=localStorage.getItem(SESSION_KEY);const session=ref<Session|null>(saved?JSON.parse(saved):null);
const room=ref<Room|null>(null),report=ref<Report|null>(null),latest=ref<RollResolution|null>(null);
const connected=ref(false),syncing=ref(false),busy=ref(false),rolling=ref(false),settingsOpen=ref(false),reportOpen=ref(false),menuOpen=ref(false);
const reducedMotion=ref(localStorage.getItem("bobing.reducedMotion")==="1"),sound=ref(localStorage.getItem("bobing.sound")!=="0");
const displayName=ref(session.value?.displayName??""),roomCode=ref(new URLSearchParams(location.search).get("code")??""),maxPlayers=ref(8);
const message=ref(""),messageTone=ref<"error"|"success"|"info">("info"),reactions=ref<Reaction[]>([]);
let realtime:RealtimeRoom|null=null,noticeTimer=0,refreshTimer=0,pollTimer=0;
const drag=reactive({active:false,startX:0,startY:0,x:0,y:0,time:0});

const activeMembers=computed(()=>room.value?.members.filter(m=>m.status==="ACTIVE").sort((a,b)=>a.seatNo-b.seatNo)??[]);
const me=computed(()=>activeMembers.value.find(m=>m.displayName===session.value?.displayName));
const isHost=computed(()=>me.value?.id===room.value?.hostMemberId);
const current=computed(()=>activeMembers.value.find(m=>m.id===room.value?.game?.currentMemberId));
const myTurn=computed(()=>room.value?.state==="PLAYING"&&current.value?.id===me.value?.id);
const champion=computed(()=>activeMembers.value.find(m=>m.id===room.value?.game?.champion?.memberId));
const stateLabel=computed(()=>({LOBBY:"等待中",PLAYING:"进行中",PAUSED:"已暂停",FINISHED:"已结束",EXPIRED:"已过期"}[room.value?.state??"LOBBY"]));
const throwStrength=computed(()=>Math.min(1,Math.hypot(drag.x-drag.startX,drag.y-drag.startY)/150));
const activeCount=computed(()=>activeMembers.value.length);

function notify(text:string,tone:"error"|"success"|"info"="info"){message.value=text;messageTone.value=tone;clearTimeout(noticeTimer);noticeTimer=window.setTimeout(()=>message.value="",3200)}
function err(error:unknown){notify(error instanceof Error?error.message:"操作失败","error")}
function persistSession(next:Session){session.value=next;localStorage.setItem(SESSION_KEY,JSON.stringify(next))}
async function ensureSession(){const name=displayName.value.trim();if(!name)throw new Error("请先输入昵称");if(name.length>24)throw new Error("昵称最多 24 个字符");if(!session.value||session.value.displayName!==name){persistSession(await createSession(name))}return session.value!}
async function createGame(){if(busy.value)return;busy.value=true;try{const s=await ensureSession();await enter(await createRoomApi(s.token,maxPlayers.value));notify("房间创建成功","success")}catch(e){err(e)}finally{busy.value=false}}
async function joinGame(){if(busy.value)return;const code=roomCode.value.trim().toUpperCase();if(code.length!==6){notify("请输入 6 位房间码","error");return}busy.value=true;try{const s=await ensureSession();await enter(await joinRoomApi(s.token,code));notify("已加入房间","success")}catch(e){err(e)}finally{busy.value=false}}
async function enter(next:Room){room.value=next;localStorage.setItem(LAST_ROOM_KEY,next.id);history.replaceState(null,"",`?room=${encodeURIComponent(next.id)}`);connect()}
function connect(){realtime?.close();clearInterval(pollTimer);if(!room.value||!session.value)return;syncing.value=true;realtime=new RealtimeRoom(session.value.token,room.value.id,onRealtime,v=>connected.value=v);realtime.subscribe(Number(localStorage.getItem(`bobing.seq.${room.value.id}`)??0)).then(async sync=>{if(sync.mode==="snapshot")room.value=sync.snapshot;else if(sync.events.length)await refresh();localStorage.setItem(`bobing.seq.${room.value!.id}`,String(sync.mode==="snapshot"?sync.snapshot.sequence:sync.sequence));syncing.value=false;pollTimer=window.setInterval(refresh,4000)}).catch(e=>{syncing.value=false;err(e)})}
function onRealtime(type:string,event:RoomEvent){if(!room.value)return;localStorage.setItem(`bobing.seq.${room.value.id}`,String(event.sequence));if(type==="reaction:received"){const p=event.payload as {memberId:string;reaction:string};const option=reactionOptions.find(x=>x[0]===p.reaction);const item={id:event.eventId,memberId:p.memberId,value:option?.[2]??"🎉"};reactions.value.push(item);setTimeout(()=>reactions.value=reactions.value.filter(x=>x.id!==item.id),2200);return}if(type==="game:roll-resolved"){latest.value=event.payload as RollResolution;rolling.value=true;window.setTimeout(()=>{rolling.value=false;const who=activeMembers.value.find(m=>m.id===latest.value?.memberId)?.displayName??"玩家";notify(`${who} · ${awardNames[latest.value!.award.primary]}`,latest.value!.award.primary==="NOTHING"?"info":"success")},1750)}clearTimeout(refreshTimer);refreshTimer=window.setTimeout(refresh,80)}
async function refresh(){if(!room.value||!session.value)return;try{room.value=await getRoom(session.value.token,room.value.id)}catch(e){err(e)}}
async function start(){if(!room.value||!session.value)return;busy.value=true;try{room.value=await startRoomApi(session.value.token,room.value);notify("开博！","success")}catch(e){err(e)}finally{busy.value=false}}
async function saveSettings(){if(!room.value||!realtime)return;busy.value=true;try{await realtime.settings(room.value);settingsOpen.value=false;await refresh();notify("房间设置已保存","success")}catch(e){err(e)}finally{busy.value=false}}
async function control(type:"room:pause"|"room:resume"|"room:skip-turn"|"game:finish"|"room:leave"){if(!room.value||!realtime)return;try{await realtime.control(type,room.value.version);if(type==="room:leave"){leaveLocal();return}await refresh()}catch(e){err(e)}}
async function transfer(member:Member){if(!room.value||!realtime)return;try{await realtime.transfer(member.id,room.value.version);menuOpen.value=false;await refresh();notify(`已将房主移交给 ${member.displayName}`,"success")}catch(e){err(e)}}
function leaveLocal(){realtime?.close();clearInterval(pollTimer);realtime=null;room.value=null;latest.value=null;localStorage.removeItem(LAST_ROOM_KEY);history.replaceState(null,"","/")}
async function showReport(){if(!room.value||!session.value)return;reportOpen.value=true;try{report.value=await getReport(session.value.token,room.value.id)}catch(e){err(e)}}
async function copyInvite(){if(!room.value)return;const url=`${location.origin}${location.pathname}?code=${room.value.code}`;try{await navigator.clipboard.writeText(url);notify("邀请链接已复制","success")}catch{notify(`房间码：${room.value.code}`)}}
function pointerDown(e:PointerEvent){if(!myTurn.value||busy.value)return;drag.active=true;drag.startX=drag.x=e.clientX;drag.startY=drag.y=e.clientY;drag.time=performance.now();(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)}
function pointerMove(e:PointerEvent){if(!drag.active)return;drag.x=e.clientX;drag.y=e.clientY}
async function pointerUp(){if(!drag.active||!room.value||!realtime)return;drag.active=false;const dx=drag.x-drag.startX,dy=drag.y-drag.startY,length=Math.hypot(dx,dy);const profile:ThrowProfile={start:{x:0,y:0},direction:length>.1?{x:dx/length,y:dy/length}:{x:0,y:-1},strength:Math.max(.15,Math.min(1,length/150)),holdDurationMs:Math.min(10000,Math.round(performance.now()-drag.time))};busy.value=true;rolling.value=true;try{const event=await realtime.roll(profile,room.value.version);latest.value=event.payload;await refresh();if(sound.value&&navigator.vibrate)navigator.vibrate([25,20,35])}catch(e){rolling.value=false;err(e)}finally{busy.value=false}}
async function react(value:(typeof reactionOptions)[number][0]){try{await realtime?.react(value)}catch(e){err(e)}}
function toggleReduced(){reducedMotion.value=!reducedMotion.value;localStorage.setItem("bobing.reducedMotion",reducedMotion.value?"1":"0")}
function toggleSound(){sound.value=!sound.value;localStorage.setItem("bobing.sound",sound.value?"1":"0")}
function avatar(name:string){return name.slice(0,1).toUpperCase()}
function prizeName(tier:string){return room.value?.prizeConfig.find(x=>x.tier===tier)?.displayName??tier}
function rewardSummary(player:Report["players"][number]){const entries=Object.entries(player.prizes);return entries.length?entries.map(([tier,n])=>`${prizeName(tier)}×${n}`).join(" · "):"未获得奖品"}

onMounted(async()=>{const params=new URLSearchParams(location.search),roomId=params.get("room")??localStorage.getItem(LAST_ROOM_KEY);if(roomId&&session.value){try{room.value=await getRoom(session.value.token,roomId);connect()}catch{localStorage.removeItem(LAST_ROOM_KEY)}}});
watch(()=>room.value?.state,state=>{if(state==="FINISHED")showReport()});
onBeforeUnmount(()=>{realtime?.close();clearInterval(pollTimer);clearTimeout(noticeTimer);clearTimeout(refreshTimer)});
</script>

<template>
  <main v-if="!room" class="landing">
    <header class="brand"><span class="brand-seal">博</span><span>BOBING ONLINE</span></header>
    <section class="hero">
      <div class="hero-copy"><p class="eyebrow">中秋 · 团圆 · 好彩头</p><h1>同桌不同城，<br><em>一起博好彩。</em></h1><p class="lead">厦门传统博饼，搬到线上。无需注册，创建房间，把亲友叫来就能开博。</p><div class="feature-row"><span>实时同桌</span><span>传统规则</span><span>手机即玩</span></div></div>
      <form class="entry-card" @submit.prevent>
        <div class="card-knot">如意</div><h2>入席</h2><p>起个大家认得出的名字</p>
        <label>你的昵称<input v-model="displayName" maxlength="24" placeholder="例如：阿明" autocomplete="nickname"></label>
        <div class="choice-tabs"><button type="button" class="tab active">加入房间</button><button type="button" class="tab" @click="createGame">创建房间</button></div>
        <label>房间码<input v-model="roomCode" maxlength="6" class="code-input" placeholder="6 位房间码" @input="roomCode=roomCode.toUpperCase()"></label>
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
      <button @click="toggleSound">{{sound?"🔊 声音已开":"🔇 声音已关"}}</button><button @click="toggleReduced">{{reducedMotion?"▶ 播放动画":"⏩ 减少动画"}}</button>
      <button @click="showReport">📜 查看战报</button><button class="danger-text" @click="control('room:leave')">离开房间</button>
    </div>

    <section class="game-layout">
      <aside class="side-panel players-panel">
        <div class="panel-title"><h2>同桌玩家</h2><span>{{activeCount}} / {{room.maxPlayers}}</span></div>
        <ul class="players"><li v-for="member in activeMembers" :key="member.id" :class="{current:member.id===current?.id,self:member.id===me?.id}">
          <div class="avatar">{{avatar(member.displayName)}}<i :class="{online:member.online}"></i></div>
          <div class="player-name"><strong>{{member.displayName}}</strong><span>{{member.id===me?.id?"你":`${member.seatNo} 号位`}}</span></div>
          <span v-if="member.role==='HOST'" class="host-badge">房主</span><span v-if="member.id===current?.id&&room.state!=='LOBBY'" class="turn-badge">轮到</span>
          <button v-if="isHost&&member.id!==me?.id&&room.state==='LOBBY'" class="mini-action" @click="transfer(member)">移交</button>
        </li></ul>
        <button class="invite" @click="copyInvite">＋ 邀请亲友</button>
      </aside>

      <section class="table-stage">
        <div class="round-pill" v-if="room.game">第 {{room.game.roundNo}} 轮 · 第 {{room.game.turnNo+1}} 博</div>
        <div class="stage-copy">
          <template v-if="room.state==='LOBBY'"><p>人齐之后</p><h2>由房主开博</h2></template>
          <template v-else-if="room.state==='PAUSED'"><p>稍歇片刻</p><h2>对局已暂停</h2></template>
          <template v-else-if="room.state==='FINISHED'"><p>今夜好彩</p><h2>本局已圆满结束</h2></template>
          <template v-else><p>{{myTurn?"好彩头就在手中":`等待 ${current?.displayName??'玩家'}`}}</p><h2>{{myTurn?"轮到你博了":"请见证这一博"}}</h2></template>
        </div>
        <div class="bowl-wrap">
          <DiceBowl :dice="latest?.dice??null" :rolling="rolling" :reduced-motion="reducedMotion"/>
          <div v-for="item in reactions" :key="item.id" class="flying-reaction">{{item.value}}<small>{{activeMembers.find(x=>x.id===item.memberId)?.displayName}}</small></div>
          <div v-if="latest&&!rolling" class="result-ribbon" :class="{muted:latest.award.primary==='NOTHING'}"><span>{{latest.outcome==="OUTSIDE"?"骰子出碗":latest.dice?.join(" · ")}}</span><strong>{{awardNames[latest.award.primary]}}</strong><small v-if="latest.claims.length">获得 {{latest.claims.map(x=>prizeName(x.tier)).join("、")}}</small></div>
        </div>
        <div v-if="room.state==='LOBBY'" class="lobby-action"><p>{{activeCount<2?"至少还需要 1 位玩家":"人已到齐，可以开始"}}</p><button v-if="isHost" class="primary" :disabled="busy||activeCount<2" @click="start">开 始 博 饼</button><span v-else>等待房主开始</span></div>
        <div v-else-if="room.state==='PLAYING'" class="throw-zone" :class="{disabled:!myTurn||busy}" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="drag.active=false">
          <div v-if="myTurn" class="throw-guide"><i :style="{transform:`scaleX(${Math.max(.08,throwStrength)})`}"></i><strong>{{drag.active?"松手投掷":"按住向上拖，松手投掷"}}</strong><small>力度过大会增加“跳猴”概率</small></div>
          <div v-else class="waiting-guide"><span class="pulse"></span><strong>等待 {{current?.displayName}} 投掷</strong></div>
        </div>
        <div v-else-if="room.state==='PAUSED'" class="lobby-action"><button v-if="isHost" class="primary" @click="control('room:resume')">继续对局</button><span v-else>等待房主继续</span></div>
        <button v-else class="primary" @click="showReport">查看本局战报</button>
        <div class="reactions"><button v-for="item in reactionOptions" :key="item[0]" :title="item[1]" @click="react(item[0])">{{item[2]}}</button></div>
      </section>

      <aside class="side-panel prizes-panel">
        <div class="panel-title"><h2>会饼奖池</h2><button v-if="isHost&&room.state==='LOBBY'" @click="settingsOpen=true">设置</button></div>
        <ul class="prizes"><li v-for="tier in prizeOrder" :key="tier" :class="{empty:(room.game?.prizes.find(x=>x.tier===tier)?.remaining??room.prizeConfig.find(x=>x.tier===tier)?.quantity)===0}">
          <span class="prize-medal">{{tier==="CHAMPION"?"冠":tier==="STRAIGHT"?"堂":tier==="THREE_REDS"?"红":tier==="FOUR_ADVANCES"?"进":tier==="TWO_RAISES"?"举":"秀"}}</span>
          <div><strong>{{prizeName(tier)}}</strong><small>{{tier==="CHAMPION"?"全场最高者":"本档奖品"}}</small></div>
          <b>{{room.game?.prizes.find(x=>x.tier===tier)?.remaining??room.prizeConfig.find(x=>x.tier===tier)?.quantity}}<small> 份</small></b>
        </li></ul>
        <div v-if="champion" class="champion-card"><span>👑 当前状元</span><strong>{{champion.displayName}}</strong></div>
        <div v-if="isHost&&room.state!=='LOBBY'&&room.state!=='FINISHED'" class="host-controls">
          <button v-if="room.state==='PLAYING'" @click="control('room:pause')">暂停</button><button v-if="room.state==='PAUSED'" @click="control('room:resume')">继续</button><button @click="control('room:skip-turn')">跳过当前</button><button class="danger-text" @click="control('game:finish')">结束对局</button>
        </div>
      </aside>
    </section>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen=false"><section class="modal settings-modal"><button class="modal-close" @click="settingsOpen=false">×</button><p class="eyebrow">房主设置</p><h2>会饼与席位</h2><label>玩家上限<select v-model="room.maxPlayers"><option v-for="n in 11" :value="n+1" :disabled="n+1<activeCount">{{n+1}} 人</option></select></label><div class="setting-prizes"><label v-for="p in room.prizeConfig" :key="p.tier"><span>{{p.tier}}</span><input v-model="p.displayName" maxlength="40"><input v-model.number="p.quantity" type="number" min="0" max="999"></label></div><p class="hint">游戏开始后设置将锁定。奖品总数至少为 1。</p><button class="primary wide" :disabled="busy" @click="saveSettings">保存设置</button></section></div>

    <div v-if="reportOpen" class="modal-backdrop" @click.self="reportOpen=false"><section class="modal report-modal"><button class="modal-close" @click="reportOpen=false">×</button><p class="eyebrow">房间 {{room.code}}</p><h2>本局战报</h2><div v-if="!report" class="loading">正在整理好彩…</div><template v-else><div class="report-hero"><span>共博 {{report.totalRolls}} 次</span><strong>{{champion?.displayName??"本局暂无状元"}}</strong><small>{{champion?"问鼎本局状元":"期待下次好彩"}}</small></div><ol class="report-list"><li v-for="player in [...report.players].sort((a,b)=>b.totalRolls-a.totalRolls)" :key="player.memberId"><span>{{player.seatNo}}</span><div><strong>{{player.displayName}}</strong><small>{{rewardSummary(player)}}</small></div><b>{{player.totalRolls}} 博</b></li></ol></template></section></div>
    <div v-if="syncing" class="sync-mask"><span></span>正在同步房间</div>
    <Transition name="toast"><div v-if="message" class="toast" :class="messageTone">{{message}}</div></Transition>
  </main>
</template>
