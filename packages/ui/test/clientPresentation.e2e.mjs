// Real browser verification of production provider/components; no genuine enterprise login.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = resolve(import.meta.dirname, "../../..");
const server = await createServer({
  configFile: false,
  root: resolve(import.meta.dirname, "client-presentation"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  server: { host: "127.0.0.1", port: 15493, strictPort: true, fs: { allow: [root] } },
});
const code = String.raw`
import time
target = new_tab('http://127.0.0.1:15493')
# Standard CDP focus emulation keeps background React scheduling/input active.
try:
    wait_for_load()
    cdp('Emulation.setFocusEmulationEnabled',enabled=True)
    cdp('Runtime.enable')
    def until(expression):
        for _ in range(100):
            if js(expression): return
            time.sleep(.1)
        raise AssertionError(expression + ': ' + str(js('document.body.innerText')))
    def click_test(testid):
        nodes=cdp('Accessibility.getFullAXTree')['nodes']
        labels={'publish':'发布','empty':'空欢迎','slow':'慢读取','release':'释放旧请求','logout':'退出','signin':'恢复身份','fail':'失败'}
        matches=[n for n in nodes if n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value')==labels[testid]]
        assert len(matches)==1, testid
        q=cdp('DOM.getBoxModel',backendNodeId=matches[0]['backendDOMNodeId'])['model']['content']
        click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
    until("document.querySelector('[data-testid=enterprise-risk-notice]')?.dataset.status==='ready'")
    for width in [320,768,1440]:
        cdp('Emulation.setDeviceMetricsOverride',width=width,height=850,deviceScaleFactor=1,mobile=False)
        assert js('document.documentElement.scrollWidth <= innerWidth'), width
        assert '内容由 AI 生成' in js("document.querySelector('[data-testid=enterprise-risk-notice]').innerText")
    click_test('slow')
    time.sleep(.15)
    click_test('publish')
    until("document.querySelector('[data-v4-draft-greeting]').innerText==='新发布欢迎'")
    click_test('release')
    time.sleep(.15)
    assert js("document.querySelector('[data-v4-draft-greeting]').innerText==='新发布欢迎'")
    click_test('empty')
    until("document.querySelector('[data-v4-draft-greeting]').innerText===''")
    click_test('slow')
    time.sleep(.15)
    click_test('logout')
    until("document.querySelector('[data-testid=enterprise-risk-notice]')?.dataset.status==='fallback'")
    click_test('release')
    time.sleep(.15)
    assert js("document.querySelector('[data-testid=enterprise-risk-notice]')?.dataset.status==='fallback'")
    click_test('signin')
    until("document.querySelector('[data-testid=enterprise-risk-notice]')?.dataset.status==='ready'")
    click_test('fail')
    until("document.querySelector('[data-testid=enterprise-risk-notice]')?.dataset.status==='fallback'")
    assert js("Number(document.documentElement.dataset.runtimeErrors ?? 0)===0")
    print('client presentation browser: responsive 320/768/1440; published/empty/late/logout/failure passed')
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
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolveResult(status));
  });
  if (result !== 0) process.exitCode = result ?? 1;
} finally {
  await server.close();
}
