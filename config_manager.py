#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
配置键值统一管理系统（独立应用）
================================
- 前后端一体，单文件独立运行
- 账号登录（Session 鉴权）
- 以「键」为维度统一管理：自动提取所有 track 的键并集，不硬编码任何键
- 批量查看/修改同一键在所有 track 中的值
- 检测缺失键、冗余键，支持一键补齐/清理

启动：python config_manager.py
默认端口：5002
默认密码：admin123（首次启动自动生成 password_cm.txt）
"""

import os
import json
import secrets
import argparse
from functools import wraps
from flask import (
    Flask, request, session, jsonify, redirect,
    render_template_string
)

# ============== 路径常量 ==============
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, 'config.json')
PASSWORD_PATH = os.path.join(BASE_DIR, 'password_cm.txt')
SECRET_PATH = os.path.join(BASE_DIR, '.cm_flask_secret')

DEFAULT_PASSWORD = 'admin123'

# ============== 密码管理 ==============
def _load_password():
    if not os.path.exists(PASSWORD_PATH):
        with open(PASSWORD_PATH, 'w', encoding='utf-8') as f:
            f.write(DEFAULT_PASSWORD)
        return DEFAULT_PASSWORD
    try:
        with open(PASSWORD_PATH, 'r', encoding='utf-8') as f:
            return f.read().strip() or DEFAULT_PASSWORD
    except Exception:
        return DEFAULT_PASSWORD

def _init_secret():
    if os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, 'r', encoding='utf-8') as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(SECRET_PATH, 'w', encoding='utf-8') as f:
        f.write(key)
    try:
        os.chmod(SECRET_PATH, 0o600)
    except Exception:
        pass
    return key

# ============== Flask 应用 ==============
app = Flask(__name__)
app.secret_key = _init_secret()

# ============== 鉴权装饰器 ==============
def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get('cm_auth_ok'):
            if request.path.startswith('/cm/api/'):
                return jsonify({"ok": False, "error": "未登录"}), 401
            return redirect('/cm/login')
        return fn(*args, **kwargs)
    return wrapper

# ============== 配置读写 ==============
def _read_config():
    if not os.path.exists(CONFIG_PATH):
        return None, "config.json 不存在"
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            return json.load(f), None
    except Exception as e:
        return None, f"读取失败: {e}"

def _write_config(cfg):
    try:
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        return None
    except Exception as e:
        return f"写入失败: {e}"

# ============== 页面路由 ==============

LOGIN_PAGE = r"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 - 配置键值管理系统</title>
<style>
  :root {
    --primary: #b46fc7; --primary-dark: #9a4eb0; --secondary: #7b6cd9;
    --panel-bg: rgba(255,255,255,0.92); --panel-border: rgba(180,111,199,0.25);
    --text: #3d2b5c; --text-light: #8a7ca8; --danger: #e74c6f;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #e8d5f5 0%, #d4c5f9 50%, #c8b8e8 100%);
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 20px; color: var(--text);
  }
  .login-card {
    width: 100%; max-width: 420px; padding: 36px 32px;
    background: var(--panel-bg); border: 1px solid var(--panel-border);
    border-radius: 22px; box-shadow: 0 12px 40px rgba(180,120,200,0.25);
    backdrop-filter: blur(10px);
  }
  .login-card h1 {
    text-align: center; font-size: 22px; margin-bottom: 8px;
    background: linear-gradient(135deg, var(--primary), var(--secondary));
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; font-weight: 800;
  }
  .login-card .sub { text-align: center; color: var(--text-light); font-size: 13px; margin-bottom: 24px; }
  .form-group { margin-bottom: 18px; }
  .form-group label { display: block; margin-bottom: 8px; font-size: 13px; color: var(--text-light); font-weight: 600; }
  .form-group input {
    width: 100%; padding: 12px 14px; font-size: 15px;
    border: 1px solid rgba(180,111,199,0.35); border-radius: 12px;
    background: rgba(255,255,255,0.8); outline: none; transition: all 0.2s;
    font-family: inherit; color: var(--text);
  }
  .form-group input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(180,111,199,0.15); }
  .error-msg { min-height: 18px; color: var(--danger); font-size: 13px; text-align: center; margin-bottom: 10px; font-weight: 600; }
  .login-btn {
    width: 100%; padding: 13px; color: white; border: none; border-radius: 12px;
    font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit;
    background: linear-gradient(135deg, var(--primary), var(--primary-dark));
    box-shadow: 0 4px 0 rgba(154,78,176,0.15); transition: all 0.2s;
  }
  .login-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 12px rgba(180,111,199,0.3); }
  .login-btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
</head>
<body>
<div class="login-card">
  <h1>🔐 配置键值管理系统</h1>
  <div class="sub">请输入密码进入配置管理</div>
  <div class="form-group">
    <label>密码</label>
    <input type="password" id="pwdInput" placeholder="请输入密码..." autocomplete="current-password" autofocus>
  </div>
  <div class="error-msg" id="errMsg"></div>
  <button class="login-btn" id="loginBtn">登 录</button>
</div>
<script>
const $ = id => document.getElementById(id);
const showErr = m => $('errMsg').textContent = m || '';
async function doLogin() {
  const pwd = $('pwdInput').value;
  if (!pwd.trim()) { showErr('请输入密码'); return; }
  $('loginBtn').disabled = true; showErr('');
  try {
    const r = await fetch('/cm/api/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await r.json();
    if (data.ok) { window.location.href = '/cm'; }
    else { showErr(data.error || '登录失败'); $('pwdInput').select(); }
  } catch (e) { showErr('网络错误：' + e.message); }
  finally { $('loginBtn').disabled = false; }
}
$('loginBtn').addEventListener('click', doLogin);
$('pwdInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
</script>
</body>
</html>
"""

