"""
AYA Expo Tools — Computer Vision Detector v2
Lê stream RTSP, roda YOLO person detection, emite eventos JSONL no stdout.

Mudanças v2:
  - JSONL stdout como protocolo primário (zero latência, sem polling de arquivo)
  - TensorRT auto-detect via env_config (3-5x mais rápido)
  - Upgrade YOLOv8n → yolo11n por padrão
  - Detecção de zonas (point-in-polygon, configurável por expo)
  - Arquivos (heatmap.png, frame.jpg) ainda escritos a cada N frames (backward compat)

Protocolo JSONL stdout:
  {"event": "ready",     "model": "...", "format": "tensorrt", "gpu": "...", ...}
  {"event": "detection", "timestamp": "...", "camera": "...", "count": N, "zones": {...}, ...}
  {"event": "status",    "status": "reconnecting", ...}
  {"event": "error",     "message": "...", "retriable": true}

Node.js lê os eventos via proc.stdout (linha a linha).
Heatmap e frame annotated ainda são escritos em arquivo (imagens binárias).

Usage:
    python detector.py --config ../config/beleza-astral.json --camera-id cam-1
    python detector.py --rtsp "rtsp://..." --gpu 0 --interval 0
"""

import argparse
import json
import os
import sys
import time
import signal
from pathlib import Path
from datetime import datetime, timezone

import cv2
import numpy as np

# ─── Paths ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
BASE_OUTPUT_DIR = SCRIPT_DIR / "output"
BASE_OUTPUT_DIR.mkdir(exist_ok=True)

OUTPUT_DIR = BASE_OUTPUT_DIR
DETECTIONS_FILE = None
HEATMAP_FILE = None
HEATMAP_RAW_FILE = None
FRAME_FILE = None
STATUS_FILE = None


def setup_output_paths(camera_id=None):
    global OUTPUT_DIR, DETECTIONS_FILE, HEATMAP_FILE, HEATMAP_RAW_FILE, FRAME_FILE, STATUS_FILE
    OUTPUT_DIR = BASE_OUTPUT_DIR / camera_id if camera_id else BASE_OUTPUT_DIR
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DETECTIONS_FILE = OUTPUT_DIR / "detections.json"
    HEATMAP_FILE = OUTPUT_DIR / "heatmap.png"
    HEATMAP_RAW_FILE = OUTPUT_DIR / "heatmap_raw.npy"
    FRAME_FILE = OUTPUT_DIR / "frame.jpg"
    STATUS_FILE = OUTPUT_DIR / "status.json"


# ─── Shutdown ──────────────────────────────────────────────────────────────────

running = True


def signal_handler(sig, frame):
    global running
    running = False
    print("[CV] Encerrando...", file=sys.stderr, flush=True)


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ─── Emissão JSONL ─────────────────────────────────────────────────────────────

