# 🎵 无缝循环播放器 v1.7

基于 **BPM 节拍对齐 + Web Audio API 双轨调度** 的毫秒级无缝 BGM 循环网页播放器。自带密码保护的 Web 管理后台，支持多目录 BGM 管理、精确到 5 位小数的 BPM 参数、双轨/单轨两种循环模式、跳转段衔接，并对 PC / 平板 / 移动端浏览器全面响应式适配。内置 LRC 卡拉OK歌词字幕引擎（支持逐字/逐词组/双语）与原神日式字体渲染。

> 版本：**1.7**  
> License：MIT

---

## ✨ 功能特性

### 🎼 核心循环与调度
- **BPM 节拍对齐**：每首曲目单独指定 BPM、拍号、音频 0s 对应小节/拍，按数学推导换算到精确样本帧对齐，而非依赖硬件 `loop=-1`
- **两种循环模式**：
  - `single`（单轨循环）：内部 A/B 双缓冲 + 2ms 最小交叉淡入，实现任意循环点的无缝切换
  - `dual`（双轨循环）：旧轨自然播放到音频末尾（允许淡出），新轨从循环起点淡入衔接，等待所有增益包络走完再清理节点
- **独立淡入淡出（按"拍"计）**：
  - 淡入：从循环起点开始，可配置 0~N 拍淡入时长
  - 淡出：从指定小节/拍开始（0=自动，淡出结束对齐循环终点；可设在循环终点之后），0 拍时旧轨保持 gain=1 自然播放到底不硬切
- **跳转段（Bridge）衔接**：循环终点 → 跳转段起点 → 跳转段终点 → 循环起点，支持 3 段式无缝跳转链（单曲循环、前奏/副歌分离、BGM 中段插入桥段等场景）
- **三重保障防停播**：`onended` 兜底回调、音频物理末尾预跳保护、`start()` 失败自动重试调度

### 📂 BGM 目录与搜索
- **多目录跨系统路径兼容**：Windows 绝对路径（`C:\Users\XXX\Music`）、Android 手机路径（`/sdcard/Music/XXX`）、项目相对路径（`./BGM`）自动规范化
- **每目录独立标签 & 状态徽章**：默认 🟠 / 可用 🟢 / 不存在 🔴
- **双层搜索**：
  - 全局搜索：工具栏输入关键词，后端按文件名模糊过滤整个 BGM 列表
  - 曲目内搜索：单首曲目配置卡片内按文件名过滤，仅显示当前所选目录下的文件

### 🛡️ 账号与安全
- **密码保护**：管理页 `/admin`、`/api/config` 写入、`/api/bgm-dirs` 写入等接口统一 `@login_required`
- **Session Cookie 鉴权**：Flask `session`，前端所有 `fetch` 显式带 `credentials: 'include'`
- **在线改密**：管理页右上角"改密码"按钮，密码独立存储 `password.txt`
- **防误删默认目录**：任何操作下 `id=default` 默认目录不可删除，防止老曲目找不到目录

### 📱 响应式 UI（PC / 平板 / 手机）
- **PC 端（>1024px）**：播放器 1.4fr + 曲目列表 1fr 两列并排，管理页卡片多列 grid
- **平板端（768–1024px）**：保留两列，缩小间距/字号，工具栏自动换行
- **移动端（≤767px）**：
  - 主页：曲目列表收起到**左侧抽屉**，点击左上角 ☰ 汉堡按钮滑出，遮罩点击 / ✕ 关闭按钮 / ESC / 选曲后 / 窗口放大自动收起
  - 管理页：顶部 header 两行、工具栏 2 列 grid、目录表单单列、曲目卡片默认折叠（点击展开/收起，曲目多的时候更清爽）、所有字段降为单列、按钮点击区 ≥ 40px
- **二次元风格界面**：粉色/紫色渐变、毛玻璃面板、节拍指示灯小点随小节脉冲
- **原神日式字体**：全局（含管理页、登录页、卡拉OK歌词）优先使用 `static/JA-JP.TTF` 原神风格日文汉字字体，日文假名/汉字呈现更美观（通过 `<link rel="preload">` 首屏强制预加载，绕过浏览器 WebFont 懒加载）

