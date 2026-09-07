"""Bounded, hash-first receiver artifact reading and observation replay.

Observation validation is not external process settlement, prepared-host
qualification, calibrated attribution or a capacity verdict.
"""
import hashlib
import os
import re
import stat
from contextlib import contextmanager
from dataclasses import dataclass

from format import (ARTIFACT_MAX_BYTES, LOG_MAX_BYTES, MAX_BASELINE,
                    METADATA_MAX_BYTES, RAW_MAX_BYTES, decode_json, keys, need)
from format import (ACK_RECEIPT, DRIVER_RECEIPT, LOG_LINE_MAX_BYTES, Codec, SCHEMA, counter,
                    identity, iter_frames, text)
from observe import Cadence, DriverTimeline

FILE_CAPS = {'receiver.raw': RAW_MAX_BYTES, 'client.stdout': LOG_MAX_BYTES,
             'client.stderr': LOG_MAX_BYTES, 'receiver-settlement.json': METADATA_MAX_BYTES}
MANIFEST_NAME = 'receiver-manifest.json'


def digest_text(value):
    need(type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value), 'SHA256 syntax')
    return value


def file_identity(value):
    need(stat.S_ISREG(value.st_mode) and value.st_nlink == 1, 'non-regular or linked evidence')
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_nlink, value.st_mode)


@dataclass
class RetainedFile:
    name: str
    fd: int
    identity: tuple
    size: int
    sha256: str


class HashPass:
    """A single bounded pass over the same already-verified descriptor."""
    def __init__(self, owner, retained):
        owner.check_stable(retained)
        os.lseek(retained.fd, 0, os.SEEK_SET)
        self.owner, self.retained = owner, retained
        self.bytes = 0
        self.hash = hashlib.sha256()

    def read(self, size):
        need(type(size) is int and 0 < size <= MAX_BASELINE, 'unbounded evidence read')
        data = os.read(self.retained.fd, size)
        self.bytes += len(data)
        need(self.bytes <= self.retained.size, 'evidence grew during read')
        self.hash.update(data)
        return data

    def finish(self):
        need(self.bytes == self.retained.size and self.hash.hexdigest() == self.retained.sha256,
             'incomplete or changed evidence pass')
        self.owner.check_stable(self.retained)


