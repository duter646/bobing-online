# 素材与许可证策略

## 1. 基本规则

- “免费下载”不等于允许商用、修改或再分发。
- 每个素材按其具体下载页面和随包许可证核验，不能只相信搜索结果摘要。
- 首选 CC0，其次考虑允许商用的 CC BY；暂不采用 CC BY-SA、GPL、NC、ND 或许可证不明素材。
- 下载时保存原始许可证文本或页面快照，并写入素材登记表。
- 不使用原 Godot 博饼项目中的模型、贴图、UI、音频、HDR、材质和场景。
- 商标、人物肖像、字体和传统图案也需要单独确认权利。

## 2. 当前可用来源

### 骰子模型

- OpenGameArt Simple Dice：https://opengameart.org/content/simple-dice-0
- OpenGameArt Low-poly Dice with LODs：https://opengameart.org/content/low-poly-dice-with-lods

页面标注为 CC0。采用前仍需核对压缩包内许可证、点数方向、面法线、网格数量及导出格式。骰子也可以用 Three.js 圆角立方体和程序化点数自行生成，能够进一步减少外部资产风险。

### 碗和桌面

- OpenGameArt Cooking Assets：https://opengameart.org/content/cooking-assets
- Quaternius Furniture Pack：https://quaternius.com/packs/furniture.html
- CGTrader Free Ceramic Bowl：https://www.cgtrader.com/free-3d-models/interior/kitchen/free-ceramic-bowl

前两者页面标注 CC0。CGTrader 条目虽然声明 CC0，仍需下载后核对随包文件和平台条款。博饼碗需要合适的内壁碰撞面，建议最终自行在 Blender 建一个低面数瓷碗，以获得可控的碰撞形状和中国风外观。

### 环境光和材质

- Poly Haven：https://polyhaven.com/
- 室内候选 Warm Restaurant：https://polyhaven.com/a/warm_restaurant

Poly Haven 声明其 HDRI、纹理和模型为 CC0。网页端只使用压缩后的低分辨率环境贴图，避免直接发布几十 MB 的原始 HDRI。

### 音效

- Kenney Casino Audio：https://kenney.nl/assets/casino-audio

该资源包包含骰子、筹码等 50 个音效，页面标注 CC0。瓷碗碰撞的独特声音可能仍需自行录制或由多个 CC0 声音混合制作。

### 通用 UI 和场景物件

- Kenney：https://kenney.nl/assets
- Quaternius：https://quaternius.com/

两者官方说明均以 CC0 提供其素材页面中的游戏资产。实际采用时仍对具体资源包留存许可证。

## 3. 代码依赖许可

| 依赖 | 用途 | 许可证 | 处理 |
|---|---|---|---|
| Three.js | WebGL 3D 渲染 | MIT | 保留版权和许可证声明 |
| cannon-es | 轻量 3D 物理表现 | MIT | 保留版权和许可证声明 |
| funny/bobing GDScript | 规则和物理参考 | MPL 2.0 | 默认不复制，独立 TypeScript 重写 |

若未来决定复制或移植 MPL 代码，必须将含有该代码的文件标为 MPL 2.0、保留原版权通知，并在对外分发时提供相应源代码。其他完全独立、未包含 MPL 代码的文件可采用项目自己的许可证。

## 4. 素材登记表

每个进入仓库的第三方文件都登记：

| 项目路径 | 原始名称 | 作者 | 来源 URL | 许可证 | 下载日期 | 是否修改 | 校验值 |
|---|---|---|---|---|---|---|---|
| 待添加 | | | | | | | |

建议同时在素材目录保留：

```text
assets/
├─ ATTRIBUTIONS.md
├─ licenses/
└─ provenance.json
```

## 5. 上线前检查

- 仓库内不存在来源不明文件。
- 每个第三方素材能对应到登记记录。
- 许可证允许商业使用、修改以及随网页资源分发。
- 模型已转为 GLB 并压缩，纹理尺寸适合移动端。
- 没有直接使用原 Godot 项目的视觉或音频资产。
- 第三方代码的版权声明包含在发布包或第三方声明页面中。

