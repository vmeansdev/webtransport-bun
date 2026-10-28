import copy
import hashlib
import io
import struct
import unittest

from fixtures_test_helper import sample
from format import Codec


class CodecContractTests(unittest.TestCase):
    def test_complete_inventory_round_trip(self):
        for threads in (1, 3, 49, 512):
            row = sample(threads)
            codec = Codec(row)
            self.assertEqual(codec.decode(codec.encode(row, 0), 0), row)

    def test_storage_width_does_not_relax_existing_semantic_numeric_limits(self):
        for field in ('scheduledNs', 'beganNs', 'finishedNs', 'drops', 'runtimeNs'):
            with self.subTest(field=field):
                row = sample()
                if field == 'scheduledNs': row[field] = 2 ** 53
                elif field in ('beganNs', 'finishedNs'): row['snapshot'][field] = 2 ** 53
                elif field == 'drops': next(iter(row['snapshot']['sockets'].values()))[field] = 2 ** 53
                else: next(iter(row['snapshot']['threads'].values()))[field] = 2 ** 53
                with self.assertRaises(ValueError): Codec(row)

    def test_process_identity_schema_and_leader_membership_are_required(self):
        for mutate in (
            lambda r: r['snapshot']['identity'].pop('bootId'),
            lambda r: r['snapshot']['identity'].update(pid=True),
            lambda r: r['snapshot']['identity'].update(bootId='bad'),
            lambda r: r['snapshot']['identity'].update(exe='/x\x00bad'),
            lambda r: r['snapshot']['identity'].update(pid=9999),
        ):
            row = sample()
            mutate(row)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): Codec(row)

    def test_sample_kind_string_lists_and_numeric_types_are_not_coerced(self):
        for mutate in (
            lambda r: r.update(kind='other'),
            lambda r: r['snapshot'].update(limits=[True]),
            lambda r: r['snapshot'].update(effectiveRcvbufSource=9),
            lambda r: r['snapshot'].update(beganNs=1.5),
            lambda r: next(iter(r['snapshot']['sockets'].values())).update(drops=True),
        ):
            row = sample()
            mutate(row)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): Codec(row)

    def test_socket_bindings_are_complete_and_unique(self):
        for mutate in (
            lambda r: r['snapshot']['sockets'].pop('100127'),
            lambda r: r['snapshot']['sockets']['100001'].update(local='00000000:4E20'),
            lambda r: r['snapshot']['sockets']['100000'].update(local='bad'),
            lambda r: r['snapshot']['sockets']['100000'].update(rcvbufBytes=0),
        ):
            row = sample()
            mutate(row)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): Codec(row)

    def test_dynamic_buffer_values_remain_lossless_and_static_changes_refuse(self):
        baseline = sample()
        codec = Codec(baseline)
        row = copy.deepcopy(baseline)
        row['snapshot']['sockets']['100000']['rcvbufBytes'] *= 2
        self.assertEqual(codec.decode(codec.encode(row, 1), 1), row)
        row['snapshot']['threads']['1000']['startTime'] += 1
        with self.assertRaises(ValueError): codec.encode(row, 1)

    def test_decode_validates_numeric_payload_even_with_a_matching_baseline(self):
        codec = Codec(sample())
        raw = bytearray(codec.encode(sample(), 0))
        struct.pack_into('>Q', raw, 44, 2 ** 53)
        with self.assertRaises(ValueError): codec.decode(bytes(raw), 0)

    def test_maximum_admitted_sample_values_have_fixed_width(self):
        from format import MAX_SAMPLES, maximum_sample_size
        row = sample(512, at=2 ** 53 - 1001)
        for item in row['snapshot']['sockets'].values():
            for field in ('drops', 'rxQueueBytes', 'txQueueBytes', 'rcvbufBytes', 'sndbufBytes'):
                item[field] = 2 ** 53 - 1
        for item in row['snapshot']['threads'].values():
            for field in ('runtimeNs', 'waitNs', 'timeslices'):
                item[field] = 2 ** 53 - 1
        codec = Codec(row)
        raw = codec.encode(row, MAX_SAMPLES - 1)
        self.assertEqual(len(raw), maximum_sample_size())
        self.assertEqual(codec.decode(raw, MAX_SAMPLES - 1), row)
        with self.assertRaises(ValueError): codec.encode(row, MAX_SAMPLES)


