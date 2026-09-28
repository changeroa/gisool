import json
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parent.parent
evidence = root / 'docs/evidence/search-20260928'
cases = json.loads((evidence / 'agent-cases.json').read_text())
db = sqlite3.connect('file:/Users/victor/.codex/state_5.sqlite?mode=ro', uri=True)
rows = []
for case in cases:
    found = db.execute('select id, rollout_path from threads where title=? and created_at>=? order by created_at desc limit 1', (case['prompt'], case['after_epoch'])).fetchone()
    if not found:
        continue
    result = {'case': case['id'], 'session_id': found[0], 'calls': [], 'completed': False, 'prompt': case['prompt']}
    text = Path(found[1]).read_text()
    assert 'mode: discovery' in text, 'New global discovery instructions missing'
    for line in text.splitlines():
        event = json.loads(line)
        payload = event.get('payload', {})
        if event.get('type') == 'turn_context':
            result.update(model=payload.get('model'), effort=payload.get('effort'))
        if payload.get('type') == 'task_started':
            result['started_at'] = event['timestamp']
        if payload.get('type') == 'task_complete':
            result.update(completed=True, duration_ms=payload.get('duration_ms'), answer=payload.get('last_agent_message'))
        item = payload.get('item', {})
        if payload.get('type') != 'item_completed' or item.get('type') != 'McpToolCall':
            continue
        call = {'tool': item.get('tool'), 'arguments': item.get('arguments'), 'plugin': item.get('pluginId'), 'time': event['timestamp']}
        duration = item.get('duration', {})
        call['duration_ms'] = round(duration.get('secs', 0)*1000 + duration.get('nanos', 0)/1e6, 2)
        if call['tool'] == 'search_skills':
            data = json.loads(item['result']['content'][0]['text'])
            call.update(total=data['totalMatches'], names=[s['name'] for s in data['skills']], commit=data['commit'], runtime=data.get('server_version'))
        result['calls'].append(call)
    result['loaded'] = [c['arguments']['uri'].split('/')[-2] for c in result['calls'] if c['tool'] == 'load_skill']
    result['searched'] = any(c['tool'] == 'search_skills' for c in result['calls'])
    rows.append(result)
assert len({r['session_id'] for r in rows}) == len(rows)
summary = {'completed': sum(r['completed'] for r in rows), 'searched': sum(r['searched'] for r in rows),
           'irrelevant_ux_loads': sum('ux-state-review' in r['loaded'] for r in rows if r['case'] != 'state-flow'),
           'results': rows}
(evidence / 'agent-after.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(summary, ensure_ascii=False))
