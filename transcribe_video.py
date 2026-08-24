# -*- coding: utf-8 -*-
"""
音频/视频 -> 字幕(SRT) 离线转写脚本
========================================
基于 faster-whisper（Whisper large-v3），完全离线推理，不联网、不上传任何数据。

用法：
  python transcribe_video.py <视频或音频路径> [--out <输出srt路径>] [--lang zh]

特性：
  - 自动用 ffmpeg 抽音频(16kHz mono wav 临时文件)
  - faster-whisper 内置 VAD 自动切句，输出带时间戳的 SRT（默认简体中文）
  - 有 NVIDIA 显卡时自动用 GPU(CUDA)，否则回退 CPU
  - 输出形如 [进度] N% / [完成] 的协议行，供 server.js 解析推进度条

依赖（装进某个 Python 环境即可，server 端在 config.json 里指向它）：
  pip install faster-whisper zhconv

模型：
  - 默认首次运行自动从 HuggingFace 下载 large-v3 到用户缓存目录
  - 或在 config.json 的 whisperModel 里指定本地模型目录（离线机器）
"""
import os
import sys
import shutil
import argparse
import subprocess

# ----------------------------------------------------------------------------
# 路径配置
# ----------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ffmpeg：优先项目内 ffmpeg/bin，其次 PATH
_ff_local = os.path.join(SCRIPT_DIR, "ffmpeg", "bin", "ffmpeg.exe")
FFMPEG = _ff_local if os.path.exists(_ff_local) else "ffmpeg"

# 由 server.js 通过环境变量注入（config.json: whisperModel / language）
MODEL_DIR = os.environ.get("ASD_WHISPER_MODEL", "").strip()
MODEL_SIZE = "large-v3"
LANGUAGE = os.environ.get("ASD_LANGUAGE", "zh").strip() or "zh"


# ----------------------------------------------------------------------------
# CUDA 准备：给 ctranslate2 补 cublas DLL（Windows + N 卡才需要）
# 思路来自社区：优先从本机 Ollama / CUDA Toolkit 里找现成的 CUDA DLL，
# 复制到 ctranslate2 包目录，免去用户单独装 CUDA。
# ----------------------------------------------------------------------------
def _find_cuda_dll_dirs():
    candidates = []
    ollama = os.path.expandvars(os.path.join(
        "%LOCALAPPDATA%", "Programs", "Ollama", "lib", "ollama"))
    if os.path.isdir(ollama):
        for name in sorted(os.listdir(ollama)):
            if name.startswith("cuda_v"):
                candidates.append(os.path.join(ollama, name))
    cuda_toolkit = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if os.path.isdir(cuda_toolkit):
        for name in sorted(os.listdir(cuda_toolkit), reverse=True):
            candidates.append(os.path.join(cuda_toolkit, name, "bin"))
    result = []
    for d in candidates:
        if os.path.isdir(d):
            dlls = [f for f in os.listdir(d) if f.startswith("cublas64") and f.endswith(".dll")]
            if dlls:
                result.append(d)
    return result


def _check_cuda():
    import ctypes
    try:
        ctypes.CDLL("nvcuda.dll")
        return True
    except OSError:
        return False


def _find_ctranslate2_dir():
    import importlib.util
    try:
        spec = importlib.util.find_spec("ctranslate2")
        if spec and spec.origin:
            return os.path.dirname(spec.origin)
        if spec and spec.submodule_search_locations:
            return spec.submodule_search_locations[0]
    except Exception:
        pass
    return None


def ensure_cuda_dlls():
    """确保 ctranslate2 目录有 cublas，返回是否检测到 GPU 驱动"""
    import ctypes
    if not _check_cuda():
        return False
    ct2_dir = _find_ctranslate2_dir()
    if ct2_dir is None:
        return False
    existing = [f for f in os.listdir(ct2_dir) if f.startswith("cublas64")]
    if existing:
        return True
    needed = ["cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"]
    for cuda_dir in _find_cuda_dll_dirs():
        if not os.path.exists(os.path.join(cuda_dir, "cublas64_12.dll")):
            continue
        for dll in needed:
            src = os.path.join(cuda_dir, dll)
            dst = os.path.join(ct2_dir, dll)
            if os.path.exists(src) and not os.path.exists(dst):
                try:
                    shutil.copy2(src, dst)
                except Exception as e:
                    print(f"[CUDA] 复制 {dll} 失败: {e}")
        for dll in needed:
            dll_path = os.path.join(ct2_dir, dll)
            if os.path.exists(dll_path):
                try:
                    ctypes.CDLL(dll_path)
                except Exception:
                    pass
        return True
    return False