class FrameContractTests(unittest.TestCase):
    def encoder(self, **kwargs):
        from format import FrameEncoder
        return FrameEncoder(**kwargs)

    def read(self, raw, **kwargs):
        from format import iter_frames
        return list(iter_frames(io.BytesIO(raw), **kwargs))

    def stream(self):
        encoder = self.encoder()
        return b''.join([encoder.encode('BEGIN', b'{}'), encoder.encode('SAMPLE', b'abc'),
                         encoder.encode('STREAM_END', b'{}')])

    def test_streamed_frame_payloads_and_order_round_trip(self):
        frames = self.read(self.stream())
        self.assertEqual([f.kind for f in frames], ['BEGIN', 'SAMPLE', 'STREAM_END'])
        self.assertEqual([f.sequence for f in frames], [0, 1, 2])
        self.assertEqual([f.payload for f in frames], [b'{}', b'abc', b'{}'])

    def test_body_corruption_truncation_trailing_data_and_missing_end_refuse(self):
        raw = self.stream()
        for broken in (raw[:-1], raw + b'x', raw[:84] + b'xx' + raw[86:], raw[:86]):
            with self.subTest(length=len(broken)), self.assertRaises(ValueError): self.read(broken)

    def test_lengths_reject_before_reading_excess_payload(self):
        raw = bytearray(self.stream())
        struct.pack_into('>I', raw, 8, 0xFFFFFFFF)
        class HeaderOnly(io.BytesIO):
            def read(self, size=-1):
                if self.tell() >= 84:
                    raise AssertionError('oversized length caused a payload read')
                return super().read(size)
        from format import iter_frames
        with self.assertRaises(ValueError): list(iter_frames(HeaderOnly(raw)))

    def test_chain_and_sequence_not_only_body_hash_are_checked(self):
        raw = self.stream()
        begin, sample_record, end = raw[:86], raw[86:173], raw[173:]
        with self.assertRaises(ValueError): self.read(begin + begin + sample_record + end)
        with self.assertRaises(ValueError): self.read(begin + end)
        broken = bytearray(raw)
        broken[20] ^= 1  # Previous-record hash of BEGIN, not body.
        with self.assertRaises(ValueError): self.read(broken)

    def test_end_reserve_and_cap_are_real_byte_bounds(self):
        from format import FINAL_RESERVE_BYTES
        encoder = self.encoder(max_bytes=FINAL_RESERVE_BYTES + 100)
        prefix = encoder.encode('BEGIN', b'{}')
        with self.assertRaises(ValueError): encoder.encode('SAMPLE', b'abc' * 50)
        # A rejected over-budget request does not consume the terminal reserve.
        terminal = encoder.encode('STREAM_END', b'{}')
        self.assertLessEqual(len(prefix + terminal), FINAL_RESERVE_BYTES + 100)
        with self.assertRaises(ValueError): encoder.encode('SAMPLE', b'x')
        self.assertEqual(len(self.read(prefix + terminal, max_bytes=FINAL_RESERVE_BYTES + 100)), 2)

    def test_short_reads_are_accumulated_without_unbounded_reads(self):
        from format import iter_frames
        class SmallReads(io.BytesIO):
            def read(self, size=-1):
                self.assert_bounded(size)
                return super().read(min(size, 7))
            @staticmethod
            def assert_bounded(size):
                if not 0 < size <= 131072:
                    raise AssertionError('unbounded read')
        self.assertEqual(len(list(iter_frames(SmallReads(self.stream())))), 3)

    def test_payload_bounds_and_stream_end_not_external_success(self):
        from format import FINAL_RESERVE_BYTES, KIND_LIMITS
        encoder = self.encoder()
        with self.assertRaises(ValueError): encoder.encode('SAMPLE', b'x')
        encoder.encode('BEGIN', b'{}')
        with self.assertRaises(ValueError): encoder.encode('READY', b'x' * (KIND_LIMITS['READY'] + 1))
        with self.assertRaises(ValueError): encoder.encode('STREAM_END', b'x' * FINAL_RESERVE_BYTES)
        # Envelope correctness deliberately says nothing about semantic success.
        self.assertEqual(self.read(self.stream())[-1].kind, 'STREAM_END')

    def test_record_count_also_reserves_a_terminal_slot(self):
        from format import MAX_RECORDS
        encoder = self.encoder()
        encoder.encode('BEGIN', b'{}')
        for _ in range(MAX_RECORDS - 2): encoder.encode('PHASE', b'x')
        with self.assertRaises(ValueError): encoder.encode('PHASE', b'x')
        encoder.encode('STREAM_END', b'{}')

    def test_framed_maximum_envelope_fits_without_a_compression_assumption(self):
        from format import worst_case_raw_bytes, RAW_MAX_BYTES, ARTIFACT_MAX_BYTES, LOG_MAX_BYTES, METADATA_MAX_BYTES
        self.assertLessEqual(worst_case_raw_bytes(), RAW_MAX_BYTES)
        self.assertLessEqual(RAW_MAX_BYTES + 2 * LOG_MAX_BYTES + METADATA_MAX_BYTES, ARTIFACT_MAX_BYTES)


if __name__ == '__main__':
    unittest.main()
