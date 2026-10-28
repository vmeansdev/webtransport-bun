"""Rehashed synthetic streams exercise semantics, not live qualification."""
import copy
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fixtures_test_helper import TOKEN, end, phase, ready, sample
from format import ACK_RECEIPT, DRIVER_RECEIPT, Codec, FrameEncoder, encode_json
from replay import replay_observations, replay_verified
import replay


def fixture():
    base = sample(at=900_000_000)
    client = base['snapshot']['identity']
    binding = dict(schema='g6-receiver-binding/1', candidateSha='5' * 40, sourceSha256='1' * 64,
                   producerSha256='2' * 64, registrationSha256='3' * 64,
                   mappingSha256='4' * 64, runId='run-test', nodeId='node-test',
                   bootId=client['bootId'], mode='owned-v1', storm=False,
                   cleanupNs=3_000_000_000, cutoffNs=8_000_000_000)
    supervisor, writer = copy.deepcopy(client), copy.deepcopy(client)
    supervisor['pid'], writer['pid'] = 998, 999
    begin = dict(schema='g6-receiver-evidence/1', binding=binding, client=client,
                 supervisor=supervisor, writer=writer, token=TOKEN, armedNs=700_000_000)
    records = [('BEGIN', begin), ('READY', (800_001_000, ready()))]
    for at in (850_000_000, 900_000_000):
        records.append(('FREEZE', dict(atNs=at + 2000, snapshot=sample(at=at)['snapshot'])))
    ack = b'ARMED\n' + ready()
    records.extend([('ACK_INTENT', (950_000_000, ack)),
                    ('ACK', (1_000_000_000, 1_000_001_000, 970_000_000, ack))])
    fences = {0: (1, 'connect', 1_000_000_500), 2: (2, 'steady', 1_200_000_000),
              5: (3, 'drain', 1_500_000_000), 8: (4, 'idle', 1_800_000_000)}
    for k in range(10):
        if k in fences:
            seq, name, at = fences[k]
            records.append(('PHASE', (at + 1000, phase(seq, name, at))))
        row = sample(at=1_000_000_000 + k * 100_000_000)
        row['snapshot']['beganNs'] += 2000
        row['snapshot']['finishedNs'] += 2000
        records.append(('SAMPLE', row))
    records.extend([('PHASE', (2_000_001_000, phase(5, 'stop', 2_000_000_000))),
                    ('END', (2_001_001_000, end())),
                    ('CLIENT_EXIT', dict(identity=client, atNs=2_002_000_000, code=0)),
                    ('STREAM_END', dict(atNs=2_003_000_000, stdoutEof=True, stderrEof=True))])
    # The baseline's scheduled time is its began time, not a periodic tick.
    base['scheduledNs'] = base['snapshot']['beganNs']
    return binding, records, Codec(base)


def encode(records, codec):
    encoder, parts, ordinal, intent = FrameEncoder(), [], 0, None
    for kind, value in records:
        if kind in ('READY', 'PHASE', 'END', 'ACK_INTENT'):
            payload = DRIVER_RECEIPT.pack(value[0]) + value[1]
        elif kind == 'ACK':
            before, after, commit, raw = value
            payload = ACK_RECEIPT.pack(before, after, commit, *intent) + raw
        elif kind == 'SAMPLE':
            payload = codec.encode(value, ordinal)
            ordinal += 1
        else:
            value = copy.deepcopy(value)
            if kind == 'STREAM_END':
                value.update(recordsBeforeEnd=encoder.sequence, bytesBeforeEnd=encoder.bytes,
                             chainBeforeEnd=encoder.previous.hex())
            payload = encode_json(value)
        parts.append(encoder.encode(kind, payload))
        if kind == 'ACK_INTENT': intent = encoder.bytes, encoder.previous
    return b''.join(parts)


