# 实时通信协议

## 1. 通用信封

所有实时消息使用版本化信封：

```ts
interface ClientCommand<T> {
  protocolVersion: 1;
  commandId: string;
  roomId: string;
  expectedRoomVersion?: number;
  payload: T;
}

interface ServerEvent<T> {
  protocolVersion: 1;
  eventId: string;
  roomId: string;
  sequence: number;
  roomVersion: number;
  occurredAt: string;
  payload: T;
}
```

- `commandId` 在客户端重试时保持不变。
- `sequence` 在单个房间内严格递增，用于发现丢包。
- `roomVersion` 在状态改变后递增，用于并发校验。
- 时间使用 UTC ISO 8601；客户端只负责本地展示。

## 2. 连接流程

1. 客户端通过 HTTP 获得匿名会话令牌。
2. 建立 Socket.IO 连接并在握手中携带令牌。
3. 发送 `room:subscribe`，包含最后收到的 `sequence`。
4. 服务端返回增量事件或 `room:snapshot`。
5. 客户端完成同步后才开放操作按钮。

当前实现中，`room:subscribe` 的 acknowledgment 数据为以下二者之一：

```ts
type RoomSync =
  | { mode: "snapshot"; snapshot: Room }
  | { mode: "events"; events: StoredRoomEvent[]; roomVersion: number; sequence: number };
```

服务端仅在缺失事件连续且不超过 200 条时返回 `events`；否则返回 `snapshot`。客户端应用增量事件后必须把本地 `sequence` 推进到响应中的值。

在线状态按“成员在该房间中的有效连接数”计算。同一成员多个标签页中只要还有一个连接，成员仍显示在线；服务进程重启时所有恢复房间的成员先统一标记为离线，并写入 `room:presence-reset` 事件，避免增量恢复后残留错误的在线状态。

## 3. 客户端命令

| 事件                     | 发起人   | 用途        |
| ---------------------- | ----- | --------- |
| `room:subscribe`       | 成员/观众 | 订阅房间并恢复状态 |
| `room:join`            | 游客    | 加入大厅      |
| `room:leave`           | 成员    | 主动离开      |
| `room:update-settings` | 房主    | 更新规则和奖品配置 |
| `room:start`           | 房主    | 锁定配置并开始   |
| `room:pause`           | 房主    | 暂停        |
| `room:resume`          | 房主    | 继续        |
| `room:transfer-host`   | 房主    | 移交房主      |
| `room:skip-turn`       | 房主    | 跳过离线玩家    |
| `game:roll`            | 当前玩家  | 请求投掷      |
| `game:finish`          | 房主    | 人工结束      |
| `reaction:send`        | 成员    | 发送预设表情    |

命令均通过 acknowledgment 返回：

```ts
type CommandAck<T> =
  | { ok: true; commandId: string; data: T }
  | { ok: false; commandId: string; error: ProtocolError };
```

## 4. 服务端事件

| 事件                      | 用途           |
| ----------------------- | ------------ |
| `room:snapshot`         | 完整房间状态       |
| `room:member-joined`    | 新成员加入        |
| `room:member-updated`   | 在线状态、昵称或座位变化 |
| `room:settings-updated` | 设置变更         |
| `room:state-changed`    | 开始、暂停、继续、结束  |
| `room:host-transferred` | 房主移交         |
| `game:turn-changed`     | 当前玩家变化       |
| `game:roll-resolved`    | 骰子、奖项和领奖结果   |
| `game:champion-changed` | 当前状元变化       |
| `game:finished`         | 最终结果         |
| `reaction:received`     | 预设表情         |
| `system:error`          | 无法归属到单个命令的错误 |

## 5. 投掷命令

请求：

```json
{
  "protocolVersion": 1,
  "commandId": "01JROLL...",
  "roomId": "01JROOM...",
  "expectedRoomVersion": 18,
  "payload": {
    "throwProfile": {
      "start": { "x": 0.12, "y": 0.35 },
      "direction": { "x": 0.31, "y": -0.95 },
      "strength": 0.72,
      "holdDurationMs": 640
    }
  }
}
```

服务端验证：

- 房间为 `PLAYING`。
- 发起者是房间成员且轮到该成员。
- 该成员没有另一条正在处理的投掷。
- `commandId` 未执行，或返回之前执行的同一结果。
- 房间版本允许执行该命令。
- 投掷位置、方向、力度和持续时间均在协议允许范围内。

服务端使用力度计算跳猴概率。位置和方向在 MVP 中只影响表现，不参与中奖概率计算。

成功事件：

```json
{
  "protocolVersion": 1,
  "eventId": "01JEVENT...",
  "roomId": "01JROOM...",
  "sequence": 27,
  "roomVersion": 19,
  "occurredAt": "2026-09-15T12:00:00.000Z",
  "payload": {
    "rollId": "01JROLLRESULT...",
    "memberId": "01JMEMBER...",
    "outcome": "DICE",
    "dice": [1, 1, 4, 4, 4, 4],
    "outsideProbabilityBasisPoints": 0,
    "visualSeed": "bd33c9...",
    "throwProfile": {
      "start": { "x": 0.12, "y": 0.35 },
      "direction": { "x": 0.31, "y": -0.95 },
      "strength": 0.72,
      "holdDurationMs": 640
    },
    "award": {
      "primary": "CHAMPION_WITH_GOLDEN_FLOWERS",
      "secondary": []
    },
    "claims": [
      { "tier": "CHAMPION", "quantity": 1 }
    ],
    "nextMemberId": "01JNEXT..."
  }
}
```

跳猴时 `outcome` 为 `OUTSIDE`，`dice` 为 `null`，`award.primary` 为 `OUTSIDE`。`outsideProbabilityBasisPoints` 记录本次使用的万分比概率，便于回放和审计。

## 6. 快照

快照至少包含：

- 房间状态、版本和最后事件序号。
- 规则预设及配置摘要。
- 成员、座位、在线状态和房主。
- 当前游戏、轮次和当前玩家。
- 奖品初始数量与剩余数量。
- 当前状元。
- 最近投掷记录；完整记录可通过 HTTP 分页获取。

客户端必须整体替换本地房间状态，不能将快照与旧状态盲目合并。

## 7. 错误码

| 错误码                  | 含义              |
| -------------------- | --------------- |
| `UNAUTHENTICATED`    | 会话无效或过期         |
| `ROOM_NOT_FOUND`     | 房间不存在或已过期       |
| `ROOM_FULL`          | 玩家座位已满          |
| `ROOM_LOCKED`        | 房间不允许新玩家加入      |
| `NOT_A_MEMBER`       | 不是房间成员          |
| `NOT_HOST`           | 需要房主权限          |
| `INVALID_ROOM_STATE` | 当前状态不允许此操作      |
| `NOT_YOUR_TURN`      | 尚未轮到该玩家         |
| `STALE_ROOM_VERSION` | 客户端状态过旧         |
| `COMMAND_CONFLICT`   | 命令 ID 与既有命令内容冲突 |
| `RATE_LIMITED`       | 操作过于频繁          |
| `VALIDATION_FAILED`  | 输入不合法           |
| `PERSISTENCE_FAILED` | 结果未能安全保存        |

## 8. 兼容策略

- `protocolVersion` 发生不兼容变化时增加主版本。
- 新增可选字段不改变版本。
- 服务端在部署后一段时间内兼容当前和前一个协议版本。
- 规则预设带独立版本，协议版本不能代替规则版本。
