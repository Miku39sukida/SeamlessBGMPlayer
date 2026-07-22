# 🖥️ Electron Web Browser

基于 Electron 框架的轻量网页浏览器，集成桌面悬浮歌词功能，专为配合 [无缝循环播放器](https://github.com/Miku39sukida/SeamlessBGMPlayer) 使用而设计。

> 版本：**1.0**  
> License：MIT  
> 配合使用：[无缝循环播放器](https://github.com/Miku39sukida/SeamlessBGMPlayer)

---

## ✨ 功能特性

### 🌐 轻量网页浏览
- **简洁界面**：无多余工具栏，专注浏览体验
- **多标签页**：支持打开多个网页
- **下载管理**：内置下载管理器，支持断点续传
- **全屏模式**：F11 切换全屏

### 🎤 桌面悬浮歌词
- **透明置顶窗口**：无边框、透明背景、始终置顶显示
- **卡拉OK模式**：逐字高亮已唱/正在唱/未唱歌词
- **双语显示**：支持原文+译文同步显示
- **自由拖动**：鼠标拖动调整位置，自动保存位置
- **自动跟随关闭**：关闭播放器页面时自动关闭悬浮歌词

### ⚙️ 歌词设置
- **字体自定义**：选择系统已安装的字体（如原神 SDK_SC_Web）
- **颜色调整**：自定义歌词颜色和阴影颜色
- **字号调节**：支持多档字号选择
- **卡拉OK模式开关**：一键切换逐字高亮模式

---

## 🚀 快速开始

### 依赖
- **Node.js 18+**
- **npm**

### 安装 & 启动

```bash
# 1. 克隆或解压项目后进入目录
git clone https://github.com/Miku39sukida/Electron-Web-Browser.git
cd Electron-Web-Browser

# 2. 安装依赖
npm install

# 3. 启动应用
npm start
```

### 一键启动（Windows）
双击 `start.vbs` 脚本，自动检查 Node.js/npm 是否安装，未安装则提示并打开安装终端。

---

## 📁 目录结构

```
Electron-Web-Browser/
├── main.js             # Electron 主进程（窗口管理、IPC通信、API）
├── preload.js          # 预加载脚本（渲染进程与主进程通信桥接）
├── index.html          # 主窗口页面（浏览器界面）
├── desktop-lyric.html  # 悬浮歌词窗口
├── lyric-settings.html # 歌词设置窗口
├── downloads.html      # 下载管理页面
├── package.json        # npm 依赖配置
├── start.vbs           # Windows 一键启动脚本
└── icon/               # 应用图标
```

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+L` | 切换悬浮歌词交互模式（点击歌词区域也可切换） |
| `F11` | 切换全屏模式 |
| `Ctrl+T` | 新建标签页 |
| `Ctrl+W` | 关闭当前标签页 |

---

## 🎵 使用场景

1. **配合无缝循环播放器**：打开播放器网页后，点击"悬浮歌词"按钮，歌词会在桌面置顶显示
2. **单独使用**：作为轻量浏览器使用，支持网页浏览和下载
3. **卡拉OK模式**：播放包含 LRC 逐字时间戳的歌曲时，开启卡拉OK模式体验逐字高亮

---

## 🧱 技术栈

| 层 | 技术选型 |
|----|----------|
| 框架 | Electron 32 |
| 前端 | 原生 HTML/CSS/JavaScript |
| 字体读取 | font-list |
| 存储 | localStorage + 文件系统 |

---

## 📋 更新日志

### v1.0
- **初始版本**：轻量网页浏览器 + 桌面悬浮歌词 + 歌词设置
- **系统字体读取**：支持选择电脑已安装的所有字体
- **卡拉OK模式**：逐字高亮歌词，实时同步播放进度
- **自动跟随关闭**：关闭播放器窗口时悬浮歌词自动关闭

---

## 📦 资源来源

- **节拍器音效**：通过 Google 搜索找到，来源于 [Pixabay](https://pixabay.com/zh/sound-effects/search/%E8%8A%82%E6%8B%8D%E5%99%A8/)

---

## 📜 License
MIT
