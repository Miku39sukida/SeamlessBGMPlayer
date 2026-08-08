import os
import re
import sys
import json
import uuid
import secrets
import socket
import mimetypes
import time
from functools import wraps
import threading
from flask import Flask, send_file, send_from_directory, jsonify, request, session, redirect, render_template

mimetypes.add_type('font/ttf', '.ttc')
mimetypes.add_type('font/ttf', '.ttf')

app = Flask(__name__, static_folder='static', template_folder='templates')

# 本地开发工具：禁用静态资源缓存，确保 app.js / style.css / beat-utils.js 等修改
# 即时生效，避免“改了代码但浏览器仍跑旧脚本”导致遥控端/播放器行为看起来没修复。
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0


@app.after_request
def _no_cache_static(resp):
    try:
        if request.path.startswith('/static/'):
            resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
            resp.headers['Pragma'] = 'no-cache'
            resp.headers['Expires'] = '0'
    except Exception:
        pass
    return resp

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
            "note_value": "quarter",
            "audio_zero_bar": 1,
            "audio_zero_beat": 4,
            "loop_start_bar": 5,
            "loop_start_beat": 1,
            "loop_end_bar": 62,
            "loop_end_beat": 1,
            "lyric_end_bar": 0,
            "lyric_end_beat": 0,
            "fade_in_beats": 0,
            "fade_out_beats": 0,
            "crossfade_beats": 0,
            "loop_mode": "single",
            "font_face": "default",
            "multi_style_enabled": False,
            "styles": [],
            "extra_tracks_enabled": False,
            "extra_tracks": [],
            "ending_enabled": False,
            "ending_filename": "",
            "ending_dir_id": "",
            "ending_fade_duration": 2.0,
            "full_loop_enabled": False,
            "full_loop_fade_duration": 2.0,
            "loop_sfx_enabled": False,
            "loop_sfx_filename": "",
            "loop_sfx_dir_id": "",
            "loop_sfx_fade_in_beats": 4,
            "intro_enabled": False,
            "intro_filename": "",
            "intro_dir_id": "",
            "gain": 1.0
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

# ============== 远程控制器访问令牌 ==============
# 仅在密码验证后签发，用于保护 /remote_app 页面与 WebSocket 连接。
# 令牌存于内存（服务器重启即失效），默认 12 小时有效，
# 彻底解决“用开发者工具删掉密码框就能操控”的客户端漏洞：
# 未经验证的浏览器根本拿不到控制界面 DOM，也无法建立可用的 WebSocket。
REMOTE_TOKEN_TTL = 12 * 3600
_remote_tokens = {}

def _create_remote_token():
    tok = secrets.token_hex(16)
    _remote_tokens[tok] = time.time() + REMOTE_TOKEN_TTL
    return tok

