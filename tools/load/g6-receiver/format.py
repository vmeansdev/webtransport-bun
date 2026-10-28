"""Bounded lossless receiver samples. Not a lifecycle or capacity verdict.

Structural validation is performed on both encoding and decoding. Cross-sample
identity/counter continuity, cadence, source authority and external settlement
are additional requirements enforced by the observation/replay layers.
"""
import copy
import hashlib
import json
import re
import struct
from dataclasses import dataclass

MAX_BASELINE = 128 * 1024
MAX_SOCKETS = 128
MAX_THREADS = 512
MAX_SAMPLES = 4202
U64 = (1 << 64) - 1
SAFE_LIMIT = 1 << 53
SOCKET_VALUES = ('drops', 'rxQueueBytes', 'txQueueBytes', 'rcvbufBytes', 'sndbufBytes')
THREAD_VALUES = ('runtimeNs', 'waitNs', 'timeslices')
HEADER = struct.Struct('>4s32sQ')  # version, exact baseline hash, sample ordinal


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def integer(value):
    need(type(value) is int and 0 <= value <= U64, 'non-u64 value')
    return value


def counter(value, positive=False):
    need(type(value) is int and int(positive) <= value < SAFE_LIMIT, 'semantic counter bound')
    return value


def text(value, maximum):
    need(type(value) is str and '\x00' not in value and len(value.encode('utf-8')) <= maximum,
         'text bound/type')
    return value


def identity(value):
    keys(value, ('pid', 'startTime', 'netns', 'exe', 'exeDevice', 'exeInode',
                 'exeSize', 'exeMtimeNs', 'bootId'))
    for field in ('pid', 'startTime', 'exeDevice', 'exeInode', 'exeSize', 'exeMtimeNs'):
        need(integer(value[field]) > 0, 'identity integer')
    need(re.fullmatch(r'net:\[[0-9]{1,20}\]', text(value['netns'], 32)) is not None,
         'namespace identity')
    need(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', text(value['bootId'], 36))
         is not None, 'boot identity')
    need(text(value['exe'], 4096).startswith('/'), 'executable identity')


def keys(value, expected):
    need(type(value) is dict and set(value) == set(expected), 'schema keys')


def shape(row):
    keys(row, ('kind', 'scheduledNs', 'snapshot'))
    need(row['kind'] == 'sample', 'record kind')
    s = row['snapshot']
    keys(s, ('identity', 'sockets', 'threads', 'beganNs', 'finishedNs', 'effectiveRcvbufSource', 'limits'))
    identity(s['identity'])
    need(counter(row['scheduledNs'], True) <= counter(s['beganNs'], True)
         <= counter(s['finishedNs'], True), 'sample timestamp order')
    need(text(s['effectiveRcvbufSource'], 128)
         == 'SOCK_DIAG_BY_FAMILY/INET_DIAG_SKMEMINFO per owned inode', 'socket buffer provenance')
    need(type(s['limits']) is list and len(s['limits']) <= 16, 'limits list')
    for limitation in s['limits']:
        text(limitation, 512)
    addresses = set()
    for name, maximum, fields in (
        ('sockets', MAX_SOCKETS, ('family', 'local') + SOCKET_VALUES),
        ('threads', MAX_THREADS, ('pid', 'startTime') + THREAD_VALUES),
    ):
        inventory = s[name]
        need(type(inventory) is dict and 1 <= len(inventory) <= maximum, 'inventory count')
        if name == 'sockets':
            need(len(inventory) == MAX_SOCKETS, 'complete endpoint inventory required')
        for key, item in inventory.items():
            need(type(key) is str and key.isascii() and key.isdigit()
                 and str(int(key)) == key and 0 < int(key) <= U64, 'inventory key')
            keys(item, fields)
            if name == 'threads':
                need(integer(item['pid']) == int(key), 'thread key/pid')
                counter(item['startTime'], True)
            else:
                need(type(item['family']) is int and item['family'] in (4, 6), 'family')
                address = text(item['local'], 37)
                width = 8 if item['family'] == 4 else 32
                need(re.fullmatch(r'[0-9A-Fa-f]{' + str(width) + r'}:[0-9A-Fa-f]{4}', address)
                     is not None and int(address[-4:], 16) > 0, 'local address')
                normalized = (item['family'], address.upper())
                need(normalized not in addresses, 'duplicate socket binding')
                addresses.add(normalized)
                counter(item['rcvbufBytes'], True)
                counter(item['sndbufBytes'], True)
            for field in SOCKET_VALUES if name == 'sockets' else THREAD_VALUES:
                counter(item[field])
    leader = s['threads'].get(str(s['identity']['pid']))
    need(leader is not None and leader['startTime'] == s['identity']['startTime'],
         'process leader missing or replaced')
    return s