class VerifiedFiles:
    """Open fixed names without following links; hash every file before replay.

    The caller supplies the expected manifest digest from its retained receipt,
    not a digest inferred from the manifest being validated. Context exit closes
    all descriptors, including when hashing or semantic replay fails.
    """
    def __init__(self, root, manifest_sha256):
        self.root = root
        self.expected_manifest_sha256 = digest_text(manifest_sha256)
        self.root_fd = None
        self.files = {}
        self.active = set()
        self.manifest = None

    def _open(self, name, maximum, expected_sha256=None):
        before = os.stat(name, dir_fd=self.root_fd, follow_symlinks=False)
        identity = file_identity(before)
        need(0 <= before.st_size <= maximum, 'evidence file byte cap')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.root_fd)
        try:
            need(file_identity(os.fstat(fd)) == identity, 'evidence replaced while opening')
            retained = RetainedFile(name, fd, identity, before.st_size, expected_sha256 or '')
            self.files[name] = retained
            return retained
        except BaseException:
            os.close(fd)
            raise

    def check_stable(self, retained):
        need(file_identity(os.fstat(retained.fd)) == retained.identity
             and file_identity(os.stat(retained.name, dir_fd=self.root_fd, follow_symlinks=False))
             == retained.identity, 'evidence identity/metadata changed')

    def check_inventory(self):
        expected = set(FILE_CAPS) | {MANIFEST_NAME}
        seen = set()
        with os.scandir(self.root_fd) as entries:
            for entry in entries:
                need(entry.name in expected and entry.name not in seen, 'unclosed artifact set')
                seen.add(entry.name)
        need(seen == expected, 'unclosed artifact set')

    def _hash(self, retained, keep=False):
        self.check_stable(retained)
        os.lseek(retained.fd, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        size = 0
        parts = []
        while True:
            piece = os.read(retained.fd, 65536)
            if not piece:
                break
            size += len(piece)
            need(size <= retained.size, 'evidence grew while hashing')
            digest.update(piece)
            if keep:
                parts.append(piece)
        need(size == retained.size and digest.hexdigest() == retained.sha256, 'evidence hash/size mismatch')
        self.check_stable(retained)
        return b''.join(parts) if keep else None

    def __enter__(self):
        try:
            self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.check_inventory()
            manifest_file = self._open(MANIFEST_NAME, METADATA_MAX_BYTES, self.expected_manifest_sha256)
            manifest_bytes = self._hash(manifest_file, keep=True)
            manifest = decode_json(manifest_bytes, METADATA_MAX_BYTES)
            keys(manifest, ('schema', 'binding', 'files'))
            need(manifest['schema'] == 'g6-receiver-manifest/1', 'manifest schema')
            entries = manifest['files']
            need(type(entries) is list and len(entries) == len(FILE_CAPS), 'manifest file set')
            names = set()
            total = manifest_file.size
            metadata = manifest_file.size
            for entry in entries:
                keys(entry, ('name', 'bytes', 'sha256'))
                name = entry['name']
                need(type(name) is str and name in FILE_CAPS and name not in names, 'manifest filename')
                names.add(name)
                need(type(entry['bytes']) is int and 0 <= entry['bytes'] <= FILE_CAPS[name], 'manifest file byte cap')
                retained = self._open(name, FILE_CAPS[name], digest_text(entry['sha256']))
                need(retained.size == entry['bytes'], 'manifest size differs from file')
                total += retained.size
                if name == 'receiver-settlement.json': metadata += retained.size
            need(names == set(FILE_CAPS) and total <= ARTIFACT_MAX_BYTES and metadata <= METADATA_MAX_BYTES,
                 'aggregate artifact or metadata cap')
            # Complete this loop before allowing even the first raw frame parse.
            for name in FILE_CAPS:
                self._hash(self.files[name])
            self.manifest = manifest
            return self
        except BaseException:
            self.close()
            raise

    @contextmanager
    def pass_file(self, name):
        need(self.manifest is not None and name in FILE_CAPS and name not in self.active,
             'unverified or overlapping file pass')
        self.active.add(name)
        try:
            reader = HashPass(self, self.files[name])
            yield reader
            reader.finish()
        finally:
            self.active.remove(name)

    def metadata(self, name):
        need(name == 'receiver-settlement.json', 'not a bounded metadata file')
        parts = []
        with self.pass_file(name) as reader:
            while True:
                part = reader.read(65536)
                if not part: break
                parts.append(part)
        return decode_json(b''.join(parts), METADATA_MAX_BYTES)

    def finish(self):
        """Revalidate every retained artifact after all semantic consumers."""
        need(self.manifest is not None and not self.active, 'unfinished evidence pass')
        self.check_inventory()
        for retained in self.files.values():
            self._hash(retained)
        # A write to an earlier member while hashing a later one must not pass.
        for retained in self.files.values():
            self.check_stable(retained)
        self.check_inventory()

    def close(self):
        first_error = None
        for retained in self.files.values():
            if retained.fd >= 0:
                fd, retained.fd = retained.fd, -1
                try: os.close(fd)
                except OSError as error: first_error = first_error or error
        if self.root_fd is not None:
            fd, self.root_fd = self.root_fd, None
            try: os.close(fd)
            except OSError as error: first_error = first_error or error
        if first_error is not None: raise first_error

    def __exit__(self, *exception):
        self.close()


def validate_binding(value):
    """Expected values come from the caller's source/owner authority, not raw."""
    keys(value, ('schema', 'candidateSha', 'sourceSha256', 'producerSha256', 'registrationSha256',
                 'mappingSha256', 'runId', 'nodeId', 'bootId', 'mode', 'storm',
                 'cleanupNs', 'cutoffNs'))
    need(value['schema'] == 'g6-receiver-binding/1' and value['mode'] == 'owned-v1', 'binding schema/mode')
    need(type(value['candidateSha']) is str and re.fullmatch(r'[a-f0-9]{40}', value['candidateSha']),
         'binding candidate commit')
    for field in ('sourceSha256', 'producerSha256', 'registrationSha256', 'mappingSha256'):
        digest_text(value[field])
    for field in ('runId', 'nodeId'):
        need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', text(value[field], 128)), 'binding owner ID')
    need(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', text(value['bootId'], 36)),
         'binding boot ID')
    need(type(value['storm']) is bool, 'binding storm mode')
    need(counter(value['cleanupNs'], True) + 5_000_000_000 == counter(value['cutoffNs'], True),
         'binding cleanup reserve')


def receipt(payload):
    need(len(payload) > DRIVER_RECEIPT.size, 'empty driver receipt')
    return DRIVER_RECEIPT.unpack_from(payload)[0], payload[DRIVER_RECEIPT.size:]


def control_pass(source, expected_binding):
    """Retain only identities, two freezes and bounded driver fences."""
    timeline = codec = begin = client_exit = cancellation = terminal = None
    prior_hash = bytes(32)
    samples = 0
    for frame in iter_frames(source):
        kind, payload = frame.kind, frame.payload
        if kind == 'BEGIN':
            begin = decode_json(payload)
            keys(begin, ('schema', 'binding', 'client', 'supervisor', 'writer', 'token', 'armedNs'))
            need(begin['schema'] == SCHEMA and begin['binding'] == expected_binding, 'BEGIN binding mismatch')
            for name in ('client', 'supervisor', 'writer'):
                identity(begin[name])
                need(begin[name]['bootId'] == expected_binding['bootId'], 'process boot mismatch')
                need(begin[name]['netns'] == begin['client']['netns'], 'process namespace mismatch')
            need(len({begin[n]['pid'] for n in ('client', 'supervisor', 'writer')}) == 3,
                 'duplicate process ownership')
            need(counter(begin['armedNs'], True) < expected_binding['cleanupNs'], 'late arm')
            timeline = DriverTimeline(begin['client'], begin['token'], expected_binding['storm'])
        elif kind in ('READY', 'PHASE', 'END'):
            need(client_exit is None, 'driver frame after client exit')
            received, raw = receipt(payload)
            need(begin['armedNs'] <= counter(received, True) < expected_binding['cleanupNs'],
                 'driver receipt outside observation deadline')
            result = timeline.feed(raw, received)
            need((kind == 'READY' and result == 'READY') or (kind == 'END' and result == 'END')
                 or (kind == 'PHASE' and result in timeline.phases), 'driver envelope kind mismatch')
            need(timeline.last_ns >= begin['armedNs'], 'driver predates arm')
        elif kind == 'FREEZE':
            value = decode_json(payload)
            keys(value, ('atNs', 'snapshot'))
            need(value['atNs'] < expected_binding['cleanupNs'], 'late freeze')
            timeline.freeze(value['snapshot'], value['atNs'])
        elif kind == 'ACK_INTENT':
            at, raw = receipt(payload)
            timeline.intent(raw, at, frame.end_offset, frame.sha256)
        elif kind == 'ACK':
            need(len(payload) > ACK_RECEIPT.size, 'empty ACK receipt')
            before, after, commit, size, chain = ACK_RECEIPT.unpack_from(payload)
            timeline.ack(payload[ACK_RECEIPT.size:], before, after, commit, size, chain)
            need(after < expected_binding['cleanupNs'], 'late ACK')
            codec = Codec({'kind': 'sample', 'scheduledNs': timeline.baseline['beganNs'],
                           'snapshot': timeline.baseline})
        elif kind == 'SAMPLE':
            need(codec is not None and client_exit is None and cancellation is None, 'sample placement')
            need(len(payload) == codec.size, 'sample size differs from frozen inventory')
            samples += 1
        elif kind == 'TAIL_CANCEL':
            need(codec is not None and cancellation is None and client_exit is None, 'tail cancellation placement')
            cancellation = decode_json(payload, 4096)
        elif kind == 'CLIENT_EXIT':
            need(timeline.end_ns is not None and client_exit is None, 'client exit placement')
            client_exit = decode_json(payload, 4096)
            keys(client_exit, ('identity', 'atNs', 'code'))
            need(client_exit['identity'] == begin['client'] and type(client_exit['code']) is int
                 and client_exit['code'] == 0, 'client identity/outcome')
            need(timeline.last_received <= counter(client_exit['atNs'], True) < expected_binding['cutoffNs'],
                 'client exit clock')
        elif kind == 'STREAM_END':
            need(client_exit is not None, 'stream end before client reap')
            terminal = decode_json(payload)
            keys(terminal, ('atNs', 'stdoutEof', 'stderrEof', 'recordsBeforeEnd', 'bytesBeforeEnd', 'chainBeforeEnd'))
            need(type(terminal['recordsBeforeEnd']) is int and terminal['recordsBeforeEnd'] == frame.sequence
                 and type(terminal['bytesBeforeEnd']) is int and terminal['bytesBeforeEnd'] == frame.offset
                 and terminal['chainBeforeEnd'] == prior_hash.hex(), 'stream end prefix mismatch')
            need(terminal['stdoutEof'] is True and terminal['stderrEof'] is True, 'client pipe EOF missing')
            need(client_exit['atNs'] <= counter(terminal['atNs'], True) < expected_binding['cutoffNs'],
                 'stream end clock/deadline')
        prior_hash = frame.sha256
    need(terminal is not None, 'missing internal stream end')
    timeline.summary()
    if cancellation is not None:
        keys(cancellation, ('scheduledNs', 'beganNs', 'failedNs', 'reason'))
        need(counter(cancellation['failedNs'], True) <= client_exit['atNs']
             and cancellation['failedNs'] < expected_binding['cleanupNs'], 'tail failure after exit/deadline')
    return begin, timeline, codec, client_exit, cancellation, samples, prior_hash


def replay_observations(open_pass, expected_binding):
    """Two bounded passes over hash-verified files; no settlement/capacity PASS.

    open_pass must provide a context-managed bounded reader. Production callers
    use VerifiedFiles.pass_file so all files are hashed before any parsing and
    every semantic pass is checked against the same retained descriptor/hash.
    """
    validate_binding(expected_binding)
    with open_pass() as source:
        begin, timeline, codec, client_exit, cancellation, count, end_hash = control_pass(source, expected_binding)
    cadence = Cadence(timeline.ack_interval[0], timeline.baseline)
    interiors = {name: 0 for name in timeline.phases if name != 'stop'}
    deltas = {name: dict(socketDrops=0, threadRuntimeNs=0, threadWaitNs=0, threadTimeslices=0)
              for name in interiors}
    ambiguous_samples = ambiguous_deltas = 0
    with open_pass() as source:
        for frame in iter_frames(source):
            if frame.kind == 'SAMPLE':
                row = codec.decode(frame.payload, cadence.count)
                current, previous = row['snapshot'], cadence.previous
                need(current['beganNs'] >= timeline.ack_interval[1], 'sample began before ACK completed')
                need(current['finishedNs'] <= client_exit['atNs']
                     and current['finishedNs'] < expected_binding['cleanupNs'], 'sample after exit/deadline')
                phase, ambiguous = timeline.classify(current['beganNs'], current['finishedNs'])
                if ambiguous: ambiguous_samples += 1
                elif phase in interiors: interiors[phase] += 1
                delta_phase, delta_ambiguous = timeline.classify(previous['beganNs'], current['finishedNs'])
                if delta_ambiguous or delta_phase not in deltas:
                    ambiguous_deltas += 1
                else:
                    target = deltas[delta_phase]
                    target['socketDrops'] += sum(r['drops'] - previous['sockets'][i]['drops']
                                                 for i, r in current['sockets'].items())
                    for field, output in (('runtimeNs', 'threadRuntimeNs'), ('waitNs', 'threadWaitNs'),
                                          ('timeslices', 'threadTimeslices')):
                        target[output] += sum(r[field] - previous['threads'][i][field]
                                              for i, r in current['threads'].items())
                cadence.add(row)
            if frame.kind == 'STREAM_END':
                need(frame.sha256 == end_hash, 'raw changed between semantic passes')
    need(cadence.count == count, 'sample count changed between passes')
    _, stop_before, stop_after, _ = timeline.fences[-1]
    coverage = cadence.finish(stop_before, stop_after, cancellation=cancellation,
                              clean_client_exit=True, end_ns=timeline.end_ns)
    for phase, minimum in dict(connect=1, steady=2, drain=2, idle=1).items():
        need(interiors[phase] >= minimum, 'missing interior phase observations: ' + phase)
    return dict(schema='g6-receiver-observations/1', binding=expected_binding,
                streamEndSha256=end_hash.hex(), driver=timeline.summary(), coverage=coverage,
                interiorSamples=interiors, unambiguousDeltas=deltas,
                ambiguousSamples=ambiguous_samples, ambiguousDeltas=ambiguous_deltas,
                externalSettlementVerified=False, capacityQualified=False)


def replay_verified(root, manifest_sha256, expected_binding):
    with VerifiedFiles(root, manifest_sha256) as files:
        validate_binding(expected_binding)
        need(files.manifest['binding'] == expected_binding, 'manifest binding mismatch')
        for name in ('client.stdout', 'client.stderr'):
            with files.pass_file(name) as source:
                validate_log_lines(source)
        result = replay_observations(lambda: files.pass_file('receiver.raw'), expected_binding)
        files.finish()
        return result


def validate_log_lines(source):
    """Count bytes without retaining a complete line; newline counts in cap."""
    pending = 0
    while True:
        chunk = source.read(65536)
        if not chunk: return
        start = 0
        while True:
            end = chunk.find(b'\n', start)
            if end == -1:
                pending += len(chunk) - start
                need(pending <= LOG_LINE_MAX_BYTES, 'client log line cap')
                break
            pending += end + 1 - start
            need(pending <= LOG_LINE_MAX_BYTES, 'client log line cap')
            pending, start = 0, end + 1
