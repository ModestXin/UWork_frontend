import base64
import json
import pathlib
import time

out = pathlib.Path(EVIDENCE)
results = []

def facts():
    return json.loads(js("document.querySelector('[data-testid=producer-facts]')?.textContent||'{}'"))

def panel():
    return js("document.querySelector('[data-testid=actual-panel]')?.innerText||''")

def wait(predicate, timeout=15):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        value = facts()
        if value and predicate(value):
            return value
        time.sleep(.025)
    raise AssertionError(('Fixture/public-port precondition failed', value))

def click(name):
    nodes = [n for n in cdp('Accessibility.getFullAXTree')['nodes'] if not n.get('ignored') and n.get('role',{}).get('value')=='button' and n.get('name',{}).get('value')==name]
    assert len(nodes)==1, ('Ambiguous producer input',name,len(nodes))
    cdp('DOM.scrollIntoViewIfNeeded',backendNodeId=nodes[0]['backendDOMNodeId'])
    q=cdp('DOM.getBoxModel',backendNodeId=nodes[0]['backendDOMNodeId'])['model']['content']
    click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)

def control(tid):
    root=cdp('DOM.getDocument')['root']['nodeId']
    matches=cdp('DOM.querySelectorAll',nodeId=root,selector='[data-testid='+json.dumps(tid)+']')['nodeIds']
    assert len(matches)==1,('Expected actual production control',tid,len(matches))
    node=cdp('DOM.describeNode',nodeId=matches[0])['node']['backendNodeId']
    cdp('DOM.scrollIntoViewIfNeeded',backendNodeId=node)
    q=cdp('DOM.getBoxModel',backendNodeId=node)['model']['content']
    click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)

def capture(name):
    value={'driverDiagnostics':js("({runtimeErrors:Number(document.documentElement.dataset.ownedRuntimeErrors||0),unexpectedGetterAccesses:Number(document.documentElement.dataset.ownedGetterErrors||0)})"),'producer':facts(),'actualPanelText':panel(),'selectedPeriods':js("Array.from(document.querySelectorAll('[data-testid^=ucas-gateway-period-]')).map(e=>({id:e.dataset.testid,pressed:e.getAttribute('aria-pressed')}))")}
    value['layoutReads']=js("JSON.parse(document.querySelector('[data-testid=layout-facts]')?.textContent||'[]')")
    value['actualSyncControl']=sync_control(required=False)
    with(out/(name+'-observed.json')).open('x')as f:json.dump(value,f,ensure_ascii=False,indent=2)
    with(out/(name+'-ax.json')).open('x')as f:json.dump(cdp('Accessibility.getFullAXTree'),f,ensure_ascii=False,indent=2)
    with(out/(name+'.png')).open('xb')as f:f.write(base64.b64decode(cdp('Page.captureScreenshot',format='png')['data']))
    return value


def sync_control(required=True):
    value=js("(()=>{const e=document.querySelector('[data-testid=ucas-gateway-sync]');return e?{disabled:e.disabled,text:e.textContent}:null})()")
    if required:
        assert value is not None, 'Actual sync control missing'
    return value

