"""Meaningful end-to-end local workflow contracts; real network is forbidden."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

os.environ['LLM_MODE'] = 'mock'
from app import config, db, llm, business, main

PROFILE = {'name': 'Dapur Rina', 'product': 'Nasi kotak', 'audience': 'Karyawan', 'tone': 'ramah', 'contact': '@dapur'}
BRIEF = {'channel': 'whatsapp', 'goal': 'Kenalkan menu baru', 'facts': 'Rp25.000. Pesan H-1.'}


class BusinessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sobis-business-')
        if db._conn:
            db._conn.close()
        db._conn = None
        self.patches = [patch.object(config, 'DB_PATH', str(Path(self.temp.name) / 'test.db')),
                        patch.object(httpx.AsyncHTTPTransport, 'handle_async_request', side_effect=AssertionError('Network forbidden'))]
        for p in self.patches:
            p.start()
        db.init()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose()
        db._conn.close()
        db._conn = None
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    async def create(self):
        response = await self.client.put('/api/business/profile', json=PROFILE)
        self.assertEqual(response.status_code, 200)
        response = await self.client.post('/api/business/drafts', json=BRIEF)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    async def test_complete_workflow_persistence_and_conflicts(self):
        draft = await self.create()
        path = f'/api/business/drafts/{draft["id"]}'
        text = draft['versions'][0]['content']
        self.assertIn('Rp25.000', text)
        self.assertEqual((await self.client.get(path + '/download')).status_code, 409)
        self.assertEqual((await self.client.post(path + '/approve', json={'expected_version': 1})).status_code, 200)
        exported = await self.client.get(path + '/download')
        self.assertIn('Contoh simulasi', exported.text)
        self.assertIn(text, exported.text)
        revised = await self.client.post(path + '/versions', json={'expected_version': 1, 'content': 'Pesan nasi kotak hari ini.'})
        self.assertEqual(revised.status_code, 201)
        self.assertIsNone(revised.json()['approved_version'])
        self.assertEqual(len(revised.json()['versions']), 2)
        self.assertEqual((await self.client.get(path + '/download')).status_code, 409)
        for suffix, body in [('/approve', {'expected_version': 1}), ('/versions', {'expected_version': 1, 'content': 'Stale'})]:
            self.assertEqual((await self.client.post(path + suffix, json=body)).status_code, 409)
        await self.client.post(path + '/approve', json={'expected_version': 2})
        self.assertIn('Contoh simulasi', (await self.client.get(path + '/download')).text)
        # New profile cannot rewrite the historical business facts.
        await self.client.put('/api/business/profile', json={**PROFILE, 'name': 'Nama Baru'})
        self.assertEqual((await self.client.get(path)).json()['profile']['name'], 'Dapur Rina')
        db._conn.close(); db._conn = None; db.init()
        overview = (await self.client.get('/api/business')).json()
        self.assertEqual(overview['profile']['name'], 'Nama Baru')
        self.assertEqual(overview['drafts'][0]['latest_version'], 2)
        self.assertEqual(overview['drafts'][0]['approved_version'], 2)

    async def test_validation_and_profile_required(self):
        self.assertEqual((await self.client.post('/api/business/drafts', json=BRIEF)).status_code, 409)
        for data in [{**PROFILE, 'name': '   '}, {**PROFILE, 'name': 'x' * 101}, {**PROFILE, 'tone': 'unknown'}, {**PROFILE, 'customer_id': 2}]:
            self.assertEqual((await self.client.put('/api/business/profile', json=data)).status_code, 422)
        await self.create()
        for data in [{**BRIEF, 'channel': 'unknown'}, {**BRIEF, 'goal': '   '}]:
            self.assertEqual((await self.client.post('/api/business/drafts', json=data)).status_code, 422)
        for path in ['/api/business/drafts/999', '/api/business/drafts/999/download']:
            self.assertEqual((await self.client.get(path)).status_code, 404)

    async def test_sample_channels_only_use_supplied_facts(self):
        await self.client.put('/api/business/profile', json=PROFILE)
        texts = set()
        for channel in ['whatsapp', 'instagram', 'toko']:
            response = await self.client.post('/api/business/drafts', json={**BRIEF, 'channel': channel})
            text = response.json()['versions'][0]['content']
            self.assertIn(PROFILE['product'], text)
            self.assertIn(BRIEF['facts'], text)
            self.assertNotIn('diskon', text)
            texts.add(text)
        self.assertEqual(len(texts), 3)

    async def test_live_requires_explicit_consent_and_records_usage(self):
        await self.client.put('/api/business/profile', json=PROFILE)
        async def fake(*args, **kwargs):
            yield {'type': 'delta', 'text': 'Naskah dari transport uji.'}
            yield {'type': 'usage', 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'cost': 0.002}}
        with patch.object(llm, 'get_mode', return_value='live'), patch.object(llm, 'get_api_key', return_value='synthetic'), patch.object(llm, 'stream_chat', fake):
            self.assertEqual((await self.client.post('/api/business/drafts', json=BRIEF)).status_code, 409)
            draft = (await self.client.post('/api/business/drafts', json={**BRIEF, 'confirm_live': True})).json()
        self.assertEqual(draft['versions'][0]['mode'], 'live')
        row = db._one('SELECT * FROM usage_records WHERE sender_name=?', ('Promosi UMKM',))
        self.assertEqual(row['cost_source'], 'recorded')
        self.assertEqual(row['cost'], 0.002)

    async def test_live_failure_is_sanitized_and_never_saves_partial_result(self):
        await self.client.put('/api/business/profile', json=PROFILE)
        async def broken(*args, **kwargs):
            yield {'type': 'delta', 'text': 'Partial'}
            raise RuntimeError('SECRET-UPSTREAM-KEY')
        with patch.object(llm, 'get_mode', return_value='live'), patch.object(llm, 'get_api_key', return_value='synthetic'), patch.object(llm, 'stream_chat', broken):
            response = await self.client.post('/api/business/drafts', json={**BRIEF, 'confirm_live': True})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('SECRET-UPSTREAM-KEY', response.text)
        self.assertEqual((await self.client.get('/api/business')).json()['drafts'], [])
        self.assertEqual(db._one('SELECT cost_source FROM usage_records')['cost_source'], 'unknown')

    async def test_generation_lock_prevents_duplicate_overlap(self):
        await self.client.put('/api/business/profile', json=PROFILE)
        async with business._generating:
            response = await self.client.post('/api/business/drafts', json=BRIEF)
        self.assertEqual(response.status_code, 409)

    async def test_entry_routes_and_additive_tables(self):
        self.assertIn('Kenalkan usaha Anda', (await self.client.get('/')).text)
        self.assertIn('static/app.js', (await self.client.get('/kantor')).text)
        self.assertEqual(len(db.list_agents()), 4)
        db.init()
        self.assertEqual(len(db.list_agents()), 4)


if __name__ == '__main__':
    unittest.main()