def split(row):
    s = shape(row)
    static = copy.deepcopy(row)
    target = static['snapshot']
    values = [integer(row['scheduledNs']), integer(s['beganNs']), integer(s['finishedNs'])]
    del static['scheduledNs']
    del target['beganNs'], target['finishedNs']
    for name, fields in (('sockets', SOCKET_VALUES), ('threads', THREAD_VALUES)):
        for key in sorted(s[name], key=int):
            for field in fields:
                values.append(integer(s[name][key][field]))
                del target[name][key][field]
    return static, values


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                      allow_nan=False).encode('ascii')


class Codec:
    def __init__(self, baseline):
        # This object is initialized only from an already parsed offline sample.
        # A live decoder would need bounded framing/parsing before construction.
        static, values = split(baseline)
        self.baseline = copy.deepcopy(baseline)
        self.static = canonical(static)
        self.baseline_bytes = canonical(baseline)
        need(len(self.baseline_bytes) <= MAX_BASELINE, 'baseline cap')
        self.digest = hashlib.sha256(self.baseline_bytes).digest()
        self.count = len(values)
        self.size = HEADER.size + 8 * self.count

    def encode(self, row, ordinal):
        static, values = split(row)
        need(canonical(static) == self.static, 'frozen identity/inventory/schema changed')
        need(integer(ordinal) < MAX_SAMPLES, 'sample count bound')
        return HEADER.pack(b'GRC1', self.digest, ordinal) + struct.pack('>' + 'Q' * self.count, *values)

    def decode(self, raw, expected_ordinal):
        need(type(raw) is bytes and len(raw) == self.size, 'frame length')
        magic, digest, ordinal = HEADER.unpack_from(raw)
        need(magic == b'GRC1' and digest == self.digest, 'frame version/baseline')
        need(ordinal == integer(expected_ordinal) and ordinal < MAX_SAMPLES, 'frame ordinal')
        values = iter(struct.unpack_from('>' + 'Q' * self.count, raw, HEADER.size))
        row = copy.deepcopy(self.baseline)
        s = row['snapshot']
        row['scheduledNs'], s['beganNs'], s['finishedNs'] = next(values), next(values), next(values)
        for name, fields in (('sockets', SOCKET_VALUES), ('threads', THREAD_VALUES)):
            for key in sorted(s[name], key=int):
                for field in fields:
                    s[name][key][field] = next(values)
        shape(row)
        return row


def maximum_sample_size():
    return HEADER.size + 8 * (3 + MAX_SOCKETS * len(SOCKET_VALUES) + MAX_THREADS * len(THREAD_VALUES))


# Envelope validation is intentionally separate from observation semantics.
# STREAM_END is an internal end marker, never fsync/reap/settlement proof.
SCHEMA = 'g6-receiver-evidence/1'
RAW_MAX_BYTES = 80 * 1024 * 1024
ARTIFACT_MAX_BYTES = 128 * 1024 * 1024
FINAL_RESERVE_BYTES = 64 * 1024
LOG_MAX_BYTES = 8 * 1024 * 1024
LOG_LINE_MAX_BYTES = 128 * 1024
METADATA_MAX_BYTES = 1024 * 1024
MAX_RECORDS = MAX_SAMPLES + 32
FRAME_HEADER = struct.Struct('>4sBBHIQ32s32s')
DRIVER_RECEIPT = struct.Struct('>Q')
ACK_RECEIPT = struct.Struct('>QQQQ32s')
KIND_LIMITS = {
    'BEGIN': MAX_BASELINE,
    'FREEZE': MAX_BASELINE,
    'READY': 16378 + DRIVER_RECEIPT.size,
    'ACK_INTENT': 16384 + DRIVER_RECEIPT.size,
    'ACK': 16384 + ACK_RECEIPT.size,
    'SAMPLE': maximum_sample_size(),
    'PHASE': 512 + DRIVER_RECEIPT.size,
    'END': 512 + DRIVER_RECEIPT.size,
    'CLIENT_EXIT': 4096,
    'STREAM_END': FINAL_RESERVE_BYTES - FRAME_HEADER.size,
    'TAIL_CANCEL': 4096,
}
KINDS = tuple(KIND_LIMITS)


def byte_cap(value):
    need(type(value) is int and FINAL_RESERVE_BYTES < value <= RAW_MAX_BYTES, 'raw byte cap')
    return value


@dataclass(frozen=True)
class Frame:
    kind: str
    sequence: int
    payload: bytes
    sha256: bytes
    offset: int
    end_offset: int


