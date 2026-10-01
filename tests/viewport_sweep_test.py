#!/usr/bin/env python3
"""
主要端末ビューポートの総点検テスト

実機に近い 9 パターンのビューポートで
  - 縦横スクロールが出ないこと
  - キャンバスがステージ内に収まること
  - 映像がステージを十分に使うこと（占有率 45% 以上）
  - 操作バー／ヘッダーの要素が画面外へはみ出さないこと
  - JS エラーが出ないこと
を一括で検証する。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rotation_test import FAKE_CAMERA, URL
from playwright.sync_api import sync_playwright
# 代表的な端末で崩れがないか総点検
CASES = [
    ("iPhone SE 縦",      320, 568, True,  1080,1920),
    ("iPhone SE 横",      568, 320, True,  1920,1080),
    ("iPhone 14 縦",      390, 844, True,  1080,1920),
    ("iPhone 14 横",      844, 390, True,  1920,1080),
    ("iPhone 14 PM 横",   932, 430, True,  1920,1080),
    ("Pixel 7 縦",        412, 915, True,  1080,1920),
    ("iPad mini 縦",      744,1133, True,  1080,1920),
    ("iPad Pro 横",      1366, 1024,True,  1920,1080),
    ("PC",               1440, 900, False, 1920,1080),
]
fails=0
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'])
    for name,w,h,mob,cw,ch in CASES:
        kw=dict(viewport={'width':w,'height':h})
        if mob: kw.update(is_mobile=True, has_touch=True)
        ctx=b.new_context(**kw); ctx.grant_permissions(['camera'])
        pg=ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.add_init_script(f"window.__CAM_W__={cw};window.__CAM_H__={ch};window.__FAKE_ELEV__=60;")
        pg.goto(URL); pg.add_script_tag(content=FAKE_CAMERA)
        pg.wait_for_function("window.__FAKE_READY__===true")
        pg.click('#splash-start')
        pg.wait_for_function("()=>document.getElementById('video').videoWidth>0", timeout=10000)
        pg.wait_for_timeout(900)
        m=pg.evaluate("""()=>{
          const s=document.getElementById('stage-inner').getBoundingClientRect();
          const c=document.getElementById('setup-canvas').getBoundingClientRect();
          // ビューポートからはみ出す要素を検出
          const over=[...document.querySelectorAll('#controls *, #topbar *')]
            .filter(e=>{const r=e.getBoundingClientRect();
              return r.width>0 && (r.right>innerWidth+1 || r.left<-1);})
            .map(e=>e.id||e.className);
          return {sw:s.width,sh:s.height,cw:c.width,ch:c.height,
                  fill:(c.width*c.height)/(s.width*s.height),
                  scrollW:document.documentElement.scrollWidth,
                  scrollH:document.body.scrollHeight, over:over.slice(0,3)};
        }""")
        bad=[]
        if m['scrollW']>w+1: bad.append(f"横スクロール({m['scrollW']})")
        if m['scrollH']>h+2: bad.append(f"縦スクロール({m['scrollH']})")
        if m['cw']>m['sw']+1 or m['ch']>m['sh']+1: bad.append("キャンバスはみ出し")
        if m['fill']<0.45: bad.append(f"占有率{m['fill']*100:.0f}%")
        if m['over']: bad.append(f"要素はみ出し{m['over']}")
        if errs: bad.append(f"JSエラー")
        status = "\033[32mOK\033[0m" if not bad else "\033[31mNG\033[0m"
        print(f"{status} {name:16} {w}x{h} 占有率={m['fill']*100:3.0f}% {'; '.join(bad)}")
        if bad: fails+=1
        ctx.close()
    b.close()
print()
print("NG:", fails, "/", len(CASES))
sys.exit(1 if fails else 0)
