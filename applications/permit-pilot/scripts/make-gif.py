"""Assemble the run's step screenshots into a short walkthrough GIF.

Usage: .venv/bin/python scripts/make-gif.py artifacts/<run> proof/<name>/walkthrough.gif

Frames are the screenshots the adapter took at each step, cropped to the top
of the page and captioned. No frame is synthesized; if a screenshot is missing
it is skipped.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FRAMES = [
    ('portal-search-form.png', 'Solari Browser: permit number typed into the public search form'),
    ('portal-search.png', 'Search result opened; the permit record loads'),
    ('portal-permit-info.png', 'Permit Info tab: status, milestones, attachments with VOID labels'),
    ('portal-reviews.png', 'Reviews tab: every departmental review row'),
    ('portal-review-detail.png', 'Reviewer comment page read verbatim'),
    ('desktop-tracker.png', 'Solari Desktop: tracker CSV opened on a real screen'),
]
WIDTH, HEIGHT, BAR = 900, 620, 34

def frame(path: Path, caption: str) -> Image.Image:
    img = Image.open(path).convert('RGB')
    scale = WIDTH / img.width
    img = img.resize((WIDTH, max(1, int(img.height * scale))))
    img = img.crop((0, 0, WIDTH, min(img.height, HEIGHT)))
    canvas = Image.new('RGB', (WIDTH, HEIGHT + BAR), '#f4f5f0')
    canvas.paste(img, (0, BAR))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, WIDTH, BAR), fill='#197967')
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
    except OSError:
        font = ImageFont.load_default()
    draw.text((12, 8), caption, fill='white', font=font)
    return canvas.quantize(colors=128, method=Image.Quantize.MEDIANCUT)

run, target = Path(sys.argv[1]), Path(sys.argv[2])
frames = [frame(run / name, caption) for name, caption in FRAMES if (run / name).exists()]
if not frames:
    raise SystemExit('no screenshots found')
target.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(target, save_all=True, append_images=frames[1:], duration=[2200] * len(frames), loop=0, optimize=True)
print(f'{target}: {len(frames)} frames, {target.stat().st_size // 1024} kB')
