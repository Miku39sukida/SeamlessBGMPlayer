import os
import re
import json
import uuid
import secrets
import mimetypes
from functools import wraps
from flask import Flask, send_file, send_from_directory, jsonify, request, session, redirect

mimetypes.add_type('font/ttf', '.ttc')
mimetypes.add_type('font/ttf', '.ttf')

app = Flask(__name__, static_folder='static', template_folder='templates')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BGM_DIR = os.path.join(BASE_DIR, 'BGM')
CONFIG_PATH = os.path.join(BASE_DIR, 'config.json')
PASSWORD_PATH = os.path.join(BASE_DIR, 'password.txt')
SECRET_PATH = os.path.join(BASE_DIR, '.flask_secret')

AUDIO_EXTS = ('.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.opus')
DEFAULT_DIR_ID = 'default'

DEFAULT_PASSWORD = 'admin123'
DEFAULT_CONFIG = {
    "bgm_dirs": [
        {"id": DEFAULT_DIR_ID, "label": "默认目录", "path": "./BGM"}
    ],
    "tracks": [
        {
            "name": "Waifu 4 Laifu",
            "category": "未分类",
            "filename": "01_35 - Waifu 4 Laifu.wav",
            "bgm_dir_id": DEFAULT_DIR_ID,
            "bpm": 160.0,
            "beats_per_bar": 4,
            "audio_zero_bar": 1,
            "audio_zero_beat": 4,
            "loop_start_bar": 5,
            "loop_start_beat": 1,
            "loop_end_bar": 62,
            "loop_end_beat": 1,
            "fade_in_beats": 0,
            "fade_out_beats": 0,
            "crossfade_beats": 0,
            "loop_mode": "single",
            "font_face": "default"
        }
    ]
}

def _init_secrets():
    if os.path.exists(SECRET_PATH):
        with open(SECRET_PATH, 'r', encoding='utf-8') as f:
            app.secret_key = f.read().strip()
    else:
        app.secret_key = secrets.token_hex(32)
        with open(SECRET_PATH, 'w', encoding='utf-8') as f:
            f.write(app.secret_key)
        try:
            os.chmod(SECRET_PATH, 0o600)
        except Exception:
            pass

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

# ============== 跨系统路径规范化工具 ==============
def normalize_path(raw_path):
    """把 Windows / Android / 相对路径 规范化为本地绝对路径。
    输入示例：
      -  Windows:  "C:\\Users\\XXX\\Music" 或 "C:/Users/XXX/Music"
      -  Android:  "/sdcard/Music/XXX"
      -  相对:     "./BGM" 或 "BGM"
    返回: (绝对路径字符串, 是否存在, 是否是目录)
    """
    if not raw_path:
        return '', False, False
    s = str(raw_path).strip().strip('"').strip("'")
    # 把反斜杠全部统一为 os.sep（normpath 会处理，但先统一避免奇怪问题）
    s = s.replace('\\', os.sep).replace('/', os.sep)
    # 处理开头可能多出来的分隔符（Android 路径在 Windows 下会被当作相对路径，保留原样由后续 normpath）
    s = os.path.normpath(s)
    # 相对路径 → 基于 BASE_DIR 展开
    if not os.path.isabs(s):
        s = os.path.join(BASE_DIR, s)
        s = os.path.normpath(s)
    exists = os.path.exists(s)
    is_dir = exists and os.path.isdir(s)
    return s, exists, is_dir

def _path_to_display(raw_path):
    """存的是规范化前的用户输入，规范化路径逆向回显时直接显示即可。"""
    return str(raw_path or '')

def load_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))
    if not isinstance(cfg, dict):
        cfg = {}
    # 向后兼容：没有 bgm_dirs 字段就注入默认
    if not isinstance(cfg.get('bgm_dirs'), list) or len(cfg['bgm_dirs']) == 0:
        cfg['bgm_dirs'] = [
            {"id": DEFAULT_DIR_ID, "label": "默认目录", "path": "./BGM"}
        ]
    # 确保默认目录始终在（若用户误删，自动补回，防止老曲目找不到）
    has_default = any(d.get('id') == DEFAULT_DIR_ID for d in cfg['bgm_dirs'] if isinstance(d, dict))
    if not has_default:
        cfg['bgm_dirs'].insert(0, {"id": DEFAULT_DIR_ID, "label": "默认目录", "path": "./BGM"})
    # tracks 保底
    if not isinstance(cfg.get('tracks'), list):
        cfg['tracks'] = []
    for t in cfg['tracks']:
        if not isinstance(t, dict):
            continue
        if not t.get('category'):
            t['category'] = '未分类'
    return cfg

