import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const root = resolve(import.meta.dirname, "../../..");
const server = await createServer({
  configFile: false,
  root: resolve(import.meta.dirname, "enterprise-console"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  server: { host: "127.0.0.1", port: 15494, strictPort: true, fs: { allow: [root] } },
});
const code = String.raw`
import time,base64
from pathlib import Path
target=new_tab('http://127.0.0.1:15494')
# Standard CDP focus emulation keeps background React scheduling/input active.
try:
    wait_for_load()
    cdp('Emulation.setFocusEmulationEnabled',enabled=True)
    def until(expression):
        for _ in range(100):
            if js(expression): return
            time.sleep(.1)
        raise AssertionError(expression+': '+str(js('document.body.innerText')))
    def click_selector(selector):
        rect=js("document.querySelector("+repr(selector)+").getBoundingClientRect().toJSON()")
        cdp('Runtime.evaluate',expression="document.querySelector("+repr(selector)+").scrollIntoView({block:'center'})")
        rect=js("document.querySelector("+repr(selector)+").getBoundingClientRect().toJSON()")
        click_at_xy(rect['x']+rect['width']/2,rect['y']+rect['height']/2)
    def click_name(name):
        nodes=cdp('Accessibility.getFullAXTree')['nodes']
        matches=[node for node in nodes if node.get('role',{}).get('value')=='button' and node.get('name',{}).get('value')==name]
        assert len(matches)==1, (name,len(matches))
        cdp('DOM.scrollIntoViewIfNeeded',backendNodeId=matches[0]['backendDOMNodeId'])
        q=cdp('DOM.getBoxModel',backendNodeId=matches[0]['backendDOMNodeId'])['model']['content']
        click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
    until("!!document.querySelector('[data-testid=enterprise-menu-agents]')")
    assert js("Array.from(document.querySelectorAll('[data-testid=enterprise-navigation] button')).map(e=>e.innerText).join('|')")=='企业门户|自动化|插件商店|对话'
    for selector in ['task-new-button','automations-open','plugin-store-sidebar-open']:
        assert not js("!!document.querySelector('[data-testid="+selector+"]')"),selector
    click_name('企业门户')
    until("document.documentElement.dataset.externalUrl==='https://portal.example.test/'")
    click_name('自动化')
    until("document.documentElement.dataset.automationsOpen==='1'")
    assert js("!!document.querySelector('[data-testid=existing-automations-owner]')")
    assert js("document.querySelector('[data-testid=enterprise-menu-agents]').getAttribute('aria-pressed')==='true'")
    click_name('插件商店')
    until("document.documentElement.dataset.pluginStoreOpen==='1'")
    assert js("!!document.querySelector('[data-testid=existing-plugin-store-owner]')")
    assert js("document.querySelector('[data-testid=enterprise-menu-assets]').getAttribute('aria-pressed')==='true'")
    click_name('已发布旧标题')
    until("document.querySelector('[data-testid=enterprise-menu-agents]')?.innerText==='智能体'")
    click_name('智能体')
    until("document.documentElement.dataset.automationsOpen==='2'")
    click_name('自定义名称')
    until("document.querySelector('[data-testid=enterprise-menu-agents]')?.innerText==='团队计划'")
    click_name('团队计划')
    until("document.documentElement.dataset.automationsOpen==='3'")
    for width in [320,768,1440]:
        cdp('Emulation.setDeviceMetricsOverride',width=width,height=850,deviceScaleFactor=1,mobile=False)
        assert js('document.documentElement.scrollWidth<=innerWidth'),width
        Path('/tmp/uwork-existing-menu-'+str(width)+'.png').write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
    click_name('插件商店')
    until("document.documentElement.dataset.pluginStoreOpen==='2'")
    click_name('撤销下一次自动化准入')
    click_name('团队计划')
    until("!document.querySelector('[data-testid=enterprise-menu-agents]')")
    assert js("document.documentElement.dataset.automationsOpen==='3'")
    assert not js("!!document.querySelector('[data-testid=automations-open]')")
    click_name('关闭商店入口')
    until("!document.querySelector('[data-testid=enterprise-menu-assets]')")
    assert not js("!!document.querySelector('[data-testid=plugin-store-sidebar-open]')")
    click_name('恢复菜单')
    until("!!document.querySelector('[data-testid=enterprise-menu-chat]')")
    click_name('延迟菜单')
    click_name('对话')
    click_name('退出身份')
    until("!document.querySelector('[data-testid=enterprise-navigation]')")
    click_name('释放菜单')
    time.sleep(.2)
    assert js("Number(document.documentElement.dataset.createdLocalTask ?? 0)===0")
    assert js("Number(document.documentElement.dataset.chatOpen ?? 0)===0")
    click_name('恢复身份')
    until("!!document.querySelector('[data-testid=enterprise-menu-chat]')")
    click_name('服务故障')
    until("document.querySelector('[data-testid=enterprise-navigation]')?.innerText.includes('暂不可用')")
    assert not js("!!document.querySelector('[data-testid=task-new-button]')")
    click_name('恢复菜单')
    until("!!document.querySelector('[data-testid=enterprise-menu-chat]')")
    click_name('对话')
    until("document.documentElement.dataset.createdLocalTask==='1'")
    click_name('延迟菜单')
    click_name('对话')
    click_name('切换侧栏')
    until("!document.querySelector('[data-testid=enterprise-menu-chat]')")
    click_name('释放菜单')
    time.sleep(.2)
    assert js("document.documentElement.dataset.createdLocalTask==='1'")
    click_name('切换侧栏')
    until("!!document.querySelector('[data-testid=enterprise-menu-chat]')")
    click_name('关闭对话入口')
    until("!document.querySelector('[data-testid=enterprise-menu-chat]')")
    assert not js("!!document.querySelector('[data-testid=task-new-button]')")
    click_name('UCAS模式')
    until("!!document.querySelector('[data-testid=task-new-button]')")
    for selector in ['task-new-button','automations-open','plugin-store-sidebar-open']:
        click_selector('[data-testid='+selector+']')
    until("document.documentElement.dataset.createdLocalTask==='2'")
    assert js("document.documentElement.dataset.automationsOpen==='4'")
    assert js("document.documentElement.dataset.pluginStoreOpen==='3'")
    assert js("Number(document.documentElement.dataset.resourceCalls ?? 0)===0")
    assert js("Number(document.documentElement.dataset.runtimeErrors ?? 0)===0")
    assert not js("!!document.querySelector('[data-testid=enterprise-agents-page],[data-testid=enterprise-assets-page]')")
    print('existing UWork menu owners: real Sidebar/production dispatcher, custom names, current admission/revocation, late logout/unmount, UCAS legacy entries; Agent/assets/runs calls=0, 320/768/1440, runtimeErrors=0 passed')
finally:
    cdp('Emulation.setFocusEmulationEnabled',enabled=False)
    cdp('Emulation.clearDeviceMetricsOverride')
    cdp('Target.closeTarget',targetId=target)
    prior=[t for t in cdp('Target.getTargets')['targetInfos'] if t.get('url','').startswith('http://uwork-review.localhost:3015/')]
    if prior: switch_tab(prior[0]['targetId'])
`;
try {
  await server.listen();
  const child = spawn("browser-harness", [], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.end(code);
  const result = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  if (result !== 0) process.exitCode = result ?? 1;
} finally {
  await server.close();
}
