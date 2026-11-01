import base64, json, pathlib, time

out = pathlib.Path(EVIDENCE)
results = []

def facts():
    return json.loads(js("document.querySelector('[data-testid=navigation-facts]')?.textContent || '{}'") or '{}')

def wait(predicate):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        value=facts()
        if predicate(value): return value
        time.sleep(.025)
    raise AssertionError('Actual DOM result did not settle: '+str(facts()))

def click(label):
    nodes=[n for n in cdp('Accessibility.getFullAXTree')['nodes'] if not n.get('ignored') and n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value')==label]
    assert len(nodes)==1,(label,len(nodes))
    q=cdp('DOM.getBoxModel',backendNodeId=nodes[0]['backendDOMNodeId'])['model']['content']
    click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)

def capture(name):
    for suffix in ['.txt','.png','-ax.json','-facts.json']:assert not (out/(name+suffix)).exists()
    (out/(name+'.txt')).write_text(js('document.body.innerText'))
    (out/(name+'-facts.json')).write_text(json.dumps(facts(),indent=2))
    (out/(name+'-ax.json')).write_text(json.dumps(cdp('Accessibility.getFullAXTree'),ensure_ascii=False))
    (out/(name+'.png')).write_bytes(base64.b64decode(cdp('Page.captureScreenshot',format='png')['data']))

def assert_view(expected):
    wait(lambda x:x.get('isWorkspaceVisible') is True)
    # Let real layout effects finish; no React getter, store or synthetic event.
    time.sleep(.1)
    value=facts()
    assert value['workspaceMainView']==expected,('expected',expected,'actual',value)
    assert value['returnScope']=='user' and value['runtimeErrors']==0,value
    return value

for case in ['already-store-browse','first-chat-browse','ordinary-settings-back','one-shot-consumption']:
    target=new_tab(ORIGIN+'/?case='+case)
    wait_for_load()
    wait(lambda x:x.get('ready') is True)
    try:
        capture(case+'-before')
        if case in ['already-store-browse','ordinary-settings-back']:
            click('Open store');assert_view('plugin-store')
        click('Open settings')
        wait(lambda x:x.get('isWorkspaceVisible') is False)
        if case=='ordinary-settings-back':
            click('Back');assert_view('chat')
        else:
            click('Browse plugins');assert_view('plugin-store')
            if case=='one-shot-consumption':
                click('Open settings');wait(lambda x:x.get('isWorkspaceVisible') is False)
                click('Back');assert_view('chat')
        capture(case+'-after')
        results.append({'case':case,'status':'PASS','facts':facts()})
    except Exception as error:
        capture(case+'-failed')
        results.append({'case':case,'status':'FAIL','error':str(error),'facts':facts()})
    finally:
        cdp('Target.closeTarget',targetId=target)

with (out/'results.json').open('x') as f:json.dump(results,f,indent=2)
print(json.dumps(results))
assert all(row['status']=='PASS' for row in results),'plugin settings navigation component regression'