def save_config_raw(cfg):
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

# ============== BGM 目录辅助 ==============
def get_bgm_dirs_info(cfg=None):
    """返回带 exists / is_dir / count 状态的目录列表。"""
    if cfg is None:
        cfg = load_config()
    result = []
    for d in cfg.get('bgm_dirs', []):
        if not isinstance(d, dict):
            continue
        abs_path, exists, is_dir = normalize_path(d.get('path', ''))
        count = 0
        if exists and is_dir:
            try:
                count = sum(1 for n in os.listdir(abs_path) if n.lower().endswith(AUDIO_EXTS))
            except Exception:
                count = 0
        result.append({
            "id": d.get('id', ''),
            "label": d.get('label', ''),
            "path": d.get('path', ''),   # 用户原始输入（含跨系统路径形态）
            "abs_path": abs_path,
            "exists": exists,
            "is_dir": is_dir,
            "file_count": count,
        })
    return result

def _find_dir_cfg(cfg, dir_id):
    for d in cfg.get('bgm_dirs', []):
        if isinstance(d, dict) and d.get('id') == dir_id:
            return d
    return None

def _collect_all_bgm_entries(dirs_info, search=None):
    """根据 dirs_info（get_bgm_dirs_info 的返回）生成 flat files 列表，
    每个 entry 形如 {dir_id, dir_label, filename}，与 /api/bgm-list 兼容。
    """
    out = []
    sq = (search or '').strip().lower()
    for d in dirs_info:
        if not d.get('is_dir') or not d.get('exists'):
            continue
        try:
            names = sorted(os.listdir(d['abs_path']))
        except Exception:
            continue
        for n in names:
            if not n.lower().endswith(AUDIO_EXTS):
                continue
            if sq and sq not in n.lower():
                continue
            out.append({
                "dir_id": d['id'],
                "dir_label": d.get('label', d['id']),
                "filename": n,
            })
    return out

def list_audio_files(dir_abs_path, search=None):
    """列出目录下的音频文件，可选搜索过滤（不区分大小写）。返回文件名列表（sorted）。"""
    if not dir_abs_path or not os.path.isdir(dir_abs_path):
        return []
    try:
        names = sorted(os.listdir(dir_abs_path))
    except Exception:
        return []
    out = []
    sq = (search or '').strip().lower()
    for n in names:
        if not n.lower().endswith(AUDIO_EXTS):
            continue
        if sq and sq not in n.lower():
            continue
        out.append(n)
    return out

def resolve_bgm_file(filename, dir_id=None, cfg=None):
    """根据文件名和 dir_id 解析到本地绝对路径。
    策略：
      - dir_id 有效 → 只在该目录找
      - dir_id 为空/无效 → 先按默认目录找；找不到则遍历所有目录按 basename 匹配（兼容旧配置）
    返回: 绝对路径 或 None
    """
    if not filename:
        return None
    if cfg is None:
        cfg = load_config()
    base_name = os.path.basename(filename)
    dirs_info = get_bgm_dirs_info(cfg)
    if dir_id:
        for d in dirs_info:
            if d['id'] == dir_id and d['is_dir']:
                cand = os.path.join(d['abs_path'], base_name)
                if os.path.isfile(cand):
                    return cand
        return None
    # 无 dir_id：先默认目录
    default_dir = next((d for d in dirs_info if d['id'] == DEFAULT_DIR_ID), None)
    if default_dir and default_dir['is_dir']:
        cand = os.path.join(default_dir['abs_path'], base_name)
        if os.path.isfile(cand):
            return cand
    # 再遍历其他目录
    for d in dirs_info:
        if d['id'] == DEFAULT_DIR_ID:
            continue
        if d['is_dir']:
            cand = os.path.join(d['abs_path'], base_name)
            if os.path.isfile(cand):
                return cand
    return None


def _parse_karaoke_tokens(text):
    """解析 <mm:ss.xx> 形式的逐字时间戳。保留空文本token用于标记停顿和行尾结束时间。"""
    if not text:
        return []
    matches = list(re.finditer(r'<(\d+):(\d+(?:\.\d+)?)>', text))
    if not matches:
        return []
    tokens = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        seg = text[start:end]
        tokens.append({
            'time_sec': int(match.group(1)) * 60 + float(match.group(2)),
            'text': seg,
        })
    return tokens


