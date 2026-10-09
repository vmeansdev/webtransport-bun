import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from format import FrameEncoder, encode_json, iter_frames
from replay import VerifiedFiles


def fixture(root):
    encoder = FrameEncoder()
    raw = encoder.encode('BEGIN', b'{}') + encoder.encode('STREAM_END', b'{}')
    files = {'receiver.raw': raw, 'client.stdout': b'output\n', 'client.stderr': b'',
             'receiver-settlement.json': b'{}'}
    entries = []
    for name, data in files.items():
        (root / name).write_bytes(data)
        entries.append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    manifest = encode_json({'schema': 'g6-receiver-manifest/1', 'binding': {}, 'files': entries})
    (root / 'receiver-manifest.json').write_bytes(manifest)
    return hashlib.sha256(manifest).hexdigest()


class VerifiedFileTests(unittest.TestCase):
    def test_directory_inventory_never_materializes_unbounded_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = fixture(root)
            with patch('replay.os.listdir', side_effect=AssertionError('unbounded directory enumeration')):
                with VerifiedFiles(root, digest) as files: files.finish()

    def test_directory_scan_stops_on_first_unknown_entry(self):
        @contextmanager
        def enormous_directory(_):
            def entries():
                yield SimpleNamespace(name='unknown')
                self.fail('continued scanning after unexpected directory entry')
            yield entries()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = fixture(root)
            with patch('replay.os.scandir', side_effect=enormous_directory):
                with self.assertRaises(ValueError):
                    with VerifiedFiles(root, digest): pass

    def test_two_streaming_passes_use_verified_retained_descriptors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = fixture(root)
            with VerifiedFiles(root, digest) as files:
                for _ in range(2):
                    with files.pass_file('receiver.raw') as stream:
                        self.assertEqual([r.kind for r in iter_frames(stream)], ['BEGIN', 'STREAM_END'])
                self.assertEqual(files.metadata('receiver-settlement.json'), {})
            self.assertTrue(all(f.fd == -1 for f in files.files.values()))

    def test_changed_bytes_fail_in_enter_before_any_semantic_parser(self):
        for name in ('receiver.raw', 'client.stdout', 'receiver-settlement.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                digest = fixture(root)
                original = (root / name).read_bytes()
                (root / name).write_bytes(b'x' + original[1:])
                files = VerifiedFiles(root, digest)
                with self.assertRaisesRegex(ValueError, 'hash/size'):
                    with files:
                        self.fail('unverified bytes reached replay')
                self.assertIsNone(files.root_fd)
                self.assertTrue(all(f.fd == -1 for f in files.files.values()))

    def test_manifest_hash_is_supplied_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            with self.assertRaisesRegex(ValueError, 'hash/size'):
                with VerifiedFiles(root, '0' * 64): self.fail('bad manifest hash accepted')

    def test_symlink_hardlink_fifo_and_unknown_file_refuse(self):
        for replacement in ('symlink', 'hardlink', 'fifo', 'extra'):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                digest = fixture(root)
                if replacement == 'extra': (root / 'unlisted').write_bytes(b'x')
                else:
                    (root / 'client.stderr').unlink()
                    if replacement == 'symlink': (root / 'client.stderr').symlink_to('client.stdout')
                    if replacement == 'hardlink': os.link(root / 'client.stdout', root / 'client.stderr')
                    if replacement == 'fifo': os.mkfifo(root / 'client.stderr')
                with self.assertRaises((ValueError, OSError)):
                    with VerifiedFiles(root, digest): self.fail('non-closed regular files accepted')

    def test_replacement_or_in_place_change_between_hash_and_parse_refuse(self):
        for mode in ('replace', 'overwrite'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                digest = fixture(root)
                with VerifiedFiles(root, digest) as files:
                    raw = root / 'receiver.raw'
                    contents = raw.read_bytes()
                    if mode == 'replace':
                        raw.unlink()
                        raw.write_bytes(contents)
                    else: raw.write_bytes(b'x' + contents[1:])
                    with self.assertRaises(ValueError):
                        with files.pass_file('receiver.raw') as stream: list(iter_frames(stream))

    def test_partial_consumption_cannot_be_reported_as_a_complete_hash_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = fixture(root)
            with VerifiedFiles(root, digest) as files:
                with self.assertRaisesRegex(ValueError, 'incomplete'):
                    with files.pass_file('receiver.raw') as stream: stream.read(1)


if __name__ == '__main__':
    unittest.main()