# ----------------------------------------------------------------------------
# 抽音频
# ----------------------------------------------------------------------------
def extract_audio(video_path, tmp_wav):
    cmd = [
        FFMPEG, "-y", "-i", video_path,
        "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", tmp_wav,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(tmp_wav):
        raise RuntimeError("ffmpeg 抽音频失败:\n" + (r.stderr[-1500:] or r.stdout[-1500:]))


# ----------------------------------------------------------------------------
# SRT 时间格式化 + 输出
# ----------------------------------------------------------------------------
def srt_time(seconds):
    ms = int(round(seconds * 1000))
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1000
    ms %= 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segments, out_path, to_simplified=True):
    def to_simplified(text):
        try:
            from zhconv import convert as _c
            return _c(text, "zh-cn")
        except Exception:
            return text

    with open(out_path, "w", encoding="utf-8") as f:
        idx = 0
        for seg in segments:
            text = (seg.text or "").strip()
            if not text:
                continue
            start = getattr(seg, "start", None)
            end = getattr(seg, "end", None)
            if start is None or end is None:
                continue
            idx += 1
            f.write(f"{idx}\n")
            f.write(f"{srt_time(start)} --> {srt_time(end)}\n")
            f.write(to_simplified(text) + "\n\n")
    return idx


def load_model():
    from faster_whisper import WhisperModel
    has_gpu = ensure_cuda_dlls()
    print(f"[信息] GPU 驱动检测: {'有' if has_gpu else '无（将使用 CPU）'}", flush=True)

    # 指定了本地模型目录则离线加载；否则传模型名让 faster-whisper 自动下载
    model_arg = MODEL_DIR if MODEL_DIR else MODEL_SIZE
    kwargs = dict(local_files_only=True) if MODEL_DIR else {}

    if has_gpu:
        try:
            model = WhisperModel(model_arg, device="cuda", compute_type="float16", **kwargs)
            # 空推理验证 CUDA 真正可用
            import numpy as np
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language=LANGUAGE))
            print("[信息] 使用 GPU (CUDA float16)", flush=True)
            return model
        except Exception as e:
            print(f"[警告] CUDA 不可用，回退 CPU: {e}", flush=True)
    model = WhisperModel(model_arg, device="cpu", compute_type="int8", **kwargs)
    print("[信息] 使用 CPU (int8)", flush=True)
    return model


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", default=None, help="输出 srt 路径（默认与输入同目录同名）")
    ap.add_argument("--lang", default=LANGUAGE, help="字幕语言（默认 zh）")
    args = ap.parse_args()

    src = os.path.abspath(args.input)
    if not os.path.exists(src):
        print(f"[错误] 找不到输入文件: {src}")
        sys.exit(2)

    # 输出路径：与输入同目录，名为 <原名>.<语言>.srt
    if args.out:
        out_path = os.path.abspath(args.out)
    else:
        base, _ = os.path.splitext(src)
        out_path = base + f".{args.lang}.srt"

    # 已是 srt 则跳过
    if src.lower().endswith(".srt"):
        print("[提示] 输入已是 srt，无需转写。")
        sys.exit(0)

    print(f"[信息] 模型: {MODEL_DIR if MODEL_DIR else MODEL_SIZE + '（自动下载）'}", flush=True)
    model = load_model()

    tmp_wav = src + ".tmp_extract.wav"
    is_audio_input = src.lower().endswith((".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac"))
    try:
        if is_audio_input:
            audio_path = src
        else:
            print("[信息] 用 ffmpeg 抽取音频...", flush=True)
            extract_audio(src, tmp_wav)
            audio_path = tmp_wav

        print(f"[信息] 开始转写({args.lang})...", flush=True)
        segments, info = model.transcribe(
            audio_path,
            language=args.lang if args.lang != "auto" else None,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            beam_size=5,
            temperature=0.0,
            initial_prompt="以下是普通话的句子，使用简体中文。" if args.lang.startswith("zh") else None,
        )
        # 注意：必须先把生成器耗完并收集，才能安全清理临时文件
        seg_list = list(segments)
        count = write_srt(seg_list, out_path)
        print(f"[完成] 共 {count} 条字幕 -> {out_path}", flush=True)
        if count == 0:
            print("[警告] 未识别出任何字幕，可能音频无语音内容。", flush=True)
    finally:
        if not is_audio_input and os.path.exists(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass


if __name__ == "__main__":
    main()