def parse_lrc_content(content):
    """解析简化的 LRC 文本，支持普通时间戳、双语同时间戳以及逐字时间戳。
    保留空行作为间奏分隔，空行的 time_sec 使用下一行的时间戳。"""
    entries = []
    if not content:
        return entries
    
    lines = content.splitlines()
    for i, raw_line in enumerate(lines):
        line = raw_line.strip()
        
        if not line:
            entries.append({
                'time_sec': -1,
                'text': '',
                'karaoke': [],
                'is_empty': True,
            })
            continue
        
        matches = re.findall(r'\[(\d+):(\d+(?:\.\d+)?)\]', line)
        if not matches:
            continue
        
        text = re.sub(r'\[(\d+):(\d+(?:\.\d+)?)\]', '', line).strip()
        if not text:
            # 只有时间标签没有文字的行（如 [8:1]），作为空行（间奏）处理
            for bar_str, beat_str in matches:
                bar = int(bar_str)
                beat = float(beat_str)
                abs_beat = (bar - 1) * beats_per_bar + beat
                time_sec = beat_to_sec(abs_beat)
                entries.append({
                    'time_sec': max(0, time_sec),
                    'text': '',
                    'karaoke': [],
                    'is_empty': True,
                })
            continue
        
        for minute, sec_text in matches:
            karaoke_tokens = _parse_karaoke_tokens(text)
            entries.append({
                'time_sec': int(minute) * 60 + float(sec_text),
                'text': re.sub(r'<\d+:\d+(?:\.\d+)?>', '', text).strip(),
                'karaoke': karaoke_tokens,
                'is_empty': False,
            })
    
    # 给没有时间标签的空行（time_sec < 0）设置 time_sec
    for i in range(len(entries)):
        if entries[i].get('is_empty') and entries[i].get('time_sec', -1) < 0:
            prev_time = entries[i-1].get('time_sec', 0) if i > 0 else 0
            # 找到下一个非空行
            next_time = None
            for j in range(i+1, len(entries)):
                if not entries[j].get('is_empty') and entries[j].get('time_sec', -1) >= 0:
                    next_time = entries[j]['time_sec']
                    break
            if next_time is not None and next_time > prev_time:
                entries[i]['time_sec'] = prev_time + (next_time - prev_time) / 2
            elif next_time is not None:
                entries[i]['time_sec'] = next_time
            else:
                entries[i]['time_sec'] = prev_time + 5

    entries.sort(key=lambda item: item.get('time_sec', 0))
    
    merged = []
    for entry in entries:
        if entry.get('is_empty'):
            merged.append(entry)
            continue
        if merged and abs(merged[-1].get('time_sec', 0) - entry.get('time_sec', 0)) < 1e-9:
            merged[-1]['translated_text'] = entry.get('text', '')
            if not merged[-1].get('karaoke') and entry.get('karaoke'):
                merged[-1]['karaoke'] = entry.get('karaoke')
        else:
            merged.append(entry)
    return merged


