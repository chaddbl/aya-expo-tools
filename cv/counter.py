"""
AYA Expo Tools — Visitor Counter (Line Crossing)

Counts people entering/exiting by tracking them across a virtual line.
Uses YOLO + ByteTrack for detection + tracking.

Output:
    cv/output/counter/count.json    — running totals (entries, exits, current occupancy)
    cv/output/counter/frame.jpg     — annotated frame with line + tracks
    cv/output/counter/hourly.json   — hourly breakdown
    cv/output/counter/status.json   — process status

Usage:
    python counter.py --config ../config/beleza-astral.json
    python counter.py --rtsp "rtsp://..." --line "500,500,1400,500"
"""

import argparse
import json
import os
import sys
import time
import signal
from pathlib import Path
from datetime import datetime, timezone, timedelta

import cv2
import numpy as np

SCRIPT_DIR = Path(__file__).parent
OUTPUT_DIR = SCRIPT_DIR / "output" / "counter"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

COUNT_FILE = OUTPUT_DIR / "count.json"
FRAME_FILE = OUTPUT_DIR / "frame.jpg"
STATUS_FILE = OUTPUT_DIR / "status.json"
HOURLY_FILE = OUTPUT_DIR / "hourly.json"

running = True

def signal_handler(sig, frame):
    global running
    running = False
    print("\n[Counter] Shutting down...")

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def write_json(filepath, data):
    tmp = str(filepath) + ".tmp"
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, str(filepath))


def write_status(status, **kwargs):
    write_json(STATUS_FILE, {
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "pid": os.getpid(),
        **kwargs,
    })


class LineCrossingCounter:
    """
    Counts objects crossing a virtual line using centroid tracking.
    
    The line divides the frame into "above" and "below".
    - Object moves from above to below = ENTRY (into the exhibition)
    - Object moves from below to above = EXIT (out of the exhibition)
    """

    def __init__(self, line_start, line_end):
        self.line_start = line_start  # (x1, y1)
        self.line_end = line_end      # (x2, y2)
        self.entries = 0
        self.exits = 0
        self.prev_positions = {}  # track_id → "above" | "below"
        
        # Hourly tracking
        self.hourly = {}  # "HH" → { entries, exits }
        self.day_start = datetime.now().strftime("%Y-%m-%d")

    def _side_of_line(self, point):
        """Determine which side of the line a point is on. Returns 'above' or 'below'."""
        x, y = point
        x1, y1 = self.line_start
        x2, y2 = self.line_end
        # Cross product: positive = one side, negative = other
        cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        return "above" if cross < 0 else "below"

    def update(self, tracks):
        """
        Update counter with new tracked detections.
        tracks: list of { id, cx, cy } (centroid of each tracked person)
        Returns: (entries_this_frame, exits_this_frame)
        """
        new_entries = 0
        new_exits = 0
        current_ids = set()
        hour = datetime.now().strftime("%H")

        # Reset hourly if day changed
        today = datetime.now().strftime("%Y-%m-%d")
        if today != self.day_start:
            self.hourly = {}
            self.day_start = today
            # Don't reset total entries/exits — those accumulate per session

        if hour not in self.hourly:
            self.hourly[hour] = {"entries": 0, "exits": 0}

        for track in tracks:
            tid = track["id"]
            cx, cy = track["cx"], track["cy"]
            current_ids.add(tid)

            side = self._side_of_line((cx, cy))

            if tid in self.prev_positions:
                prev_side = self.prev_positions[tid]
                if prev_side == "above" and side == "below":
                    self.entries += 1
                    new_entries += 1
                    self.hourly[hour]["entries"] += 1
                elif prev_side == "below" and side == "above":
                    self.exits += 1
                    new_exits += 1
                    self.hourly[hour]["exits"] += 1

            self.prev_positions[tid] = side

        # Clean up old tracks
        stale = set(self.prev_positions.keys()) - current_ids
        for tid in stale:
            del self.prev_positions[tid]

        return new_entries, new_exits

    @property
    def occupancy(self):
        return max(0, self.entries - self.exits)

    def get_counts(self):
        return {
            "entries": self.entries,
            "exits": self.exits,
            "occupancy": self.occupancy,
            "activeTrackers": len(self.prev_positions),
            "hourly": dict(sorted(self.hourly.items())),
            "date": self.day_start,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }


