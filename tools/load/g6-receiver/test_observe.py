import copy
import unittest

from fixtures_test_helper import TOKEN, end, phase, ready, sample


class CadenceTests(unittest.TestCase):
    def cadence(self):
        from observe import Cadence
        return Cadence(1_000_000_000, sample(at=900_000_000)['snapshot'])

    def fill(self, cadence, count):
        for k in range(count): cadence.add(sample(at=1_000_000_000 + k * 100_000_000))

    def test_complete_exact_slots_and_optional_fractional_tail(self):
        c = self.cadence()
        self.fill(c, 10)
        self.assertEqual(c.finish(2_000_000_000, 2_000_000_001)['requiredSamples'], 10)
        c = self.cadence()
        self.fill(c, 11)
        self.assertEqual(c.finish(2_050_000_000, 2_050_000_001)['boundarySamples'], 1)

    def test_missing_middle_tick_and_synthetic_duplicate_refuse(self):
        for at in (1_000_000_000, 1_200_000_000):
            c = self.cadence()
            self.fill(c, 1)
            with self.subTest(at=at), self.assertRaises(ValueError): c.add(sample(at=at))

    def test_collection_must_finish_inside_its_own_slot(self):
        c = self.cadence()
        row = sample()
        row['snapshot']['finishedNs'] = 1_100_000_000
        with self.assertRaises(ValueError): c.add(row)

    def test_early_stop_missing_tail_and_sparse_minimum_counts_refuse(self):
        for count in (0, 1, 6, 9):
            c = self.cadence()
            self.fill(c, count)
            with self.subTest(count=count), self.assertRaises(ValueError): c.finish(2_000_000_000, 2_000_000_001)

    def test_counter_reset_identity_or_complete_inventory_change_refuse(self):
        mutations = (
            lambda r: r['snapshot']['identity'].update(exeInode=3),
            lambda r: r['snapshot']['threads']['1001'].update(runtimeNs=0),
            lambda r: r['snapshot']['sockets'].pop('100000'),
            lambda r: r['snapshot']['threads']['1001'].update(startTime=999),
        )
        for mutate in mutations:
            c = self.cadence()
            row = sample()
            mutate(row)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): c.add(row)

    def test_increasing_and_decreasing_queue_and_buffer_values_are_not_counter_resets(self):
        c = self.cadence()
        row = sample()
        row['snapshot']['sockets']['100000']['rcvbufBytes'] = 65536
        row['snapshot']['sockets']['100000']['rxQueueBytes'] = 1024
        c.add(row)
        c.add(sample(at=1_100_000_000))
        self.assertEqual(c.finish(1_200_000_000, 1_200_000_001)['requiredSamples'], 2)

    def test_failed_collection_poisoning_prevents_a_later_success_summary(self):
        c = self.cadence()
        with self.assertRaises(ValueError): c.add(sample(at=1_100_000_000))
        with self.assertRaises(ValueError): c.add(sample())
        with self.assertRaises(ValueError): c.finish(1_100_000_000, 1_100_000_001)

    def test_tail_cancellation_cannot_excuse_a_required_slot_or_pre_stop_error(self):
        for count, failed_at in ((9, 2_050_000_100), (10, 2_000_000_000)):
            c = self.cadence()
            self.fill(c, count)
            cancellation = {'scheduledNs': 1_000_000_000 + count * 100_000_000,
                            'beganNs': 1_000_000_001 + count * 100_000_000,
                            'failedNs': failed_at, 'reason': 'client-exited'}
            with self.subTest(count=count), self.assertRaises(ValueError):
                c.finish(2_050_000_000, 2_050_000_001, cancellation=cancellation,
                         clean_client_exit=True, end_ns=2_050_000_050)
        c = self.cadence()
        self.fill(c, 10)
        cancellation = {'scheduledNs': 2_000_000_000, 'beganNs': 2_000_000_001,
                        'failedNs': 2_050_000_100, 'reason': 'client-exited'}
        result = c.finish(2_050_000_000, 2_050_000_001, cancellation=cancellation,
                          clean_client_exit=True, end_ns=2_050_000_050)
        self.assertTrue(result['tailCancelled'])