for case in ['initial-late','sync-late','selection-retired','service-replaced']:
    target=new_tab(ORIGIN+'/?case='+case)
    wait_for_load()
    cdp('Runtime.enable')
    cdp('Log.enable')
    checks=[]
    try:
        wait(lambda f:f['A']['getViewCalls']==1)
        if case in ['initial-late','service-replaced']:
            click('Deliver current A event')
        wait(lambda f:'OWNED_OWNER_A'in panel())
        capture(case+'-ready-a')
        if case=='initial-late':
            click('Deliver current signed-out event')
            wait(lambda f:f['A']['latest']['status']=='signed-out'and 'OWNED_OWNER_A'not in panel())
            capture(case+'-signed-out')
            click('Deliver old initial response')
            wait(lambda f:not f['A']['initialPending'])
            time.sleep(.15)
            observed=capture(case+'-late-response')
            checks.append({'name':'old-getView-must-not-revive-owner-a','pass':'OWNED_OWNER_A'not in observed['actualPanelText']})
        elif case=='sync-late':
            control('ucas-gateway-sync')
            wait(lambda f:f['A']['syncCalls']==1 and f['A']['latest']['revision']==12)
            click('Deliver current signed-out event')
            wait(lambda f:f['A']['latest']['status']=='signed-out'and 'OWNED_OWNER_A'not in panel())
            capture(case+'-signed-out')
            click('Deliver old sync response')
            wait(lambda f:not f['A']['syncPending'])
            time.sleep(.15)
            observed=capture(case+'-late-response')
            checks.append({'name':'old-sync-result-must-not-revive-owner-a','pass':'OWNED_OWNER_A'not in observed['actualPanelText']})
        elif case=='selection-retired':
            control('ucas-gateway-period-7d')
            wait(lambda f:len(f['A']['requests'])==1)
            capture(case+'-pending-seven-days')
            click('Deliver current signed-out event')
            wait(lambda f:f['A']['latest']['status']=='signed-out'and 'OWNED_OWNER_A'not in panel())
            click('Deliver new B event')
            wait(lambda f:'OWNED_OWNER_B'in panel())
            click('Retire old usage request')
            wait(lambda f:not f['A']['usagePending'])
            time.sleep(.15)
            observed=capture(case+'-new-owner-after-retire')
            selected={row['id']:row['pressed']for row in observed['selectedPeriods']}
            checks.append({'name':'retired-selection-must-follow-new-month-fact','pass':selected.get('ucas-gateway-period-month')=='true'and selected.get('ucas-gateway-period-7d')!='true'})
            checks.append({'name':'new-owner-b-remains-visible','pass':'OWNED_OWNER_B'in observed['actualPanelText']and'OWNED_OWNER_A'not in observed['actualPanelText']})
        else:
            click('Replace service with B')
            wait(lambda f:f['selected']=='B'and f['B']['getViewCalls']==1)
            time.sleep(.15)
            pending=capture(case+'-b-pending')
            checks.append({'name':'old-owner-hidden-while-new-service-pending','pass':'OWNED_OWNER_A'not in pending['actualPanelText']})
            click('Deliver B initial response')
            wait(lambda f:'OWNED_OWNER_B'in panel())
            click('Deliver old initial response')
            wait(lambda f:not f['A']['initialPending'])
            time.sleep(.15)
            observed=capture(case+'-late-a-after-b')
            checks.append({'name':'new-service-lower-revision-accepted-and-old-promise-ignored','pass':'OWNED_OWNER_B'in observed['actualPanelText']and'OWNED_OWNER_A'not in observed['actualPanelText']})
        diagnostics=js("({runtimeErrors:Number(document.documentElement.dataset.ownedRuntimeErrors||0),unexpectedGetterAccesses:Number(document.documentElement.dataset.ownedGetterErrors||0)})")
        assert diagnostics=={'runtimeErrors':0,'unexpectedGetterAccesses':0}, diagnostics
        assert facts()['runtimeErrors']==0, facts()
        results.append({'case':case,'classification':'component-contract-PASS'if all(c['pass']for c in checks)else'component-contract-RED','checks':checks,'producer':facts(),'driverErrors':0,'driverDiagnostics':diagnostics,'actualNativeOrBackendLogout':False})
    except Exception as error:
        observed=capture(case+'-driver-failed')
        results.append({'case':case,'classification':'DRIVER_ERROR','error':str(error),'observed':observed,'driverErrors':1,'actualNativeOrBackendLogout':False})
    finally:
        with(out/(case+'-runtime-events.json')).open('x')as f:json.dump(drain_events(),f,ensure_ascii=False,indent=2)
        cdp('Target.closeTarget',targetId=target)