def parse_brc_content(content, bpm=120, beats_per_bar=4, audio_zero_bar=1, audio_zero_beat=1, tempo_changes=None, meter_changes=None):
    """解析 BRC（Beat-based Lyrics）文本，格式为 [小节:拍]。
    根据 BPM 和零拍偏移配置将节拍时间转换为秒数。
    支持原文译文并行：相同时间戳的连续歌词合并为原文+译文。
    支持分段变速：tempo_changes 为 [{bar, beat, bpm}] 格式的列表。
    支持分段变拍：meter_changes 为 [{bar, beat, beats_per_bar}] 格式的列表。"""
    entries = []
    if not content:
        return entries
    
    def bar_beat_to_abs(target_bar, target_beat, bpb, meter_changes_list):
        sorted_meter = sorted(
            [mc for mc in (meter_changes_list or [])
             if isinstance(mc, dict) and 'bar' in mc and 'beat' in mc and 'beats_per_bar' in mc
             and mc['bar'] >= 1 and mc['beat'] >= 1 and mc['beats_per_bar'] > 0],
            key=lambda x: (x['bar'], x['beat'])
        )
        
        current_bar = 1
        current_bpb = bpb
        abs_beat = 0
        
        for mc in sorted_meter:
            if mc['bar'] > target_bar:
                break
            
            if mc['bar'] == target_bar and mc['beat'] <= target_beat:
                beats_to_change = (mc['bar'] - current_bar) * current_bpb + (mc['beat'] - 1)
                abs_beat += beats_to_change
                current_bar = mc['bar']
                current_bpb = mc['beats_per_bar']
                break
            
            beats_to_change = (mc['bar'] - current_bar) * current_bpb + (mc['beat'] - 1)
            abs_beat += beats_to_change
            current_bar = mc['bar']
            current_bpb = mc['beats_per_bar']
        
        beats_remaining = (target_bar - current_bar) * current_bpb + (target_beat - 1)
        abs_beat += beats_remaining
        
        return abs_beat
    
    zero_abs_beat = bar_beat_to_abs(audio_zero_bar, audio_zero_beat, beats_per_bar, meter_changes)
    
    tempo_changes = tempo_changes or []
    tempo_list = []
    for tc in tempo_changes:
        if isinstance(tc, dict) and 'bar' in tc and 'beat' in tc and 'bpm' in tc:
            abs_beat_val = bar_beat_to_abs(tc['bar'], tc['beat'], beats_per_bar, meter_changes)
            tempo_list.append({'abs': abs_beat_val, 'bpm': tc['bpm']})
    tempo_list.sort(key=lambda x: x['abs'])
    
    def beat_to_sec(abs_beat):
        if not tempo_list:
            beats_per_sec = bpm / 60.0
            return (abs_beat - zero_abs_beat) / beats_per_sec
        
        remaining = abs_beat - zero_abs_beat
        if remaining <= 0:
            return 0
        
        time = 0
        prev_bpm = bpm
        prev_abs = zero_abs_beat
        
        for tc in tempo_list:
            if abs_beat <= tc['abs']:
                beats_in_segment = abs_beat - prev_abs
                time += beats_in_segment / (prev_bpm / 60.0)
                return max(0, time)
            
            beats_in_segment = tc['abs'] - prev_abs
            time += beats_in_segment / (prev_bpm / 60.0)
            prev_abs = tc['abs']
            prev_bpm = tc['bpm']
        
        beats_in_segment = abs_beat - prev_abs
        time += beats_in_segment / (prev_bpm / 60.0)
        return max(0, time)
    
    lines = content.splitlines()
    for i, raw_line in enumerate(lines):
        line = raw_line.strip()
        
        if not line:
            entries.append({
                'time_sec': -1,
                'text': '',
                'karaoke': [],
                'is_empty': True,
            })
            continue
        
        matches = re.findall(r'\[(\d+):(\d+(?:\.\d+)?)\]', line)
        if not matches:
            continue
        
        text = re.sub(r'\[(\d+):(\d+(?:\.\d+)?)\]', '', line).strip()
        if not text:
            # 只有时间标签没有文字的行（如 [8:1]），作为空行（间奏）处理
            for bar_str, beat_str in matches:
                bar = int(bar_str)
                beat = float(beat_str)
                abs_beat = bar_beat_to_abs(bar, beat, beats_per_bar, meter_changes)
                time_sec = beat_to_sec(abs_beat)
                entries.append({
                    'time_sec': max(0, time_sec),
                    'text': '',
                    'karaoke': [],
                    'is_empty': True,
                })
            continue
        
        for bar_str, beat_str in matches:
            bar = int(bar_str)
            beat = float(beat_str)
            abs_beat = bar_beat_to_abs(bar, beat, beats_per_bar, meter_changes)
            time_sec = beat_to_sec(abs_beat)
            entries.append({
                'time_sec': max(0, time_sec),
                'text': text.strip(),
                'karaoke': [],
                'is_empty': False,
            })

    # 给没有时间标签的空行（time_sec < 0）设置 time_sec
    for i in range(len(entries)):
        if entries[i].get('is_empty') and entries[i].get('time_sec', -1) < 0:
            prev_time = entries[i-1].get('time_sec', 0) if i > 0 else 0
            # 找到下一个非空行
            next_time = None
            for j in range(i+1, len(entries)):
                if not entries[j].get('is_empty') and entries[j].get('time_sec', -1) >= 0:
                    next_time = entries[j]['time_sec']
                    break
            if next_time is not None and next_time > prev_time:
                entries[i]['time_sec'] = prev_time + (next_time - prev_time) / 2
            elif next_time is not None:
                entries[i]['time_sec'] = next_time
            else:
                entries[i]['time_sec'] = prev_time + 5

    entries.sort(key=lambda item: item.get('time_sec', 0))

    merged = []
    i = 0
    while i < len(entries):
        current = entries[i]
        if current.get('is_empty'):
            merged.append(current)
            i += 1
            continue
        if i + 1 < len(entries) and abs(entries[i + 1]['time_sec'] - current['time_sec']) < 0.01:
            merged.append({
                'time_sec': current['time_sec'],
                'text': current['text'],
                'translation': entries[i + 1]['text'],
                'karaoke': [],
            })
            i += 2
        else:
            merged.append({
                'time_sec': current['time_sec'],
                'text': current['text'],
                'karaoke': [],
            })
            i += 1

    return merged


