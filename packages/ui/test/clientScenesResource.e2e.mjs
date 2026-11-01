import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createPortProbe } from "node:net";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

// Separate browser profile/CDP/daemon: never attach to a user's or Native acceptance browser.
const client = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
assert.ok(process.argv[2], "Pass a new owned evidence directory as the first argument");
const evidence = resolve(process.argv[2]);
const chromePath =
  process.argv[3] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(chromePath);
await mkdir(dirname(evidence), { recursive: true });
await mkdir(evidence, { mode: 0o700 });
const scratch = await mkdtemp(join(tmpdir(), "uwork-scene-swr-"));
const daemonHome = await mkdtemp(join(tmpdir(), "bh-"));
const fixture = join(client, "packages/ui/test/client-scenes-resource/main.tsx");
await writeFile(
  join(scratch, "index.html"),
  `<!doctype html><html><head><title>Scene resource lifecycle</title></head><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`,
);
const portProbe = createPortProbe();
await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
const fixturePort = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
const server = await createServer({
  configFile: false,
  envFile: false,
  envDir: scratch,
  root: scratch,
  cacheDir: join(scratch, "vite-cache"),
  plugins: [react()],
  resolve: { alias: { "@": join(client, "packages/ui/src") } },
  server: {
    host: "127.0.0.1",
    port: fixturePort,
    strictPort: true,
    fs: { allow: [client, scratch] },
  },
  logLevel: "error",
});
let chrome;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = join(scratch, "chrome");
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let cdpPort;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      cdpPort = Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
      );
      break;
    } catch {
      await delay(25);
    }
  }
  assert.ok(cdpPort, "owned headless Chrome must expose its own CDP endpoint");
  await writeFile(
    join(evidence, "runtime.json"),
    JSON.stringify(
      {
        origin,
        chromePid: chrome.pid,
        cdpPort,
        profile,
        daemonHome,
        rootEnvFilesExcluded: true,
        nativeProfileTouched: false,
      },
      null,
      2,
    ),
  );
  const code = `
import time, json, base64, pathlib
out=pathlib.Path(${JSON.stringify(evidence)})
origin=${JSON.stringify(origin)}
results=[]
def wait(expression):
    for _ in range(200):
        if js(expression): return
        time.sleep(.05)
    raise AssertionError(expression+': '+str(js('document.body.innerText')))
def text(testid): return js('document.querySelector('+json.dumps('[data-testid='+testid+']')+')?.textContent')
def click(label):
    nodes=cdp('Accessibility.getFullAXTree')['nodes']
    matches=[n for n in nodes if n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value')==label]
    assert len(matches)==1, label
    q=cdp('DOM.getBoxModel',backendNodeId=matches[0]['backendDOMNodeId'])['model']['content']
    click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
def snapshot(name):
    (out/(name+'.txt')).write_text(js('document.body.innerText'))
    (out/(name+'-ax.json')).write_text(json.dumps(cdp('Accessibility.getFullAXTree'),ensure_ascii=False))
    (out/(name+'.png')).write_bytes(base64.b64decode(cdp('Page.captureScreenshot')['data']))
for case in ['shared','remount','same-commit','strict','publication','owner','late-error','unavailable','logout','idle-owner']:
    target=new_tab(origin+'/?case='+case)
    try:
        wait_for_load()
        cdp('Emulation.setFocusEmulationEnabled',enabled=True)
        wait("document.querySelector('[data-testid=scope]')?.textContent.endsWith('ready:ready:1') && document.querySelector('[data-testid=scheduled-A]')?.textContent==='A-scheduled-1' && document.querySelector('[data-testid=scheduled-B]')?.textContent==='A-scheduled-1'")
        baseline=int(text('calls'))
        snapshot(case+'-before')
        if case in ['shared','strict']:
            click('Toggle A'); time.sleep(.15)
            assert text('scheduled-B')=='A-scheduled-1', 'one reader unmount erased the other reader'
            assert text('offpeak-B')=='A-offpeak-1'
            assert int(text('calls'))==baseline, 'remaining reader must keep its deduped current data'
        elif case=='remount':
            click('Toggle A'); click('Toggle B'); time.sleep(.15); click('Toggle B'); time.sleep(.2)
            assert text('scheduled-B')=='A-scheduled-1', 'last reader remount stayed empty within dedupe window'
            assert text('offpeak-B')=='A-offpeak-1'
        elif case=='same-commit':
            click('Only A'); time.sleep(.1); click('Swap readers'); time.sleep(.15)
            assert text('scheduled-B')=='A-scheduled-1'
            assert int(text('calls'))==baseline, 'same commit handoff must retain the shared snapshot'
        elif case=='idle-owner':
            click('Toggle A'); click('Toggle B'); time.sleep(.1); click('Switch owner'); click('Toggle B')
            wait("document.querySelector('[data-testid=scheduled-B]')?.textContent==='B-scheduled-1'")
            click('Inspect cache'); assert 'A-scheduled-1' not in text('cache-data')
        else:
            click('Hold next'); click('Refresh A'); wait("Number(document.querySelector('[data-testid=calls]').textContent)>"+str(baseline))
            if case=='publication':
                click('Publish version'); expected='A-scheduled-2'
            elif case=='unavailable':
                click('Switch unavailable owner'); expected='EMPTY'
            elif case=='logout':
                click('Logout current'); expected='EMPTY'
            else:
                click('Switch owner'); expected='B-scheduled-1'
            wait("document.querySelector('[data-testid=scheduled-B]')?.textContent==="+json.dumps(expected))
            click('Reject old' if case=='late-error' else 'Release old'); time.sleep(.15)
            assert text('scheduled-A')==expected and text('scheduled-B')==expected, 'late old scope replaced current view'
            if case not in ['unavailable','logout']: assert text('error-B')=='NONE'
            click('Inspect cache'); assert 'A-scheduled-1' not in text('cache-data')
        assert js('Number(document.documentElement.dataset.runtimeErrors ?? 0)===0')
        snapshot(case+'-after')
        results.append({'case':case,'status':'PASS','callsBefore':baseline,'callsAfter':int(text('calls'))})
    except Exception as error:
        snapshot(case+'-failed')
        results.append({'case':case,'status':'FAIL','error':str(error),'body':js('document.body.innerText')})
    finally:
        cdp('Target.closeTarget',targetId=target)
(out/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False))
assert all(item['status']=='PASS' for item in results), 'scene resource lifecycle regression'
`;
  const browser = spawn("browser-harness", [], {
    cwd: scratch,
    env: {
      ...process.env,
      BH_HOME: daemonHome,
      BH_RUNTIME_DIR: join(daemonHome, "runtime"),
      BH_TMP_DIR: join(daemonHome, "tmp"),
      BH_AGENT_WORKSPACE: join(daemonHome, "agent-workspace"),
      BH_CONFIG_DIR: daemonHome,
      BU_NAME: `scene-${process.pid}`,
      BU_CDP_URL: `http://127.0.0.1:${cdpPort}`,
      BH_RECORD: "0",
    },
    stdio: ["pipe", "inherit", "inherit"],
  });
  browser.stdin.end(code);
  const exit = await new Promise((done, reject) => {
    browser.once("error", reject);
    browser.once("exit", done);
  });
  if (exit !== 0) process.exitCode = Number(exit ?? 1);
} finally {
  await server.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGTERM");
    for (
      let attempt = 0;
      attempt < 100 && chrome.exitCode === null && chrome.signalCode === null;
      attempt++
    )
      await delay(25);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  }
  let daemonPid;
  try {
    daemonPid = Number((await readFile(join(daemonHome, "runtime/bu.pid"), "utf8")).trim());
    if (Number.isSafeInteger(daemonPid) && daemonPid > 1) process.kill(daemonPid, "SIGTERM");
  } catch {
    /* Own daemon may already have stopped with its browser. */
  }
  let daemonExited = true;
  if (daemonPid) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(daemonPid, 0);
        daemonExited = false;
      } catch {
        daemonExited = true;
        break;
      }
      await delay(10);
    }
    if (!daemonExited) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {}
    }
  }
  await rm(daemonHome, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  await writeFile(
    join(evidence, "cleanup.json"),
    JSON.stringify({
      ownViteClosed: !server.httpServer.listening,
      ownBrowserClosed: chrome?.exitCode !== null || chrome?.signalCode !== null,
      daemonPid,
      daemonExited,
      ownScratchRemoved: true,
      ownDaemonHomeRemoved: true,
      nativeProfileTouched: false,
    }) + "\n",
  );
}