def draw_frame(frame, line_start, line_end, tracks, counter):
    """Draw annotations on frame."""
    annotated = frame.copy()

    # Draw counting line
    cv2.line(annotated, line_start, line_end, (0, 255, 255), 3)

    # Label
    cv2.putText(annotated, f"IN: {counter.entries}  OUT: {counter.exits}  NOW: {counter.occupancy}",
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

    # Draw tracked persons
    for track in tracks:
        cx, cy = int(track["cx"]), int(track["cy"])
        tid = track["id"]
        x1, y1 = int(track.get("x1", cx-20)), int(track.get("y1", cy-40))
        x2, y2 = int(track.get("x2", cx+20)), int(track.get("y2", cy+10))

        cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.circle(annotated, (cx, cy), 4, (0, 0, 255), -1)
        cv2.putText(annotated, f"#{tid}", (x1, y1-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

    return annotated


def main():
    parser = argparse.ArgumentParser(description="AYA Expo Tools — Visitor Counter")
    parser.add_argument("--config", help="Path to expo config JSON")
    parser.add_argument("--rtsp", help="RTSP URL")
    parser.add_argument("--gpu", type=int, default=1)
    parser.add_argument("--line", default="500,480,1400,480", help="Line coords: x1,y1,x2,y2")
    parser.add_argument("--confidence", type=float, default=0.45)
    parser.add_argument("--model", default="yolov8n")
    parser.add_argument("--interval", type=float, default=0.5, help="Seconds between frames (counter needs higher FPS)")
    args = parser.parse_args()

    # Load RTSP from config if not provided directly
    rtsp_url = args.rtsp
    if not rtsp_url and args.config:
        try:
            with open(args.config, encoding='utf-8') as f:
                config = json.load(f)
            cv_config = config.get("cv", {})
            # Use cam-2 (entrance camera) for counting
            counter_cam = cv_config.get("counterCamera", "cam-2")
            cam = next((c for c in config.get("cameras", []) if c["id"] == counter_cam), None)
            if cam:
                rtsp_url = f"rtsp://{cam.get('user','admin')}:{cam.get('password','')}@{cam['ip']}:554/cam/realmonitor?channel=1&subtype=0"
            # Line from config
            line_cfg = cv_config.get("counterLine")
            if line_cfg:
                args.line = line_cfg
        except Exception as e:
            print(f"[Counter] Config error: {e}")

    if not rtsp_url:
        print("[Counter] Error: no RTSP URL. Use --rtsp or --config")
        sys.exit(1)

    # Parse line coordinates
    coords = [int(x.strip()) for x in args.line.split(",")]
    line_start = (coords[0], coords[1])
    line_end = (coords[2], coords[3])

    print(f"[Counter] Line: {line_start} -> {line_end}")
    print(f"[Counter] Camera: {rtsp_url.split('@')[-1] if '@' in rtsp_url else rtsp_url}")
    write_status("loading")

    # Load YOLO with tracking
    try:
        from ultralytics import YOLO
        import torch

        device = f"cuda:{args.gpu}" if torch.cuda.is_available() else "cpu"
        model = YOLO(args.model)
        print(f"[Counter] Model loaded on {device}")
        write_status("ready", device=device)
    except Exception as e:
        print(f"[Counter] Model error: {e}")
        write_status("error", error=str(e))
        sys.exit(1)

    # Open stream
    print(f"[Counter] Connecting to RTSP...")
    cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    if not cap.isOpened():
        print("[Counter] Error: Cannot open RTSP stream")
        write_status("error", error="Cannot open RTSP stream")
        sys.exit(1)

    print("[Counter] Stream connected. Counting...")
    write_status("running")

    counter = LineCrossingCounter(line_start, line_end)
    frame_count = 0

    while running:
        ret, frame = cap.read()
        if not ret:
            print("[Counter] Stream read failed, reconnecting in 5s...")
            cap.release()
            time.sleep(5)
            cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            continue

        frame_count += 1

        # Run YOLO with tracking (ByteTrack built into ultralytics)
        results = model.track(
            frame,
            persist=True,       # persist tracks across frames
            tracker="bytetrack.yaml",
            classes=[0],        # person only
            conf=args.confidence,
            device=device,
            verbose=False,
        )

        # Extract tracked detections
        tracks = []
        if results and results[0].boxes is not None and results[0].boxes.id is not None:
            boxes = results[0].boxes
            for i in range(len(boxes)):
                x1, y1, x2, y2 = boxes.xyxy[i].cpu().numpy()
                tid = int(boxes.id[i].cpu().numpy())
                cx = (x1 + x2) / 2
                cy = (y1 + y2) / 2
                tracks.append({
                    "id": tid,
                    "cx": cx, "cy": cy,
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                })

        # Update counter
        new_in, new_out = counter.update(tracks)
        if new_in > 0 or new_out > 0:
            print(f"[Counter] +{new_in} IN / +{new_out} OUT → total: {counter.entries} in, {counter.exits} out, {counter.occupancy} now")

        # Write outputs periodically
        if frame_count % 5 == 0:  # every 5 frames (~2.5s at 0.5s interval)
            write_json(COUNT_FILE, counter.get_counts())

        if frame_count % 10 == 0:  # every 10 frames (~5s)
            annotated = draw_frame(frame, line_start, line_end, tracks, counter)
            cv2.imwrite(str(FRAME_FILE), annotated, [cv2.IMWRITE_JPEG_QUALITY, 80])

        time.sleep(args.interval)

    # Final write
    write_json(COUNT_FILE, counter.get_counts())
    write_status("stopped")
    cap.release()
    print(f"[Counter] Final: {counter.entries} entries, {counter.exits} exits, {counter.occupancy} occupancy")


if __name__ == "__main__":
    main()