def resolve_lrc_file(filename, dir_id=None, cfg=None):
    """根据音频文件名解析对应的歌词文件（同名 .lrc 或 .brc）。
    优先级：.brc > .lrc，优先查找节拍格式歌词。"""
    if not filename:
        return None
    if cfg is None:
        cfg = load_config()
    base_name = os.path.basename(filename)
    if not base_name:
        return None
    audio_path = resolve_bgm_file(base_name, dir_id=dir_id or None, cfg=cfg)
    if not audio_path:
        return None
    audio_dir = os.path.dirname(audio_path)
    stem, ext = os.path.splitext(base_name)
    if ext.lower() in ('.lrc', '.brc'):
        candidates = [base_name]
    else:
        candidates = [f'{stem}.brc', f'{stem}.lrc']
    for candidate in candidates:
        full_path = os.path.join(audio_dir, candidate)
        if os.path.isfile(full_path):
            return full_path
    return None


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get('auth_ok'):
            if request.path.startswith('/api/'):
                return jsonify({"ok": False, "error": "Unauthorized"}), 401
            return redirect('/login')
        return fn(*args, **kwargs)
    return wrapper

_init_secrets()

@app.route('/')
def index():
    return send_from_directory('templates', 'index.html')

@app.route('/login')
def login_page():
    return send_from_directory('templates', 'login.html')

@app.route('/admin')
@login_required
def admin_page():
    return send_from_directory('templates', 'admin.html')

@app.route('/bpmtest')
def bpmtest_page():
    return send_from_directory('templates', 'bpmtest.html')

@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json(silent=True) or {}
    pwd = (data.get('password') or '').strip()
    correct = _load_password()
    if pwd == correct:
        session['auth_ok'] = True
        return jsonify({"ok": True, "data": {"redirect": "/admin"}})
    return jsonify({"ok": False, "error": "密码错误"}), 401

@app.route('/api/logout', methods=['POST'])
def api_logout():
    session.pop('auth_ok', None)
    return jsonify({"ok": True})

@app.route('/api/session')
def api_session():
    return jsonify({"ok": True, "data": {"authed": bool(session.get('auth_ok'))}})

@app.route('/api/change-password', methods=['POST'])
@login_required
def api_change_password():
    data = request.get_json(silent=True) or {}
    old = (data.get('old_password') or '').strip()
    new = (data.get('new_password') or '').strip()
    if len(new) < 4:
        return jsonify({"ok": False, "error": "新密码至少4位"}), 400
    correct = _load_password()
    if old != correct:
        return jsonify({"ok": False, "error": "旧密码错误"}), 400
    with open(PASSWORD_PATH, 'w', encoding='utf-8') as f:
        f.write(new)
    return jsonify({"ok": True})

# ============== BGM 目录管理 API ==============
@app.route('/api/bgm-dirs')
def api_bgm_dirs():
    """返回所有 BGM 目录的状态（包含 exists/is_dir/file_count）。公共读。"""
    cfg = load_config()
    dirs = get_bgm_dirs_info(cfg)
    # 脱敏：abs_path 仅供内部使用，但前端展示状态可以给；这里返回全部给管理端用
    return jsonify({"ok": True, "data": {"dirs": dirs}})