def emit(event: dict):
    """Emite evento JSONL no stdout. Node.js lê linha a linha."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def emit_status(status: str, **kwargs):
    """Emite evento de status (lido pelo Node e escrito em arquivo)."""
    ts = datetime.now(timezone.utc).isoformat()
    emit({"event": "status", "status": status, "timestamp": ts, "pid": os.getpid(), **kwargs})
    # Também escreve arquivo para backward compat
    if STATUS_FILE:
        tmp = str(STATUS_FILE) + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"status": status, "timestamp": ts, "pid": os.getpid(), **kwargs}, f)
        os.replace(tmp, str(STATUS_FILE))


# ─── Zonas ─────────────────────────────────────────────────────────────────────

def parse_zones(cv_config: dict, camera_id: str) -> list:
    """
    Extrai zonas relevantes para esta câmera do config.
    Cada zona: { id, name, polygon (np.array) }

    Config esperado em cv.zones:
    [
      {
        "id": "sala-principal",
        "name": "Sala Principal",
        "cameras": ["cam-1"],          ← opcional, filtra por câmera
        "polygon": [[0,0],[1920,0],[1920,1080],[0,1080]]
      }
    ]
    """
    zones_raw = cv_config.get("zones", [])
    zones = []
    for z in zones_raw:
        # Filtra por câmera se especificado
        cam_filter = z.get("cameras")
        if cam_filter and camera_id not in cam_filter:
            continue
        poly = np.array(z["polygon"], dtype=np.float32)
        if len(poly) < 3:
            continue  # polígono inválido
        zones.append({
            "id": z["id"],
            "name": z.get("name", z["id"]),
            "polygon": poly,
            "alert": z.get("alert", {}),
        })
    return zones


def point_in_polygon(point: tuple, polygon: np.ndarray) -> bool:
    """Retorna True se point (x, y) está dentro do polígono."""
    return cv2.pointPolygonTest(polygon, (float(point[0]), float(point[1])), False) >= 0


def classify_detections_to_zones(detections: list, zones: list) -> dict:
    """
    Para cada zona, conta quantas pessoas estão dentro.
    Usa o ponto dos pés (bottom-center da bbox) para o teste.

    Retorna: { zone_id: count, ... }
    """
    if not zones:
        return {}

    zone_counts = {z["id"]: 0 for z in zones}
    for d in detections:
        # Ponto dos pés: bottom-center da bounding box
        feet_x = d["x"] + d["w"] // 2
        feet_y = d["y"] + d["h"]
        d["zones"] = []
        for z in zones:
            if point_in_polygon((feet_x, feet_y), z["polygon"]):
                zone_counts[z["id"]] += 1
                d["zones"].append(z["id"])

    return zone_counts


# ─── Heatmap ───────────────────────────────────────────────────────────────────

def load_heatmap(shape):
    if HEATMAP_RAW_FILE and HEATMAP_RAW_FILE.exists():
        try:
            hm = np.load(str(HEATMAP_RAW_FILE))
            if hm.shape[:2] == shape[:2]:
                return hm
        except Exception:
            pass
    return np.zeros(shape[:2], dtype=np.float64)


def save_heatmap(heatmap_acc, shape):
    np.save(str(HEATMAP_RAW_FILE), heatmap_acc)
    hm_max = heatmap_acc.max()
    if hm_max > 0:
        hm_norm = (heatmap_acc / hm_max * 255).astype(np.uint8)
    else:
        hm_norm = np.zeros(shape[:2], dtype=np.uint8)
    hm_color = cv2.applyColorMap(hm_norm, cv2.COLORMAP_JET)
    hm_color[hm_norm < 5] = [20, 20, 20]
    cv2.imwrite(str(HEATMAP_FILE), hm_color)


# ─── Config ────────────────────────────────────────────────────────────────────

def parse_config(config_path: str, camera_id: str) -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    cv_config = config.get("cv", {})
    cam_id = camera_id or cv_config.get("camera", "cam-1")
    rtsp_url = None

    for cam in config.get("cameras", []):
        if cam["id"] == cam_id:
            user = cam.get("user", "admin")
            password = cam.get("password", "")
            # URL-encode credenciais
            from urllib.parse import quote
            user_enc = quote(str(user), safe="")
            pass_enc = quote(str(password), safe="")
            ip = cam["ip"]
            port = cam.get("rtspPort", 554)
            channel = cam.get("channel", 1)
            rtsp_url = f"rtsp://{user_enc}:{pass_enc}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0"
            break

    return {
        "rtsp": rtsp_url,
        "gpu": str(cv_config.get("gpu", 0)),
        "interval": float(cv_config.get("interval", 0)),  # 0 = contínuo
        "model": cv_config.get("model", "yolo11n"),
        "heatmap_decay": float(cv_config.get("heatmapDecay", 0.999)),
        "confidence": float(cv_config.get("confidence", 0.4)),
        "camera": cam_id,
        "imgsz": int(cv_config.get("imgsz", 640)),
        "zones_raw": cv_config,  # passado para parse_zones
    }


# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AYA Expo Tools — CV Detector v2")
    parser.add_argument("--config", help="Path to expo config JSON")
    parser.add_argument("--rtsp", help="RTSP URL (sobrescreve config)")
    parser.add_argument("--gpu", default="0", help="GPU index (padrão: 0)")
    parser.add_argument("--interval", type=float, default=None,
                        help="Segundos entre detecções (0 = contínuo)")
    parser.add_argument("--model", default=None, help="Modelo YOLO (padrão: yolo11n)")
    parser.add_argument("--confidence", type=float, default=None)
    parser.add_argument("--heatmap-decay", type=float, default=None)
    parser.add_argument("--heatmap-reset", action="store_true")
    parser.add_argument("--camera-id", help="ID da câmera (ex: cam-1)")
    parser.add_argument("--imgsz", type=int, default=None, help="Tamanho de inferência (640, 960...)")
    parser.add_argument("--no-trt", action="store_true", help="Desabilita TensorRT (usa PyTorch)")
    args = parser.parse_args()

    camera_id = args.camera_id
    setup_output_paths(camera_id)

    # Carrega settings
    if args.config:
        settings = parse_config(args.config, camera_id or "cam-1")
    else:
        settings = {
            "rtsp": args.rtsp,
            "gpu": args.gpu,
            "interval": 0.0,
            "model": "yolo11n",
            "heatmap_decay": 0.999,
            "confidence": 0.4,
            "camera": camera_id or "cli",
            "imgsz": 640,
            "zones_raw": {},
        }

    # Sobrescreve com CLI se explícito
    if args.rtsp:
        settings["rtsp"] = args.rtsp
    if args.gpu:
        settings["gpu"] = args.gpu
    if args.interval is not None:
        settings["interval"] = args.interval
    if args.model:
        settings["model"] = args.model
    if args.confidence is not None:
        settings["confidence"] = args.confidence
    if args.heatmap_decay is not None:
        settings["heatmap_decay"] = args.heatmap_decay
    if args.imgsz is not None:
        settings["imgsz"] = args.imgsz
    if camera_id:
        settings["camera"] = camera_id

    if not settings.get("rtsp"):
        emit({"event": "error", "message": "RTSP URL não configurada", "retriable": False})
        print("[CV] Erro: RTSP URL não configurada. Use --rtsp ou --config.", file=sys.stderr)
        sys.exit(1)

    # Zonas
    zones = parse_zones(settings.get("zones_raw", {}), settings["camera"])
    zone_ids = [z["id"] for z in zones]
    if zones:
        print(f"[CV] {len(zones)} zona(s) configurada(s): {zone_ids}", file=sys.stderr, flush=True)

    # ─── Carrega modelo ──────────────────────────────────────────────────────

    print(f"[CV] Carregando {settings['model']} (GPU {settings['gpu']})...",
          file=sys.stderr, flush=True)
    emit_status("loading", model=settings["model"], gpu=settings["gpu"])

    try:
        if args.no_trt:
            from ultralytics import YOLO
            import torch
            model = YOLO(f"{settings['model']}.pt")
            device = f"cuda:{settings['gpu']}" if torch.cuda.is_available() else "cpu"
            model.to(device)
            model_format = "pytorch-cuda" if "cuda" in device else "pytorch-cpu"
            gpu_name = torch.cuda.get_device_name(0) if "cuda" in device else "CPU"
        else:
            from env_config import detect_gpu, load_model_optimized
            gpu_info = detect_gpu()
            gpu_name = gpu_info.get("name", "unknown")
            model, model_format = load_model_optimized(settings["model"], device=settings["gpu"])
            device = f"cuda:{settings['gpu']}" if gpu_info["cuda_available"] else "cpu"

        # Warm-up
        dummy = np.zeros((480, 640, 3), dtype=np.uint8)
        _kw = dict(verbose=False, classes=[0])
        if "tensorrt" not in model_format:
            _kw["device"] = device
        model.predict(dummy, **_kw)
        print(f"[CV] Modelo pronto: {model_format} | GPU: {gpu_name}", file=sys.stderr, flush=True)

    except Exception as e:
        emit({"event": "error", "message": f"Erro ao carregar modelo: {e}", "retriable": False})
        print(f"[CV] Erro ao carregar modelo: {e}", file=sys.stderr)
        sys.exit(1)

    # ─── Abre stream RTSP ────────────────────────────────────────────────────

    rtsp_safe = settings["rtsp"].split("@")[-1] if "@" in settings["rtsp"] else settings["rtsp"]
    print(f"[CV] Conectando: {rtsp_safe}", file=sys.stderr, flush=True)
    emit_status("connecting", camera=settings["camera"])

    cap = cv2.VideoCapture(settings["rtsp"], cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    if not cap.isOpened():
        emit({"event": "error", "message": "Não foi possível abrir stream RTSP", "retriable": True})
        sys.exit(1)

    ret, frame = cap.read()
    if not ret or frame is None:
        emit({"event": "error", "message": "Não foi possível ler primeiro frame", "retriable": True})
        sys.exit(1)

    h, w = frame.shape[:2]
    resolution = f"{w}x{h}"
    print(f"[CV] Stream: {resolution}", file=sys.stderr, flush=True)

    # Reset heatmap se solicitado
    if args.heatmap_reset and HEATMAP_RAW_FILE.exists():
        HEATMAP_RAW_FILE.unlink()

    heatmap_acc = load_heatmap((h, w))

    # Emite evento ready
    emit({
        "event": "ready",
        "camera": settings["camera"],
        "model": settings["model"],
        "format": model_format,
        "gpu": settings["gpu"],
        "gpuName": gpu_name,
        "resolution": resolution,
        "zones": zone_ids,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    emit_status("running", camera=settings["camera"], resolution=resolution,
                model=settings["model"], format=model_format)

    # ─── Loop de detecção ────────────────────────────────────────────────────

    frame_count = 0
    file_write_interval = 10  # escreve heatmap/frame a cada N frames
    fps_count = 0
    fps_timer = time.time()
    fps = 0.0

    predict_kwargs = dict(
        verbose=False,
        classes=[0],   # person only
        conf=settings["confidence"],
        imgsz=settings["imgsz"],
    )
    if "tensorrt" not in model_format:
        predict_kwargs["device"] = device

    while running:
        loop_start = time.time()

        # Descarta frames acumulados no buffer — pega o mais recente
        cap.grab()
        ret, frame = cap.retrieve()

        if not ret or frame is None:
            print("[CV] Stream perdido. Reconectando em 5s...", file=sys.stderr, flush=True)
            emit({"event": "status", "status": "reconnecting", "camera": settings["camera"],
                  "timestamp": datetime.now(timezone.utc).isoformat()})
            cap.release()
            time.sleep(5)
            cap = cv2.VideoCapture(settings["rtsp"], cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                print("[CV] Reconexão falhou. Tentando novamente...", file=sys.stderr, flush=True)
            continue

        # ─── Inferência YOLO ─────────────────────────────────────────────────

        try:
            results = model.predict(frame, **predict_kwargs)
        except Exception as e:
            print(f"[CV] Erro na inferência: {e}", file=sys.stderr, flush=True)
            time.sleep(1)
            continue

        detections = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy().astype(int)
                conf = float(box.conf[0])
                detections.append({
                    "x": int(x1), "y": int(y1),
                    "w": int(x2 - x1), "h": int(y2 - y1),
                    "confidence": round(conf, 3),
                    "zones": [],
                })

                # Acumula heatmap (gaussian no ponto dos pés)
                cx = (x1 + x2) // 2
                cy = y2
                sigma = max(x2 - x1, y2 - y1) // 3
                if sigma > 0:
                    y_range = np.arange(max(0, cy - sigma * 2), min(h, cy + sigma * 2))
                    x_range = np.arange(max(0, cx - sigma * 2), min(w, cx + sigma * 2))
                    if len(y_range) > 0 and len(x_range) > 0:
                        yy, xx = np.meshgrid(y_range, x_range, indexing="ij")
                        gaussian = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))
                        heatmap_acc[y_range[0]:y_range[-1] + 1,
                                    x_range[0]:x_range[-1] + 1] += gaussian

        heatmap_acc *= settings["heatmap_decay"]

        # ─── Classificação por zonas ─────────────────────────────────────────

        zone_counts = classify_detections_to_zones(detections, zones)

        # ─── FPS ─────────────────────────────────────────────────────────────

        fps_count += 1
        elapsed_fps = time.time() - fps_timer
        if elapsed_fps >= 5.0:
            fps = fps_count / elapsed_fps
            fps_count = 0
            fps_timer = time.time()

        # ─── Emite evento JSONL (protocolo primário — zero latência) ─────────

        now = datetime.now(timezone.utc).isoformat()
        emit({
            "event": "detection",
            "timestamp": now,
            "camera": settings["camera"],
            "count": len(detections),
            "fps": round(fps, 1),
            "resolution": resolution,
            "model": settings["model"],
            "format": model_format,
            "detections": detections,
            "zones": zone_counts,
        })

        # ─── Escrita em arquivo (backward compat — a cada N frames) ──────────

        frame_count += 1
        if frame_count % file_write_interval == 0:
            # detections.json
            result_data = {
                "timestamp": now,
                "camera": settings["camera"],
                "count": len(detections),
                "fps": round(fps, 1),
                "resolution": resolution,
                "model": settings["model"],
                "detections": detections,
                "zones": zone_counts,
            }
            tmp = str(DETECTIONS_FILE) + ".tmp"
            with open(tmp, "w") as f:
                json.dump(result_data, f)
            os.replace(tmp, str(DETECTIONS_FILE))

            # Heatmap
            save_heatmap(heatmap_acc, (h, w))

        # Frame annotado (a cada 5 frames)
        if frame_count % 5 == 0:
            annotated = frame.copy()
            for d in detections:
                color = (0, 255, 0)
                cv2.rectangle(annotated, (d["x"], d["y"]),
                              (d["x"] + d["w"], d["y"] + d["h"]), color, 2)
                label = f'{d["confidence"]:.0%}'
                if d["zones"]:
                    label += f' [{",".join(d["zones"])}]'
                cv2.putText(annotated, label, (d["x"], d["y"] - 5),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)

            # Overlay: contagem total e por zona
            cv2.putText(annotated, f"Pessoas: {len(detections)}",
                        (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
            cv2.putText(annotated, f"{fps:.1f} FPS | {model_format}",
                        (10, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 200, 0), 1)

            y_offset = 82
            for zid, zcount in zone_counts.items():
                zname = next((z["name"] for z in zones if z["id"] == zid), zid)
                cv2.putText(annotated, f"{zname}: {zcount}",
                            (10, y_offset), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)
                y_offset += 22

            # Desenha polígonos das zonas
            for z in zones:
                poly_pts = z["polygon"].reshape((-1, 1, 2)).astype(np.int32)
                cv2.polylines(annotated, [poly_pts], isClosed=True, color=(0, 200, 255), thickness=2)
                # Label no centroide
                M = cv2.moments(z["polygon"])
                if M["m00"] != 0:
                    cx_z = int(M["m10"] / M["m00"])
                    cy_z = int(M["m01"] / M["m00"])
                    cv2.putText(annotated, z["name"],
                                (cx_z - 20, cy_z), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)

            cv2.imwrite(str(FRAME_FILE), annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])

        # ─── Sleep (0 = contínuo) ─────────────────────────────────────────────

        if settings["interval"] > 0:
            elapsed = time.time() - loop_start
            sleep_time = max(0, settings["interval"] - elapsed)
            if sleep_time > 0:
                time.sleep(sleep_time)

    # ─── Cleanup ─────────────────────────────────────────────────────────────

    cap.release()
    save_heatmap(heatmap_acc, (h, w))
    emit_status("stopped")
    emit({"event": "status", "status": "stopped", "camera": settings["camera"],
          "timestamp": datetime.now(timezone.utc).isoformat()})
    print("[CV] Encerrado.", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