MANAGER_PAGE = r"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>配置键值统一管理系统</title>
<style>
  :root {
    --primary: #b46fc7; --primary-dark: #9a4eb0; --secondary: #7b6cd9;
    --panel-bg: rgba(255,255,255,0.92); --panel-border: rgba(180,111,199,0.2);
    --text: #3d2b5c; --text-light: #8a7ca8;
    --danger: #e74c6f; --success: #5cb85c; --warning: #f0ad4e;
    --code-bg: #f8f5fc; --row-hover: rgba(180,111,199,0.06);
    --missing: rgba(231,76,111,0.08); --missing-border: rgba(231,76,111,0.2);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #e8d5f5 0%, #d4c5f9 50%, #c8b8e8 100%);
    min-height: 100vh; color: var(--text); padding: 12px;
  }
  .container { max-width: 1400px; margin: 0 auto; }
  /* Header */
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; background: var(--panel-bg);
    border: 1px solid var(--panel-border); border-radius: 16px;
    margin-bottom: 12px; backdrop-filter: blur(10px);
    flex-wrap: wrap; gap: 10px;
  }
  .header h1 {
    font-size: 19px; font-weight: 800;
    background: linear-gradient(135deg, var(--primary), var(--secondary));
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; white-space: nowrap;
  }
  .header-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .btn {
    padding: 7px 14px; border: none; border-radius: 9px;
    font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit; transition: all 0.2s; white-space: nowrap;
  }
  .btn-primary { background: linear-gradient(135deg, var(--primary), var(--primary-dark)); color: white; }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 10px rgba(180,111,199,0.3); }
  .btn-danger { background: var(--danger); color: white; }
  .btn-danger:hover { opacity: 0.85; }
  .btn-success { background: var(--success); color: white; }
  .btn-success:hover { opacity: 0.85; }
  .btn-warning { background: var(--warning); color: white; }
  .btn-warning:hover { opacity: 0.85; }
  .btn-ghost { background: transparent; border: 1px solid var(--panel-border); color: var(--text-light); }
  .btn-ghost:hover { background: rgba(180,111,199,0.08); }
  .btn-sm { padding: 4px 9px; font-size: 12px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  /* Tabs */
  .tabs { display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab {
    padding: 8px 18px; border: 1px solid var(--panel-border);
    border-radius: 10px 10px 0 0; cursor: pointer; font-size: 14px;
    font-weight: 600; background: rgba(255,255,255,0.6); color: var(--text-light);
    transition: all 0.2s; border-bottom: none;
  }
  .tab.active {
    background: var(--panel-bg); color: var(--primary-dark);
    border-color: var(--panel-border);
  }
  .tab:hover:not(.active) { color: var(--text); }
  /* Panel */
  .panel {
    background: var(--panel-bg); border: 1px solid var(--panel-border);
    border-radius: 0 12px 12px 12px; padding: 16px; backdrop-filter: blur(10px);
    min-height: 500px;
  }
  /* Table */
  .table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid var(--panel-border); }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  thead th {
    background: linear-gradient(135deg, rgba(180,111,199,0.1), rgba(123,108,217,0.1));
    padding: 8px 10px; text-align: left; font-weight: 700; color: var(--primary-dark);
    border-bottom: 2px solid var(--panel-border); white-space: nowrap;
    position: sticky; top: 0; z-index: 1; cursor: pointer; user-select: none;
  }
  thead th:hover { background: rgba(180,111,199,0.15); }
  thead th .col-stats { font-size: 10px; color: var(--text-light); font-weight: 400; }
  thead th .col-type { font-size: 9px; padding: 1px 4px; border-radius: 3px; background: rgba(123,108,217,0.15); color: var(--secondary); margin-left: 4px; }
  tbody td {
    padding: 6px 10px; border-bottom: 1px solid rgba(180,111,199,0.08);
    vertical-align: middle; max-width: 300px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  tbody tr:hover { background: var(--row-hover); }
  tbody td.missing { background: var(--missing); color: var(--danger); font-style: italic; font-size: 12px; }
  tbody td.editable { cursor: text; }
  tbody td.editable:hover { background: rgba(180,111,199,0.1); }
  .track-name { font-weight: 700; color: var(--primary-dark); white-space: nowrap; }
  .track-cat { font-size: 11px; color: var(--text-light); }
  /* Edit input */
  .cell-input {
    width: 100%; padding: 3px 6px; border: 1px solid var(--primary);
    border-radius: 5px; font-size: 13px; font-family: "Consolas", monospace;
    background: white; color: var(--text); outline: none;
  }
  .cell-select { width: 100%; padding: 3px 6px; border: 1px solid var(--primary); border-radius: 5px; font-size: 13px; background: white; }
  /* Checkbox */
  .row-check, .col-check { cursor: pointer; width: 16px; height: 16px; }
  /* Toolbar */
  .toolbar {
    display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; align-items: center;
  }
  .search-box {
    flex: 1; min-width: 180px; padding: 7px 12px;
    border: 1px solid var(--panel-border); border-radius: 9px;
    background: white; font-size: 13px; font-family: inherit;
  }
  .search-box:focus { outline: none; border-color: var(--primary); }
  .info-text { font-size: 12px; color: var(--text-light); }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 700;
  }
  .badge-warning { background: rgba(240,173,78,0.2); color: var(--warning); }
  .badge-danger { background: rgba(231,76,111,0.15); color: var(--danger); }
  .badge-success { background: rgba(92,184,92,0.15); color: var(--success); }
  /* Batch bar */
  .batch-bar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 10px 14px; background: rgba(180,111,199,0.08);
    border-radius: 10px; margin-bottom: 10px;
  }
  .batch-bar select, .batch-bar input {
    padding: 6px 10px; border: 1px solid var(--panel-border);
    border-radius: 8px; font-size: 13px; font-family: inherit; background: white;
  }
  /* Key analysis */
  .key-list { display: flex; flex-direction: column; gap: 6px; }
  .key-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    border: 1px solid var(--panel-border); border-radius: 10px;
    background: white; transition: all 0.15s;
  }
  .key-item:hover { border-color: var(--primary); box-shadow: 0 2px 8px rgba(180,111,199,0.1); }
  .key-item.missing-key { border-color: var(--missing-border); background: var(--missing); }
  .key-item.redundant-key { border-color: rgba(240,173,78,0.3); background: rgba(240,173,78,0.05); }
  .key-name { font-weight: 700; color: var(--primary-dark); min-width: 180px; font-size: 14px; }
  .key-stats { font-size: 12px; color: var(--text-light); flex: 1; }
  .key-actions { display: flex; gap: 4px; }
  .coverage-bar {
    width: 80px; height: 6px; border-radius: 3px; background: rgba(180,111,199,0.15); overflow: hidden;
  }
  .coverage-fill { height: 100%; border-radius: 3px; background: var(--success); transition: width 0.3s; }
  /* Modal */
  .modal-mask {
    position: fixed; inset: 0; background: rgba(60,40,80,0.4);
    display: flex; align-items: center; justify-content: center;
    z-index: 3000; backdrop-filter: blur(4px);
  }
  .modal-card {
    width: 90%; max-width: 500px; background: white;
    border-radius: 18px; padding: 24px 22px;
    box-shadow: 0 20px 60px rgba(60,40,80,0.3);
  }
  .modal-card h3 { font-size: 17px; margin-bottom: 14px; color: var(--text); }
  .modal-card label { display: block; margin-bottom: 6px; font-size: 13px; color: var(--text-light); font-weight: 600; }
  .modal-card input, .modal-card select, .modal-card textarea {
    width: 100%; padding: 9px 11px; font-size: 14px;
    border: 1px solid var(--panel-border); border-radius: 9px;
    font-family: inherit; outline: none; background: white; margin-bottom: 12px;
  }
  .modal-card input:focus, .modal-card select:focus { border-color: var(--primary); }
  .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
  /* Toast */
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    padding: 11px 22px; border-radius: 11px; color: white;
    font-size: 14px; font-weight: 600; z-index: 4000;
    box-shadow: 0 6px 20px rgba(0,0,0,0.2); animation: toastIn 0.3s ease;
  }
  .toast-success { background: var(--success); }
  .toast-error { background: var(--danger); }
  @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }
  .empty-state { text-align: center; padding: 60px 20px; color: var(--text-light); }
  .empty-state .icon { font-size: 48px; margin-bottom: 12px; }
  .json-view {
    background: var(--code-bg); border: 1px solid var(--panel-border);
    border-radius: 10px; padding: 12px; font-family: "Consolas", monospace;
    font-size: 13px; line-height: 1.6; max-height: 500px; overflow: auto;
    white-space: pre-wrap; word-break: break-all;
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>⚙️ 配置键值统一管理系统</h1>
    <div class="header-actions">
      <span class="info-text" id="trackCount"></span>
      <button class="btn btn-ghost btn-sm" id="refreshBtn">🔄 刷新</button>
      <button class="btn btn-ghost btn-sm" id="rawBtn">📄 原始JSON</button>
      <button class="btn btn-primary btn-sm" id="saveBtn">💾 保存</button>
      <button class="btn btn-danger btn-sm" id="logoutBtn">退出</button>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="grid">📊 键值表格</div>
    <div class="tab" data-tab="analysis">🔍 键分析</div>
  </div>

  <div class="panel" id="panel-grid">
    <div class="toolbar">
      <input class="search-box" id="searchInput" placeholder="🔍 搜索曲目名或键名...">
      <span class="info-text" id="selInfo"></span>
    </div>
    <div class="batch-bar" id="batchBar" style="display:none;">
      <span class="info-text">已选 <b id="selCount">0</b> 个曲目</span>
      <select id="batchKey">
        <option value="">-- 选择键 --</option>
      </select>
      <input id="batchValue" placeholder="输入新值..." style="flex:1;min-width:150px;">
      <button class="btn btn-warning btn-sm" id="batchApplyBtn">批量应用</button>
      <button class="btn btn-ghost btn-sm" id="batchClearBtn">取消选择</button>
    </div>
    <div class="table-wrap" id="tableWrap">
      <div class="empty-state"><div class="icon">⏳</div><div class="text">加载中...</div></div>
    </div>
  </div>

  <div class="panel" id="panel-analysis" style="display:none;">
    <div class="toolbar">
      <button class="btn btn-success btn-sm" id="fillAllBtn">一键补齐缺失键</button>
      <button class="btn btn-danger btn-sm" id="cleanRedundantBtn">清理冗余键</button>
      <span class="info-text" id="analysisStats"></span>
    </div>
    <div class="key-list" id="keyList">
      <div class="empty-state"><div class="icon">⏳</div><div class="text">加载中...</div></div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
let cfgData = null;
let tracks = [];
let allKeys = [];
let keyTypes = {};
let selectedRows = new Set();
let currentTab = 'grid';
let searchQuery = '';

// ============ API ============
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, credentials: 'include' });
  return r.json();
}