class DriverTests(unittest.TestCase):
    def timeline(self):
        from observe import DriverTimeline
        return DriverTimeline(sample()['snapshot']['identity'], TOKEN)

    def frozen(self):
        t = self.timeline()
        t.feed(ready(), 800_000_100)
        t.freeze(sample(at=850_000_000)['snapshot'], 850_002_000)
        t.freeze(sample(at=900_000_000)['snapshot'], 900_002_000)
        return t

    def armed(self):
        t = self.frozen()
        ack = b'ARMED\n' + ready()
        t.intent(ack, 950_000_000, 200000, b'x' * 32)
        t.ack(ack, 1_000_000_000, 1_000_001_000, 970_000_000, 200000, b'x' * 32)
        return t

    def complete(self):
        t = self.armed()
        for i, (name, at) in enumerate((('connect', 1_000_000_500), ('steady', 1_200_000_000),
                                         ('drain', 1_500_000_000), ('idle', 1_800_000_000),
                                         ('stop', 2_000_000_000)), 1):
            t.feed(phase(i, name, at), at + 2000)
        t.feed(end(), 2_001_000_100)
        return t

    def test_actual_protocol_map_handshake_and_driver_intervals(self):
        t = self.complete()
        self.assertEqual(t.summary()['frames'], 7)
        self.assertFalse(t.summary()['perSessionAtomicity'])
        self.assertEqual(t.classify(1_200_000_050, 1_200_000_200), ('connect', True))
        self.assertEqual(t.classify(1_300_000_000, 1_300_000_100), ('steady', False))
        # A delta across the preceding phase fence stays ambiguous.
        self.assertTrue(t.classify(1_100_000_000, 1_300_000_100)[1])

    def test_no_ack_release_before_matching_frozen_endpoint_inventory(self):
        for mutation in (lambda s: s['identity'].update(exeInode=3),
                         lambda s: s['sockets']['100000'].update(local='00000000:FFFF')):
            t = self.timeline()
            t.feed(ready(), 800_000_100)
            s = sample(at=850_000_000)['snapshot']
            mutation(s)
            with self.assertRaises(ValueError): t.freeze(s, 850_002_000)
        with self.assertRaises(ValueError): self.timeline().feed(phase(1, 'connect', 1_000_000_500), 1_000_002_000)

    def test_ack_requires_the_exact_published_prefix_and_real_interval(self):
        for changed in ('raw', 'digest', 'offset', 'publication', 'late'):
            t = self.frozen()
            ack = b'ARMED\n' + ready()
            t.intent(ack, 950_000_000, 200000, b'x' * 32)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                t.ack(ack + (b'x' if changed == 'raw' else b''),
                      3_000_000_000 if changed == 'late' else 1_000_000_000,
                      3_000_001_000 if changed == 'late' else 1_000_001_000,
                      1_001_000_000 if changed == 'publication' else 970_000_000,
                      200001 if changed == 'offset' else 200000,
                      b'y' * 32 if changed == 'digest' else b'x' * 32)

    def test_missing_duplicate_wrong_token_and_out_of_order_frames_refuse(self):
        t = self.armed()
        with self.assertRaises(ValueError): t.feed(end(), 2_001_000_100)
        t = self.armed()
        with self.assertRaises(ValueError): t.feed(phase(2, 'steady', 1_200_000_000), 1_200_002_000)
        t = self.timeline()
        with self.assertRaises(ValueError): t.feed(ready().replace(TOKEN.encode(), b'b' * 64), 800_000_100)
        t = self.complete()
        with self.assertRaises(ValueError): t.feed(end(), 2_001_000_200)

    def test_freeze_cannot_predate_ready_receipt_or_prior_freeze_publication(self):
        t = self.timeline()
        t.feed(ready(), 860_000_000)
        with self.assertRaises(ValueError): t.freeze(sample(at=850_000_000)['snapshot'], 870_000_000)
        t = self.timeline()
        t.feed(ready(), 800_000_100)
        t.freeze(sample(at=850_000_000)['snapshot'], 910_000_000)
        with self.assertRaises(ValueError): t.freeze(sample(at=900_000_000)['snapshot'], 920_000_000)

    def test_intent_cannot_predate_freeze_receipt(self):
        t = self.timeline()
        t.feed(ready(), 800_000_100)
        t.freeze(sample(at=850_000_000)['snapshot'], 850_002_000)
        t.freeze(sample(at=900_000_000)['snapshot'], 960_000_000)
        with self.assertRaises(ValueError): t.intent(b'ARMED\n' + ready(), 950_000_000, 200000, b'x' * 32)

    def test_driver_receipt_cannot_predate_completed_ack(self):
        t = self.armed()
        with self.assertRaises(ValueError): t.feed(phase(1, 'connect', 1_000_000_500), 1_000_000_700)


if __name__ == '__main__':
    unittest.main()
