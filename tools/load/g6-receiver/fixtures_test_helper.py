"""Deterministic synthetic fixtures; never campaign evidence or host identity."""


def sample(threads=3, at=1_000_000_000):
    return {
        'kind': 'sample', 'scheduledNs': at,
        'snapshot': {
            'identity': {
                'pid': 1000, 'startTime': 12345, 'netns': 'net:[123456]',
                'exe': '/opt/g6/source/target/release/mmo-client',
                'exeDevice': 1, 'exeInode': 2, 'exeSize': 123456,
                'exeMtimeNs': 1_700_000_000_000_000_000,
                'bootId': '11111111-1111-4111-8111-111111111111',
            },
            'sockets': {
                str(100000 + i): {
                    'family': 4, 'local': f'00000000:{20000 + i:04X}',
                    'drops': 0, 'rxQueueBytes': 0, 'txQueueBytes': 0,
                    'rcvbufBytes': 262144, 'sndbufBytes': 262144,
                } for i in range(128)
            },
            'threads': {
                str(1000 + i): {'pid': 1000 + i, 'startTime': 12345,
                               'runtimeNs': i, 'waitNs': 0, 'timeslices': 1}
                for i in range(threads)
            },
            'beganNs': at + 1, 'finishedNs': at + 1000,
            'effectiveRcvbufSource': 'SOCK_DIAG_BY_FAMILY/INET_DIAG_SKMEMINFO per owned inode',
            'limits': ['Host snapshots are not atomic', 'Not full-rate calibration'],
        },
    }


TOKEN = 'a' * 64


def ready():
    return (f'G6RD1\tREADY\t{TOKEN}\t1000\t800000000\t128\n'
            + ''.join(f'{i}\t0.0.0.0:{20000 + i}\n' for i in range(128))).encode()


def phase(index, name, before):
    return f'G6RD1\tPHASE\t{TOKEN}\t{index}\t{name}\t{before}\t{before + 100}\n'.encode()


def end(at=2_001_000_000):
    return f'G6RD1\tEND\t{TOKEN}\t6\t{at}\n'.encode()
