"""Professional backend contract tests: isolated SQLite, no network or real keys."""
import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ['LLM_MODE'] = 'mock'
from app import config, db, engine, llm
from app import main
import httpx


class ProfessionalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sobis-test-')
        if db._conn is not None:
            db._conn.close()
        db._conn = None
        self.path_patch = patch.object(config, 'DB_PATH', str(Path(self.temp.name) / 'test.db'))
        self.path_patch.start()
        self.key_patch = patch.object(llm, 'get_api_key', return_value='')
        self.key_patch.start()
        # ASGI requests remain real; block only actual network transports.
        self.net_patch = patch.object(httpx.AsyncHTTPTransport, 'handle_async_request', side_effect=AssertionError('Network forbidden'))
        self.net_patch.start()
        engine.room = engine.Room()
        db.init()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test')

    async def asyncTearDown(self):
        if main._background:
            await asyncio.gather(*list(main._background), return_exceptions=True)
        await self.client.aclose()
        db._conn.close()
        db._conn = None
        self.net_patch.stop()
        self.key_patch.stop()
        self.path_patch.stop()
        self.temp.cleanup()

    async def send(self, text):
        msg = db.add_message('user', 'Tester', text)
        await engine.handle_user_message(msg['id'])
        return msg

    async def test_failed_direct_task_is_failed_not_done(self):
        async def broken(*args, **kwargs):
            raise RuntimeError('PRIVATE-UPSTREAM-BODY')
            yield
        with patch.object(llm, 'stream_chat', broken):
            msg = await self.send('@Riset hello')
        tasks = db.list_tasks()
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]['status'], 'failed')
        self.assertEqual(tasks[0]['message_id'], msg['id'])
        self.assertTrue(tasks[0]['error'])
        self.assertNotIn('PRIVATE-UPSTREAM-BODY', json.dumps(db.get_messages() + tasks))
        self.assertEqual(engine.room.agent_statuses['Riset']['status'], 'error')
        self.assertFalse(engine.room.busy)

    async def test_failed_delegation_propagates_to_parent_task(self):
        async def stream(model, messages, tools=None):
            if 'Kamu adalah Sobis' in messages[0]['content']:
                yield {'type': 'tool_calls', 'calls': [{'id': 'call', 'name': 'assign_tasks', 'arguments': {'tasks': [{'agent_name': 'Riset', 'instruction': 'research'}]}}]}
            else:
                raise RuntimeError('upstream secret')
        with patch.object(llm, 'stream_chat', stream):
            await self.send('delegate')
        tasks = db.list_tasks()
        self.assertEqual(len(tasks), 2)
        self.assertTrue(all(t['status'] == 'failed' for t in tasks))

    async def test_registry_coordinator_and_permissions_are_server_enforced(self):
        before = db.list_agents()
        for name in ['semua', 'ALL', 'system', 'sistem', '@Repair', 'two words']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                db.create_agent(name)
        sobis = db.get_agent_by_name('Sobis')
        for fields in [{'is_active': False}, {'is_orchestrator': False}]:
            with self.assertRaises(ValueError):
                db.update_agent(sobis['id'], **fields)
        with self.assertRaises(ValueError):
            db.delete_agent(sobis['id'])
        with self.assertRaises(ValueError):
            db.create_agent('Wrong', is_orchestrator=True, is_active=False)
        with self.assertRaises(ValueError):
            db.create_agent('Wrong', allowed_tools=['create_agent'])
        worker = db.get_agent_by_name('Riset')
        spoof = {**worker, 'is_orchestrator': True, 'allowed_tools': ['create_agent']}
        denied = json.loads(await engine.execute_tool(spoof, {'name': 'create_agent', 'arguments': {'name': 'Evil'}}))
        self.assertIn('error', denied)
        self.assertIsNone(db.get_agent_by_name('Evil'))
        db.update_agent(sobis['id'], allowed_tools=[])
        denied = json.loads(await engine.execute_tool(sobis, {'name': 'usulkan_memori', 'arguments': {'key': 'x', 'value': 'x'}}))
        self.assertIn('error', denied)
        new = db.create_agent('NewBoss', is_orchestrator=True)
        active = [a for a in db.list_agents() if a['is_orchestrator'] and a['is_active']]
        self.assertEqual([a['id'] for a in active], [new['id']])
        self.assertIsInstance(new['allowed_tools'], list)
        self.assertEqual(db.get_agent_by_name('Sobis')['allowed_tools'], [])

    async def test_mode_explicit_never_auto_enables_or_falls_back(self):
        with patch.dict(os.environ, {'LLM_MODE': ''}), patch.object(llm, 'get_api_key', return_value='synthetic-only') as key:
            db.set_setting('llm_mode', 'auto')
            self.assertEqual(llm.get_mode(), 'mock')
            key.assert_not_called()
            db.set_setting('llm_mode', 'live')
            self.assertEqual(llm.get_mode(), 'live')
        with patch.dict(os.environ, {'LLM_MODE': ''}):
            self.assertEqual(llm.get_mode(), 'live')
            with self.assertRaisesRegex(RuntimeError, 'Kunci API'):
                async for _ in llm.stream_chat('unknown', []):
                    self.fail('LIVE must not fall back')
        self.assertEqual(llm.get_mode(), 'mock')

    async def test_provider_errors_never_expose_response_or_credentials(self):
        original_client = httpx.AsyncClient
        for kind in ('status', 'chunk', 'network'):
            def handler(request):
                if kind == 'network':
                    raise httpx.ConnectError('PRIVATE-KEY-IN-URL', request=request)
                if kind == 'status':
                    return httpx.Response(401, text='PRIVATE-KEY-IN-BODY')
                return httpx.Response(200, text='data: {"error":{"message":"PRIVATE-KEY-IN-CHUNK"}}\n\n')
            local = original_client(transport=httpx.MockTransport(handler))
            with self.subTest(kind=kind), patch.dict(os.environ, {'LLM_MODE': ''}), patch.object(llm, 'get_api_key', return_value='synthetic-only'), patch.object(llm.httpx, 'AsyncClient', return_value=local):
                db.set_setting('llm_mode', 'live')
                with self.assertRaises(RuntimeError) as caught:
                    async for _ in llm.stream_chat('test', []):
                        pass
                self.assertNotIn('PRIVATE', str(caught.exception))
                self.assertNotIn('synthetic', str(caught.exception))

    async def test_memory_approval_replaces_normalized_key_and_terminal_conflicts(self):
        first = db.add_memory(' Target ', 'old', 'Riset')
        rejected = db.add_memory('other', 'hidden-rejected', 'Riset')
        pending = db.add_memory('pending', 'hidden-pending', 'Riset')
        self.assertEqual((await self.client.post(f"/api/memories/{first['id']}/approve")).status_code, 200)
        second = db.add_memory('target', 'new', 'Admin')
        self.assertEqual((await self.client.post(f"/api/memories/{second['id']}/approve")).status_code, 200)
        self.assertEqual((await self.client.post(f"/api/memories/{rejected['id']}/reject")).status_code, 200)
        for mid, action in [(first['id'], 'approve'), (second['id'], 'reject'), (rejected['id'], 'approve')]:
            self.assertEqual((await self.client.post(f'/api/memories/{mid}/{action}')).status_code, 409)
        rows = db.list_memories()
        self.assertEqual(next(m['status'] for m in rows if m['id'] == first['id']), 'superseded')
        self.assertEqual([m['id'] for m in db.approved_memories()], [second['id']])
        block = engine.memory_block()
        self.assertIn('new', block)
        self.assertNotIn('old', block)
        self.assertNotIn('hidden', block)
        self.assertEqual((await self.client.post('/api/memories/99999/approve')).status_code, 404)
        with self.assertRaises(ValueError):
            db.set_memory_status(pending['id'], 'superseded')

    async def test_usage_records_tool_only_and_failed_partial_calls_survive_clear(self):
        count = 0
        async def stream(*args, **kwargs):
            nonlocal count
            count += 1
            yield {'type': 'usage', 'usage': {'prompt_tokens': 11 * count, 'completion_tokens': count, 'cost': 0}}
            if count == 1:
                yield {'type': 'tool_calls', 'calls': [{'id': 'memory', 'name': 'usulkan_memori', 'arguments': {'key': 'x', 'value': 'y'}}]}
            else:
                raise RuntimeError('stream disconnected')
        with patch.object(llm, 'stream_chat', stream):
            await self.send('@Riset remember')
        usage = (await self.client.get('/api/usage')).json()
        self.assertEqual(usage['total']['pesan'], 2)
        self.assertEqual(usage['total']['ptok'], 33)
        self.assertEqual(usage['by_mode']['mock']['pesan'], 2)
        self.assertEqual(usage['by_mode']['live']['pesan'], 0)
        self.assertEqual(db.list_tasks()[0]['status'], 'failed')
        await self.client.post('/api/history/clear')
        self.assertEqual((await self.client.get('/api/usage')).json(), usage)

    async def test_usage_cost_provenance_and_manual_model_labels(self):
        db.record_usage('A', 'unlisted', {'prompt_tokens': 50}, mode='live')
        db.record_usage('A', config.DEFAULT_MODEL, {'prompt_tokens': 1000000}, mode='live')
        db.record_usage('A', 'unlisted', {'cost': 0}, mode='live')
        db.record_usage('A', 'unlisted', {'cost': 0.25}, mode='live')
        db.record_usage('A', 'unlisted', {'cost': 999}, mode='mock')
        report = db.usage_report()
        self.assertEqual(report['by_mode']['live']['unknown_count'], 1)
        self.assertEqual(report['by_mode']['live']['recorded_cost'], 0.25)
        self.assertEqual(report['by_mode']['live']['estimated_cost'], config.price_of(config.DEFAULT_MODEL)[0])
        self.assertEqual(report['by_mode']['mock']['cost'], 0)
        for model in config.MODELS:
            self.assertIn('belum diverifikasi', model['note'])
            self.assertNotIn('termurah', model['note'])
        await self.send('@Admin hello')
        message = next(m for m in db.get_messages() if m['sender_type'] == 'agent')
        self.assertEqual(message['mode'], 'mock')
        self.assertEqual(message['cost_source'], 'simulation')

    async def test_api_snapshot_and_detail_contract(self):
        for path, field in [('/api/health', 'version'), ('/api/models', 'models'), ('/api/memories', 'memories')]:
            response = await self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertIn(field, response.json())
        await self.send('@Admin hello')
        snapshot = (await self.client.get('/api/state')).json()
        self.assertEqual(snapshot['version'], '1.2.0')
        self.assertEqual(snapshot['llm_setting'], 'mock')
        self.assertTrue(snapshot['mode_locked'])
        self.assertEqual(snapshot['queue'], 0)
        self.assertEqual(snapshot['summary']['tasks'], {'queue': 0, 'doing': 0, 'done': 1, 'failed': 0})
        self.assertEqual(snapshot['summary']['active_agents'], 4)
        self.assertEqual(snapshot['summary']['messages'], len(db.get_messages()))
        self.assertEqual(snapshot['usage'], (await self.client.get('/api/usage')).json())
        self.assertTrue(all(a['status'] == 'idle' for a in snapshot['agents']))
        task = snapshot['tasks'][0]
        self.assertEqual((await self.client.get(f"/api/tasks/{task['id']}")).json(), {'task': task})
        self.assertEqual((await self.client.get('/api/tasks/999999')).status_code, 404)

    async def test_mutation_payloads_reject_wrong_types_with_422(self):
        invalid = [
            ('post', '/api/messages', {'content': 123}),
            ('post', '/api/messages', {'content': None}),
            ('post', '/api/agents', {'name': 'Agent', 'is_active': 'false'}),
            ('post', '/api/agents', {'name': 'Agent', 'allowed_tools': 'usulkan_memori'}),
            ('post', '/api/agents', {'name': 'Agent', 'media_models': [3]}),
            ('put', '/api/agents/2', {'role': []}),
            ('put', '/api/agents/2', {'is_active': None}),
            ('post', '/api/settings', {'user_name': 4}),
            ('post', '/api/settings', {'api_key': ['PRIVATE']}),
            ('post', '/api/settings', {'remove_api_key': 'true'}),
            ('post', '/api/settings', {'llm_mode': 'auto'}),
        ]
        transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
            for method, path, payload in invalid:
                with self.subTest(path=path, payload=payload):
                    response = await client.request(method, path, json=payload)
                    self.assertEqual(response.status_code, 422)
                    self.assertNotIn('PRIVATE', response.text)

    async def test_settings_require_explicit_confirmed_live_and_never_leak_key(self):
        with patch.dict(os.environ, {'LLM_MODE': ''}):
            response = await self.client.post('/api/settings', json={'api_key': 'synthetic-only'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['llm_mode'], 'mock')
            self.assertNotIn('synthetic-only', response.text)
            response = await self.client.post('/api/settings', json={'llm_mode': 'live', 'user_name': 'MustNotSave'})
            self.assertEqual(response.status_code, 400)
            self.assertNotEqual(db.get_setting('user_name'), 'MustNotSave')
            response = await self.client.post('/api/settings', json={'llm_mode': 'live', 'confirm_live': True})
            self.assertEqual(response.status_code, 400)
            with patch.object(llm, 'get_api_key', return_value='synthetic-only'):
                response = await self.client.post('/api/settings', json={'llm_mode': 'live', 'confirm_live': True})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['llm_mode'], 'live')
                self.assertNotIn('synthetic-only', response.text)
            response = await self.client.post('/api/messages', json={'content': 'cannot run'})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(db.get_messages(), [])
        response = await self.client.post('/api/settings', json={'llm_mode': 'live', 'confirm_live': True})
        self.assertEqual(response.status_code, 409)

    async def test_queue_snapshot_and_mutation_busy_guard(self):
        await engine.room.lock.acquire()
        try:
            response = await self.client.post('/api/messages', json={'content': '@Riset queued'})
            self.assertEqual(response.status_code, 200)
            snapshot = (await self.client.get('/api/state')).json()
            self.assertTrue(snapshot['busy'])
            self.assertEqual(snapshot['queue'], 1)
            self.assertEqual(snapshot['summary']['tasks']['queue'], 1)
            self.assertEqual(snapshot['tasks'][0]['message_id'], response.json()['id'])
            for method, path, payload in [
                ('post', '/api/agents', {'name': 'Blocked'}),
                ('put', '/api/agents/2', {'role': 'Blocked'}),
                ('delete', '/api/agents/2', None),
                ('post', '/api/history/clear', None),
                ('post', '/api/tasks/clear', None),
                ('post', '/api/settings', {'user_name': 'Blocked'}),
                ('post', '/api/memories/1/approve', None),
                ('post', '/api/memories/1/reject', None),
            ]:
                with self.subTest(path=path):
                    self.assertEqual((await self.client.request(method, path, json=payload)).status_code, 409)
        finally:
            engine.room.lock.release()
        await asyncio.gather(*list(main._background))
        snapshot = (await self.client.get('/api/state')).json()
        self.assertFalse(snapshot['busy'])
        self.assertEqual(snapshot['queue'], 0)
        self.assertEqual(snapshot['summary']['tasks']['done'], 1)

    async def test_room_status_subscriber_matches_queue_snapshot_when_job_starts(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def stream(*args, **kwargs):
            started.set()
            await release.wait()
            yield {'type': 'delta', 'text': 'slow result'}

        events = asyncio.Queue()
        engine.room.subscribers.add(events)
        with patch.object(llm, 'stream_chat', stream):
            run = asyncio.create_task(self.send('@Riset slow queue'))
            try:
                await asyncio.wait_for(started.wait(), timeout=2)
                snapshot = (await self.client.get('/api/state')).json()
                statuses = [event for event in
                            (events.get_nowait() for _ in range(events.qsize()))
                            if event['type'] == 'room_status']
                self.assertTrue(snapshot['busy'])
                self.assertEqual(snapshot['queue'], 0)
                self.assertTrue(statuses)
                self.assertEqual(statuses[-1]['status'], 'working')
                self.assertEqual(statuses[-1]['queue'], snapshot['queue'])
            finally:
                release.set()
                await asyncio.wait_for(run, timeout=2)
                engine.room.subscribers.discard(events)

    async def test_queued_messages_do_not_leak_future_context(self):
        first = db.add_message('user', 'Tester', '@Riset FIRST-INSTRUCTION')
        second = db.add_message('user', 'Tester', '@Admin FUTURE-PRIVATE-INSTRUCTION')
        contexts = []
        async def capture(model, messages, tools=None):
            contexts.append(messages[0]['content'])
            yield {'type': 'delta', 'text': 'done'}
        with patch.object(llm, 'stream_chat', capture):
            await asyncio.gather(engine.handle_user_message(first['id']), engine.handle_user_message(second['id']))
        self.assertIn('FIRST-INSTRUCTION', contexts[0])
        self.assertNotIn('FUTURE-PRIVATE-INSTRUCTION', contexts[0])
        self.assertIn('FUTURE-PRIVATE-INSTRUCTION', contexts[1])

    async def test_queued_job_sees_completed_results_but_not_later_user_instructions(self):
        db.add_message('agent', 'Admin', 'PRIOR-CONTEXT', mode='mock')
        first = db.add_message('user', 'Tester', '@Riset JOB-A')
        started = asyncio.Event()
        release = asyncio.Event()
        contexts = {}

        async def stream(model, messages, tools=None):
            instruction = messages[-1]['content']
            contexts[instruction] = messages[0]['content']
            if instruction == first['content']:
                started.set()
                await release.wait()
                await engine._system_note('JOB-A-SYSTEM-RESULT')
                yield {'type': 'delta', 'text': 'JOB-A-COMPLETED-RESULT'}
            else:
                yield {'type': 'delta', 'text': 'done'}

        with patch.object(llm, 'stream_chat', stream):
            runs = [asyncio.create_task(engine.handle_user_message(first['id']))]
            try:
                await asyncio.wait_for(started.wait(), timeout=2)
                second = db.add_message('user', 'Tester', '@Admin JOB-B summarize JOB-A')
                third = db.add_message('user', 'Tester', '@Penulis JOB-C-PRIVATE-INSTRUCTION')
                for message in (second, third):
                    engine.enqueue_message(message['id'])
                    runs.append(asyncio.create_task(engine.handle_user_message(message['id'])))
                # Later user rows must be filtered before the thirty-message limit.
                for index in range(35):
                    db.add_message('user', 'Tester', f'FUTURE-FLOOD-{index}')
            finally:
                release.set()
                await asyncio.wait_for(asyncio.gather(*runs), timeout=2)

        context = contexts[second['content']]
        self.assertIn('JOB-A-COMPLETED-RESULT', context)
        self.assertIn('JOB-A-SYSTEM-RESULT', context)
        self.assertIn('PRIOR-CONTEXT', context)
        self.assertIn('JOB-B summarize JOB-A', context)
        self.assertNotIn('JOB-C-PRIVATE-INSTRUCTION', context)
        self.assertNotIn('FUTURE-FLOOD-', context)
        self.assertNotIn('JOB-C-PRIVATE-INSTRUCTION', contexts[first['content']])
        self.assertTrue(all(task['status'] == 'done' for task in db.list_tasks()))

    async def test_lifespan_recovers_interrupted_work_and_cancels_background(self):
        old_queue = db.add_task('old queued', 'Admin')
        old_doing = db.add_task('old running', 'Riset')
        db.set_task_status(old_doing['id'], 'doing')
        started = asyncio.Event()
        async def blocked(*args, **kwargs):
            started.set()
            yield {'type': 'usage', 'usage': {'prompt_tokens': 9}}
            await asyncio.Event().wait()
        with patch.object(llm, 'stream_chat', blocked):
            async with main.lifespan(main.app):
                for task in (old_queue, old_doing):
                    current = db.get_task(task['id'])
                    self.assertEqual(current['status'], 'failed')
                    self.assertIn('server', current['error'])
                await self.client.post('/api/messages', json={'content': '@Riset working'})
                await asyncio.wait_for(started.wait(), timeout=2)
                await self.client.post('/api/messages', json={'content': '@Admin queued'})
                self.assertTrue(main._background)
        self.assertFalse(main._background)
        self.assertFalse(engine.room.busy)
        self.assertEqual(engine.room.queue_len, 0)
        self.assertTrue(all(t['status'] == 'failed' for t in db.list_tasks()))
        self.assertEqual(engine.room.agent_statuses['Riset']['status'], 'error')
        self.assertEqual(db.usage_report()['total']['ptok'], 9)
        self.assertEqual((await self.client.post('/api/messages', json={'content': 'shutdown'})).status_code, 503)

    async def test_legacy_migration_preserves_data_and_backfills_usage_once(self):
        db._conn.close()
        db._conn = None
        legacy = str(Path(self.temp.name) / 'legacy.db')
        with sqlite3.connect(legacy) as conn:
            conn.executescript(db.SCHEMA)
            conn.executemany('INSERT INTO agents(name,is_orchestrator,is_active) VALUES(?,?,?)', [('OldBoss', 1, 0), ('Worker', 0, 1)])
            conn.execute("INSERT INTO messages(sender_type,sender_name,content,ptok,ctok,cost) VALUES('agent','Worker','preserved',15,4,0.2)")
            conn.execute("INSERT INTO memories(key,value,status) VALUES('Fact','old','approved')")
            conn.execute("INSERT INTO memories(key,value,status) VALUES(' fact ','new','approved')")
            conn.execute("INSERT INTO tasks(title,agent,status) VALUES('legacy task','Worker','done')")
            conn.executemany('INSERT INTO settings(k,v) VALUES(?,?)', [('_seeded', '1'), ('llm_mode', 'auto')])
        conn.close()
        with patch.object(config, 'DB_PATH', legacy):
            db.init()
            self.assertEqual(len(db.list_agents()), 2)
            active = [a for a in db.list_agents() if a['is_orchestrator'] and a['is_active']]
            self.assertEqual([a['name'] for a in active], ['Worker'])
            self.assertEqual(active[0]['allowed_tools'], db.COORDINATOR_PERMISSIONS)
            self.assertEqual(db.get_setting('llm_mode'), 'mock')
            self.assertEqual(db.get_messages()[0]['content'], 'preserved')
            self.assertEqual(db.get_messages()[0]['mode'], 'legacy')
            self.assertEqual(db.list_tasks()[0]['status'], 'done')
            self.assertEqual(db.list_tasks()[0]['result'], '')
            self.assertEqual(len(db.approved_memories()), 1)
            self.assertEqual(db.approved_memories()[0]['value'], 'new')
            before = db.usage_report()
            self.assertEqual(before['by_mode']['legacy']['pesan'], 1)
            self.assertEqual(before['by_mode']['legacy']['cost'], 0.2)
            self.assertEqual(before['by_mode']['legacy']['recorded_cost'], 0)
            db.init()
            self.assertEqual(db.usage_report(), before)
            self.assertEqual(db.get_setting('schema_version'), '3')
        # TearDown owns the currently open isolated legacy connection.

    async def test_snapshot_counts_all_tasks_not_only_recent_sixty(self):
        with db.get_conn() as conn:
            conn.executemany("INSERT INTO tasks(title,agent,status,result,created_at,updated_at) VALUES(?,'Admin','done','complete',?,?)",
                             [(f'work {i}', db.now(), db.now()) for i in range(65)])
        snapshot = (await self.client.get('/api/state')).json()
        self.assertEqual(len(snapshot['tasks']), 65)
        self.assertEqual(snapshot['summary']['tasks']['done'], 65)
        self.assertEqual(len((await self.client.get('/api/tasks')).json()['tasks']), 65)
        self.assertEqual([t['id'] for t in snapshot['tasks']], sorted([t['id'] for t in snapshot['tasks']], reverse=True))

    async def test_model_only_sees_fresh_authorized_tools_and_tool_names_not_repaired(self):
        stale = db.get_agent_by_name('Sobis')
        db.update_agent(stale['id'], allowed_tools=[])
        offered = []
        async def stream(model, messages, tools=None):
            offered.extend(t['function']['name'] for t in tools)
            yield {'type': 'delta', 'text': 'done'}
        with patch.object(llm, 'stream_chat', stream):
            await engine.safe_run(stale, 'hello', engine.SOBIS_TOOLS)
        self.assertEqual(offered, [])
        db.update_agent(stale['id'], allowed_tools=db.COORDINATOR_PERMISSIONS)
        response = json.loads(await engine.execute_tool(stale, {'name': 'create_agent', 'arguments': {'name': 'two words'}}))
        self.assertIn('error', response)
        self.assertIsNone(db.get_agent_by_name('twowords'))

    async def test_truncated_provider_stream_fails_but_keeps_partial_usage(self):
        text = 'data: ' + json.dumps({'usage': {'prompt_tokens': 7, 'completion_tokens': 2, 'cost': 0.01}, 'choices': [{'delta': {'content': 'partial'}}]}) + '\n\n'
        local = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, text=text)))
        with patch.dict(os.environ, {'LLM_MODE': ''}), patch.object(llm, 'get_api_key', return_value='synthetic-only'), patch.object(llm.httpx, 'AsyncClient', return_value=local):
            db.set_setting('llm_mode', 'live')
            await self.send('@Riset hello')
        self.assertEqual(db.list_tasks()[0]['status'], 'failed')
        usage = db.usage_report()['by_mode']['live']
        self.assertEqual(usage['pesan'], 1)
        self.assertEqual(usage['ptok'], 7)
        self.assertEqual(usage['recorded_cost'], 0.01)

    async def test_empty_model_response_is_failed_not_done(self):
        async def empty(*args, **kwargs):
            yield {'type': 'usage', 'usage': {'prompt_tokens': 2}}
        with patch.object(llm, 'stream_chat', empty):
            await self.send('@Riset empty')
        self.assertEqual(db.list_tasks()[0]['status'], 'failed')
        self.assertEqual(db.usage_report()['total']['pesan'], 1)

    async def test_startup_restores_coordinator_when_legacy_registry_is_empty(self):
        db._run('DELETE FROM agents')
        db.init()
        coordinators = [a for a in db.list_agents() if a['is_orchestrator'] and a['is_active']]
        self.assertEqual(len(coordinators), 1)

    async def test_empty_registry_reseed_keeps_user_settings(self):
        db.set_settings({'user_name': 'Preserved', 'default_model': 'private-model'})
        db._run('DELETE FROM agents')
        db.init()
        self.assertEqual(db.get_setting('user_name'), 'Preserved')
        self.assertEqual(db.get_setting('default_model'), 'private-model')

    async def test_provider_error_chunk_usage_is_preserved(self):
        text = 'data: ' + json.dumps({'error': {'message': 'PRIVATE'}, 'usage': {'prompt_tokens': 3, 'cost': 0.02}}) + '\n\n'
        local = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, text=text)))
        with patch.dict(os.environ, {'LLM_MODE': ''}), patch.object(llm, 'get_api_key', return_value='synthetic-only'), patch.object(llm.httpx, 'AsyncClient', return_value=local):
            db.set_setting('llm_mode', 'live')
            await self.send('@Riset error')
        usage = db.usage_report()['by_mode']['live']
        self.assertEqual(usage['recorded_cost'], 0.02)
        self.assertEqual(usage['ptok'], 3)
        self.assertEqual(db.list_tasks()[0]['status'], 'failed')
        self.assertNotIn('PRIVATE', json.dumps(db.get_messages() + db.list_tasks()))

    async def test_forced_mock_does_not_load_environment_secret_file(self):
        import importlib
        with patch.dict(os.environ, {'LLM_MODE': 'mock', 'KANTOR_SOBIS_DB': config.DB_PATH}), patch('dotenv.load_dotenv') as loader:
            importlib.reload(config)
            loader.assert_not_called()

    async def test_migration_failure_rolls_back_schema_and_marker(self):
        db._conn.close()
        db._conn = None
        path = str(Path(self.temp.name) / 'rollback.db')
        with patch.object(config, 'DB_PATH', path):
            conn = db.get_conn()
            conn.executescript(db.SCHEMA)
            conn.set_authorizer(lambda action, table, *rest: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_INSERT and table == 'usage_records' else sqlite3.SQLITE_OK)
            with self.assertRaises(sqlite3.DatabaseError):
                db.init()
            conn.set_authorizer(None)
            self.assertNotIn('result', {row[1] for row in conn.execute('PRAGMA table_info(tasks)')})
            self.assertIsNone(db.get_setting('schema_version'))
            self.assertIsNone(db._one("SELECT name FROM sqlite_master WHERE name='usage_records'"))
            db.init()
            self.assertEqual(db.get_setting('schema_version'), '3')

    async def test_coordinator_handoff_rolls_back_on_insert_failure(self):
        sobis = db.get_agent_by_name('Sobis')
        db._run("CREATE TRIGGER reject_boss BEFORE INSERT ON agents WHEN NEW.name='BlockedBoss' BEGIN SELECT RAISE(ABORT,'blocked'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            db.create_agent('BlockedBoss', is_orchestrator=True)
        self.assertEqual(db.get_agent(sobis['id']), sobis)
        self.assertEqual(len([a for a in db.list_agents() if a['is_orchestrator'] and a['is_active']]), 1)

    async def test_working_snapshot_task_ids_and_sse_event_contract(self):
        started = asyncio.Event()
        release = asyncio.Event()
        async def stream(*args, **kwargs):
            started.set()
            await release.wait()
            yield {'type': 'delta', 'text': 'actual result'}
            yield {'type': 'usage', 'usage': {'prompt_tokens': 3, 'completion_tokens': 2}}
        events = asyncio.Queue()
        engine.room.subscribers.add(events)
        with patch.object(llm, 'stream_chat', stream):
            run = asyncio.create_task(self.send('@Riset snapshot'))
            try:
                await asyncio.wait_for(started.wait(), timeout=2)
                snapshot = (await self.client.get('/api/state')).json()
                status = snapshot['agent_statuses']['Riset']
                self.assertEqual(status['status'], 'working')
                self.assertEqual(status['task_id'], snapshot['tasks'][0]['id'])
                self.assertEqual(snapshot['tasks'][0]['status'], 'doing')
                self.assertEqual(snapshot['summary']['working_agents'], 1)
                self.assertTrue(snapshot['busy'])
            finally:
                release.set()
                await run
        types = [events.get_nowait()['type'] for _ in range(events.qsize())]
        self.assertTrue({'delta', 'message', 'agent_status', 'room_status', 'tasks_changed', 'usage_changed'} <= set(types))
        snapshot = (await self.client.get('/api/state')).json()
        self.assertEqual(snapshot['tasks'][0]['result'], 'actual result')
        self.assertEqual(snapshot['summary']['working_agents'], 0)
        response = await main.api_events(None)
        iterator = response.body_iterator
        self.assertIn('connected', await anext(iterator))
        await engine.room.publish({'type': 'state_changed'})
        self.assertIn('state_changed', await anext(iterator))
        await iterator.aclose()
        engine.room.subscribers.discard(events)
        self.assertFalse(engine.room.subscribers)

    async def test_delta_events_identify_the_current_task_for_repeated_agent_runs(self):
        async def stream(model, messages, tools=None):
            yield {'type': 'delta', 'text': messages[-1]['content']}

        events = asyncio.Queue()
        engine.room.subscribers.add(events)
        try:
            with patch.object(llm, 'stream_chat', stream):
                await self.send('@Riset first stream')
                await self.send('@Riset second stream')
        finally:
            engine.room.subscribers.discard(events)

        tasks = {task['title']: task['id'] for task in db.list_tasks()}
        working_tasks = {}
        deltas = []
        while not events.empty():
            event = events.get_nowait()
            if event['type'] == 'agent_status' and event['status'] == 'working':
                working_tasks[event['agent']] = event['task_id']
            elif event['type'] == 'delta':
                self.assertIn('task_id', event)
                self.assertEqual(event['task_id'], working_tasks[event['agent']])
                self.assertEqual(event['task_id'], tasks[event['text']])
                deltas.append(event)
        self.assertEqual(len(deltas), 2)
        self.assertNotEqual(deltas[0]['task_id'], deltas[1]['task_id'])

    async def test_live_protocol_success_uses_only_local_mock_transport(self):
        requests = []
        def handler(request):
            payload = json.loads(request.content)
            requests.append(payload)
            if len(requests) == 1:
                chunks = [
                    {'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'mem', 'function': {'name': 'usulkan_memori', 'arguments': '{"key":"Fact",'}}]}}]},
                    {'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '"value":"local fixture"}'}}]}}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'cost': 0.001}},
                ]
            else:
                chunks = [{'choices': [{'delta': {'content': 'Complete from local transport'}}], 'usage': {'prompt_tokens': 12, 'completion_tokens': 4, 'cost': 0.002}}]
            text = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
            return httpx.Response(200, text=text)
        original_client = httpx.AsyncClient
        def client_factory(*args, **kwargs):
            return original_client(transport=httpx.MockTransport(handler))
        with patch.dict(os.environ, {'LLM_MODE': ''}), patch.object(llm, 'get_api_key', return_value='synthetic-only'), patch.object(llm.httpx, 'AsyncClient', side_effect=client_factory):
            db.set_setting('llm_mode', 'live')
            await self.send('@Riset remember fixture')
        self.assertEqual(db.list_tasks()[0]['status'], 'done')
        self.assertEqual(db.list_tasks()[0]['result'], 'Complete from local transport')
        self.assertEqual(db.list_memories()[0]['status'], 'pending')
        self.assertEqual(db.list_memories()[0]['value'], 'local fixture')
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]['usage'], {'include': True})
        self.assertEqual([t['function']['name'] for t in requests[0]['tools']], ['usulkan_memori'])
        self.assertEqual(requests[1]['messages'][-1]['role'], 'tool')
        usage = db.usage_report()['by_mode']['live']
        self.assertEqual(usage['pesan'], 2)
        self.assertEqual(usage['ptok'], 22)
        self.assertAlmostEqual(usage['recorded_cost'], 0.003)


if __name__ == '__main__':
    unittest.main()
