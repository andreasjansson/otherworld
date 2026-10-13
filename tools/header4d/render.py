#!/usr/bin/env python3
"""Otherworld vol. 1 header: a first-person flight through a four-dimensional world.

The world is a 4D signed-distance field: architecture built in four dimensions (hyper-tunnels, a
junction where tunnels cross in 4D, a great hall of hyper-columns, the colossal Ring in its
chamber). We see it the only way a 3D being could, through a 3D slice (hyperplane) that flies
along the tunnels and turns through 4D as it goes. The slice turns a whole cycle in the XW plane
per loop, so cross-sections morph, side tunnels open and close, columns grow, split and vanish,
and the Ring changes from two hoops facing us into hoops lying flat above and below.

Pipeline:
  world.frag   GLSL raymarcher for the 4D world (the art lives here)
  world.html   WebGL2 harness: renders frames into a float buffer and POSTs them here
  render.py    this file. A local server that receives the linear HDR frames and post-processes
               them (pyramid bloom, tone map, grain) into PNGs. It also runs the encode, seam and
               poster commands.

Spec (fixed: the glitch decoder on the page relies on it): 1280x640, 24 fps, 576 frames (24 s),
a seamless loop. MPEG-4 Part 2 (mpeg4 / mp4v), no B-frames, GOP 48.

Usage (fxaid venv: numpy, scipy, PIL):
    python render.py serve --out DIR            # then open, in a WebGL2 browser:
        http://localhost:8743/world.html?frames=0,96,192&dir=stills&ss=1    (quick look)
        http://localhost:8743/world.html?frames=0-575&dir=frames&ss=3       (the loop, 9 rays/px)
        http://localhost:8743/world.html?frames=0,576&dir=seam&ss=3         (loop seam)
      (&debug=1..5 shows world.frag's debug views)
    python render.py seam --out DIR             # compare seam/00576.png with seam/00000.png
    python render.py encode --out DIR [--q 5] [--poster 0]
"""

import argparse
import io
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.normpath(os.path.join(HERE, '..', '..', 'site'))
FFMPEG = '/opt/homebrew/bin/ffmpeg'

W, H = 1280, 640
FPS, NFRAMES = 24, 576
PORT = 8743

EXPOSURE = 1.6
BLOOM = (0.0, 0.06, 0.07, 0.07, 0.06, 0.05, 0.04)    # weights for blur radii 1, 2, 4 ... 64 px
GRAIN = 0.010                                          # film grain, sRGB units (sigma)


# ================================================================ post-processing
def up2(a):
    """Bilinear x2 upsample of (h, w, C) with half-pixel centres and clamped edges."""
    for axis in (0, 1):
        a = np.moveaxis(a, axis, -1)
        p = np.concatenate([a[..., :1], a[..., :-1]], -1)
        n = np.concatenate([a[..., 1:], a[..., -1:]], -1)
        out = np.empty(a.shape[:-1] + (a.shape[-1] * 2,), a.dtype)
        out[..., 0::2] = 0.75 * a + 0.25 * p
        out[..., 1::2] = 0.75 * a + 0.25 * n
        a = np.moveaxis(out, -1, axis)
    return a


def down2(a):
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


def bloom(img, weights=BLOOM):
    """Pyramid bloom ("airbrush"): sum of blurs at 1, 2, 4, ... px, weighted."""
    levels = [img]
    for _ in range(len(weights) - 1):
        levels.append(down2(levels[-1]))
    acc = None
    for i in reversed(range(len(levels))):
        b = ndi.gaussian_filter(levels[i], (1.0, 1.0, 0), truncate=3.0) * weights[i]
        acc = b if acc is None else up2(acc) + b
    return acc


def post(hdr, frame):
    """Linear HDR (H, W, 3) -> sRGB uint8: bloom, exponential tone map, a little grain."""
    x = hdr + bloom(hdr)
    out = 1.0 - np.exp(-EXPOSURE * np.maximum(x, 0))
    srgb = np.where(out <= 0.0031308, 12.92 * out, 1.055 * np.power(out, 1 / 2.4) - 0.055)
    rng = np.random.default_rng(1000 + frame % NFRAMES)          # same grain on frame 576 as on 0
    srgb = srgb + GRAIN * rng.standard_normal((H, W, 1))
    return (np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)