for case in ['service-replaced-layout','service-busy-replaced','cold-sync-null-usage']:
    target=new_tab(ORIGIN+'/?case='+case)
    wait_for_load()
    cdp('Runtime.enable')
    cdp('Log.enable')
    checks=[]
    extra={}
    try:
        wait(lambda f:f['A']['getViewCalls']==1)
        if case=='cold-sync-null-usage':
            wait(lambda f:f['A']['latest']['status']=='idle')
            capture(case+'-idle')
            assert sync_control()['disabled'] is False
            control('ucas-gateway-sync')
            wait(lambda f:f['A']['syncCalls']==1 and f['A']['latest']['status']=='syncing')
            assert facts()['A']['latest']['period'] is None
            observed=capture(case+'-held-null-usage')
            checks.append({'name':'cold-sync-null-usage-must-remain-busy','pass':observed['actualSyncControl']['disabled'] is True})
            click('Deliver old sync response')
            wait(lambda f:not f['A']['syncPending'] and 'OWNED_OWNER_A' in panel())
            observed=capture(case+'-finished')
            checks.append({'name':'cold-sync-own-finish-clears-busy','pass':observed['actualSyncControl']['disabled'] is False})
        else:
            if case=='service-replaced-layout':
                click('Deliver current A event')
            wait(lambda f:'OWNED_OWNER_A' in panel())
            capture(case+'-ready-a')
            if case=='service-busy-replaced':
                control('ucas-gateway-sync')
                wait(lambda f:f['A']['syncCalls']==1 and f['A']['latest']['revision']==12)
                assert sync_control()['disabled'] is True, 'Must actually hold A operation'
                capture(case+'-held-a')
            click('Replace service with B')
            wait(lambda f:f['selected']=='B' and f['B']['getViewCalls']==1)
            observed=capture(case+'-b-pending')
            if case=='service-replaced-layout':
                reads=[r for r in observed['layoutReads'] if r['selected']=='B']
                assert len(reads)==1, ('Exactly one first committed B layout observation required',reads)
                checks.append({'name':'first-committed-b-layout-must-not-show-a','pass':'OWNED_OWNER_A' not in reads[0]['text']})
                click('Deliver B initial response')
                wait(lambda f:'OWNED_OWNER_B' in panel())
                click('Deliver old initial response')
                wait(lambda f:not f['A']['initialPending'])
                observed=capture(case+'-final-b')
                checks.append({'name':'b-lower-revision-and-old-promise-isolation-control','pass':'OWNED_OWNER_B' in observed['actualPanelText'] and 'OWNED_OWNER_A' not in observed['actualPanelText']})
            else:
                click('Deliver B initial response')
                wait(lambda f:'OWNED_OWNER_B' in panel())
                observed=capture(case+'-b-ready-a-still-pending')
                available=observed['actualSyncControl']['disabled'] is False
                checks.append({'name':'new-b-sync-must-be-available-while-old-a-pending','pass':available})
                extra['bOperationStarted']=available
                if available:
                    control('ucas-gateway-sync')
                    wait(lambda f:f['B']['syncCalls']==1 and f['B']['latest']['revision']==3)
                    assert sync_control()['disabled'] is True
                click('Deliver old sync response')
                wait(lambda f:not f['A']['syncPending'])
                observed=capture(case+'-after-old-a-finish')
                checks.append({'name':'old-a-result-must-not-replace-b','pass':'OWNED_OWNER_B' in observed['actualPanelText'] and 'OWNED_OWNER_A' not in observed['actualPanelText']})
                if available:
                    checks.append({'name':'old-a-finally-must-not-clear-new-b-busy','pass':observed['actualSyncControl']['disabled'] is True})
                    click('Deliver B sync response')
                    wait(lambda f:not f['B']['syncPending'])
                    observed=capture(case+'-new-b-finished')
                    checks.append({'name':'b-own-finish-must-clear-busy','pass':observed['actualSyncControl']['disabled'] is False})
                else:
                    extra['dependentBOperationAssertionNotRun']='Expected old-source business failure leaves actual B button disabled; no synthetic dispatch'
                    checks.append({'name':'old-a-completion-must-not-leave-b-locked','pass':observed['actualSyncControl']['disabled'] is False})
        diagnostics=js("({runtimeErrors:Number(document.documentElement.dataset.ownedRuntimeErrors||0),unexpectedGetterAccesses:Number(document.documentElement.dataset.ownedGetterErrors||0)})")
        assert diagnostics=={'runtimeErrors':0,'unexpectedGetterAccesses':0}, diagnostics
        assert facts()['runtimeErrors']==0, facts()
        results.append({'case':case,'classification':'component-contract-PASS' if all(c['pass']for c in checks)else'component-contract-RED','checks':checks,'extra':extra,'producer':facts(),'driverErrors':0,'driverDiagnostics':diagnostics,'actualNativeOrBackendLogout':False})
    except Exception as error:
        observed=capture(case+'-driver-failed')
        results.append({'case':case,'classification':'DRIVER_ERROR','error':str(error),'observed':observed,'driverErrors':1,'actualNativeOrBackendLogout':False})
    finally:
        with(out/(case+'-runtime-events.json')).open('x')as f:json.dump(drain_events(),f,ensure_ascii=False,indent=2)
        cdp('Target.closeTarget',targetId=target)