### 🎤 卡拉OK 歌词字幕（LRC 引擎）
- **自动加载同名 .lrc**：BGM 同目录下（多目录兼容）与音频文件同名的 `.lrc` 文件自动解析为歌词
- **三种时间戳格式**：
  - 行级 `[mm:ss.xx]`：整行歌词 + 可选整行译文字（同一时间戳的第二行自动作为翻译）
  - 字级 `<mm:ss.xx>`：标准 LRC 逐字卡拉OK，时间戳可以连写（如 `<00:14.88>引き裂かれしわたしは<00:17.83>_<00:17.83>冬`）
  - 重复时间戳 token：兼容 Foobar2000 打歌词习惯（同一秒出现在中间位置的时间戳会被独立保留，两个词共享起始时间后自动均分滚动）
- **智能分组均分滚动（除英文外）**：
  - 日文 / 汉字 / 中文标点等：**同时间戳合并的多字自动按字符数均分时长逐字滚动**，无需每个半拍都打单独时间戳（例：9字词组÷2.95s=每字0.328s）
  - 英文词组 / 句子：保持整组整体变色，不拆字符
- **三阶段高亮视觉区分**：
  - `lyric-done` 已唱完 → 绿色（success）沉淀
  - `lyric-active` 正在唱 → 橙色（warning）+ 发光阴影，焦点突出
  - `lyric-rest` 未唱 → 浅灰色（text-light）压暗
- **末尾 token 自动补时**：最后一字的结束时间按前面平均每字时长估算，避免末尾歌词突然消失

---

## 🚀 快速开始