def write_evidence(root, contents, binding):
    entries = []
    for name, data in contents.items():
        (root / name).write_bytes(data)
        entries.append(dict(name=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    manifest = encode_json(dict(schema='g6-receiver-manifest/1', binding=binding, files=entries))
    (root / 'receiver-manifest.json').write_bytes(manifest)
    return hashlib.sha256(manifest).hexdigest()


class SemanticTests(unittest.TestCase):
    def run_fixture(self, records=None, binding=None):
        expected, normal, codec = fixture()
        raw = encode(normal if records is None else records, codec)
        # API requires a fresh bounded stream for each of the two passes.
        return replay_observations(lambda: io.BytesIO(raw), binding or expected)

    def test_complete_schedule_is_observation_only(self):
        result = self.run_fixture()
        self.assertEqual(result['coverage']['samples'], 10)
        self.assertEqual(result['interiorSamples'], dict(connect=2, steady=3, drain=3, idle=2))
        self.assertFalse(result['externalSettlementVerified'])
        self.assertFalse(result['capacityQualified'])

    def test_independent_binding_required(self):
        binding, _, _ = fixture()
        binding['producerSha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'binding'): self.run_fixture(binding=binding)

    def test_candidate_commit_binding_is_mandatory(self):
        binding, _, _ = fixture()
        binding.pop('candidateSha', None)
        with self.assertRaises(ValueError): replay.validate_binding(binding)

    def test_malformed_or_mismatched_candidate_refuses(self):
        for value in ('f' * 64, 'F' * 40, '', None, 123):
            binding, _, _ = fixture()
            binding['candidateSha'] = value
            with self.subTest(value=value), self.assertRaises(ValueError): replay.validate_binding(binding)
        binding, _, _ = fixture()
        binding['candidateSha'] = 'f' * 40
        with self.assertRaisesRegex(ValueError, 'binding'): self.run_fixture(binding=binding)

    def test_missing_middle_or_tail_and_sparse_minima_rejected(self):
        for drop in ([3], [9], [1, 4, 7, 9]):
            _, records, _ = fixture()
            ordinal = -1
            kept = []
            for item in records:
                if item[0] == 'SAMPLE': ordinal += 1
                if item[0] != 'SAMPLE' or ordinal not in drop: kept.append(item)
            with self.subTest(drop=drop), self.assertRaises(ValueError): self.run_fixture(kept)

    def test_control_order_end_exit_and_eof_fail_closed(self):
        _, records, _ = fixture()
        for kind in ('FREEZE', 'ACK_INTENT', 'ACK', 'END', 'CLIENT_EXIT'):
            bad = records.copy()
            bad.pop(next(i for i, r in enumerate(bad) if r[0] == kind))
            # Encoder cannot construct ACK without intent, so retain framing but
            # move intent after ACK in this particular semantic attack.
            if kind == 'ACK_INTENT': continue
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.run_fixture(bad)
        for field in ('stdoutEof', 'stderrEof'):
            bad = copy.deepcopy(records)
            bad[-1][1][field] = False
            with self.assertRaises(ValueError): self.run_fixture(bad)
        bad = copy.deepcopy(records)
        bad[-2][1]['code'] = 9
        with self.assertRaises(ValueError): self.run_fixture(bad)

    def test_ack_delay_cannot_move_anchor(self):
        _, records, _ = fixture()
        i = next(i for i, r in enumerate(records) if r[0] == 'ACK')
        before, _, commit, raw = records[i][1]
        records[i] = ('ACK', (before, before + 100_000_000, commit, raw))
        with self.assertRaises(ValueError): self.run_fixture(records)

    def test_sample_after_exit_and_early_stream_end_rejected(self):
        _, records, _ = fixture()
        moved = records.pop(next(i for i, r in enumerate(records) if r[0] == 'SAMPLE'))
        records.insert(-1, moved)
        with self.assertRaises(ValueError): self.run_fixture(records)

    def test_rehashed_ambiguous_sample_and_delta_are_not_phase_assigned(self):
        _, records, _ = fixture()
        # Move the steady boundary through the sample, leaving two later
        # steady interiors and the original complete global cadence intact.
        index = next(i for i, (kind, value) in enumerate(records)
                     if kind == 'PHASE' and b'\tsteady\t' in value[1])
        records[index] = ('PHASE', (1_200_004_000, phase(2, 'steady', 1_200_002_500)))
        result = self.run_fixture(records)
        self.assertEqual(result['ambiguousSamples'], 1)
        self.assertEqual(result['interiorSamples']['steady'], 2)
        self.assertGreaterEqual(result['ambiguousDeltas'], 4)

    def test_valid_and_forged_fractional_tail_cancellation(self):
        _, records, _ = fixture()
        records[-4] = ('PHASE', (2_050_001_000, phase(5, 'stop', 2_050_000_000)))
        records[-3] = ('END', (2_051_001_000, end(2_051_000_000)))
        records[-2][1]['atNs'] = 2_052_000_000
        records[-1][1]['atNs'] = 2_053_000_000
        cancelled = dict(scheduledNs=2_000_000_000, beganNs=2_000_002_000,
                         failedNs=2_051_500_000, reason='client-exited')
        records.insert(-2, ('TAIL_CANCEL', cancelled))
        self.assertTrue(self.run_fixture(records)['coverage']['tailCancelled'])
        for failed in (2_010_000_000, 3_100_000_000):
            bad = copy.deepcopy(records)
            bad[-3][1]['failedNs'] = failed
            with self.assertRaises(ValueError): self.run_fixture(bad)

    def test_hash_first_and_rehashed_logs_with_overlong_lines(self):
        binding, records, codec = fixture()
        for attack in ('none', 'raw-semantic', 'unhashed-log', 'long-log'):
            with self.subTest(attack=attack), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                contents = {'receiver.raw': encode(records, codec), 'client.stdout': b'hello\n',
                            'client.stderr': b'', 'receiver-settlement.json': b'{}'}
                if attack == 'raw-semantic':
                    bad = copy.deepcopy(records)
                    bad[-2][1]['code'] = 1
                    contents['receiver.raw'] = encode(bad, codec)
                if attack == 'long-log': contents['client.stdout'] = b'x' * (128 * 1024 + 1)
                digest = write_evidence(root, contents, binding)
                if attack == 'unhashed-log':
                    (root / 'client.stderr').write_bytes(b'changed')
                    with patch('replay.control_pass', side_effect=AssertionError('semantic parsing too early')):
                        with self.assertRaises(ValueError): replay_verified(root, digest, binding)
                elif attack == 'none':
                    self.assertEqual(replay_verified(root, digest, binding)['coverage']['samples'], 10)
                else:
                    with self.assertRaises(ValueError): replay_verified(root, digest, binding)

    def test_every_artifact_and_directory_must_remain_stable_through_replay(self):
        binding, records, codec = fixture()
        original_pass = replay.control_pass
        names = (*replay.FILE_CAPS, replay.MANIFEST_NAME, 'extra-file')
        for name in names:
            for change in ('overwrite', 'replace'):
                with self.subTest(name=name, change=change), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    contents = {'receiver.raw': encode(records, codec), 'client.stdout': b'hello\n',
                                'client.stderr': b'error\n', 'receiver-settlement.json': b'{}'}
                    digest = write_evidence(root, contents, binding)
                    def mutate_after_first_pass(*args):
                        result = original_pass(*args)
                        target = root / name
                        if name == 'extra-file': target.write_bytes(b'extra')
                        elif change == 'replace':
                            old = target.read_bytes()
                            target.unlink()
                            target.write_bytes(old)
                        else:
                            old = target.read_bytes()
                            target.write_bytes(b'x' + old[1:])
                        return result
                    with patch('replay.control_pass', side_effect=mutate_after_first_pass):
                        with self.assertRaises((ValueError, OSError)): replay_verified(root, digest, binding)


if __name__ == '__main__': unittest.main()