// ============ Toast ============
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ============ 类型检测 ============
function getType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function valDisplay(v, maxLen = 60) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v.length > maxLen ? v.substring(0, maxLen) + '...' : v;
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length}项]` : `{${Object.keys(v).length}键}`;
  return String(v);
}
function valForInput(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ============ 加载数据 ============
async function loadData() {
  const data = await api('/cm/api/config');
  if (!data.ok) { toast(data.error, 'error'); return; }
  cfgData = data.data;
  tracks = Array.isArray(cfgData.tracks) ? cfgData.tracks : [];
  extractKeys();
  renderAll();
}

function extractKeys() {
  const keySet = new Set();
  keyTypes = {};
  tracks.forEach(t => {
    if (typeof t !== 'object' || t === null) return;
    Object.keys(t).forEach(k => {
      keySet.add(k);
      const t2 = getType(t[k]);
      if (!keyTypes[k]) keyTypes[k] = new Set();
      keyTypes[k].add(t2);
    });
  });
  // 排除复杂嵌套键（对象/数组）在表格中直接编辑，但仍显示
  allKeys = Array.from(keySet).sort();
}

// ============ 渲染表格 ============
function renderTable() {
  const wrap = $('tableWrap');
  if (tracks.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="icon">📭</div><div class="text">没有曲目数据</div></div>';
    return;
  }

  // 过滤
  let displayTracks = tracks.map((t, i) => ({ t, i }));
  if (searchQuery) {
    displayTracks = displayTracks.filter(({t}) => {
      const name = String(t.name || '').toLowerCase();
      const cat = String(t.category || '').toLowerCase();
      return name.includes(searchQuery) || cat.includes(searchQuery);
    });
  }

  let html = '<table><thead><tr>';
  // 选择列
  html += '<th style="width:36px;"><input type="checkbox" class="col-check" id="checkAll"></th>';
  // 曲名列
  html += '<th style="min-width:140px;">曲目</th>';
  // 键列
  allKeys.forEach(k => {
    const types = Array.from(keyTypes[k] || []);
    const typeStr = types.join('|');
    const coverage = getKeyCoverage(k);
    html += `<th data-key="${k}" title="点击选中此列所有曲目">
      ${k}
      <span class="col-type">${typeStr}</span>
      <br><span class="col-stats">${coverage}/${tracks.length}</span>
    </th>`;
  });
  html += '</tr></thead><tbody>';

  displayTracks.forEach(({t, i}) => {
    const checked = selectedRows.has(i) ? 'checked' : '';
    html += `<tr data-idx="${i}">`;
    html += `<td style="text-align:center;"><input type="checkbox" class="row-check" data-idx="${i}" ${checked}></td>`;
    html += `<td><div class="track-name">${t.name || '(未命名)'}</div><div class="track-cat">${t.category || ''}</div></td>`;
    allKeys.forEach(k => {
      const has = (k in t);
      const val = t[k];
      const type = getType(val);
      const isComplex = type === 'object' || type === 'array';
      const displayVal = valDisplay(val);

      if (!has) {
        html += `<td class="missing" data-key="${k}" data-idx="${i}" title="缺失键">— 缺失</td>`;
      } else if (isComplex) {
        html += `<td data-key="${k}" data-idx="${i}" title="${valForInput(val).replace(/"/g,'&quot;')}" style="color:var(--text-light);font-size:12px;">${displayVal}</td>`;
      } else {
        html += `<td class="editable" data-key="${k}" data-idx="${i}" data-type="${type}" title="点击编辑">${displayVal}</td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  // 绑定事件
  bindTableEvents();
  updateSelInfo();
}

function bindTableEvents() {
  // 行选择
  document.querySelectorAll('.row-check').forEach(cb => {
    cb.onchange = () => {
      const idx = parseInt(cb.dataset.idx);
      if (cb.checked) selectedRows.add(idx);
      else selectedRows.delete(idx);
      updateSelInfo();
    };
  });
  // 全选
  const checkAll = $('checkAll');
  if (checkAll) {
    checkAll.onchange = () => {
      if (checkAll.checked) {
        tracks.forEach((_, i) => selectedRows.add(i));
      } else {
        selectedRows.clear();
      }
      renderTable();
    };
  }
  // 单元格编辑
  document.querySelectorAll('td.editable').forEach(td => {
    td.onclick = () => startEditCell(td);
  });
  // 列头点击选中该列所有缺失/全部
  document.querySelectorAll('thead th[data-key]').forEach(th => {
    th.onclick = () => {
      const k = th.dataset.key;
      // 选中所有缺失该键的曲目
      tracks.forEach((t, i) => {
        if (!(k in t)) selectedRows.add(i);
      });
      renderTable();
      toast(`已选中缺失 "${k}" 的曲目`);
    };
  });
}

function startEditCell(td) {
  const key = td.dataset.key;
  const idx = parseInt(td.dataset.idx);
  const type = td.dataset.type;
  const oldVal = tracks[idx][key];
  td.classList.remove('editable');
  td.onclick = null;
  td.innerHTML = '';

  let input;
  if (type === 'boolean') {
    input = document.createElement('select');
    input.className = 'cell-select';
    input.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    input.value = String(oldVal);
  } else {
    input = document.createElement('input');
    input.className = 'cell-input';
    input.value = valForInput(oldVal);
  }
  // 阻止点击冒泡到 td 导致重新渲染
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('mousedown', e => e.stopPropagation());
  td.appendChild(input);
  input.focus();
  if (input.select) input.select();

  let committed = false;
  const restoreCell = (val) => {
    td.textContent = valDisplay(val);
    td.classList.add('editable');
    td.onclick = () => startEditCell(td);
  };
  const commit = () => {
    if (committed) return;
    committed = true;
    let newVal = input.value;
    if (type === 'number') {
      const n = Number(newVal);
      newVal = isNaN(n) ? oldVal : n;
    } else if (type === 'boolean') {
      newVal = newVal === 'true';
    }
    tracks[idx][key] = newVal;
    restoreCell(newVal);
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    restoreCell(oldVal);
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  if (type === 'boolean') {
    input.onchange = () => commit();
    input.onblur = () => setTimeout(() => commit(), 150);
  } else {
    input.onblur = () => commit();
  }
}

// ============ 键覆盖率 ============
function getKeyCoverage(key) {
  return tracks.filter(t => key in t).length;
}

// ============ 选择信息 ============
function updateSelInfo() {
  const n = selectedRows.size;
  $('selInfo').textContent = n > 0 ? `已选 ${n} 个曲目` : '';
  $('batchBar').style.display = n > 0 ? 'flex' : 'none';
  $('selCount').textContent = n;

  // 填充批量键选择
  const sel = $('batchKey');
  sel.innerHTML = '<option value="">-- 选择键 --</option>';
  allKeys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = `${k} (${getKeyCoverage(k)}/${tracks.length})`;
    sel.appendChild(opt);
  });
}

// ============ 批量应用 ============
$('batchApplyBtn').onclick = () => {
  const key = $('batchKey').value;
  const valStr = $('batchValue').value;
  if (!key) { toast('请选择键', 'error'); return; }
  if (selectedRows.size === 0) { toast('请先选择曲目', 'error'); return; }

  // 自动推断类型
  let val = valStr;
  if (valStr === 'true') val = true;
  else if (valStr === 'false') val = false;
  else if (valStr === 'null') val = null;
  else if (valStr !== '' && !isNaN(Number(valStr))) val = Number(valStr);

  selectedRows.forEach(i => {
    if (tracks[i]) tracks[i][key] = val;
  });
  renderTable();
  renderAnalysis();
  toast(`已对 ${selectedRows.size} 个曲目设置 "${key}" = ${JSON.stringify(val)}（记得保存）`);
};

$('batchClearBtn').onclick = () => {
  selectedRows.clear();
  renderTable();
};

// ============ 键分析 ============
function renderAnalysis() {
  const list = $('keyList');
  if (allKeys.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📭</div><div class="text">没有键数据</div></div>';
    return;
  }

  let html = '';
  let missingCount = 0, redundantCount = 0, fullCount = 0;

  allKeys.forEach(k => {
    const coverage = getKeyCoverage(k);
    const total = tracks.length;
    const isFull = coverage === total;
    const isMissing = coverage < total;
    // 冗余键定义：只有少数曲目有（覆盖率 < 50%）
    const isRedundant = coverage > 0 && coverage < total * 0.5;

    if (isMissing) missingCount++;
    if (isRedundant) redundantCount++;
    if (isFull) fullCount++;

    const pct = total > 0 ? (coverage / total * 100) : 0;
    const cls = isRedundant ? 'redundant-key' : (isMissing ? 'missing-key' : '');
    const badge = isFull
      ? '<span class="badge badge-success">完整</span>'
      : (isRedundant ? `<span class="badge badge-warning">冗余</span>` : `<span class="badge badge-danger">缺失</span>`);

    // 找缺失的曲目
    const missingTracks = tracks
      .map((t, i) => ({name: t.name || `(未命名#${i})`, has: k in t}))
      .filter(t => !t.has)
      .map(t => t.name);

    html += `
      <div class="key-item ${cls}">
        <span class="key-name">${k}</span>
        ${badge}
        <span class="key-stats">
          覆盖: ${coverage}/${total} (${pct.toFixed(0)}%)
          <br>类型: ${Array.from(keyTypes[k]||[]).join(', ')}
          ${missingTracks.length > 0 ? `<br>缺失: ${missingTracks.join(', ')}` : ''}
        </span>
        <div class="coverage-bar"><div class="coverage-fill" style="width:${pct}%;${pct<50?'background:var(--warning);':''}${pct<100&&pct>=50?'background:var(--primary);':''}"></div></div>
        <div class="key-actions">
          ${isMissing ? `<button class="btn btn-success btn-sm" onclick="fillKey('${k}')">补齐</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="deleteKeyAll('${k}')">全删</button>
        </div>
      </div>
    `;
  });

  list.innerHTML = html;
  $('analysisStats').textContent = `共 ${allKeys.length} 个键 | 完整: ${fullCount} | 缺失: ${missingCount} | 冗余: ${redundantCount}`;
}

// ============ 补齐键 ============
window.fillKey = function(key) {
  // 找一个参考值（第一个有该键的曲目）
  let refVal = null;
  for (const t of tracks) {
    if (key in t) { refVal = t[key]; break; }
  }
  let count = 0;
  tracks.forEach(t => {
    if (!(key in t)) {
      // 深拷贝参考值
      t[key] = refVal === null ? null : (typeof refVal === 'object' ? JSON.parse(JSON.stringify(refVal)) : refVal);
      count++;
    }
  });
  extractKeys();
  renderTable();
  renderAnalysis();
  toast(`已补齐 ${count} 个曲目的 "${key}"（记得保存）`);
};

// ============ 删除键 ============
window.deleteKeyAll = function(key) {
  if (!confirm(`确定从所有曲目中删除 "${key}"？`)) return;
  tracks.forEach(t => { delete t[key]; });
  extractKeys();
  renderTable();
  renderAnalysis();
  toast(`已删除 "${key}"（记得保存）`);
};

// ============ 一键补齐所有缺失 ============
$('fillAllBtn').onclick = () => {
  let total = 0;
  allKeys.forEach(k => {
    let refVal = null;
    for (const t of tracks) {
      if (k in t) { refVal = t[k]; break; }
    }
    tracks.forEach(t => {
      if (!(k in t)) {
        t[k] = refVal === null ? null : (typeof refVal === 'object' ? JSON.parse(JSON.stringify(refVal)) : refVal);
        total++;
      }
    });
  });
  extractKeys();
  renderTable();
  renderAnalysis();
  toast(`已补齐 ${total} 处缺失键（记得保存）`);
};

// ============ 清理冗余键 ============
$('cleanRedundantBtn').onclick = () => {
  if (!confirm('清理所有冗余键（覆盖率<50%的键将从所有曲目中删除）？')) return;
  let total = 0;
  allKeys.forEach(k => {
    const coverage = getKeyCoverage(k);
    if (coverage > 0 && coverage < tracks.length * 0.5) {
      tracks.forEach(t => { delete t[k]; });
      total++;
    }
  });
  extractKeys();
  renderTable();
  renderAnalysis();
  toast(`已清理 ${total} 个冗余键（记得保存）`);
};

// ============ 保存 ============
$('saveBtn').onclick = async () => {
  if (!cfgData) return;
  cfgData.tracks = tracks;
  const data = await api('/cm/api/config/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: cfgData })
  });
  if (data.ok) { toast('保存成功'); await loadData(); }
  else { toast(data.error, 'error'); }
};

// ============ 原始 JSON ============
$('rawBtn').onclick = () => {
  if (!cfgData) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal-card" style="max-width:700px;">
      <h3>📄 原始 JSON</h3>
      <div class="json-view">${JSON.stringify(cfgData, null, 2).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="this.closest('.modal-mask').remove()">关闭</button>
        <button class="btn btn-primary" id="copyJsonBtn">复制</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.querySelector('#copyJsonBtn').onclick = () => {
    navigator.clipboard.writeText(JSON.stringify(cfgData, null, 2));
    toast('已复制');
  };
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
};

// ============ Tab 切换 ============
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    $('panel-grid').style.display = currentTab === 'grid' ? '' : 'none';
    $('panel-analysis').style.display = currentTab === 'analysis' ? '' : 'none';
  };
});

// ============ 其他事件 ============
$('refreshBtn').onclick = () => loadData();
$('logoutBtn').onclick = async () => {
  await api('/cm/api/logout', { method: 'POST' });
  window.location.href = '/cm/login';
};
$('searchInput').oninput = e => {
  searchQuery = e.target.value.toLowerCase().trim();
  renderTable();
};

// ============ 渲染全部 ============
function renderAll() {
  $('trackCount').textContent = `共 ${tracks.length} 个曲目，${allKeys.length} 个键`;
  renderTable();
  renderAnalysis();
}

// ============ 初始化 ============
loadData();
</script>
</body>
</html>
"""

# ============== API 路由 ==============

@app.route('/cm/login')
def cm_login_page():
    return render_template_string(LOGIN_PAGE)

@app.route('/cm')
@login_required
def cm_index():
    return render_template_string(MANAGER_PAGE)

@app.route('/cm/api/login', methods=['POST'])
def cm_api_login():
    data = request.get_json(silent=True) or {}
    pwd = (data.get('password') or '').strip()
    if pwd == _load_password():
        session['cm_auth_ok'] = True
        return jsonify({"ok": True, "data": {"redirect": "/cm"}})
    return jsonify({"ok": False, "error": "密码错误"}), 401

@app.route('/cm/api/logout', methods=['POST'])
def cm_api_logout():
    session.pop('cm_auth_ok', None)
    return jsonify({"ok": True})

@app.route('/cm/api/session')
def cm_api_session():
    return jsonify({"ok": True, "data": {"authed": bool(session.get('cm_auth_ok'))}})

@app.route('/cm/api/config')
@login_required
def cm_api_config_get():
    data, err = _read_config()
    if err:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "data": data})

@app.route('/cm/api/config/save', methods=['POST'])
@login_required
def cm_api_config_save():
    body = request.get_json(silent=True) or {}
    data = body.get('data')
    if data is None:
        return jsonify({"ok": False, "error": "缺少数据"}), 400
    err = _write_config(data)
    if err:
        return jsonify({"ok": False, "error": err}), 500
    return jsonify({"ok": True})

@app.route('/cm/api/change-password', methods=['POST'])
@login_required
def cm_api_change_password():
    data = request.get_json(silent=True) or {}
    old = (data.get('old_password') or '').strip()
    new = (data.get('new_password') or '').strip()
    if len(new) < 4:
        return jsonify({"ok": False, "error": "新密码至少4位"}), 400
    if old != _load_password():
        return jsonify({"ok": False, "error": "旧密码错误"}), 400
    with open(PASSWORD_PATH, 'w', encoding='utf-8') as f:
        f.write(new)
    return jsonify({"ok": True})

# ============== 入口 ==============
def main():
    parser = argparse.ArgumentParser(description='配置键值统一管理系统')
    parser.add_argument('--port', type=int, default=5002, help='端口号（默认 5002）')
    parser.add_argument('--host', default='0.0.0.0', help='监听地址（默认 0.0.0.0）')
    args = parser.parse_args()

    _load_password()

    print("=" * 50)
    print("  ⚙️  配置键值统一管理系统")
    print(f"  本机:   http://127.0.0.1:{args.port}/cm")
    print(f"  登录:   http://127.0.0.1:{args.port}/cm/login")
    print(f"  默认密码: {DEFAULT_PASSWORD}  (可在 password_cm.txt 中修改)")
    print("=" * 50)

    app.run(host=args.host, port=args.port, debug=False)

if __name__ == '__main__':
    main()
