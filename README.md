# 🎵 无缝循环播放器 v1.3

基于 **BPM 节拍对齐 + Web Audio API 双轨调度** 的毫秒级无缝 BGM 循环网页播放器。自带密码保护的 Web 管理后台，支持多目录 BGM 管理、精确到 5 位小数的 BPM 参数、双轨/单轨两种循环模式、跳转段衔接，并对 PC / 平板 / 移动端浏览器全面响应式适配。

> 版本：**1.3**  
> License：MIT

---
## 💡 前置准备
由于GitHub单文件不得超过25MB，所以我上传到网盘了，下载[这个文件](https://share.feijipan.com/s/eKeQkOas)，并放到 `./BGM` 目录，运行就能测试了。

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
  - 管理页：顶部 header 两行、工具栏 2 列 grid、目录表单单列、曲目卡片所有字段降为单列、按钮点击区 ≥ 40px
- **二次元风格界面**：粉色/紫色渐变、毛玻璃面板、节拍指示灯小点随小节脉冲

---

## 🚀 快速开始

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

### v1.3
- **新增多目录 BGM 支持**：可在管理页添加多个 BGM 目录（Windows 绝对路径、Android 路径、项目相对路径），每首曲目独立绑定 `bgm_dir_id`；支持目录扫描、状态检测与曲目内按目录筛选文件
- **修复循环逻辑**：优化单轨调度与跳转段衔接，避免循环终点后出现小段静音痕迹
- **修复淡出位置**：`fade_out_start_bar = 0` 时改为自动模式（淡出结束对齐循环终点），不再误将循环终点当作淡出起点；独立指定的淡出起点支持设在循环终点之后，不再被截断忽略

---

## 📜 License
MIT
