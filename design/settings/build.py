"""Bundle the design source and local assets into a standalone HTML file."""

import base64
import re
from pathlib import Path

root = Path(__file__).resolve().parent
source = (root / "index.html").read_text()
cloud = base64.b64encode((root / "cloud-grain.png").read_bytes()).decode()
bootstrap = (
    "<script>\n"
    f'const cloudBytes=Uint8Array.from(atob("{cloud}"),c=>c.charCodeAt(0));\n'
    'const cloudAsset=URL.createObjectURL(new Blob([cloudBytes],{type:"image/png"}));\n'
    'document.documentElement.style.setProperty("--cloud-asset",`url("${cloudAsset}")`);\n'
    "</script>\n"
)
source = source.replace("<style>", bootstrap + "<style>", 1)
source = source.replace("url('cloud-grain.png')", "var(--cloud-asset)")


def inline_svg(match):
    path = root / match.group(1)
    data = base64.b64encode(path.read_bytes()).decode()
    return f'{match.group(0).split("=")[0]}="data:image/svg+xml;base64,{data}"'


source = re.sub(r'(?:src|href)="(\.\./icon\.svg|icons/[^"/]+\.svg)"', inline_svg, source)
# Model options are created dynamically; use the same embedded icon there.
check = base64.b64encode((root / "icons/check.svg").read_bytes()).decode()
source = source.replace("icon.src='icons/check.svg'", f"icon.src='data:image/svg+xml;base64,{check}'")
(root / "final-model.html").write_text(source)
print("Wrote final-model.html with embedded background, brand and icons.")