@app.route('/api/bgm-dirs', methods=['POST'])
@login_required
def api_bgm_dirs_post():
    """统一 action 分发器（同时兼容旧的仅添加目录接口）。
    body JSON: { action: 'add'|'delete'|'scan'|'scan_all'|'list', ...payload }
    所有非 list/scan_all 非单一 scan 的 action 返回时都带上最新的 dirs 状态 + 可选的 flat files 列表，
    以便前端管理页一次性刷新 UI。
    """
    data = request.get_json(silent=True) or {}
    action = str(data.get('action') or 'add').strip().lower()

    # --------- action: list ---------
    if action == 'list':
        cfg = load_config()
        dirs = get_bgm_dirs_info(cfg)
        return jsonify({"ok": True, "data": {"dirs": dirs}})

    # --------- action: add ---------
    if action == 'add':
        label = str(data.get('label') or '').strip()
        path = str(data.get('path') or '').strip()
        if not path:
            return jsonify({"ok": False, "error": "路径不能为空"}), 400
        if not label:
            cleaned = path.replace('\\', '/').rstrip('/')
            label = cleaned.rsplit('/', 1)[-1] or '新目录'
        cfg = load_config()
        dir_id = 'd_' + uuid.uuid4().hex[:8]
        abs_path, exists, is_dir = normalize_path(path)
        new_cfg_dir = {"id": dir_id, "label": label, "path": path}
        cfg.setdefault('bgm_dirs', []).append(new_cfg_dir)
        save_config_raw(cfg)
        added = {
            "id": dir_id, "label": label, "path": path,
            "abs_path": abs_path, "exists": exists, "is_dir": is_dir,
            "file_count": len(list_audio_files(abs_path)) if is_dir else 0,
        }
        # 返回最新 dirs + 合并 flat files 便于前端刷新
        dirs = get_bgm_dirs_info(cfg)
        files_flat = _collect_all_bgm_entries(dirs, search='')
        return jsonify({
            "ok": True,
            "data": {"added": added, "dirs": dirs, "files": files_flat},
        })

    # --------- action: delete ---------
    if action == 'delete':
        dir_id = str(data.get('id') or '').strip()
        if dir_id == DEFAULT_DIR_ID:
            return jsonify({"ok": False, "error": "不能删除默认目录"}), 400
        cfg = load_config()
        before = len(cfg.get('bgm_dirs', []))
        cfg['bgm_dirs'] = [d for d in cfg.get('bgm_dirs', []) if isinstance(d, dict) and d.get('id') != dir_id]
        if len(cfg['bgm_dirs']) == before:
            return jsonify({"ok": False, "error": "目录不存在"}), 404
        # 引用的曲目回退到默认目录
        for t in cfg.get('tracks', []):
            if isinstance(t, dict) and t.get('bgm_dir_id') == dir_id:
                t['bgm_dir_id'] = DEFAULT_DIR_ID
        save_config_raw(cfg)
        dirs = get_bgm_dirs_info(cfg)
        files_flat = _collect_all_bgm_entries(dirs, search='')
        return jsonify({"ok": True, "data": {"dirs": dirs, "files": files_flat}})

    # --------- action: scan（单个目录） ---------
    if action == 'scan':
        dir_id = str(data.get('id') or '').strip()
        cfg = load_config()
        dir_cfg = _find_dir_cfg(cfg, dir_id)
        if not dir_cfg:
            return jsonify({"ok": False, "error": "目录不存在"}), 404
        abs_path, exists, is_dir = normalize_path(dir_cfg.get('path', ''))
        if not exists or not is_dir:
            return jsonify({"ok": False, "error": "目录不存在或不可读"}), 400
        file_names = list_audio_files(abs_path)
        file_count = len(file_names)
        # 更新 dirs 中的 file_count 后返回
        dirs = get_bgm_dirs_info(cfg)
        for d in dirs:
            if d['id'] == dir_id:
                d['file_count'] = file_count
                break
        files_flat = _collect_all_bgm_entries(dirs, search='')
        return jsonify({
            "ok": True,
            "data": {
                "dir_id": dir_id,
                "file_count": file_count,
                "dirs": dirs,
                "files": files_flat,
            },
        })

    # --------- action: scan_all（重新扫描所有目录） ---------
    if action == 'scan_all':
        cfg = load_config()
        dirs = get_bgm_dirs_info(cfg)
        # 扫描每个目录并更新 file_count（仅内存返回，不单独持久化计数）
        total = 0
        for d in dirs:
            if d.get('exists') and d.get('is_dir'):
                try:
                    n = len(list_audio_files(d['abs_path']))
                except Exception:
                    n = 0
                d['file_count'] = n
                total += n
        files_flat = _collect_all_bgm_entries(dirs, search='')
        return jsonify({
            "ok": True,
            "data": {"dirs": dirs, "files": files_flat, "total": total},
        })

    return jsonify({"ok": False, "error": f"未知 action: {action}"}), 400

