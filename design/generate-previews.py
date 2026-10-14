"""Generate three standalone visual proposals from the real settings markup."""
from pathlib import Path
import re
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

root = Path(__file__).resolve().parent
source = (root.parent / 'src/settings.html').read_text()
icon = (root.parent / 'src/icon.svg').read_text()
(root / 'icon.svg').write_text(icon)
w, h = 1800, 1150
y, x = np.mgrid[0:h, 0:w].astype(float)
x /= w
y /= h
rng = np.random.default_rng(42)
noise = rng.normal(0, 1, (h, w))
variants = [('a', '01 · 官网云雾', 1.0, .0), ('b', '02 · 轻雾留白', .66, .12), ('c', '03 · 蓝紫暮光', .9, -.16)]
for key, title, strength, shift in variants:
    warp = .065 * np.sin(x * 21 + y * 14) + .034 * np.sin(x * 49 - y * 23) + .014 * np.sin(x * 103 + y * 87)
    colors = [(0.03, .05, .27, .30, [211, 91, 194]), (.42, -.05, .24, .35, [97, 187, 224]), (.72, .13, .22, .28, [151, 96, 234]), (1.0, .08, .22, .31, [246, 149, 183]), (.23, .30, .18, .20, [234, 181, 216])]
    canvas = np.full((h, w, 3), 253., dtype=float)
    weights = []
    for cx, cy, sx, sy, color in colors:
        weight = np.exp(-(((x + warp - cx - shift) / sx) ** 2 + ((y + warp * .6 - cy) / sy) ** 2) * 2.8)
        weights.append((weight, np.array(color)))
    total = sum(weight for weight, _ in weights)
    cloud = sum(weight[..., None] * color for weight, color in weights) / total[..., None]
    fade = np.clip((.69 - y) / .41, 0, 1)
    fade = fade * fade * (3 - 2 * fade)
    alpha = fade * strength
    canvas = canvas * (1 - alpha[..., None]) + cloud * alpha[..., None]
    grain = noise * 12 + np.sin(x * w * 2.1 + y * h * 1.7) * 3
    canvas += grain[..., None] * alpha[..., None]
    image = Image.fromarray(np.uint8(np.clip(canvas, 0, 255)))
    image.save(root / f'background-{key}.jpg', quality=92)
    css = f'''
:root{{--pink:#e4d9fa;--paper:#fefefe;--ink:#202022;--line:#dedde3;--muted:#74717c}}
body{{background:#fdfdfd url("background-{key}.jpg") center top / 100% auto no-repeat;min-height:100svh}}
.topbar{{height:82px;background:transparent;border:0;max-width:1240px;margin:auto;padding:0 36px}}
.brand{{font-size:20px}}.brand-icon{{width:32px;height:32px}}.topmeta{{font-size:11px}}
main{{max-width:1168px;min-height:700px;margin:48px auto 60px;border:0!important;grid-template-columns:.95fr 1.05fr}}
.intro{{background:transparent;border:0;padding:42px 56px 32px 28px}}
.intro h2{{font-size:54px;letter-spacing:-3px;line-height:1.2;margin:30px 0 60px}}
.eyebrow{{font-size:11px}}.diagram{{margin:auto 0 35px;max-width:340px}}
.window{{background:#ffffffb8;box-shadow:3px 3px 0 #202022;backdrop-filter:blur(8px)}}
.window.final{{background:#fff}}.window-title{{height:28px}}.window-body{{padding:16px 18px}}
.intro-foot{{border-color:#20202224}}.settings{{background:#ffffffed;border:1px solid #343039;padding:40px 38px 28px;box-shadow:5px 5px 0 #25222c12;min-width:0;backdrop-filter:blur(18px)}}
.heading h1{{font-size:30px}}.heading{{margin-bottom:30px}}.enable-row label,legend{{font-size:15px}}.enable-row{{border-color:var(--line)}}
.model{{min-height:72px;padding:14px}}.model.selected{{background:#f0eafa;box-shadow:2px 2px 0 #202022}}.model-title{{font-size:15px}}.model-id{{font-size:10px}}.models{{max-height:306px}}
.settings-foot{{padding-top:30px}}.section-number{{font-size:11px}}.window-label,.restore{{font-size:12px}}
@media(max-width:809px){{body{{background-size:auto 700px}}.topbar{{padding:0 22px;height:68px}}main{{display:block;margin:10px 20px 30px;min-height:0}}.intro{{padding:20px 4px 28px}}.intro h2{{font-size:34px;letter-spacing:-1.5px;margin:18px 0 0}}.settings{{padding:28px 24px;min-height:560px}}}}
'''
    if key == 'b':
        css += '.settings{border-color:#dedce4;box-shadow:0 18px 70px #3530490a}.window{box-shadow:2px 2px 0 #202022}.model.selected{background:#f4f0fa}.intro h2{font-weight:500}'
    if key == 'c':
        css += ':root{--pink:#ceddf9}.model.selected{background:#edf2fd}.window.final .window-title{background:#292c47}.settings{border-color:#35384f}.intro h2{color:#25283d}'
    html = source.replace('__VERSION__', '0.2.0').replace('/icon.svg', 'icon.svg')
    html = html.replace('</style>', css + '\n</style>')
    html = html.replace('<script src="/settings.js" defer></script>', '')
    html = html.replace('<title>Final Model · 设置</title>', f'<title>{title} · Final Model</title>')
    script = '''
<script>
const models=[{name:'GPT-6-Luna',id:'codex/gpt-6-luna',size:'256K'},{name:'Gemini 3.8 Flash',id:'antigravity/gemini-3.8-flash',size:'256K'}];
const enabled=document.getElementById('enabled');enabled.disabled=false;enabled.checked=true;
const search=document.getElementById('search');search.disabled=false;
let selected=models[0].id;
document.getElementById('version').textContent='设计预览';document.getElementById('working-model').textContent='smart';
function render(){const list=document.getElementById('models');list.replaceChildren();list.setAttribute('aria-busy','false');const heading=document.createElement('p');heading.className='provider';heading.textContent='magpie-groups';list.append(heading);for(const model of models.filter(m=>(m.name+' '+m.id).toLowerCase().includes(search.value.toLowerCase()))){const label=document.createElement('label');label.className='model'+(model.id===selected?' selected':'');const input=document.createElement('input');input.type='radio';input.name='model';input.checked=model.id===selected;input.onchange=()=>{selected=model.id;render()};const copy=document.createElement('span');copy.className='model-copy';const name=document.createElement('span');name.className='model-title';name.textContent=model.name;const id=document.createElement('span');id.className='model-id';id.textContent=model.id;copy.append(name,id);const cap=document.createElement('span');cap.className='capacity';cap.textContent=model.size;const radio=document.createElement('span');radio.className='radio';label.append(input,copy,cap,radio);list.append(label)}document.getElementById('final-model').textContent=enabled.checked?models.find(m=>m.id===selected).name:'跟随工作模型';document.getElementById('restore-label').textContent=enabled.checked?'完成后，回到工作模型':'由工作模型完成全部答复'}
search.oninput=render;enabled.onchange=render;render();document.getElementById('save-status').textContent='预览模式 · 不修改配置';
</script>
'''
    (root / f'{key}.html').write_text(html.replace('</body>', script + '</body>'))

sheet = Image.new('RGB', (1500, 400), '#ffffff')
draw = ImageDraw.Draw(sheet)
for i, (key, _, _, _) in enumerate(variants):
    image = Image.open(root / f'background-{key}.jpg').resize((500, 340))
    sheet.paste(image, (i * 500, 0))
    draw.text((i * 500 + 24, 355), f'{key.upper()} / FINAL MODEL', fill='#202022')
sheet.save(root / 'backgrounds.jpg', quality=94)
