"""Mandatory driver/server regressions called by the targeted Vitest file, without Playwright."""
import importlib.util
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('apps_render', sys.argv.pop(1))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
FIXTURE = {'spec': {'pages': [{'id': 'first', 'components': []}, {'id': 'Second', 'components': [{'id': 'status', 'type': 'filter'}]}], 'actions': [{'id': 'assign'}, {'id': 'unreferenced'}]}, 'cards': {'assign': {}, 'unreferenced': {}}}
VALUES = ['Open', '日本語', 'a/b', 'a?b', 'x' * 1000]


class Page:
    def __init__(self, late=None, ready=True):
        self.current = None
        self.calls = []
        self.errors = []
        self.late = late
        self.ready = ready
        self.shots = []

    def on(self, *_):
        pass

    def goto(self, *_args, **_kwargs):
        pass

    def evaluate(self, expression, arg=None):
        if 'ready === true' in expression:
            return self.ready
        if '.errors' in expression:
            return list(self.errors)
        if '.pages()' in expression:
            return ['first', 'Second']
        if '.show(' in expression:
            self.current = arg
            self.calls.append(('show', arg))
        elif '.filters(' in expression:
            assert self.current == arg, 'page was not selected before inspection'
            return [] if arg == 'first' else [{'id': 'status', 'values': VALUES}]
        elif '.actions(' in expression:
            return [] if arg == 'first' else ['assign']
        elif '.setFilter(' in expression:
            self.calls.append(('filter', arg['value']))
            if self.late == 'filter':
                self.errors.append('query failed after filter')
        elif '.prepare(' in expression:
            self.calls.append(('prepare', arg))
            if self.late == 'prepare':
                self.errors.append('card failed after prepare')
        elif '.closeCard(' in expression and self.late == 'close':
            self.errors.append('failure on last close')

    def screenshot(self, path):
        assert self.current is not None, 'screenshot without selecting a page'
        self.shots.append(self.current)
        with open(path, 'wb') as fh:
            fh.write(b'PNG')


def report():
    return {'pages': [], 'filters': [], 'actions': [], 'errors': []}


class DriverTests(unittest.TestCase):
    def test_complete_interactions_and_bounded_unique_names(self):
        result = report()
        with tempfile.TemporaryDirectory() as out:
            for width in (1440, 390):
                page = Page()
                driver._drive(page, 'http://127.0.0.1:1', width, out, result, FIXTURE)
                self.assertEqual(page.calls, [('show', 'first'), ('show', 'Second')] + [('filter', v) for v in VALUES] + [('prepare', 'assign'), ('prepare', 'unreferenced')])
                self.assertEqual(page.shots, ['first'] + ['Second'] * 8)
        self.assertEqual(result['errors'], [])
        self.assertEqual([(p['page'], p['width']) for p in result['pages'] if p['note'] == 'page'], [('first', 1440), ('Second', 1440), ('first', 390), ('Second', 390)])
        self.assertEqual(len(result['filters']), 10)
        self.assertEqual(len(result['actions']), 4)
        names = [p['shot'] for p in result['pages']]
        self.assertEqual(len(set(names)), len(names))
        for name in names:
            self.assertRegex(name, r'^[a-z0-9.-]+$')
            self.assertLess(len(name), 80)

    def test_readiness_failure_persisted_even_with_other_viewport_screenshots(self):
        result = report()
        with tempfile.TemporaryDirectory() as out:
            driver._drive(Page(), 'http://127.0.0.1:1', 1440, out, result, FIXTURE)
            saved = driver.READY_TIMEOUT_MS
            driver.READY_TIMEOUT_MS = 0
            try:
                driver._drive(Page(ready=False), 'http://127.0.0.1:1', 390, out, result, FIXTURE)
            finally:
                driver.READY_TIMEOUT_MS = saved
        self.assertTrue(result['pages'])
        self.assertTrue(any('did not become ready at 390' in e for e in result['errors']))

    def test_late_fixture_errors(self):
        for interaction in ('filter', 'prepare', 'close'):
            with self.subTest(interaction=interaction), tempfile.TemporaryDirectory() as out:
                result = report()
                driver._drive(Page(late=interaction), 'http://127.0.0.1:1', 1440, out, result, FIXTURE)
                self.assertTrue(any(e.startswith('fixture:') for e in result['errors']))

    def test_missing_page_or_card_fails_closed(self):
        for change in ('pages', 'cards'):
            fixture = {**FIXTURE, 'cards': {'assign': {}}} if change == 'cards' else {**FIXTURE, 'spec': {**FIXTURE['spec'], 'pages': []}}
            with tempfile.TemporaryDirectory() as out:
                result = report()
                driver._drive(Page(), 'http://127.0.0.1:1', 1440, out, result, fixture)
                self.assertTrue(result['errors'])

    def test_missing_filters_empty_values_and_unknown_actions_fail(self):
        for missing in ('filters', 'values', 'actions'):
            class IncompletePage(Page):
                def evaluate(self, expression, arg=None):
                    if missing == 'filters' and '.filters(' in expression:
                        return []
                    if missing == 'values' and '.filters(' in expression and arg == 'Second':
                        return [{'id': 'status', 'values': []}]
                    if missing == 'actions' and '.actions(' in expression:
                        return ['unknown']
                    return super().evaluate(expression, arg)
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as out:
                result = report()
                driver._drive(IncompletePage(), 'http://127.0.0.1:1', 1440, out, result, FIXTURE)
                self.assertTrue(result['errors'])

    def test_server_only_serves_asset_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in driver.ASSETS:
                with open(os.path.join(directory, name), 'w') as fh:
                    fh.write(name)
            os.mkdir(os.path.join(directory, 'out'))
            with open(os.path.join(directory, 'private.txt'), 'w') as fh:
                fh.write('private')
            server, port = driver._serve(directory)
            try:
                for name in driver.ASSETS:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/{name}') as response:
                        self.assertEqual(response.read(), name.encode())
                        self.assertEqual(response.headers['Content-Security-Policy'], driver.CSP)
                for path in ('/', '/out/', '/private.txt', '/%66ixture.json', '/out/../fixture.json', '/out//fixture.json', '/fixture.json/extra'):
                    with self.assertRaises(urllib.error.HTTPError):
                        urllib.request.urlopen(f'http://127.0.0.1:{port}{path}')
            finally:
                server.shutdown()
                server.server_close()
            for link in ('symlink', 'hardlink'):
                path = os.path.join(directory, 'runtime.js')
                os.unlink(path)
                target = os.path.join(directory, 'private.txt')
                if link == 'symlink':
                    os.symlink(target, path)
                else:
                    os.link(target, path)
                with self.assertRaises((OSError, ValueError)):
                    driver._serve(directory)
            alias = directory + '-link'
            os.symlink(directory, alias)
            try:
                with self.assertRaises(OSError):
                    driver._serve(alias)
            finally:
                os.unlink(alias)


if __name__ == '__main__':
    unittest.main()