@app.route('/api/bgm-dirs/<dir_id>', methods=['DELETE'])
@login_required
def api_bgm_dirs_delete(dir_id):
    if dir_id == DEFAULT_DIR_ID:
        return jsonify({"ok": False, "error": "不能删除默认目录"}), 400
    cfg = load_config()
    before = len(cfg.get('bgm_dirs', []))
    cfg['bgm_dirs'] = [d for d in cfg.get('bgm_dirs', []) if isinstance(d, dict) and d.get('id') != dir_id]
    if len(cfg['bgm_dirs']) == before:
        return jsonify({"ok": False, "error": "目录不存在"}), 404
    # 清除该目录相关曲目 bgm_dir_id 指向，防止目录被删后曲目找不到
    for t in cfg.get('tracks', []):
        if isinstance(t, dict) and t.get('bgm_dir_id') == dir_id:
            t['bgm_dir_id'] = ''
    save_config_raw(cfg)
    return jsonify({"ok": True})

@app.route('/api/bgm-dirs/<dir_id>/scan', methods=['POST'])
@login_required
def api_bgm_dirs_scan(dir_id):
    """手动触发扫描（按约束：目录扫描手动触发）。返回该目录下的音频文件列表。"""
    cfg = load_config()
    dir_cfg = _find_dir_cfg(cfg, dir_id)
    if not dir_cfg:
        return jsonify({"ok": False, "error": "目录不存在"}), 404
    abs_path, exists, is_dir = normalize_path(dir_cfg.get('path', ''))
    if not exists or not is_dir:
        return jsonify({"ok": False, "error": "目录不存在或不可读"}), 400
    files = list_audio_files(abs_path)
    return jsonify({
        "ok": True,
        "data": {
            "dir_id": dir_id,
            "label": dir_cfg.get('label', ''),
            "path": dir_cfg.get('path', ''),
            "abs_path": abs_path,
            "file_count": len(files),
            "files": files,
        }
    })

@app.route('/api/bgm-list')
def bgm_list():
    """多目录 BGM 列表 + 搜索过滤。
    Query:
      - dir_id: 可选，只返回该目录；否则返回所有目录合并结果
      - search: 可选，按文件名模糊匹配（不区分大小写）
      - mode: 'flat'（默认）合并列表；'grouped' 按目录分组
    返回 flat: [{dir_id, dir_label, filename, basename_matches_default_dir}]
    """
    cfg = load_config()
    dirs = get_bgm_dirs_info(cfg)
    q_dir_id = request.args.get('dir_id') or ''
    q_search = (request.args.get('search') or '').strip()
    mode = (request.args.get('mode') or 'flat').lower()

    entries = []
    per_dir = {}
    for d in dirs:
        if q_dir_id and d['id'] != q_dir_id:
            continue
        if not d['is_dir']:
            files = []
        else:
            files = list_audio_files(d['abs_path'], search=q_search)
        if mode == 'grouped':
            per_dir[d['id']] = {
                "id": d['id'],
                "label": d['label'],
                "path": d['path'],
                "exists": d['exists'],
                "is_dir": d['is_dir'],
                "file_count": len(files),
                "files": files,
            }
        for fn in files:
            entries.append({
                "dir_id": d['id'],
                "dir_label": d['label'],
                "filename": fn,
                "search": q_search,
            })

    data = {"dirs": dirs, "total": len(entries)}
    if mode == 'grouped':
        data["grouped"] = per_dir
    else:
        data["files"] = entries
    return jsonify({"ok": True, "data": data})

@app.route('/api/bgm/<path:filename>')
def get_bgm(filename):
    """向后兼容旧 URL：按文件名（可带 dir_id 可选 query）解析绝对路径并返回。
    Query:
      - dir_id: 可选，限定目录；否则按默认→全目录顺序查找（兼容旧曲目）
    """
    dir_id = request.args.get('dir_id') or ''
    base = os.path.basename(filename)  # 安全：丢弃任何路径分隔
    full_path = resolve_bgm_file(base, dir_id=dir_id or None)
    if not full_path or not os.path.isfile(full_path):
        return jsonify({"ok": False, "error": "File not found"}), 404
    return send_file(full_path)