def _valid_remote_token(tok):
    if not tok:
        return False
    exp = _remote_tokens.get(tok)
    if exp is None:
        return False
    if time.time() > exp:
        _remote_tokens.pop(tok, None)
        return False
    return True

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
        if 'extra_tracks' not in t or not isinstance(t['extra_tracks'], list):
            extra = []
            if t.get('vocal_enabled') and t.get('vocal_filename'):
                extra.append({
                    "name": "人声轨",
                    "filename": t.get('vocal_filename', ''),
                    "dir_id": t.get('vocal_dir_id', ''),
                    "audio_zero_bar": t.get('vocal_audio_zero_bar', 1),
                    "audio_zero_beat": t.get('vocal_audio_zero_beat', 1),
                    "volume": 1.0
                })
            t['extra_tracks'] = extra
            if extra and 'extra_tracks_enabled' not in t:
                t['extra_tracks_enabled'] = True
        if 'extra_tracks_enabled' not in t:
            t['extra_tracks_enabled'] = bool(t.get('extra_tracks'))
        for et in t['extra_tracks']:
            if not isinstance(et, dict):
                continue
            if 'volume' not in et:
                et['volume'] = 1.0
            if 'audio_zero_bar' not in et:
                et['audio_zero_bar'] = t.get('audio_zero_bar', 1)
            if 'audio_zero_beat' not in et:
                et['audio_zero_beat'] = t.get('audio_zero_beat', 1)
            if 'dir_id' not in et or not et['dir_id']:
                et['dir_id'] = t.get('bgm_dir_id', 'default')
        if 'ending_enabled' not in t:
            t['ending_enabled'] = bool(t.get('ending_filename'))
        if 'ending_fade_duration' not in t or t['ending_fade_duration'] is None:
            t['ending_fade_duration'] = 2.0
        if 'ending_dir_id' not in t or not t['ending_dir_id']:
            t['ending_dir_id'] = t.get('bgm_dir_id', 'default')
        if 'full_loop_enabled' not in t:
            t['full_loop_enabled'] = False
        if 'full_loop_fade_duration' not in t or t['full_loop_fade_duration'] is None:
            t['full_loop_fade_duration'] = 2.0
        if 'loop_sfx_enabled' not in t:
            t['loop_sfx_enabled'] = False
        if 'loop_sfx_filename' not in t:
            t['loop_sfx_filename'] = ''
        if 'loop_sfx_dir_id' not in t or not t['loop_sfx_dir_id']:
            t['loop_sfx_dir_id'] = t.get('bgm_dir_id', 'default')
        if 'loop_sfx_fade_in_beats' not in t or t['loop_sfx_fade_in_beats'] is None:
            t['loop_sfx_fade_in_beats'] = 4
        if 'gain' not in t or t['gain'] is None:
            t['gain'] = 1.0
    # 为缺少 _id 的曲目分配唯一 ID 并持久化（一次性迁移）
    needs_save = False
    for t in cfg['tracks']:
        if isinstance(t, dict) and not t.get('_id'):
            t['_id'] = 'id_' + uuid.uuid4().hex[:8]
            needs_save = True
    if needs_save:
        save_config_raw(cfg)
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
            # 只有时间标签没有文字的行
            # 检测是 LRC 时间 [mm:ss.xx] 还是 BRC 节拍 [bar:beat]
            for bar_str, beat_str in matches:
                bar = int(bar_str)
                beat = float(beat_str)
                # 如果分钟部分 >= 10，很可能是 LRC 时间戳（如 [00:12.34]）
                # 如果分钟部分 < 10 且 beat < 10，可能是 BRC 节拍标签（如 [8:1]）
                if bar >= 10 or ('.' in beat_str and bar >= 1):
                    # LRC 时间戳格式
                    time_sec = bar * 60 + beat
                else:
                    # BRC 节拍格式，跳过（LRC 解析器不处理节拍换算）
                    continue
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


