import sys
sys.path.insert(0,'/home/user/webapp/tests')
from e2e_test import FAKE_CAMERA, URL, ANALYZE
from playwright.sync_api import sync_playwright
# WebGL を無効化して 2D フォールバックを強制
BLOCK = """
(() => { const o = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(t, ...a) {
    if (t === 'webgl' || t === 'experimental-webgl' || t === 'webgl2') return null;
    return o.call(this, t, ...a); }; })();
"""
with sync_playwright() as pw:
    b = pw.chromium.launch(args=['--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width':1280,'height':800}); ctx.grant_permissions(['camera'])
    pg = ctx.new_page(); errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script(BLOCK); pg.add_init_script("window.__FAKE_ELEV__=45;")
    pg.goto(URL); pg.add_script_tag(content=FAKE_CAMERA)
    pg.wait_for_function("window.__FAKE_READY__===true")
    pg.click('#splash-start')
    pg.wait_for_function("()=>document.getElementById('video').videoWidth>0", timeout=10000)
    pg.wait_for_timeout(600)
    for _ in range(2): pg.click('#angle-btn'); pg.wait_for_timeout(300)
    pg.click('#mode-btn'); pg.wait_for_timeout(1200)
    print('engine:', pg.inner_text('#info-engine'))
    g = pg.evaluate(ANALYZE)
    exp = [['light' if (r+c)%2==0 else 'blue' for c in range(4)] for r in range(4)]
    for row in g: print('  ', ' '.join(f'{c:>5}' for c in row))
    m = sum(1 for r in range(4) for c in range(4) if g[r][c]==exp[r][c])
    print(f'match: {m}/16'); print('errors:', errs)
    
    assert pg.inner_text('#info-engine').startswith('Canvas 2D'), 'fallback not active'
    assert m >= 14, f'2D fallback transform wrong ({m}/16)'
    assert not errs
    print('OK: Canvas 2D fallback works')
    b.close()
