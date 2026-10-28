"""Pure receiver observation invariants. Live collection is a separate layer."""
import copy
import ipaddress
import re
from functools import wraps

from format import MAX_SAMPLES, counter, keys, need, shape

INTERVAL_NS = 100_000_000
PHASES = ('connect', 'steady', 'drain', 'idle', 'stop')


def endpoint_address(value):
    need(type(value) is str and len(value) <= 64 and '%' not in value, 'endpoint address type/zone')
    match = re.fullmatch(r'\[([^\]]+)\]:([0-9]+)', value) if value.startswith('[') else re.fullmatch(r'([^:]+):([0-9]+)', value)
    need(match is not None, 'endpoint address syntax')
    address = ipaddress.ip_address(match[1])
    port = int(match[2])
    need(0 < port <= 65535 and match[2] == str(port), 'endpoint port')
    return address.version, str(address), port


def proc_address(row):
    raw, port = row['local'].split(':')
    value = bytes.fromhex(raw)
    # Registered Linux little-endian proc tables store each word in native order.
    value = b''.join(value[i:i + 4][::-1] for i in range(0, len(value), 4))
    return row['family'], str(ipaddress.ip_address(value)), int(port, 16)


def poison_on_failure(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        need(not self.failed, 'driver evidence already invalid')
        try:
            return method(self, *args, **kwargs)
        except (ValueError, TypeError, KeyError, IndexError):
            self.failed = True
            raise
    return wrapped


class DriverTimeline:
    """The committed G6RD1 protocol, with bounded pre-ACK and phase evidence.

    Receipt times and driver brackets share the generator host clock. This keeps
    at most ten small frames and two snapshots, never a list of all samples.
    The replay owner independently supplies the expected process identity/token.
    """
    def __init__(self, client_identity, token, storm=False):
        from format import identity
        identity(client_identity)
        need(type(token) is str and re.fullmatch(r'[a-f0-9]{64}', token), 'diagnostic token')
        need(type(storm) is bool, 'storm mode')
        self.client_identity = copy.deepcopy(client_identity)
        self.token = token
        self.phases = ('connect', 'steady', 'drain', 'storm', 'post-storm', 'idle', 'stop') if storm else PHASES
        self.frames = 0
        self.frame_bytes = 0
        self.ready = None
        self.mapping = None
        self.last_ns = 0
        self.last_received = 0
        self.freeze_count = 0
        self.freeze_at_ns = 0
        self.baseline = None
        self.intent_record = None
        self.ack_interval = None
        self.fences = []
        self.end_ns = None
        self.failed = False

    @poison_on_failure
    def feed(self, raw, received_ns):
        counter(received_ns, True)
        need(type(raw) is bytes and 0 < len(raw) <= 16378, 'driver frame byte bound')
        need(self.end_ns is None and self.last_received <= received_ns, 'driver frame after END/receipt regression')
        self.frames += 1
        self.frame_bytes += len(raw)
        need(self.frames <= 10 and self.frame_bytes <= 32768, 'driver frame/count budget')
        decoded = raw.decode('ascii')
        need(decoded.endswith('\n') and '\r' not in decoded, 'driver LF framing')
        lines = decoded[:-1].split('\n')
        fields = lines[0].split('\t')
        need(len(fields) >= 3 and fields[:1] == ['G6RD1'] and fields[2] == self.token,
             'driver version/token')
        self.last_received = received_ns
        if fields[1] == 'READY':
            need(self.ready is None and self.frames == 1 and len(fields) == 6, 'READY placement/schema')
            need(fields[3] == str(self.client_identity['pid']) and fields[5] == '128' and len(lines) == 129,
                 'READY identity/count')
            ns = int(fields[4])
            need(fields[4] == str(ns) and counter(ns, True) <= received_ns, 'READY clock')
            mapping = []
            for index, line in enumerate(lines[1:]):
                pair = line.split('\t')
                need(len(pair) == 2 and pair[0] == str(index), 'READY index')
                endpoint_address(pair[1])
                mapping.append(pair[1])
            need(len(set(map(endpoint_address, mapping))) == 128, 'duplicate READY address')
            self.ready, self.mapping, self.last_ns = raw, mapping, ns
            return 'READY'
        need(self.ack_interval is not None and len(lines) == 1 and len(raw) <= 512,
             'phase before ACK/framing')
        need(received_ns >= self.ack_interval[1], 'driver receipt before completed ACK')
        if fields[1] == 'PHASE':
            need(len(fields) == 7 and len(self.fences) < len(self.phases), 'PHASE schema/count')
            seq, name, before, after = fields[3:]
            before_ns, after_ns = int(before), int(after)
            need(before == str(before_ns) and after == str(after_ns), 'phase canonical clock')
            counter(before_ns, True)
            counter(after_ns, True)
            need(seq == str(len(self.fences) + 1) and name == self.phases[len(self.fences)], 'phase sequence')
            need(self.last_ns <= before_ns <= after_ns <= received_ns and before_ns >= self.ack_interval[0],
                 'phase/ACK clock order')
            self.fences.append((name, before_ns, after_ns, received_ns))
            self.last_ns = after_ns
            return name
        need(fields[1] == 'END' and len(fields) == 5 and len(self.fences) == len(self.phases),
             'END or required phases missing')
        ns = int(fields[4])
        need(fields[3] == str(len(self.phases) + 1) and fields[4] == str(ns), 'END sequence/clock')
        need(self.last_ns <= counter(ns, True) <= received_ns, 'END clock order')
        self.end_ns = ns
        return 'END'

    @poison_on_failure
    def freeze(self, snapshot, at_ns):
        counter(at_ns, True)
        need(self.ready is not None and self.freeze_count < 2 and self.intent_record is None,
             'freeze placement')
        shape({'kind': 'sample', 'scheduledNs': snapshot['beganNs'], 'snapshot': snapshot})
        need(snapshot['identity'] == self.client_identity
             and max(self.last_received, self.freeze_at_ns) <= snapshot['beganNs']
             and snapshot['finishedNs'] <= at_ns, 'freeze identity/clock')
        need(set(map(endpoint_address, self.mapping)) == {proc_address(row) for row in snapshot['sockets'].values()},
             'actual endpoint map mismatch')
        if self.baseline is not None:
            validate_continuity(self.baseline, snapshot)
        self.baseline = copy.deepcopy(snapshot)
        self.freeze_count += 1
        self.freeze_at_ns = at_ns

    @poison_on_failure
    def intent(self, raw, created_ns, prefix_bytes, prefix_chain):
        counter(created_ns, True)
        need(self.freeze_count == 2 and self.intent_record is None and self.ack_interval is None,
             'ACK intent placement')
        need(type(raw) is bytes and raw == b'ARMED\n' + self.ready and len(raw) <= 16384, 'ACK intent bytes')
        need(self.freeze_at_ns <= created_ns and created_ns - self.last_ns < 2_000_000_000,
             'ACK intent clock')
        need(type(prefix_bytes) is int and 0 < prefix_bytes <= 80 * 1024 * 1024
             and type(prefix_chain) is bytes and len(prefix_chain) == 32, 'committed intent prefix')
        self.intent_record = (raw, created_ns, prefix_bytes, prefix_chain)

    @poison_on_failure
    def ack(self, raw, before_ns, after_ns, commit_received_ns, prefix_bytes, prefix_chain):
        need(self.intent_record is not None and self.ack_interval is None, 'ACK placement')
        expected, created, expected_bytes, expected_chain = self.intent_record
        for value in (before_ns, after_ns, commit_received_ns): counter(value, True)
        need(raw == expected and prefix_bytes == expected_bytes and prefix_chain == expected_chain,
             'ACK bytes/durable prefix mismatch')
        need(created <= commit_received_ns <= before_ns <= after_ns
             and after_ns - self.last_ns < 2_000_000_000, 'ACK publication/deadline')
        self.ack_interval = (before_ns, after_ns)

    def classify(self, began_ns, finished_ns):
        need(not self.failed and self.end_ns is not None, 'incomplete driver timeline')
        need(counter(began_ns, True) <= counter(finished_ns, True), 'classification interval')
        ambiguous = any(began_ns <= after and finished_ns >= before for _, before, after, _ in self.fences)
        phase = next((name for name, _, after, _ in reversed(self.fences) if after < began_ns), 'setup')
        return phase, ambiguous

    def summary(self):
        need(not self.failed and self.end_ns is not None and self.ack_interval is not None
             and self.freeze_count == 2, 'incomplete driver evidence')
        return {'frames': self.frames, 'frameBytes': self.frame_bytes,
                'preConnectHandshake': True, 'driverIntervals': True,
                'perSessionAtomicity': False}


def validate_continuity(previous, current):
    need(previous['identity'] == current['identity'], 'process identity changed')
    for name in ('sockets', 'threads'):
        need(previous[name].keys() == current[name].keys(), 'complete inventory changed')
    need(previous['finishedNs'] <= current['beganNs'], 'overlapping observations')
    for inode, row in current['sockets'].items():
        old = previous['sockets'][inode]
        need(row['family'] == old['family'] and row['local'] == old['local'], 'socket binding changed')
        need(row['drops'] >= old['drops'], 'socket drops counter reset')
    for tid, row in current['threads'].items():
        old = previous['threads'][tid]
        need(row['pid'] == old['pid'] and row['startTime'] == old['startTime'], 'thread replaced')
        for name in ('runtimeNs', 'waitNs', 'timeslices'):
            need(row[name] >= old[name], 'thread counter reset')


class Cadence:
    """Consecutive slots, retaining only one prior snapshot, never all samples.

    Any collection validation failure poisons qualification permanently. The
    owner still retains invalid raw evidence; this object supplies no cleanup,
    source authority, phase calibration or terminal-settlement verdict.
    """
    def __init__(self, anchor_ns, baseline):
        self.anchor = counter(anchor_ns, True)
        shape({'kind': 'sample', 'scheduledNs': baseline['beganNs'], 'snapshot': baseline})
        need(baseline['finishedNs'] <= self.anchor, 'baseline after ACK anchor')
        self.previous = copy.deepcopy(baseline)
        self.count = 0
        self.failed = False
        self.finished = False

    def add(self, row):
        need(not self.failed and not self.finished, 'cadence already invalid or finished')
        try:
            current = shape(row)
            need(self.count < MAX_SAMPLES, 'sample count bound')
            tick = self.anchor + self.count * INTERVAL_NS
            need(row['scheduledNs'] == tick, 'missing/duplicate scheduled tick')
            need(tick <= current['beganNs'] <= current['finishedNs'] < tick + INTERVAL_NS,
                 'observation missed its slot')
            validate_continuity(self.previous, current)
            self.previous = copy.deepcopy(current)
            self.count += 1
        except (ValueError, TypeError, KeyError):
            self.failed = True
            raise

    def finish(self, stop_before, stop_after, *, cancellation=None,
               clean_client_exit=False, end_ns=None):
        need(not self.failed and not self.finished, 'cadence already invalid or finished')
        self.finished = True
        try:
            counter(stop_before, True)
            counter(stop_after, True)
            need(self.anchor <= stop_before <= stop_after, 'stop clock order')
            required = (stop_before - self.anchor) // INTERVAL_NS
            need(0 < required <= MAX_SAMPLES, 'required coverage bound')
            fractional = (stop_before - self.anchor) % INTERVAL_NS != 0
            need(required <= self.count <= required + int(fractional), 'missing or excess observations')
            if self.count > required:
                need(self.previous['beganNs'] < stop_before, 'extra observation started after stop')
            if cancellation is not None:
                keys(cancellation, ('scheduledNs', 'beganNs', 'failedNs', 'reason'))
                need(fractional and self.count == required, 'cancellation of required or duplicate slot')
                tick = self.anchor + required * INTERVAL_NS
                need(cancellation['scheduledNs'] == tick, 'cancelled slot schedule')
                need(tick <= counter(cancellation['beganNs'], True) < stop_before,
                     'tail cancellation start')
                need(counter(cancellation['failedNs'], True) > stop_after
                     and cancellation['failedNs'] >= counter(end_ns, True)
                     and end_ns >= stop_after and clean_client_exit is True
                     and cancellation['reason'] == 'client-exited', 'unproven clean tail termination')
            return {'requiredSamples': required, 'samples': self.count,
                    'boundarySamples': self.count - required,
                    'boundaryRemainderNs': (stop_before - self.anchor) % INTERVAL_NS,
                    'tailCancelled': cancellation is not None}
        except (ValueError, TypeError, KeyError):
            self.failed = True
            raise