for case in ['usage-return-before-event','usage-return-old-revision','usage-rejected']:
    target=new_tab(ORIGIN+'/?case='+case)
    wait_for_load()
    cdp('Runtime.enable')
    cdp('Log.enable')
    checks=[]
    try:
        wait(lambda f:f['A']['getViewCalls']==1 and 'OWNED_OWNER_A'in panel())
        capture(case+'-ready')
        control('ucas-gateway-period-7d')
        wait(lambda f:len(f['A']['requests'])==1)
        capture(case+'-pending')
        if case=='usage-return-before-event':
            click('Deliver captured usage response')
            wait(lambda f:not f['A']['usagePending'])
            time.sleep(.15)
            observed=capture(case+'-response-before-event')
            selected={r['id']:r['pressed']for r in observed['selectedPeriods']}
            checks.append({'name':'usage-return-before-event-must-display-returned-facts','pass':'OWNED_RETURN_SEVEN'in observed['actualPanelText']and selected.get('ucas-gateway-period-7d')=='true'})
            click('Deliver captured usage event')
            wait(lambda f:'OWNED_RETURN_SEVEN'in panel())
            capture(case+'-matching-event-control')
        elif case=='usage-return-old-revision':
            click('Deliver newer usage event')
            wait(lambda f:f['A']['latest']['revision']==12 and 'OWNED_NEWER_THIRTY'in panel())
            capture(case+'-newer-event')
            click('Deliver captured usage response')
            wait(lambda f:not f['A']['usagePending'])
            time.sleep(.15)
            observed=capture(case+'-old-response')
            selected={r['id']:r['pressed']for r in observed['selectedPeriods']}
            checks.append({'name':'older-usage-return-must-not-overwrite-newer-view','pass':'OWNED_NEWER_THIRTY'in observed['actualPanelText']and'OWNED_RETURN_SEVEN'not in observed['actualPanelText']})
            checks.append({'name':'finished-old-selection-must-follow-current-thirty-days','pass':selected.get('ucas-gateway-period-30d')=='true'and selected.get('ucas-gateway-period-7d')!='true'})
        else:
            click('Reject usage request')
            wait(lambda f:not f['A']['usagePending']and f['A']['latest']['status']=='error')
            time.sleep(.15)
            observed=capture(case+'-rejected')
            selected={r['id']:r['pressed']for r in observed['selectedPeriods']}
            checks.append({'name':'rejected-request-must-not-stay-pending-seven-days','pass':selected.get('ucas-gateway-period-month')=='true'and selected.get('ucas-gateway-period-7d')!='true'})
            checks.append({'name':'same-owner-error-retains-authoritative-snapshot-and-clears-busy','pass':'OWNED_OWNER_A'in observed['actualPanelText']and observed['actualSyncControl']['disabled']is False})
        diagnostics=js("({runtimeErrors:Number(document.documentElement.dataset.ownedRuntimeErrors||0),unexpectedGetterAccesses:Number(document.documentElement.dataset.ownedGetterErrors||0)})")
        assert diagnostics=={'runtimeErrors':0,'unexpectedGetterAccesses':0},diagnostics
        assert facts()['runtimeErrors']==0,facts()
        results.append({'case':case,'classification':'component-contract-PASS'if all(c['pass']for c in checks)else'component-contract-RED','checks':checks,'producer':facts(),'driverErrors':0,'driverDiagnostics':diagnostics,'actualNativeOrBackendLogout':False})
    except Exception as error:
        observed=capture(case+'-driver-failed')
        results.append({'case':case,'classification':'DRIVER_ERROR','error':str(error),'observed':observed,'driverErrors':1,'actualNativeOrBackendLogout':False})
    finally:
        with(out/(case+'-runtime-events.json')).open('x')as f:json.dump(drain_events(),f,ensure_ascii=False,indent=2)
        cdp('Target.closeTarget',targetId=target)

with(out/'results.json').open('x')as f:json.dump(results,f,ensure_ascii=False,indent=2)
print(json.dumps([{'case':r['case'],'classification':r['classification'],'checks':r.get('checks',[])}for r in results]))
cdp('Browser.close')