### 📥 下载测试音频（首次体验必备）
> 由于 GitHub 无法上传大于 25MB 的音频文件，项目不内置 BGM。请先下载示例曲目放入 `BGM/` 目录：
>
> 👉 [小飞机网盘下载：01_35 - Waifu 4 Laifu.wav](https://share.feijipan.com/s/eKeQkOas)
>
> 下载后直接将 `01_35 - Waifu 4 Laifu.wav` 放入项目根目录下的 `BGM/` 文件夹中即可，无需额外配置。

### 依赖
- **Python 3.8+**（项目仅依赖 `Flask`；无其他 pip 包）

### 安装 & 启动
```bash
# 1. 克隆或解压项目后进入目录
cd 无缝循环（交叉播放）

# 2. 安装依赖
pip install flask

# 3. 启动服务（Windows / Linux / macOS / Termux 均适用）
python app.py
```

启动成功后终端会打印：
```
============================================================
  无缝循环播放器启动
  主页:   http://127.0.0.1:5000/
  登录:   http://127.0.0.1:5000/login
  管理:   http://127.0.0.1:5000/admin
  默认密码: admin123  (可在 password.txt 中修改)
============================================================
```

### 默认密码
```
初始管理员密码：admin123
```
**修改方式**：
1. 直接编辑 `password.txt`（重启生效）
2. 登录管理页 → 右上角"改密码"按钮在线修改（即时生效，同步写入文件）

### 手机（Termux / Android）运行
```bash
pkg install python
pip install flask
cd /path/to/project
python app.py
# 手机浏览器打开 http://127.0.0.1:5000/
```
跨系统路径示例：`/sdcard/Music/我的BGM` 即可挂载系统音乐库。

---

## 📁 目录结构
```
无缝循环（交叉播放）/
├── app.py                  # Flask 后端：路由、配置加载/保存、鉴权、目录扫描
├── config.json             # 曲目 + bgm_dirs 配置（见下节详细说明）
├── password.txt            # 管理员密码明文存储
├── .flask_secret           # Flask session 签名密钥（首次启动自动生成）
├── BGM/                    # 默认 BGM 目录（在 bgm_dirs 中 id=default）
│   ├── *.wav / *.flac / *.mp3
│   └── *.lrc               # 同名歌词文件（播放器作为字幕加载）
├── static/
│   ├── style.css           # 主页样式（含响应式断点）
│   ├── app.js              # 主页播放逻辑（Web Audio API 双轨调度）
│   ├── admin.css           # 管理页样式（含响应式断点）
│   └── admin.js            # 管理页前端（配置 CRUD / 目录管理 / 实时预览）
├── templates/
│   ├── index.html          # 主页播放器
│   ├── login.html          # 登录页
│   └── admin.html          # 管理页
└── README.md               # 本文件
```

---

## ⚙️ 配置说明（config.json）

配置由两部分组成：`bgm_dirs`（BGM 多目录）和 `tracks`（曲目列表）。推荐**通过管理页 Web UI 编辑**，下方说明仅作手动修改参考。

### 顶层结构
```json
{
  "bgm_dirs": [ /* ...目录列表... */ ],
  "tracks":    [ /* ...曲目列表... */ ]
}
```

### bgm_dirs 字段
| 字段    | 类型   | 说明                                                         |
|---------|--------|--------------------------------------------------------------|
| `id`    | string | 唯一目录 ID，默认目录固定为 `default`                        |
| `label` | string | UI 显示用标签，例如"本地音乐""手机 OST"                      |
| `path`  | string | 实际路径，支持 Windows `C:\...`、Android `/sdcard/...`、相对 `./BGM` |

### tracks 字段（每首曲目）
| 字段                    | 类型   | 说明                                                                          |
|-------------------------|--------|-------------------------------------------------------------------------------|
| `name`                  | string | 曲目标题                                                                      |
| `filename`              | string | 音频文件名（不含路径，结合 `bgm_dir_id` 查找）                                 |
| `bgm_dir_id`            | string | 所属目录 ID，对应 `bgm_dirs[].id`，缺省回退 `default`                         |
| `bpm`                   | number | **每分钟拍数**，支持最多 5 位小数（例：`120.005`），确保鼓点精确对齐          |
| `beats_per_bar`         | number | 每小节拍数（常见 4/4 拍填 `4`，3/4 拍填 `3`）                                 |
| `audio_zero_bar`        | number | 音频 0s 所在小节（1-based）                                                   |
| `audio_zero_beat`       | number | 音频 0s 所在拍号（1-based）                                                   |
| `loop_start_bar` / `loop_start_beat`       | number+number | **循环起点**（小节:拍），每次循环回到此点                                     |
| `loop_end_bar` / `loop_end_beat`           | number+number | **循环终点**（小节:拍），播放到此触发下一次循环 / 跳转                        |
| `fade_in_beats`         | number | 淡入拍数（从循环起点开始），`0`=禁用，保持原声衔接                            |
| `fade_out_beats`        | number | 淡出拍数（从 `fade_out_start_*` 开始），`0`=旧轨 gain=1 播到尾不硬切          |
| `fade_out_start_bar` / `fade_out_start_beat` | number+number | **淡出起点**（0=自动，淡出结束对齐循环终点；≥1 为独立指定，可设在循环终点之后） |
| `loop_mode`             | string | `"single"` 单轨无缝交叉 或 `"dual"` 双轨自然播完+淡入淡出                     |
| `jump_seg_start_bar` / `jump_seg_start_beat` | number+number | **跳转段起点**（0=禁用桥段，否则每次到 loop_end 先跳段起→段末→循环起）       |
| `jump_seg_end_bar` / `jump_seg_end_beat`   | number+number | **跳转段终点**（0=禁用桥段）                                                 |

### 时间换算公式（供参考）
```
每拍毫秒  = 60000 / BPM
绝对拍数  = (小节 - 1) * 每小节拍数 + 拍号
相对秒数  = (当前绝对拍数 - audio_zero 绝对拍数) / (BPM / 60)
```
管理页每张曲目卡片右侧的"**计算预览**"面板会实时输出上述所有换算。

---

## 🔌 代理配置说明（Git Bash / Termux 用户）

部分用户习惯在命令行开启代理访问外网资源（如 `pip install` 加速、`git clone` GitHub 等）。如果你的 Shell 环境已配置代理，访问本地 127.0.0.1 的 Flask 服务时**必须把 localhost/127.0.0.1 加入 `no_proxy` 白名单**，否则请求会被误送到代理端口导致 `ERR_EMPTY_RESPONSE` 或连接超时。

推荐在 Shell 初始化文件中添加以下三个快捷函数：

| 系统 / Shell       | 初始化文件位置                                        |
|--------------------|-------------------------------------------------------|
| Windows Git Bash   | `C:\Users\<你的用户名>\.bashrc`（即 `~/.bashrc`）      |
| Android Termux     | `~/.bashrc`（`/data/data/com.termux/files/home/.bashrc`）|
| Linux / macOS Bash | `~/.bashrc` 或 `~/.zshrc`                             |

在对应文件末尾追加：

```bash
# ===== 无缝循环播放器代理辅助函数 =====
# 使用前在脚本或当前 shell 中先定义你的代理端口，例如：
#   export MY_PROXY_PORT=7890

proxy_on() {
    export http_proxy="http://127.0.0.1:$MY_PROXY_PORT"
    export https_proxy="http://127.0.0.1:$MY_PROXY_PORT"
    export all_proxy="socks5://127.0.0.1:$MY_PROXY_PORT"
    export no_proxy="localhost,127.0.0.1,*.local"
    echo "✅ 代理已开启: 127.0.0.1:$MY_PROXY_PORT"
}

proxy_off() {
    unset http_proxy https_proxy all_proxy no_proxy
    echo "❌ 代理已关闭"
}

proxy_status() {
    echo "http_proxy  = ${http_proxy:-（未设置）}"
    echo "https_proxy = ${https_proxy:-（未设置）}"
    echo "all_proxy   = ${all_proxy:-（未设置）}"
}
```

使用示例：
```bash
# 开启代理（安装依赖时用）
export MY_PROXY_PORT=7890
proxy_on
pip install flask

# 关闭代理（启动本地 Flask 服务前务必关闭或确认 no_proxy 生效）
proxy_off
python app.py

# 查看当前代理状态
proxy_status
```

> 💡 **提示**：即便 `proxy_on`，只要 `no_proxy` 含 `127.0.0.1,localhost`，也可以安全访问 `http://127.0.0.1:5000/`；但若代理软件本身对本地端口有冲突，仍建议 `proxy_off` 后运行 Flask。

---

## 🧱 技术栈 & 实现原理

| 层       | 技术选型                          |
|----------|-----------------------------------|
| 后端     | Python + Flask（session 鉴权）    |
| 前端     | 原生 HTML/CSS/JavaScript，无任何构建工具 |
| 音频核心 | Web Audio API（`AudioBufferSourceNode` + `GainNode` 手动调度）|
| 浏览器传输 | `fetch` + `credentials: 'include'`（session cookie）|

**音频调度核心思路**：
1. 每首曲目用两个 track 对象（A/B）做双缓冲；提前 `180ms` 通过 `setTimeout`（基于 `audioContext.currentTime` 绝对时间）挂下一跳
2. 所有 `start(offset, when)` 与增益 `setValueAtTime / linearRampToValueAtTime` 统一对齐到同一 `audioContext` 时间线，避免 RAF 帧率抖动
3. 每个 source 额外绑定 `_guardOnended`：若调度漏判，`onended` 自动补跳，避免死循环中断
4. 清理策略：`gain.value <= 0.006` 才 `disconnect`；设置了包络的节点再等 `stopAtCtx + 0.5s buffer` 才真正回收，杜绝爆音和衔接缝

---

## 📋 更新日志

### v1.7
- **新增节拍计算器**：独立窗口形式，支持选择文件夹和列表，计算节拍，拖动进度条查看并设置小节:拍，确保与播放器偏移一致

### v1.6
- **新增曲目分类/分组功能**：
  - 每首曲目新增 `category` 字段，管理面板可手动填写分类；新曲目默认归类到「**未分类**」
  - 主页播放页曲目列表按分类分组渲染（中文拼音排序、「未分类」自动置于最后），每组显示曲目数量徽章
  - 分类**默认折叠**，点击分类头可展开/收起；切歌时自动展开对应分类并平滑滚动到曲目位置
  - 分类展开动画改为 **CSS Grid `grid-template-rows: 0fr ↔ 1fr`** 方案 + JS 精确高度计算，丝滑过渡且内容不截断（彻底告别旧 `max-height` 方案的动画卡顿和最后半行被切）
- **自适应高度/独立滚动容器优化（解决桌面端/移动端长期存在的列表空白/挤压问题）**：
  - 桌面端：曲目列表外层新增独立 `.scroll-container` 滚动容器（`max-height:70vh` + `overflow-y:auto`），内层 `.track-list` 完全按内容自由撑开，绝不被父容器挤压；所有分类全展开后内容超高立即出粉紫渐变滚动条，可一直滑到底
  - 移动端抽屉：**严格按 Ant Design Mobile Drawer / Tailwind UI 标准三层 Flex 结构**（Wrapper `height:100vh display:flex flex-col overflow:hidden` + Header `flex-shrink:0` + Scroll Body `flex:1 min-height:0 overflow-y:auto`），滚动容器自动吸收 Header 后剩余全部高度，**零空白、不越界**；并在移动端媒体查询中使用 `!important` 解决 CSS 层叠顺序被后面全局规则覆盖的根因问题
  - 桌面端/移动端均配置 `overscroll-behavior:contain` + `touch-action:pan-y` + 惯性滚动，列表区滑动不穿透到 body，移动端触控丝滑
- **管理面板优化**：
  - 曲目列表外层新增 `.tracks-container` 独立滚动容器（`max-height: calc(100vh - 320px) overflow-y:auto`），曲目多时不再让整个页面滚动
  - 新增曲目后容器自动调用 `scrollTo` 滚到底部，直接看到刚加的条目
- **播放页面 UI 精简**：
  - 删除播放器面板上多余的播放/暂停按钮（已可直接点击曲目列表播放），仅保留音量控制和停止按钮，界面更清爽

### v1.5
- **新增卡拉OK歌词引擎**：自动加载与音频同名的 `.lrc` 文件，支持行级 `[mm:ss.xx]` / 字级 `<mm:ss.xx>` 时间戳、双语同时间戳翻译行
- **歌词跳动优化（Foobar2000 习惯兼容）**：
  - 日文 / 汉字等非英文同时间戳合并的多字 → 自动按字符数均分时长**逐字滚动**（例：9字÷2.95s=每字0.328s）
  - 英文词组保持整组整体变色，不拆字符
  - 中间重复时间戳（Foobar2000 `<t>_<t>冬` 打标法）完整保留，归组后再均分滚动
  - 三阶段视觉区分（done绿 / active橙发光 / rest灰），末尾token自动补时避免消失
- **接入原神日式字体**：`Font/JA-JP.TTF` 通过 `/font/JA-JP.TTF` 接口一年缓存分发，全局/管理页/登录页/歌词优先使用 GenshinJA 字体，日文假名与汉字呈现风格统一
- **管理面板曲目卡片默认折叠**：曲目多时默认收起，点击展开，减少滚动长度
- **多目录歌词解析兼容**：`bgm_dirs` 中任意目录的 `.lrc` 可被解析，不再局限默认目录

### v1.4
- **新增跳转段衔接**：loop_end → jump_seg_start → jump_seg_end → loop_start 三段无缝跳转，支持 BGM 副歌循环/桥段插入
- **修复循环提前一拍触发 bug**（93 小节终点变 92 小节触发）
- **淡入淡出 0 拍旧轨自然播完**：不再硬切，单轨/双轨均等音频物理结束 + 增益包络走完再清理节点
- **三重保障防停播**：`onended` 兜底、末尾预跳保护、`start()` 失败重试
- **响应式布局 PC/平板/手机**：移动端主页左侧抽屉菜单，管理页流式 grid

### v1.3
- **新增多目录 BGM 支持**：可在管理页添加多个 BGM 目录（Windows 绝对路径、Android 路径、项目相对路径），每首曲目独立绑定 `bgm_dir_id`；支持目录扫描、状态检测与曲目内按目录筛选文件
- **修复循环逻辑**：优化单轨调度与跳转段衔接，避免循环终点后出现小段静音痕迹
- **修复淡出位置**：`fade_out_start_bar = 0` 时改为自动模式（淡出结束对齐循环终点），不再误将循环终点当作淡出起点；独立指定的淡出起点支持设在循环终点之后，不再被截断忽略

---

## 📜 License
MIT
