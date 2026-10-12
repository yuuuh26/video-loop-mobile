from pathlib import Path
from math import cos, sin, radians
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parents[1] / 'icons'
output.mkdir(exist_ok=True)
scale = 4
size = 512 * scale
image = Image.new('RGB', (size, size))
draw = ImageDraw.Draw(image)
for y in range(size):
    t = y / size
    color = tuple(round(a * (1 - t) + b * t) for a, b in zip((37, 49, 36), (17, 23, 19)))
    draw.line((0, y, size, y), fill=color)

def p(x, y): return (x * scale, y * scale)
accent = '#e9c46a'
box = [*p(111, 111), *p(401, 401)]
draw.arc(box, start=204, end=352, fill=accent, width=15 * scale)
draw.arc(box, start=24, end=172, fill=accent, width=15 * scale)
for angle in (352, 172):
    x = 256 + 145 * cos(radians(angle))
    y = 256 + 145 * sin(radians(angle))
    tangent = radians(angle + 90)
    points = [(x + 30*cos(tangent), y + 30*sin(tangent)),
              (x - 15*cos(tangent) + 22*cos(tangent+1.570796), y - 15*sin(tangent) + 22*sin(tangent+1.570796)),
              (x - 15*cos(tangent) - 22*cos(tangent+1.570796), y - 15*sin(tangent) - 22*sin(tangent+1.570796))]
    draw.polygon([p(a, b) for a, b in points], fill=accent)
draw.rounded_rectangle([*p(186, 178), *p(326, 334)], radius=30*scale, fill='#334031')
draw.polygon([p(227, 213), p(297, 256), p(227, 299)], fill=accent)
for resolution in (192, 512):
    resized = image.resize((resolution, resolution), Image.Resampling.LANCZOS)
    for stem in ('icon', 'maskable'):
        resized.save(output / f'{stem}-{resolution}.png', optimize=True)
print('Generated four PNG icons at 192 and 512 pixels, with full-bleed background and safe central artwork.')
