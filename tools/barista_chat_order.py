#!/usr/bin/env python3
"""Drive the barista agent end-to-end over SSE: order -> confirm -> approve.

The approval gate pauses the write tool mid-stream: the SSE connection
stays open while the client POSTs /api/agents/approve. So the stream is
read on a background thread and the approval is sent from the main thread
as soon as the gate event arrives.

Usage:
  APP_TOKEN=<oauth token> python3 tools/barista_chat_order.py
"""
import json
import os
import queue
import sys
import threading
import urllib.request

APP = os.environ.get('APP_URL', 'https://daiwt-coffee-shop-7474646087200844.aws.databricksapps.com')
TOKEN = os.environ.get('APP_TOKEN') or open('/tmp/app_token.txt').read().strip()

DONE = object()


def post_json(path: str, payload: dict) -> bytes:
    req = urllib.request.Request(
        APP + path,
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'},
        method='POST',
    )
    return urllib.request.urlopen(req, timeout=60).read()


def sse_reader(payload: dict, events: queue.Queue) -> None:
    req = urllib.request.Request(
        APP + '/api/agents/chat',
        data=json.dumps(payload).encode(),
        headers={
            'Authorization': f'Bearer {TOKEN}',
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            for raw in resp:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:'):
                    continue
                data = line[5:].strip()
                if not data or data == '[DONE]':
                    continue
                try:
                    events.put(json.loads(data))
                except json.JSONDecodeError:
                    continue
    except Exception as e:  # stream errors surface as a synthetic event
        events.put({'type': 'client.error', 'error': str(e)})
    finally:
        events.put(DONE)


def chat(message: str, thread_id: str | None, auto_approve: bool) -> tuple[str, str | None]:
    payload: dict = {'message': message, 'agent': 'barista'}
    if thread_id:
        payload['threadId'] = thread_id
    events: queue.Queue = queue.Queue()
    threading.Thread(target=sse_reader, args=(payload, events), daemon=True).start()

    text_parts: list[str] = []
    tid = thread_id
    while True:
        ev = events.get(timeout=600)
        if ev is DONE:
            break
        t = ev.get('type')
        if t == 'response.output_text.delta':
            text_parts.append(ev.get('delta', ''))
        elif t == 'appkit.metadata':
            got = (ev.get('data') or {}).get('threadId')
            if got:
                tid = got
        elif t == 'response.output_item.added' and (ev.get('item') or {}).get('type') == 'function_call':
            print(f"  [tool] {ev['item'].get('name')} {ev['item'].get('arguments')}")
        elif t == 'appkit.approval_pending':
            print(f"  [approval gate] tool={ev.get('tool_name')} args={ev.get('args')}")
            if auto_approve:
                post_json('/api/agents/approve', {
                    'streamId': ev['stream_id'],
                    'approvalId': ev['approval_id'],
                    'decision': 'approve',
                })
                print('  [approved]')
        elif t == 'client.error':
            print('  [stream error]', ev.get('error'))
    return ''.join(text_parts), tid


def main() -> int:
    print('== turn 1: order intent ==')
    text, tid = chat('東京駅前店(TYO001)で、アイスコーヒーのMサイズを1つ注文したいです。名前はKonomiです。', None, auto_approve=True)
    print('assistant:', text[:500])

    print('== turn 2: confirm (approve gate auto-approved) ==')
    text, tid = chat('はい、その内容で注文を確定してください。', tid, auto_approve=True)
    print('assistant:', text[:500])

    print('== turn 3: ask for the order id ==')
    text, tid = chat('注文IDとステータスを教えてください。', tid, auto_approve=True)
    print('assistant:', text[:600])
    return 0


if __name__ == '__main__':
    sys.exit(main())