class FrameEncoder:
    """Bounded encoded bytes, not a durability receipt. Caller owns writes."""
    def __init__(self, max_bytes=RAW_MAX_BYTES):
        self.max_bytes = byte_cap(max_bytes)
        self.sequence = 0
        self.bytes = 0
        self.previous = bytes(32)
        self.ended = False

    def encode(self, kind, payload):
        need(not self.ended and self.sequence < MAX_RECORDS, 'record count/after end')
        need(type(kind) is str and kind in KIND_LIMITS, 'record kind')
        need((kind == 'BEGIN') == (self.sequence == 0), 'BEGIN placement')
        need(type(payload) is bytes and 0 < len(payload) <= KIND_LIMITS[kind], 'payload bound')
        final = kind == 'STREAM_END'
        need(self.sequence < MAX_RECORDS - int(not final), 'final record slot reserve')
        length = FRAME_HEADER.size + len(payload)
        limit = self.max_bytes if final else self.max_bytes - FINAL_RESERVE_BYTES
        need(self.bytes + length <= limit, 'raw cap/final reserve')
        header = FRAME_HEADER.pack(b'GRF1', KINDS.index(kind) + 1, 0, 0,
                                   len(payload), self.sequence, self.previous,
                                   hashlib.sha256(payload).digest())
        result = header + payload
        self.previous = hashlib.sha256(result).digest()
        self.sequence += 1
        self.bytes += len(result)
        self.ended = final
        return result


def read_exact(source, length):
    need(type(length) is int and 0 < length <= MAX_BASELINE, 'bounded read length')
    result = bytearray()
    while len(result) < length:
        part = source.read(length - len(result))
        need(type(part) is bytes and 0 < len(part) <= length - len(result), 'truncated/invalid read')
        result.extend(part)
    return bytes(result)


def iter_frames(source, max_bytes=RAW_MAX_BYTES):
    """Consume to exhaustion to establish framing completeness, not acceptance.

    At most one bounded payload/frame is retained. The manifest must already be
    independently hash-verified before this parser processes an evidence file.
    """
    cap = byte_cap(max_bytes)
    sequence, offset, previous = 0, 0, bytes(32)
    while True:
        need(sequence < MAX_RECORDS and offset + FRAME_HEADER.size <= cap, 'record/cap bound')
        header = read_exact(source, FRAME_HEADER.size)
        magic, code, flags, padding, size, actual_sequence, prior, body_hash = FRAME_HEADER.unpack(header)
        need(magic == b'GRF1' and flags == 0 and padding == 0, 'record version/reserved bits')
        need(1 <= code <= len(KINDS), 'record kind code')
        kind = KINDS[code - 1]
        need(sequence < MAX_RECORDS - int(kind != 'STREAM_END'), 'final record slot reserve')
        need((kind == 'BEGIN') == (sequence == 0), 'BEGIN placement')
        need(actual_sequence == sequence and prior == previous, 'record sequence/hash chain')
        need(0 < size <= KIND_LIMITS[kind], 'record payload bound')
        end = offset + FRAME_HEADER.size + size
        need(end <= (cap if kind == 'STREAM_END' else cap - FINAL_RESERVE_BYTES), 'raw cap/final reserve')
        payload = read_exact(source, size)
        need(hashlib.sha256(payload).digest() == body_hash, 'record payload hash')
        previous = hashlib.sha256(header + payload).digest()
        frame = Frame(kind, sequence, payload, previous, offset, end)
        offset = end
        sequence += 1
        if kind == 'STREAM_END':
            need(source.read(1) == b'', 'data after STREAM_END')
            yield frame
            return
        yield frame


def worst_case_raw_bytes():
    """Bound for the semantic contract's maximum valid record multiplicities.

    The ten driver frames are conservatively budgeted at READY size even though
    PHASE/END are smaller and Rust additionally caps their combined raw bytes.
    Invalid extra records remain subject to the actual writer cap; they cannot
    be used to assert this valid-sequence bound.
    """
    framed = lambda size: FRAME_HEADER.size + size
    return (3 * framed(MAX_BASELINE)  # BEGIN and two freezes
            + 10 * framed(KIND_LIMITS['READY'])
            + framed(KIND_LIMITS['ACK_INTENT'])
            + framed(KIND_LIMITS['ACK'])
            + MAX_SAMPLES * framed(maximum_sample_size())
            + framed(KIND_LIMITS['CLIENT_EXIT'])
            + framed(KIND_LIMITS['TAIL_CANCEL'])
            + FINAL_RESERVE_BYTES)


def encode_json(value, maximum=MAX_BASELINE):
    result = canonical(value)
    need(0 < len(result) <= maximum, 'JSON byte bound')
    return result


def decode_json(raw, maximum=MAX_BASELINE):
    need(type(raw) is bytes and 0 < len(raw) <= maximum, 'JSON byte bound')
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    def invalid_number(_):
        raise ValueError('non-integer control JSON number')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_number,
                           parse_float=invalid_number)
        need(canonical(value) == raw, 'noncanonical control JSON')
        return value
    except (UnicodeError, RecursionError, OverflowError) as error:
        raise ValueError('malformed control JSON') from error