# ================================================================ the frame server
class Handler(BaseHTTPRequestHandler):
    out_dir = '.'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body=b'', ctype='text/plain'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path.lstrip('/') or 'world.html'
        if path not in ('world.html', 'world.frag'):
            return self._send(404)
        with open(os.path.join(HERE, path), 'rb') as fh:
            self._send(200, fh.read(), 'text/html; charset=utf-8' if path.endswith('.html') else 'text/plain')

    def do_POST(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        body = self.rfile.read(int(self.headers['Content-Length']))
        if u.path == '/log':
            print('[browser]', body.decode('utf-8', 'replace'), flush=True)
            return self._send(200)
        if u.path == '/frame':
            n = int(qs['n'][0])
            sub = os.path.basename(qs.get('dir', ['frames'])[0])
            d = os.path.join(self.out_dir, sub)
            os.makedirs(d, exist_ok=True)
            hdr = np.frombuffer(body, np.float32).reshape(H, W, 4)[::-1, :, :3].astype(np.float32)
            Image.fromarray(post(hdr, n)).save(os.path.join(d, f'{n:05d}.png'), compress_level=1)
            if n % 48 == 0 or sub != 'frames':
                print(f'{sub}/{n:05d}.png  mean {hdr.mean():.4f}  max {hdr.max():.2f}', flush=True)
            return self._send(200)
        self._send(404)


def serve(out_dir):
    Handler.out_dir = out_dir
    os.makedirs(out_dir, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'serving {HERE} on http://localhost:{PORT}/world.html, frames to {out_dir}', flush=True)
    srv.serve_forever()


# ================================================================ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cmd', choices=['serve', 'seam', 'encode'])
    ap.add_argument('--out', required=True, help='working folder (frames/, stills/, seam/)')
    ap.add_argument('--q', type=int, default=5, help='ffmpeg -qscale:v (2-6)')
    ap.add_argument('--poster', type=int, default=0, help='poster frame (0 = first frame: no jump at start)')
    a = ap.parse_args()
    if a.cmd == 'serve':
        serve(a.out)
    elif a.cmd == 'seam':
        f0 = np.asarray(Image.open(os.path.join(a.out, 'seam', '00000.png')), int)
        f1 = np.asarray(Image.open(os.path.join(a.out, 'seam', '00576.png')), int)
        d = np.abs(f0 - f1)
        print(f'frame 576 vs frame 0: max |diff| {d.max()}, mean {d.mean():.5f}, '
              f'pixels differing by more than 2: {(d.max(-1) > 2).sum()}')
    elif a.cmd == 'encode':
        frames = os.path.join(a.out, 'frames')
        missing = [i for i in range(NFRAMES) if not os.path.exists(os.path.join(frames, f'{i:05d}.png'))]
        if missing:
            sys.exit(f'{len(missing)} frames missing, e.g. {missing[:5]}')
        mp4 = os.path.join(SITE, 'header-4d.mp4')
        subprocess.run([FFMPEG, '-y', '-framerate', str(FPS), '-i', os.path.join(frames, '%05d.png'),
                        '-c:v', 'mpeg4', '-vtag', 'mp4v', '-bf', '0', '-g', '48', '-qscale:v', str(a.q),
                        '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', mp4], check=True)
        # the poster: the poster frame as the mp4 decodes it (what the player draws first), as a small
        # WebP that build.py inlines into the page, so the header shows before the video and wasm load
        png = subprocess.run([FFMPEG, '-v', 'error', '-i', mp4, '-vf', f'select=eq(n\\,{a.poster})', '-frames:v', '1',
                              '-f', 'image2pipe', '-c:v', 'png', '-'], check=True, capture_output=True).stdout
        Image.open(io.BytesIO(png)).convert('RGB').save(os.path.join(SITE, 'header-4d.webp'), quality=80, method=6)
        print(f'{mp4}: {os.path.getsize(mp4) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
