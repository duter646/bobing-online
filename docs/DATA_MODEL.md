# SQLite 数据模型

## 1. 设计目标

- 支撑匿名会话、房间恢复、投掷幂等、奖品库存和只读战报。
- 进行中的热状态保留在内存，SQLite 提供可靠恢复和审计。
- 表中保存稳定标识与结构化事实，易变规则配置可使用版本化 JSON。

以下为逻辑模型，字段类型和迁移工具在初始化工程时确定。

## 2. 表结构

### `guest_sessions`

| 字段             | 说明        |
| -------------- | --------- |
| `id`           | ULID 主键   |
| `token_hash`   | 会话令牌哈希，唯一 |
| `display_name` | 默认昵称      |
| `avatar_key`   | 可选的预设头像   |
| `created_at`   | 创建时间      |
| `expires_at`   | 过期时间      |
| `last_seen_at` | 最近访问时间    |

### `rooms`

| 字段                  | 说明                                      |
| ------------------- | --------------------------------------- |
| `id`                | ULID 主键                                 |
| `code`              | 短房间码，唯一                                 |
| `public_token_hash` | 战报公开令牌哈希                                |
| `state`             | `LOBBY/PLAYING/PAUSED/FINISHED/EXPIRED` |
| `rule_preset_id`    | 带版本号的规则预设                               |
| `settings_json`     | 房间配置快照                                  |
| `version`           | 乐观并发版本                                  |
| `last_sequence`     | 最后事件序号                                  |
| `created_at`        | 创建时间                                    |
| `started_at`        | 开始时间                                    |
| `finished_at`       | 结束时间                                    |
| `expires_at`        | 清理时间                                    |

### `room_members`

| 字段             | 说明                      |
| -------------- | ----------------------- |
| `id`           | ULID 主键                 |
| `room_id`      | 房间外键                    |
| `session_id`   | 游客会话外键                  |
| `display_name` | 本局昵称快照                  |
| `avatar_key`   | 本局头像快照                  |
| `seat_no`      | 座位号                     |
| `role`         | `HOST/PLAYER/SPECTATOR` |
| `status`       | `ACTIVE/LEFT/REMOVED`   |
| `joined_at`    | 加入时间                    |
| `left_at`      | 离开时间                    |

建议约束：同一房间座位唯一、同一会话只有一个有效成员身份、每个房间最多一个 `HOST`。

### `games`

| 字段                  | 说明       |
| ------------------- | -------- |
| `id`                | ULID 主键  |
| `room_id`           | 房间外键     |
| `status`            | 游戏状态     |
| `current_member_id` | 当前玩家     |
| `round_no`          | 当前轮数     |
| `turn_no`           | 全局投掷序号   |
| `champion_roll_id`  | 当前最强状元投掷 |
| `started_at`        | 开始时间     |
| `finished_at`       | 结束时间     |

MVP 每个房间只有一局，但仍单独建表，为后续“同房再来一局”保留空间。

### `prize_pools`

| 字段                   | 说明      |
| -------------------- | ------- |
| `id`                 | ULID 主键 |
| `game_id`            | 游戏外键    |
| `tier`               | 奖品档位代码  |
| `display_name`       | 奖品名称    |
| `initial_quantity`   | 初始数量    |
| `remaining_quantity` | 剩余数量    |
| `sort_order`         | 展示顺序    |

约束：数量不得为负，同一游戏的档位唯一。

### `rolls`

| 字段                   | 说明       |
| -------------------- | -------- |
| `id`                 | ULID 主键  |
| `game_id`            | 游戏外键     |
| `member_id`          | 投掷玩家     |
| `command_id`         | 客户端幂等键   |
| `turn_no`            | 游戏内投掷序号  |
| `throw_profile_json` | 经服务端规范化的位置、方向、力度和持续时间 |
| `outside_probability_bp` | 本次跳猴概率，单位为万分比 |
| `is_outside`         | 是否判定为跳猴 |
| `dice_json`          | 六枚骰子；跳猴时为空 |
| `primary_award`      | 主奖项代码    |
| `result_json`        | 完整规则结果   |
| `champion_rank_json` | 可选的状元比较值 |
| `created_at`         | 服务端结算时间  |

建议唯一约束：`(game_id, command_id)` 和 `(game_id, turn_no)`。

### `prize_claims`

| 字段              | 说明                          |
| --------------- | --------------------------- |
| `id`            | ULID 主键                     |
| `roll_id`       | 投掷外键                        |
| `prize_pool_id` | 奖池外键                        |
| `member_id`     | 获奖成员                        |
| `quantity`      | 数量                          |
| `status`        | `PROVISIONAL/FINAL/REVOKED` |
| `created_at`    | 创建时间                        |

`PROVISIONAL` 可用于状元最终归属尚未确定的情况。

### `room_events`

| 字段                | 说明      |
| ----------------- | ------- |
| `id`              | ULID 主键 |
| `room_id`         | 房间外键    |
| `sequence`        | 房间内事件序号 |
| `event_type`      | 事件类型    |
| `actor_member_id` | 可选操作人   |
| `command_id`      | 可选来源命令  |
| `payload_json`    | 事件数据    |
| `created_at`      | 创建时间    |

建议唯一约束：`(room_id, sequence)`；若有命令 ID，则 `(room_id, command_id, event_type)` 应避免重复。

### `room_snapshots`

| 字段             | 说明         |
| -------------- | ---------- |
| `room_id`      | 房间主键和外键    |
| `sequence`     | 快照覆盖到的事件序号 |
| `room_version` | 房间版本       |
| `state_json`   | 可恢复的完整状态   |
| `updated_at`   | 更新时间       |

## 3. 事务边界

一次成功投掷应在一个事务中完成：

1. 插入包含投掷参数、跳猴概率和最终结果的 `rolls`。
2. 条件更新 `prize_pools.remaining_quantity`。
3. 插入 `prize_claims`。
4. 更新 `games` 当前轮次和状元。
5. 插入 `room_events`。
6. 更新 `rooms.version` 与 `last_sequence`。
7. 更新 `room_snapshots`。

任何一步失败则整体回滚，客户端收到 `PERSISTENCE_FAILED`，不能播放“已中奖”的最终反馈。

## 4. SQLite 设置

建议启动时设置：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

生产环境必须定期备份数据库文件，并同时考虑 WAL 文件的一致性；优先使用 SQLite 在线备份 API，而不是运行中直接复制主文件。

## 5. 数据保留

- 未开始的空房间：24 小时后过期。
- 已结束房间和战报：默认保留 7 天。
- 游客会话：最后活跃 30 天后清理。
- 聚合后的匿名运行指标可以长期保留，但不得包含令牌、昵称等直接标识。
- 房主主动删除战报时，进入异步清理队列并返回删除状态。

保留期限属于产品配置，正式上线前应在隐私说明中明确。

## 6. 迁移原则

- 所有结构变化通过顺序迁移文件执行。
- 迁移不可依赖应用内存状态。
- 规则预设内容不可原地修改；创建新版本并让新房间引用。
- 将来迁移 PostgreSQL 时，避免依赖 SQLite 独有的宽松类型行为。