def parse_brc_content(content, bpm=120, beats_per_bar=4, audio_zero_bar=1, audio_zero_beat=1, tempo_changes=None, meter_changes=None, note_value_fraction=1):
    """解析 BRC（Beat-based Lyrics）文本，格式为 [小节:拍]。
    根据 BPM 和零拍偏移配置将节拍时间转换为秒数。
    支持原文译文并行：相同时间戳的连续歌词合并为原文+译文。
    支持分段变速：tempo_changes 为 [{bar, beat, bpm}] 格式的列表。
    支持分段变拍：meter_changes 为 [{bar, beat, beats_per_bar}] 格式的列表。
    支持卡拉OK逐字格式：行内 <bar:beat>字 标签解析为 karaoke 数组。"""
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
            beats_per_sec = bpm / (60.0 * note_value_fraction)
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
                time += beats_in_segment / (prev_bpm / 60.0 * note_value_fraction)
                return max(0, time)
            
            beats_in_segment = tc['abs'] - prev_abs
            time += beats_in_segment / (prev_bpm / 60.0 * note_value_fraction)
            prev_abs = tc['abs']
            prev_bpm = tc['bpm']

        beats_in_segment = abs_beat - prev_abs
        time += beats_in_segment / (prev_bpm / 60.0 * note_value_fraction)
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
        
        # 解析卡拉OK逐字标签 <bar:beat>字，填充 karaoke 数组
        char_matches = re.findall(r'<(\d+):(\d+(?:\.\d+)?)>([^<]*)', line)
        karaoke = []
        for bar_str, beat_str, char_text in char_matches:
            bar = int(bar_str)
            beat = float(beat_str)
            abs_beat = bar_beat_to_abs(bar, beat, beats_per_bar, meter_changes)
            time_sec = beat_to_sec(abs_beat)
            karaoke.append({
                'time_sec': max(0, time_sec),
                'text': char_text,
            })
        
        # text 同时去除 [bar:beat] 和 <bar:beat> 标签
        text = re.sub(r'\[(\d+):(\d+(?:\.\d+)?)\]', '', line)
        text = re.sub(r'<(\d+):(\d+(?:\.\d+)?)>', '', text).strip()
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
                'karaoke': list(karaoke),
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
                'karaoke': current.get('karaoke', []),
                'translation_karaoke': entries[i + 1].get('karaoke', []),
            })
            i += 2
        else:
            merged.append({
                'time_sec': current['time_sec'],
                'text': current['text'],
                'karaoke': current.get('karaoke', []),
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

@app.route('/api/remote_auth', methods=['POST'])
def api_remote_auth():
    """远程控制器专用：校验 password.txt 密码，成功签发访问令牌。
    令牌用于 /remote_app 页面访问控制与 WebSocket 握手，确保“先密码、后加载页面”。"""
    data = request.get_json(silent=True) or {}
    pwd = (data.get('password') or '').strip()
    if pwd != _load_password():
        return jsonify({"ok": False, "error": "密码错误"}), 401
    tok = _create_remote_token()
    resp = jsonify({"ok": True, "token": tok})
    # 令牌写入 Cookie（非 HttpOnly，便于 /remote_app 页面鉴权与 WS 握手复用），
    # 不再放进 URL，避免地址栏明文暴露、被记进浏览器历史 / referrer。
    resp.set_cookie(
        'rc_token', tok,
        max_age=REMOTE_TOKEN_TTL, httponly=False,
        samesite='Lax', path='/',
    )
    return resp

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

@app.route('/api/lyrics', methods=['POST'])
def get_lyrics():
    """返回与当前音频同名的歌词文件内容。若未找到则返回空列表。
    支持 BRC（节拍歌词）格式，根据文件扩展名选择解析方式：.brc 使用节拍解析，.lrc 使用时间戳解析。
    支持分段变速：tempo_changes 参数为 JSON 数组格式。"""
    try:
        data = request.get_json(silent=True) or {}
        filename = data.get('filename')
        dir_id = data.get('dir_id') or ''
        
        if not filename:
            return jsonify({"ok": False, "error": "缺少文件名"}), 400
        
        base = os.path.basename(filename)
        full_path = resolve_lrc_file(base, dir_id=dir_id or None)
        if not full_path or not os.path.isfile(full_path):
            return jsonify({"ok": True, "data": {"lines": []}})
        _, ext = os.path.splitext(full_path)
        if ext.lower() not in ('.lrc', '.brc'):
            return jsonify({"ok": True, "data": {"lines": []}})
        
        bpm = float(data.get('bpm', 120))
        beats_per_bar = float(data.get('beats_per_bar', 4))
        audio_zero_bar = float(data.get('audio_zero_bar', 1))
        audio_zero_beat = float(data.get('audio_zero_beat', 1))
        note_value_fraction = float(data.get('note_value_fraction', 1))
        
        tempo_changes = data.get('tempo_changes') or []
        if not isinstance(tempo_changes, list):
            tempo_changes = []
        
        meter_changes = data.get('meter_changes') or []
        if not isinstance(meter_changes, list):
            meter_changes = []
        
        with open(full_path, 'r', encoding='utf-8', errors='ignore') as fh:
            content = fh.read()
        if ext.lower() == '.brc':
            lines = parse_brc_content(content, bpm=bpm, beats_per_bar=beats_per_bar,
                                       audio_zero_bar=audio_zero_bar, audio_zero_beat=audio_zero_beat,
                                       tempo_changes=tempo_changes, meter_changes=meter_changes,
                                       note_value_fraction=note_value_fraction)
        else:
            lines = parse_lrc_content(content)
        return jsonify({"ok": True, "data": {"lines": lines}})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route('/api/get-raw-lyric', methods=['POST'])
@login_required
def get_raw_lyric():
    """返回与音频同名的原始歌词文件内容（不解析），用于节奏打点载入。
    优先级：.brc > .lrc。返回 format 字段标识文件类型。"""
    data = request.get_json(silent=True) or {}
    filename = data.get('filename')
    dir_id = data.get('dir_id') or ''

    if not filename:
        return jsonify({"ok": False, "error": "缺少文件名"}), 400

    full_path = resolve_lrc_file(filename, dir_id=dir_id or None)
    if not full_path or not os.path.isfile(full_path):
        return jsonify({"ok": True, "data": {"content": "", "format": None}})

    _, ext = os.path.splitext(full_path)
    fmt = ext.lower().lstrip('.')

    try:
        with open(full_path, 'r', encoding='utf-8', errors='ignore') as fh:
            content = fh.read()
        return jsonify({"ok": True, "data": {"content": content, "format": fmt}})
    except Exception as e:
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


@app.route('/api/save-lrc', methods=['POST'])
@login_required
def save_lrc():
    """保存 LRC 歌词文件到音频同目录（用于节奏打点导出 LRC）。"""
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
    lrc_path = os.path.join(audio_dir, stem + '.lrc')

    try:
        with open(lrc_path, 'w', encoding='utf-8') as fh:
            fh.write(content)
        return jsonify({"ok": True, "data": {"path": lrc_path}})
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

@app.route('/api/track_config')
def track_config():
    dir_id = request.args.get('dir') or ''
    filename = request.args.get('file') or ''
    cfg = load_config()
    for t in cfg.get('tracks', []):
        if t.get('bgm_dir_id', 'default') == dir_id and t.get('filename') == filename:
            return jsonify(t)
    return jsonify({})

@app.route('/api/config', methods=['POST'])
@login_required
def save_config():
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get('tracks'), list):
        return jsonify({"ok": False, "error": "格式错误，缺少 tracks 数组"}), 400
    cfg = load_config()
    mode = data.get('mode') or 'full'
    if mode == 'partial':
        incoming = data['tracks']
        id_to_new = {}
        for nt in incoming:
            if not isinstance(nt, dict):
                continue
            tid = nt.get('_id')
            if tid:
                id_to_new[tid] = nt
        if not id_to_new:
            return jsonify({"ok": False, "error": "增量保存失败：未找到带 _id 的曲目"}), 400
        replaced = 0
        matched_indices = set()
        for i, t in enumerate(cfg['tracks']):
            if not isinstance(t, dict):
                continue
            tid = t.get('_id')
            if tid and tid in id_to_new:
                cfg['tracks'][i] = id_to_new[tid]
                replaced += 1
                matched_indices.add(i)
        # 回退：若部分曲目在 config 中尚无 _id（历史数据），按索引位置匹配
        if replaced < len(id_to_new):
            unmatched = [nt for nt in incoming if nt.get('_id') not in
                        {cfg['tracks'][j].get('_id') for j in matched_indices
                         if isinstance(cfg['tracks'][j], dict)}]
            for i, t in enumerate(cfg['tracks']):
                if i in matched_indices:
                    continue
                if not isinstance(t, dict):
                    continue
                if unmatched:
                    cfg['tracks'][i] = unmatched.pop(0)
                    replaced += 1
                    matched_indices.add(i)
        if replaced == 0:
            return jsonify({"ok": False, "error": "增量保存失败：未匹配到任何曲目"}), 400
    else:
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

_VIRTUAL_IFACE_PREFIXES = (
    'lo', 'tun', 'tap', 'docker', 'veth', 'br-', 'virbr', 'vmnet',
    'dummy', 'ip6tnl', 'ip6_vti', 'sit', 'gre', 'gretap', 'ppp',
    'sl', 'can', 'bond', 'vlan', 'macvlan', 'vxlan', 'wlan#',
    'p2p-dev', 'docker0', 'br0', 'cni', 'flannel', 'cali', 'vnet',
    'utun', 'awdl', 'llw', 'bridge', 'vboxnet'
)


def _is_virtual_iface(iface):
    if not iface:
        return True
    name = iface.strip().lower()
    for prefix in _VIRTUAL_IFACE_PREFIXES:
        if name.startswith(prefix):
            return True
    return False


def _get_lan_ips():
    ips = []

    def _add_ip(ip):
        if not ip or ip.startswith('127.') or ip.startswith('169.254') or ip.startswith('0.'):
            return
        parts = ip.split('.')
        if len(parts) != 4:
            return
        for p in parts:
            if not p.isdigit() or int(p) < 0 or int(p) > 255:
                return
        if ip not in ips:
            ips.append(ip)

    if sys.platform.startswith('linux') or sys.platform.startswith('darwin'):
        try:
            import subprocess
            import re
            out = subprocess.check_output(['ip', '-4', '-o', 'addr'], stderr=subprocess.DEVNULL, text=True)
            for line in out.strip().split('\n'):
                parts = line.split(None, 2)
                if len(parts) < 2:
                    continue
                iface = parts[1].split('@')[0]
                if _is_virtual_iface(iface):
                    continue
                m = re.search(r'inet\s+(\d+\.\d+\.\d+\.\d+)', line)
                if m:
                    _add_ip(m.group(1))
        except:
            try:
                import subprocess
                import re
                out = subprocess.check_output(['ifconfig'], stderr=subprocess.DEVNULL, text=True)
                current_iface = None
                for line in out.strip().split('\n'):
                    m = re.match(r'^([a-zA-Z0-9_:\-\.]+)\s+', line)
                    if m:
                        current_iface = m.group(1).split(':')[0]
                    if current_iface and not _is_virtual_iface(current_iface):
                        m2 = re.search(r'inet\s+(?:addr:)?(\d+\.\d+\.\d+\.\d+)', line)
                        if m2:
                            _add_ip(m2.group(1))
            except:
                pass
    elif sys.platform.startswith('win'):
        try:
            import subprocess
            import re
            out = subprocess.check_output(['ipconfig'], stderr=subprocess.DEVNULL, text=True)
            skip_adapter = False
            for line in out.strip().split('\n'):
                adapter_match = re.match(r'^\s*(.+)适配器\s+(.+):|^\s*(.+)adapter\s+(.+):', line, re.IGNORECASE)
                if adapter_match:
                    name = (adapter_match.group(2) or adapter_match.group(4) or '').lower()
                    skip_keywords = ['虚拟', 'virtual', 'loopback', '回环', 'tunnel', '隧道', 'vpn',
                                     'vmware', 'virtualbox', 'hyper-v', 'wsl', 'docker', 'veth']
                    skip_adapter = any(kw in name for kw in skip_keywords)
                    continue
                if not skip_adapter:
                    m = re.search(r'IPv4.*?:\s*(\d+\.\d+\.\d+\.\d+)', line)
                    if m:
                        _add_ip(m.group(1))
        except:
            pass

    hostname = socket.gethostname()
    try:
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip in ips:
                continue
            _add_ip(ip)
    except:
        pass

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        if ip not in ips:
            _add_ip(ip)
    except:
        pass
    finally:
        s.close()

    return ips

@app.route('/api/lan_ips')
def lan_ips():
    ips = _get_lan_ips()
    wifi_ips = [ip for ip in ips if ip.startswith('192.168.')]
    hotspot_ips = [ip for ip in ips if not ip.startswith('192.168.')]
    return jsonify({"ips": ips, "wifi_ips": wifi_ips, "hotspot_ips": hotspot_ips, "port": 5001})

# ===================== 远程控制 WebSocket 中继 =====================
# 角色模型：
#   player  —— 播放器（浏览器端 index.html），连接后向遥控器广播曲目列表与播放状态，
#             并接收遥控器发来的控制命令（play / pause / resume / stop / set_volume 等）。
#   remote  —— 遥控器（/remote 密码门 → /remote_app 控制界面，通常跑在手机上），连接后接收 player 的状态，
#             并向 player 发送控制命令。
# 中继服务只做消息转发，不感知业务逻辑；同一时间只允许一个 player 连接。
RC_WS_PORT = int(os.environ.get('RC_WS_PORT', '8765'))
_rc_player = [None]            # 当前连接的播放器连接（最多一个）
_rc_remotes = set()           # 所有已连接的遥控器
_rc_lock = threading.Lock()


@app.route('/api/ws_info')
def api_ws_info():
    """返回播放器 WebSocket 中继地址，便于前端自动发现端口（尤其是跨设备访问时）。"""
    host = request.host.split(':')[0]
    return jsonify({
        'host': host,
        'ws_port': RC_WS_PORT,
        'ws_url': f'ws://{host}:{RC_WS_PORT}',
    })


@app.route('/remote')
def remote_controller():
    """远程控制器「密码门」页面（通常跑在手机等移动设备上）。

    这里只提供密码输入框，不包含任何控制界面 DOM。验证通过后由前端跳转至
    /remote_app?token=... 加载真正的控制界面。这样未经验证的浏览器拿不到控制逻辑，
    也就无法像旧版那样“在开发者工具里删掉密码框就直接操控”。
    该页面为纯 HTML/JS（不含 Jinja 语法），故用 send_from_directory 从磁盘读取，
    并加 no-store 头确保每次刷新都是最新。
    """
    resp = send_from_directory('templates', 'Remote_Controller.html')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@app.route('/remote_app')
def remote_app():
    """远程控制器实际控制界面（含全部控制逻辑）。

    必须由密码门登录后持有效 Cookie 令牌才能加载，否则重定向回 /remote。
    与 /remote（纯密码门）分离，确保“先输入密码、再加载页面”。
    令牌仅存于 Cookie（不再出现在 URL），避免地址栏明文暴露。
    """
    tok = request.cookies.get('rc_token') or ''
    if not _valid_remote_token(tok):
        return redirect('/remote')
    resp = send_from_directory('templates', 'Remote_Controller_app.html')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@app.route('/api/remote_logout', methods=['POST'])
def api_remote_logout():
    """远程控制器登出：吊销当前令牌并清除 Cookie，回到密码门。"""
    tok = request.cookies.get('rc_token') or ''
    _remote_tokens.pop(tok, None)
    resp = jsonify({"ok": True})
    resp.set_cookie('rc_token', '', max_age=0, expires=0, path='/')
    return resp


async def rc_handler(websocket, path=None):
    role = None
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            t = data.get('type')
            if t == 'hello':
                role = data.get('role')
                if role == 'remote':
                    # 遥控器必须持有有效令牌（/api/remote_auth 在密码验证后签发），
                    # 兼容旧的明文密码；二者皆不通过则直接拒绝连接。
                    # 这样“先密码、后连接”，杜绝客户端绕过密码框的可能。
                    tok = (data.get('token') or '').strip()
                    pwd = (data.get('pwd') or '').strip()
                    if not _valid_remote_token(tok) and pwd != _load_password():
                        try:
                            await websocket.send(json.dumps({'type': 'auth_failed', 'message': '令牌无效或密码错误'}))
                        except Exception:
                            pass
                        return
                    with _rc_lock:
                        _rc_remotes.add(websocket)
                elif role == 'player':
                    # 播放器（宿主）信任，无需密码
                    with _rc_lock:
                        _rc_player[0] = websocket
                else:
                    return
                try:
                    await websocket.send(json.dumps({'type': 'welcome', 'role': role}))
                except Exception:
                    pass
                continue
            # 普通消息：按角色转发
            if role == 'player':
                # 播放器 -> 所有遥控器（state / tracks 等）
                with _rc_lock:
                    remotes = list(_rc_remotes)
                for r in remotes:
                    try:
                        await r.send(message)
                    except Exception:
                        with _rc_lock:
                            _rc_remotes.discard(r)
            elif role == 'remote':
                # 遥控器 -> 播放器（command 等）
                with _rc_lock:
                    p = _rc_player[0]
                if p is not None:
                    try:
                        await p.send(message)
                    except Exception:
                        with _rc_lock:
                            _rc_player[0] = None
    finally:
        with _rc_lock:
            if role == 'player' and _rc_player[0] is websocket:
                _rc_player[0] = None
                for r in list(_rc_remotes):
                    try:
                        await r.send(json.dumps({'type': 'player_offline'}))
                    except Exception:
                        _rc_remotes.discard(r)
            elif role == 'remote':
                _rc_remotes.discard(websocket)


def start_rc_ws_server():
    try:
        import websockets
    except ImportError:
        print("[远程控制] 未安装 websockets 库，远程控制功能不可用。请运行: pip install websockets")
        return
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    async def _main():
        try:
            server = await websockets.serve(
                rc_handler, '0.0.0.0', RC_WS_PORT,
                ping_interval=20, ping_timeout=20,
            )
            print(f"[远程控制] WebSocket 中继已启动: ws://0.0.0.0:{RC_WS_PORT}")
            await server.wait_closed()
        except Exception as e:
            print(f"[远程控制] WebSocket 服务启动失败: {e}")

    try:
        loop.run_until_complete(_main())
    except Exception as e:
        print(f"[远程控制] WebSocket 事件循环异常: {e}")


if __name__ == '__main__':
    os.makedirs(BGM_DIR, exist_ok=True)
    os.makedirs('static', exist_ok=True)
    os.makedirs('templates', exist_ok=True)
    _load_password()
    load_config()

    ips = _get_lan_ips()
    wifi_ips = [ip for ip in ips if ip.startswith('192.168.')]
    hotspot_ips = [ip for ip in ips if not ip.startswith('192.168.')]

    print("=" * 60)
    print("  无缝循环播放器启动")
    if wifi_ips:
        print("  📶 WiFi:")
        for ip in wifi_ips:
            url = f"http://{ip}:5001/"
            print(f"         {url}")
    if hotspot_ips:
        print("  📡 热点:")
        for ip in hotspot_ips:
            url = f"http://{ip}:5001/"
            print(f"         {url}")
    print("  本机:   http://127.0.0.1:5001/")
    print("  登录:   http://127.0.0.1:5001/login")
    print("  管理:   http://127.0.0.1:5001/admin")
    print("  默认密码: admin123  (可在 password.txt 中修改)")
    print("=" * 60)

    # 启动远程控制 WebSocket 中继（后台线程，独立端口）
    rc_thread = threading.Thread(target=start_rc_ws_server, daemon=True)
    rc_thread.start()

    app.run(host='0.0.0.0', port=5001, debug=False)