@app.route('/api/lyrics/<path:filename>')
def get_lyrics(filename):
    """返回与当前音频同名的歌词文件内容。若未找到则返回空列表。
    支持 BRC（节拍歌词）格式，根据文件扩展名选择解析方式：.brc 使用节拍解析，.lrc 使用时间戳解析。
    支持分段变速：tempo_changes 参数为 JSON 数组格式。"""
    try:
        dir_id = request.args.get('dir_id') or ''
        base = os.path.basename(filename)
        full_path = resolve_lrc_file(base, dir_id=dir_id or None)
        if not full_path or not os.path.isfile(full_path):
            return jsonify({"ok": True, "data": {"lines": []}})
        _, ext = os.path.splitext(full_path)
        if ext.lower() not in ('.lrc', '.brc'):
            return jsonify({"ok": True, "data": {"lines": []}})
        bpm = float(request.args.get('bpm', 120))
        beats_per_bar = float(request.args.get('beats_per_bar', 4))
        audio_zero_bar = float(request.args.get('audio_zero_bar', 1))
        audio_zero_beat = float(request.args.get('audio_zero_beat', 1))
        tempo_changes = []
        tempo_changes_param = request.args.get('tempo_changes')
        if tempo_changes_param:
            try:
                tempo_changes = json.loads(tempo_changes_param)
            except (json.JSONDecodeError, TypeError):
                tempo_changes = []
        
        meter_changes = []
        meter_changes_param = request.args.get('meter_changes')
        if meter_changes_param:
            try:
                meter_changes = json.loads(meter_changes_param)
            except (json.JSONDecodeError, TypeError):
                meter_changes = []
        
        with open(full_path, 'r', encoding='utf-8', errors='ignore') as fh:
            content = fh.read()
        if ext.lower() == '.brc':
            lines = parse_brc_content(content, bpm=bpm, beats_per_bar=beats_per_bar,
                                       audio_zero_bar=audio_zero_bar, audio_zero_beat=audio_zero_beat,
                                       tempo_changes=tempo_changes, meter_changes=meter_changes)
        else:
            lines = parse_lrc_content(content)
        return jsonify({"ok": True, "data": {"lines": lines}})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route('/api/save-brc', methods=['POST'])
@login_required
def save_brc():
    """保存 BRC 歌词文件到音频同目录。"""
    data = request.get_json(silent=True) or {}
    filename = data.get('filename')
    dir_id = data.get('dir_id')
    content = data.get('content', '')

    if not filename:
        return jsonify({"ok": False, "error": "缺少文件名"}), 400

    audio_path = resolve_bgm_file(filename, dir_id=dir_id or None)
    if not audio_path:
        return jsonify({"ok": False, "error": "音频文件不存在"}), 400

    audio_dir = os.path.dirname(audio_path)
    stem = os.path.splitext(os.path.basename(filename))[0]
    brc_path = os.path.join(audio_dir, stem + '.brc')

    try:
        with open(brc_path, 'w', encoding='utf-8') as fh:
            fh.write(content)
        return jsonify({"ok": True, "data": {"path": brc_path}})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route('/font/<path:filename>')
def get_font(filename):
    """返回 Font 目录下的字体文件（原神日式字体等）。"""
    base = os.path.basename(filename)
    font_path = os.path.join(BASE_DIR, 'Font', base)
    if not os.path.isfile(font_path):
        return jsonify({"ok": False, "error": "Font not found"}), 404
    resp = send_file(font_path, conditional=True)
    resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return resp

@app.route('/api/config')
def get_config():
    cfg = load_config()
    return jsonify({"ok": True, "data": cfg})

@app.route('/api/config', methods=['POST'])
@login_required
def save_config():
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get('tracks'), list):
        return jsonify({"ok": False, "error": "格式错误，缺少 tracks 数组"}), 400
    cfg = load_config()
    cfg['tracks'] = data['tracks']
    if isinstance(data.get('bgm_dirs'), list):
        new_dirs = [d for d in data['bgm_dirs'] if isinstance(d, dict)]
        has_default = any(d.get('id') == DEFAULT_DIR_ID for d in new_dirs)
        if not has_default:
            new_dirs.insert(0, {"id": DEFAULT_DIR_ID, "label": "默认目录", "path": "./BGM"})
        for d in new_dirs:
            if not d.get('id') or 'path' not in d:
                return jsonify({"ok": False, "error": "bgm_dirs 条目缺少 id 或 path 字段"}), 400
        cfg['bgm_dirs'] = new_dirs
    save_config_raw(cfg)
    return jsonify({"ok": True})

if __name__ == '__main__':
    os.makedirs(BGM_DIR, exist_ok=True)
    os.makedirs('static', exist_ok=True)
    os.makedirs('templates', exist_ok=True)
    _load_password()
    load_config()
    print("=" * 60)
    print("  无缝循环播放器启动")
    print("  主页:   http://127.0.0.1:5001/")
    print("  登录:   http://127.0.0.1:5001/login")
    print("  管理:   http://127.0.0.1:5001/admin")
    print("  默认密码: admin123  (可在 password.txt 中修改)")
    print("=" * 60)
    app.run(host='0.0.0.0', port=5001, debug=False)
