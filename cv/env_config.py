"""
env_config.py — Hardware detection e carregamento de modelo otimizado.

Adaptado do DeepCamera (SharpAI) para o contexto AYA:
focado em NVIDIA GPU + TensorRT, com fallback para PyTorch CUDA/CPU.

Uso:
    from env_config import detect_gpu, load_model_optimized

    gpu = detect_gpu()
    model, fmt = load_model_optimized("yolo11n", device=gpu["device"])
"""

import shutil
import subprocess
import sys
import time
import platform
from pathlib import Path


def _log(msg: str):
    print(f"[env] {msg}", file=sys.stderr, flush=True)


def _detect_sm_version(device_index: int = 0) -> int:
    """
    Retorna a compute capability major version da GPU (ex: 6 para Pascal, 7 para Turing, 8 para Ampere).
    Usado para decidir se FP16 é eficiente.
      Pascal  (SM 6.x) — 1080 Ti, 1070, etc    → FP16 limitado, usar FP32
      Volta   (SM 7.0) — Titan V                → FP16 ok
      Turing  (SM 7.5) — RTX 20xx               → FP16 nativo
      Ampere  (SM 8.x) — RTX 30xx               → FP16 nativo
      Ada     (SM 8.9) — RTX 40xx               → FP16 nativo
    """
    try:
        import torch
        if torch.cuda.is_available() and device_index < torch.cuda.device_count():
            major, _ = torch.cuda.get_device_capability(device_index)
            return major
    except Exception:
        pass
    return 0


def _supports_fp16(sm_major: int) -> bool:
    """FP16 é eficiente apenas em Turing+ (SM 7.5+). Pascal (SM 6.x) tem suporte parcial mas não é vantajoso."""
    return sm_major >= 7  # 7 = Volta/Turing, 8 = Ampere, 9 = Ada


def detect_gpu() -> dict:
    """
    Detecta GPU NVIDIA via nvidia-smi.
    Retorna dict com: name, memory_mb, device, cuda_available, sm_major, fp16
    """
    info = {"name": None, "memory_mb": 0, "device": "0", "cuda_available": False,
            "sm_major": 0, "fp16": False}

    # Tenta nvidia-smi
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi and platform.system() == "Windows":
        for candidate in [
            Path("C:/Program Files/NVIDIA Corporation/NVSMI/nvidia-smi.exe"),
            Path("C:/Windows/System32/nvidia-smi.exe"),
        ]:
            if candidate.exists():
                nvidia_smi = str(candidate)
                break

    if nvidia_smi:
        try:
            r = subprocess.run(
                [nvidia_smi, "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0:
                lines = [l.strip() for l in r.stdout.strip().split("\n") if l.strip()]
                if lines:
                    parts = [p.strip() for p in lines[0].split(",")]
                    if len(parts) >= 3:
                        info["device"] = parts[0]
                        info["name"] = parts[1]
                        info["memory_mb"] = int(float(parts[2]))
                        info["cuda_available"] = True
                        sm = _detect_sm_version(int(parts[0]))
                        info["sm_major"] = sm
                        info["fp16"] = _supports_fp16(sm)
                        _log(f"GPU detectada: {info['name']} ({info['memory_mb']} MB) "
                             f"SM {sm}.x — FP16: {'sim' if info['fp16'] else 'não (Pascal)'}")
                        return info
        except Exception as e:
            _log(f"nvidia-smi falhou: {e}")

    # Fallback: verifica via torch
    try:
        import torch
        if torch.cuda.is_available():
            info["device"] = "0"
            info["name"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            info["memory_mb"] = getattr(props, "total_memory", 0) // (1024 * 1024)
            info["cuda_available"] = True
            sm = _detect_sm_version(0)
            info["sm_major"] = sm
            info["fp16"] = _supports_fp16(sm)
            _log(f"GPU via torch: {info['name']} ({info['memory_mb']} MB) "
                 f"SM {sm}.x — FP16: {'sim' if info['fp16'] else 'não (Pascal)'}")
            return info
    except ImportError:
        pass

    _log("Nenhuma GPU NVIDIA detectada — usando CPU")
    return info


def load_model_optimized(model_name: str, device: str = "0") -> tuple:
    """
    Carrega modelo YOLO com TensorRT se disponível, fallback para PyTorch CUDA/CPU.

    Estratégia:
    1. Tenta carregar engine TRT já exportado e cacheado (yolo11n.engine)
    2. Tenta exportar PT → TRT (uma única vez, ~60s, resultado cacheado)
    3. Fallback PyTorch CUDA
    4. Fallback CPU

    Retorna: (model, format_str)
      format_str: "tensorrt" | "pytorch-cuda" | "pytorch-cpu"
    """
    from ultralytics import YOLO

    engine_path = Path(f"{model_name}.engine")
    pt_path = Path(f"{model_name}.pt")
    cuda_device = f"cuda:{device}" if not device.startswith("cuda") and device not in ("cpu",) else device

    # FP16 só em Turing+ (SM 7.5+). Pascal (1080 Ti = SM 6.1) usa FP32.
    sm = _detect_sm_version(int(device) if device.isdigit() else 0)
    use_half = _supports_fp16(sm)
    _log(f"Precisão TRT: {'FP16' if use_half else 'FP32'} (SM {gpu_info.get('sm_major', '?')}.x)")

    # 1. Engine TRT já existe?
    if engine_path.exists():
        try:
            _log(f"Carregando TensorRT cacheado: {engine_path}")
            model = YOLO(str(engine_path))
            return model, "tensorrt"
        except Exception as e:
            _log(f"Falha ao carregar engine: {e} — tentando reexportar")
            engine_path.unlink(missing_ok=True)

    # 2. TensorRT disponível? Exportar PT → engine
    try:
        import tensorrt  # noqa: F401
        _log(f"TensorRT disponível — exportando {model_name}.pt "
             f"({'FP16' if use_half else 'FP32'}, uma vez, ~60-120s)...")
        t0 = time.perf_counter()
        base = YOLO(str(pt_path) if pt_path.exists() else f"{model_name}.pt")
        exported = base.export(format="engine", device=device, half=use_half, verbose=False)
        elapsed = time.perf_counter() - t0
        _log(f"Export TRT concluído ({elapsed:.0f}s): {exported}")
        model = YOLO(str(exported))
        return model, "tensorrt"
    except ImportError:
        _log("TensorRT não instalado — usando PyTorch CUDA")
    except Exception as e:
        _log(f"Export TRT falhou: {e} — usando PyTorch CUDA")

    # 3. PyTorch CUDA
    try:
        import torch
        if torch.cuda.is_available():
            model = YOLO(str(pt_path) if pt_path.exists() else f"{model_name}.pt")
            model.to(cuda_device)
            _log(f"Modelo carregado: PyTorch CUDA em {cuda_device}")
            return model, "pytorch-cuda"
    except Exception as e:
        _log(f"PyTorch CUDA falhou: {e}")

    # 4. CPU fallback
    _log("Fallback CPU")
    model = YOLO(str(pt_path) if pt_path.exists() else f"{model_name}.pt")
    return model, "pytorch-cpu"


# ─── CLI: diagnóstico standalone ─────────────────────────────────────────────

if __name__ == "__main__":
    import json
    gpu = detect_gpu()
    print(json.dumps(gpu, indent=2))
