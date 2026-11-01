import base64, json, pathlib, time

out = pathlib.Path(EVIDENCE)
results = []

def facts():
    value = json.loads(js("document.querySelector('[data-testid=share-entry-facts]')?.textContent || '{}'") or '{}')
    value['triggers'] = js("document.querySelectorAll('[data-testid=conversation-share-trigger]').length")
    value['pressed'] = js("document.querySelector('[data-testid=conversation-share-trigger]')?.getAttribute('aria-pressed') ?? null")
    value['runtimeErrors'] = js("Number(document.documentElement.dataset.fixtureErrors || '0')")
    return value

def wait(predicate):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        value = facts()
        if predicate(value):
            return value
        time.sleep(.025)
    raise AssertionError('Actual component did not settle: ' + str(facts()))

def click(label):
    nodes = [n for n in cdp('Accessibility.getFullAXTree')['nodes']
             if not n.get('ignored') and n.get('role', {}).get('value') == 'button'
             and n.get('name', {}).get('value') == label]
    assert len(nodes) == 1, (label, len(nodes))
    quad = cdp('DOM.getBoxModel', backendNodeId=nodes[0]['backendDOMNodeId'])['model']['content']
    click_at_xy(sum(quad[0::2]) / 4, sum(quad[1::2]) / 4)

def share_click():
    label = js("document.querySelector('[data-testid=conversation-share-trigger]')?.getAttribute('aria-label')")
    assert label, 'Actual sharing trigger is absent'
    click(label)

def capture(name):
    data = facts()
    with (out / (name + '-facts.json')).open('x') as f:
        json.dump(data, f, indent=2)
    with (out / (name + '-ax.json')).open('x') as f:
        json.dump(cdp('Accessibility.getFullAXTree'), f, ensure_ascii=False)
    with (out / (name + '.txt')).open('x') as f:
        f.write(js('document.body.innerText'))
    with (out / (name + '.png')).open('xb') as f:
        f.write(base64.b64decode(cdp('Page.captureScreenshot', format='png')['data']))

def visible(expected):
    time.sleep(.1)
    value = facts()
    assert value['runtimeErrors'] == 0, value
    assert value['triggers'] == expected, ('sharing entry count', expected, value)
    return value

cases = ['managed-authenticated', 'managed-signed-out', 'managed-pending', 'owner-transition',
         'task-constraint', 'desktop-constraint', 'legacy-compatible', 'legacy-empty']
for case in cases:
    target = new_tab(ORIGIN + '/?case=' + case)
    phase = 'fixture-initialization'
    try:
        wait_for_load()
        expected = ('no-context' if case.startswith('legacy-') else
                    'signed-out' if case == 'managed-signed-out' else
                    'pending' if case == 'managed-pending' else 'authenticated')
        wait(lambda x: x.get('status') == expected)
        capture(case + '-before')
        phase = 'component-assertions'
        if case in ['managed-signed-out', 'managed-pending', 'legacy-empty']:
            visible(0)
        elif case == 'managed-authenticated':
            visible(1)
            share_click()
            wait(lambda x: x.get('pressed') == 'true')
            share_click()
            wait(lambda x: x.get('pressed') == 'false')
        elif case == 'owner-transition':
            visible(1)
            click('Set legacy')
            wait(lambda x: x.get('legacyUser') is True)
            click('Switch identity')
            wait(lambda x: x.get('status') == 'pending' and x.get('ownerName') == 'B')
            visible(0)
            click('Authenticate current')
            wait(lambda x: x.get('currentMember') == 'owned-member-B')
            visible(1)
            click('Sign out')
            wait(lambda x: x.get('status') == 'signed-out')
            visible(0)
        elif case == 'task-constraint':
            visible(1)
            click('Remove task')
            wait(lambda x: x.get('activeTaskId') is None)
            visible(0)
            click('Restore task')
            wait(lambda x: x.get('activeTaskId') == 'owned-task')
            visible(1)
        elif case == 'desktop-constraint':
            visible(1)
            click('Web')
            wait(lambda x: x.get('isDesktop') is False)
            visible(0)
            click('Desktop')
            wait(lambda x: x.get('isDesktop') is True)
            visible(1)
            click('Desktop unspecified')
            wait(lambda x: x.get('isDesktop') == 'unspecified')
            visible(1)
        elif case == 'legacy-compatible':
            visible(1)
            share_click()
            wait(lambda x: x.get('pressed') == 'true')
            share_click()
            wait(lambda x: x.get('pressed') == 'false')
            click('Clear legacy')
            wait(lambda x: x.get('legacyUser') is False)
            visible(0)
            click('Set legacy')
            wait(lambda x: x.get('legacyUser') is True)
            visible(1)
        capture(case + '-after')
        results.append({'case': case, 'status': 'PASS', 'facts': facts()})
    except Exception as error:
        capture(case + '-failed')
        results.append({'case': case, 'status': 'FAIL', 'phase': phase,
                        'classification': 'component-regression' if phase == 'component-assertions' else 'driver-or-fixture',
                        'error': str(error), 'facts': facts()})
    finally:
        cdp('Target.closeTarget', targetId=target)

with (out / 'results.json').open('x') as f:
    json.dump(results, f, indent=2)
print(json.dumps(results))
assert all(item['status'] == 'PASS' for item in results), 'actual enterprise sharing entry regression'
