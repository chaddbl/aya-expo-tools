"""
AYA Expo Tools — Computer Vision Detector
Reads RTSP camera stream, runs YOLO person detection, writes results.

Usage:
    python detector.py --config ../config/beleza-astral.json
    python detector.py --rtsp "rtsp://..." --gpu 1 --interval 2

Output (written every interval):
    cv/output/detections.json   — current count + bounding boxes
    cv/output/heatmap.png       — accumulated presence heatmap
    cv/output/frame.jpg         — latest annotated frame

Communication with Node.js:
    Node reads cv/output/detections.json (file-based IPC — simple, robust)
    Node serves cv/output/heatmap.png and cv/output/frame.jpg as static files
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

# ─── Paths ─────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
BASE_OUTPUT_DIR = SCRIPT_DIR / "output"
BASE_OUTPUT_DIR.mkdir(exist_ok=True)

# Camera ID from args will create per-camera subdirectory
# e.g., cv/output/cam-1/detections.json
# For backward compat, single-camera writes to cv/output/ directly
CAMERA_ID = None  # set later from args
OUTPUT_DIR = BASE_OUTPUT_DIR

DETECTIONS_FILE = None
HEATMAP_FILE = None
HEATMAP_RAW_FILE = None
FRAME_FILE = None
STATUS_FILE = None

def setup_output_paths(camera_id=None):
    global CAMERA_ID, OUTPUT_DIR, DETECTIONS_FILE, HEATMAP_FILE, HEATMAP_RAW_FILE, FRAME_FILE, STATUS_FILE
    CAMERA_ID = camera_id
    if camera_id:
        OUTPUT_DIR = BASE_OUTPUT_DIR / camera_id
    else:
        OUTPUT_DIR = BASE_OUTPUT_DIR
    OUTPUT_DIR.mkdir(exist_ok=True)
    DETECTIONS_FILE = OUTPUT_DIR / "detections.json"
    HEATMAP_FILE = OUTPUT_DIR / "heatmap.png"
    HEATMAP_RAW_FILE = OUTPUT_DIR / "heatmap_raw.npy"
    FRAME_FILE = OUTPUT_DIR / "frame.jpg"
    STATUS_FILE = OUTPUT_DIR / "status.json"

# ─── Globals ───────────────────────────────────────────────────
running = True

def signal_handler(sig, frame):
    global running
    running = False
    print("\n[CV] Shutting down...")

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def write_status(status: str, **kwargs):
    """Write status file for Node.js to read."""
    data = {
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
        **kwargs,
    }
    STATUS_FILE.write_text(json.dumps(data, indent=2))


def load_heatmap(shape):
    """Load or create heatmap accumulator."""
    if HEATMAP_RAW_FILE.exists():
        try:
            hm = np.load(str(HEATMAP_RAW_FILE))
            if hm.shape[:2] == shape[:2]:
                return hm
        except Exception:
            pass
    return np.zeros(shape[:2], dtype=np.float64)


def save_heatmap(heatmap_acc, shape):
    """Save heatmap as colorized PNG and raw numpy array."""
    np.save(str(HEATMAP_RAW_FILE), heatmap_acc)

    # Normalize to 0-255
    hm_max = heatmap_acc.max()
    if hm_max > 0:
        hm_norm = (heatmap_acc / hm_max * 255).astype(np.uint8)
    else:
        hm_norm = np.zeros(shape[:2], dtype=np.uint8)

    # Apply colormap (COLORMAP_JET: blue=cold, red=hot)
    hm_color = cv2.applyColorMap(hm_norm, cv2.COLORMAP_JET)

    # Make zero areas transparent-ish (dark)
    mask = hm_norm < 5
    hm_color[mask] = [20, 20, 20]

    cv2.imwrite(str(HEATMAP_FILE), hm_color)


def parse_config(config_path):
    """Extract CV settings from expo config JSON."""
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    cv_config = config.get("cv", {})
    cam_id = cv_config.get("camera", "cam-1")
    gpu = cv_config.get("gpu", 1)
    interval = cv_config.get("interval", 2)
    model_name = cv_config.get("model", "yolov8n")
    heatmap_decay = cv_config.get("heatmapDecay", 0.999)  # per-frame decay
    confidence = cv_config.get("confidence", 0.4)

    # Find camera RTSP URL
    rtsp_url = None
    for cam in config.get("cameras", []):
        if cam["id"] == cam_id:
            user = cam.get("user", "admin")
            password = cam.get("password", "")
            ip = cam["ip"]
            port = cam.get("rtspPort", 554)
            channel = cam.get("channel", 1)
            # Main stream (subtype=0) for better detection
            rtsp_url = f"rtsp://{user}:{password}@{ip}:{port}/cam/realmonitor?channel={channel}&subtype=0"
            break

    return {
        "rtsp": rtsp_url,
        "gpu": gpu,
        "interval": interval,
        "model": model_name,
        "heatmap_decay": heatmap_decay,
        "confidence": confidence,
        "camera": cam_id,
    }


def main():
    parser = argparse.ArgumentParser(description="AYA Expo Tools — CV Detector")
    parser.add_argument("--config", help="Path to expo config JSON")
    parser.add_argument("--rtsp", help="RTSP URL (overrides config)")
    parser.add_argument("--gpu", type=int, default=1, help="GPU index (default: 1)")
    parser.add_argument("--interval", type=float, default=2.0, help="Seconds between detections")
    parser.add_argument("--model", default="yolov8n", help="YOLO model (yolov8n, yolov8s, etc)")
    parser.add_argument("--confidence", type=float, default=0.4, help="Detection confidence threshold")
    parser.add_argument("--heatmap-decay", type=float, default=0.999, help="Heatmap decay per frame")
    parser.add_argument("--heatmap-reset", action="store_true", help="Reset accumulated heatmap")
    parser.add_argument("--camera-id", help="Camera ID for multi-camera mode (e.g., cam-1)")
    args = parser.parse_args()

    # Setup per-camera output paths
    setup_output_paths(args.camera_id)

    # Load settings from config or CLI
    if args.config:
        settings = parse_config(args.config)
    else:
        settings = {
            "rtsp": args.rtsp,
            "gpu": args.gpu,
            "interval": args.interval,
            "model": args.model,
            "heatmap_decay": args.heatmap_decay,
            "confidence": args.confidence,
            "camera": "cli",
        }

    # Override with CLI args if provided explicitly
    if args.rtsp:
        settings["rtsp"] = args.rtsp
    if args.gpu is not None:
        settings["gpu"] = args.gpu

    if not settings["rtsp"]:
        print("[CV] Error: No RTSP URL. Use --rtsp or --config with a camera defined.")
        write_status("error", error="No RTSP URL configured")
        sys.exit(1)

    # ─── Load YOLO ──────────────────────────────────────────────
    print(f"[CV] Loading {settings['model']} on GPU {settings['gpu']}...")
    write_status("loading", model=settings["model"], gpu=settings["gpu"])

    try:
        from ultralytics import YOLO
        import torch

        if not torch.cuda.is_available():
            print("[CV] Warning: CUDA not available. Running on CPU.")
            device = "cpu"
        elif settings["gpu"] >= torch.cuda.device_count():
            print(f"[CV] Warning: GPU {settings['gpu']} not found. Using GPU 0.")
            device = "0"
        else:
            device = str(settings["gpu"])
            gpu_name = torch.cuda.get_device_name(int(device))
            props = torch.cuda.get_device_properties(int(device))
            gpu_mem = (getattr(props, 'total_memory', None) or getattr(props, 'total_mem', 0)) / 1e9
            print(f"[CV] Using GPU {device}: {gpu_name} ({gpu_mem:.1f} GB)")

        model = YOLO(settings["model"])
        # ultralytics expects "cuda:N" format, not just "N"
        cuda_device = f"cuda:{device}" if device not in ("cpu",) and not device.startswith("cuda") else device
        model.to(cuda_device)

        # Warm up with a dummy frame
        dummy = np.zeros((480, 640, 3), dtype=np.uint8)
        model.predict(dummy, verbose=False, device=cuda_device, classes=[0])  # class 0 = person
        print("[CV] Model loaded and warmed up.")

    except Exception as e:
        print(f"[CV] Error loading model: {e}")
        write_status("error", error=str(e))
        sys.exit(1)

    # ─── Open RTSP stream ───────────────────────────────────────
    # Sanitize RTSP URL for logging (hide password)
    rtsp_safe = settings["rtsp"].split("@")[-1] if "@" in settings["rtsp"] else settings["rtsp"]
    print(f"[CV] Connecting to RTSP: {rtsp_safe}")
    write_status("connecting", camera=settings["camera"])

    cap = cv2.VideoCapture(settings["rtsp"], cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # minimal buffer — we want latest frame

    if not cap.isOpened():
        print(f"[CV] Error: Cannot open RTSP stream")
        write_status("error", error="Cannot open RTSP stream")
        sys.exit(1)

    # Read first frame to get dimensions
    ret, frame = cap.read()
    if not ret or frame is None:
        print("[CV] Error: Cannot read first frame")
        write_status("error", error="Cannot read first frame")
        sys.exit(1)

    h, w = frame.shape[:2]
    print(f"[CV] Stream opened: {w}x{h}")

    # ─── Heatmap accumulator ────────────────────────────────────
    if args.heatmap_reset and HEATMAP_RAW_FILE.exists():
        HEATMAP_RAW_FILE.unlink()
        print("[CV] Heatmap reset.")

    heatmap_acc = load_heatmap((h, w))

    # ─── Detection loop ─────────────────────────────────────────
    frame_count = 0
    fps_timer = time.time()
    fps = 0.0

    print(f"[CV] Running — interval {settings['interval']}s, confidence {settings['confidence']}")
    write_status("running",
                 camera=settings["camera"],
                 resolution=f"{w}x{h}",
                 model=settings["model"],
                 gpu=settings["gpu"],
                 interval=settings["interval"])

    while running:
        loop_start = time.time()

        # Grab latest frame (skip buffered frames)
        cap.grab()
        ret, frame = cap.retrieve()
        if not ret or frame is None:
            # Stream lost — try to reconnect
            print("[CV] Stream lost. Reconnecting in 5s...")
            write_status("reconnecting", camera=settings["camera"])
            cap.release()
            time.sleep(5)
            cap = cv2.VideoCapture(settings["rtsp"], cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                print("[CV] Reconnect failed. Retrying...")
                continue
            write_status("running", camera=settings["camera"], resolution=f"{w}x{h}")
            continue

        # ─── YOLO inference ─────────────────────────────────────
        results = model.predict(
            frame,
            verbose=False,
            device=device,
            classes=[0],  # person only
            conf=settings["confidence"],
            imgsz=640,    # inference size — good balance speed/accuracy
        )

        detections = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy().astype(int)
                conf = float(box.conf[0])
                detections.append({
                    "x": int(x1), "y": int(y1),
                    "w": int(x2 - x1), "h": int(y2 - y1),
                    "confidence": round(conf, 3),
                })

                # Add to heatmap — gaussian blob at person center-bottom (feet)
                cx = (x1 + x2) // 2
                cy = y2  # bottom of bounding box (feet position)
                # Create gaussian blob
                sigma = max(x2 - x1, y2 - y1) // 3
                if sigma > 0:
                    y_range = np.arange(max(0, cy - sigma * 2), min(h, cy + sigma * 2))
                    x_range = np.arange(max(0, cx - sigma * 2), min(w, cx + sigma * 2))
                    if len(y_range) > 0 and len(x_range) > 0:
                        yy, xx = np.meshgrid(y_range, x_range, indexing='ij')
                        gaussian = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma ** 2))
                        heatmap_acc[y_range[0]:y_range[-1] + 1, x_range[0]:x_range[-1] + 1] += gaussian

        # Decay heatmap slightly (so old data fades)
        heatmap_acc *= settings["heatmap_decay"]

        # ─── FPS calculation ────────────────────────────────────
        frame_count += 1
        elapsed = time.time() - fps_timer
        if elapsed >= 5.0:
            fps = frame_count / elapsed
            frame_count = 0
            fps_timer = time.time()

        # ─── Write results ──────────────────────────────────────
        now = datetime.now(timezone.utc).isoformat()

        result_data = {
            "timestamp": now,
            "camera": settings["camera"],
            "count": len(detections),
            "detections": detections,
            "fps": round(fps, 1),
            "resolution": f"{w}x{h}",
            "model": settings["model"],
            "gpu": settings["gpu"],
        }

        # Atomic write (write to tmp, then rename)
        tmp_file = DETECTIONS_FILE.with_suffix(".tmp")
        tmp_file.write_text(json.dumps(result_data, indent=2))
        tmp_file.replace(DETECTIONS_FILE)

        # Annotated frame (with bounding boxes)
        annotated = frame.copy()
        for d in detections:
            cv2.rectangle(annotated, (d["x"], d["y"]), (d["x"] + d["w"], d["y"] + d["h"]),
                          (0, 255, 0), 2)
            cv2.putText(annotated, f'{d["confidence"]:.0%}',
                        (d["x"], d["y"] - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
        # Count overlay
        cv2.putText(annotated, f'Pessoas: {len(detections)}',
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
        cv2.putText(annotated, f'{fps:.1f} FPS',
                    (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 0), 1)
        cv2.imwrite(str(FRAME_FILE), annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])

        # Heatmap — save every 10 frames
        if frame_count % 10 == 0 or frame_count == 0:
            save_heatmap(heatmap_acc, (h, w))

        # ─── Sleep until next interval ──────────────────────────
        elapsed = time.time() - loop_start
        sleep_time = max(0, settings["interval"] - elapsed)
        if sleep_time > 0:
            time.sleep(sleep_time)

    # ─── Cleanup ────────────────────────────────────────────────
    cap.release()
    save_heatmap(heatmap_acc, (h, w))
    write_status("stopped")
    print("[CV] Stopped.")


if __name__ == "__main__":
    main()
